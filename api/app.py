from __future__ import annotations

import hashlib
import hmac
import ipaddress
import os
from contextlib import asynccontextmanager
from threading import Event

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from api import accounts, ai, image_tasks, inspirations, operations, system, workspace
from api.operations import dispatch_scheduled_generation
from api.errors import install_exception_handlers
from api.support import resolve_web_asset, start_limited_account_watcher
from services.backup_service import backup_service
from services.config import config
from services.creative_operations_service import creative_operations_service
from services.image_service import start_image_cleanup_scheduler


_WEB_DOCUMENT_CACHE_CONTROL = "no-store, no-cache, must-revalidate, max-age=0"
_WEB_ASSET_CACHE_CONTROL = "no-cache, must-revalidate, max-age=0"
_DIRECT_WEB_COOKIE_NAME = "chatgpt2api_direct_web"
_LOCAL_WEB_HOSTS = {"localhost", "127.0.0.1", "::1"}
_PRIVATE_LAN_NETWORKS = tuple(
    ipaddress.ip_network(cidr)
    for cidr in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16")
)


def _env_enabled(name: str, *, default: bool = False) -> bool:
    value = str(os.getenv(name) or "").strip().lower()
    if not value:
        return default
    return value in {"1", "true", "yes", "on"}


def _is_private_lan_host(hostname: str) -> bool:
    try:
        address = ipaddress.ip_address(hostname)
    except ValueError:
        return False
    return any(address in network for network in _PRIVATE_LAN_NETWORKS)


def _public_no_login_hosts() -> set[str]:
    raw_hosts = str(os.getenv("CHATGPT2API_PUBLIC_NO_LOGIN_HOSTS") or "")
    return {
        hostname.strip().lower().rstrip(".")
        for hostname in raw_hosts.split(",")
        if hostname.strip().rstrip(".")
    }


def _trusted_direct_web_hostname(request: Request) -> str:
    if not _env_enabled("CHATGPT2API_WEB_NO_LOGIN"):
        return ""
    hostname = str(request.url.hostname or "").strip().lower().rstrip(".")
    if hostname in _LOCAL_WEB_HOSTS:
        return hostname
    if _env_enabled("CHATGPT2API_LAN_NO_LOGIN") and _is_private_lan_host(hostname):
        return hostname
    if hostname in _public_no_login_hosts():
        return hostname
    return ""


def _direct_web_cookie_value(hostname: str) -> str:
    auth_key = str(config.auth_key or "").strip()
    if not hostname or not auth_key:
        return ""
    return hmac.new(
        auth_key.encode("utf-8"),
        f"direct-web:{hostname}".encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def _has_valid_direct_web_cookie(request: Request, hostname: str) -> bool:
    expected = _direct_web_cookie_value(hostname)
    supplied = str(request.cookies.get(_DIRECT_WEB_COOKIE_NAME) or "").strip()
    return bool(expected and supplied) and hmac.compare_digest(supplied, expected)


def _is_direct_web_request(request: Request) -> bool:
    """Recognize an explicitly trusted browser UI request."""

    hostname = _trusted_direct_web_hostname(request)
    if not hostname:
        return False
    fetch_site = str(request.headers.get("sec-fetch-site") or "").strip().lower()
    return fetch_site in {
        "same-origin",
        "none",
    } or _has_valid_direct_web_cookie(request, hostname)


def _apply_cache_policy(request: Request, response: Response) -> None:
    path = request.url.path
    if path.startswith(("/auth/", "/api/")):
        response.headers["Cache-Control"] = "no-store"
        return

    content_type = str(response.headers.get("content-type") or "").lower()
    is_document = "text/html" in content_type
    is_next_route_data = path.endswith(".txt") and not path.startswith("/_next/static/")
    if is_document or is_next_route_data:
        response.headers["Cache-Control"] = _WEB_DOCUMENT_CACHE_CONTROL
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
        return

    if path.startswith("/_next/static/") and path.lower().endswith((".js", ".css")):
        response.headers["Cache-Control"] = _WEB_ASSET_CACHE_CONTROL


def create_app() -> FastAPI:
    app_version = config.app_version

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        stop_event = Event()
        thread = start_limited_account_watcher(stop_event)
        cleanup_thread = start_image_cleanup_scheduler(stop_event)
        backup_service.start()
        creative_operations_service.start(dispatch_scheduled_generation)
        config.cleanup_old_images()
        try:
            yield
        finally:
            stop_event.set()
            thread.join(timeout=1)
            cleanup_thread.join(timeout=1)
            backup_service.stop()
            creative_operations_service.stop()

    app = FastAPI(title="chatgpt2api", version=app_version, lifespan=lifespan)
    install_exception_handlers(app)

    @app.middleware("http")
    async def inject_session_cookie(request, call_next):
        force_https = _env_enabled("CHATGPT2API_FORCE_HTTPS")
        forwarded_proto = str(request.headers.get("x-forwarded-proto") or request.url.scheme).split(",", 1)[0].strip()
        if force_https and forwarded_proto != "https":
            from fastapi.responses import RedirectResponse

            target = request.url.replace(scheme="https")
            return RedirectResponse(str(target), status_code=308)
        if not request.headers.get("authorization"):
            session_token = request.cookies.get("chatgpt2api_session", "").strip()
            direct_web_admin = _is_direct_web_request(request)
            effective_token = session_token or (
                str(config.auth_key or "").strip() if direct_web_admin else ""
            )
            if effective_token:
                headers = [
                    (key, value)
                    for key, value in request.scope.get("headers", [])
                    if key.lower() != b"authorization"
                ]
                headers.append(
                    (b"authorization", f"Bearer {effective_token}".encode("latin-1"))
                )
                request.scope["headers"] = headers
        response = await call_next(request)
        direct_web_hostname = _trusted_direct_web_hostname(request)
        content_type = str(response.headers.get("content-type") or "").lower()
        if direct_web_hostname and response.status_code < 400 and "text/html" in content_type:
            direct_web_cookie = _direct_web_cookie_value(direct_web_hostname)
            if direct_web_cookie:
                response.set_cookie(
                    key=_DIRECT_WEB_COOKIE_NAME,
                    value=direct_web_cookie,
                    path="/",
                    httponly=True,
                    secure=forwarded_proto == "https",
                    samesite="strict",
                )
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        response.headers.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        response.headers.setdefault(
            "Content-Security-Policy",
            "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; "
            "form-action 'self'; img-src 'self' data: blob: https:; font-src 'self' data:; "
            "style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; "
            "connect-src 'self' https: wss:",
        )
        if forwarded_proto == "https":
            response.headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
        _apply_cache_policy(request, response)
        return response

    app.add_middleware(
        CORSMiddleware,
        allow_origins=[],
        allow_origin_regex=(
            r"^https?://(localhost|127\.0\.0\.1|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|"
            r"172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})(?::\d{1,5})?$"
        ),
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(ai.create_router())
    app.include_router(accounts.create_router())
    app.include_router(image_tasks.create_router())
    app.include_router(inspirations.create_router())
    app.include_router(workspace.create_router())
    app.include_router(operations.create_router())
    app.include_router(system.create_router(app_version))

    @app.api_route("/{full_path:path}", methods=["GET", "HEAD"], include_in_schema=False)
    async def serve_web(full_path: str):
        asset = resolve_web_asset(full_path)
        if asset is not None:
            return FileResponse(asset)
        if full_path.strip("/").startswith("_next/"):
            raise HTTPException(status_code=404, detail="Not Found")
        fallback = resolve_web_asset("")
        if fallback is None:
            raise HTTPException(status_code=404, detail="Not Found")
        return FileResponse(fallback)

    return app
