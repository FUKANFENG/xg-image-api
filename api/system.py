from __future__ import annotations

import hmac
import time
from threading import Lock
from urllib.parse import quote

from fastapi import APIRouter, Header, HTTPException, Query, Request, status
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import HTMLResponse, Response, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

from api.support import (
    SESSION_COOKIE_NAME,
    require_admin,
    require_identity,
    require_request_identity,
    resolve_image_base_url,
)
from services.auth_service import auth_service
from services.advanced_creative_service import advanced_creative_service
from services.backup_service import BackupError, backup_service
from services.config import config
from services.image_service import (
    compress_images,
    delete_images,
    delete_to_target,
    download_images_zip,
    get_image_download_response,
    get_image_response,
    get_thumbnail_response,
    list_images,
    storage_stats,
)
from services.image_integrity_service import image_integrity_service
from services.image_storage_service import ImageStorageError, image_storage_service
from services.image_tags_service import delete_tag, get_all_tags, set_tags
from services.log_service import log_service
from services.proxy_service import proxy_settings, test_clearance, test_proxy


class SettingsUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="allow")


class ProxyTestRequest(BaseModel):
    url: str = ""


class ClearanceTestRequest(BaseModel):
    target_url: str = "https://chatgpt.com"


class ImageDeleteRequest(BaseModel):
    paths: list[str] = []
    start_date: str = ""
    end_date: str = ""
    all_matching: bool = False

class ImageDownloadRequest(BaseModel):
    paths: list[str]

class ImageTagsRequest(BaseModel):
    path: str
    tags: list[str]

class LogDeleteRequest(BaseModel):
    ids: list[str] = []
class BackupDeleteRequest(BaseModel):
    key: str = ""


class PasswordLoginRequest(BaseModel):
    username: str | None = Field(default=None, max_length=32)
    password: str | None = Field(default=None, max_length=128)


class PasswordRegistrationRequest(BaseModel):
    username: str = Field(..., min_length=3, max_length=32)
    password: str = Field(..., min_length=8, max_length=128)
    name: str = Field(default="", max_length=80)


_DEFAULT_REGISTERED_IMAGE_QUOTA = 100
_LOGIN_ATTEMPT_WINDOW_SECONDS = 15 * 60
_LOGIN_ATTEMPT_LIMIT = 5
_login_attempt_lock = Lock()
_login_attempts: dict[str, tuple[int, float]] = {}
_REGISTRATION_ATTEMPT_WINDOW_SECONDS = 15 * 60
_REGISTRATION_ATTEMPT_LIMIT = 20
_registration_attempt_lock = Lock()
_registration_attempts: dict[str, tuple[int, float]] = {}


def _login_attempt_key(username: str, request: Request) -> str:
    host = request.client.host if request.client else "unknown"
    return f"{username.strip().lower()}@{host}"


def _ensure_login_not_limited(key: str) -> None:
    now = time.monotonic()
    with _login_attempt_lock:
        attempts = _login_attempts.get(key)
        if attempts is None:
            return
        count, started_at = attempts
        if now - started_at >= _LOGIN_ATTEMPT_WINDOW_SECONDS:
            _login_attempts.pop(key, None)
            return
        if count >= _LOGIN_ATTEMPT_LIMIT:
            raise HTTPException(status_code=429, detail={"error": "登录尝试过多，请 15 分钟后再试"})


def _record_login_failure(key: str) -> None:
    now = time.monotonic()
    with _login_attempt_lock:
        count, started_at = _login_attempts.get(key, (0, now))
        if now - started_at >= _LOGIN_ATTEMPT_WINDOW_SECONDS:
            count, started_at = 0, now
        _login_attempts[key] = (count + 1, started_at)


def _clear_login_failures(key: str) -> None:
    with _login_attempt_lock:
        _login_attempts.pop(key, None)


def _consume_registration_attempt(request: Request) -> None:
    host = request.client.host if request.client else "unknown"
    now = time.monotonic()
    with _registration_attempt_lock:
        attempts = _registration_attempts.get(host)
        if attempts is None or now - attempts[1] >= _REGISTRATION_ATTEMPT_WINDOW_SECONDS:
            _registration_attempts[host] = (1, now)
            return
        count, started_at = attempts
        if count >= _REGISTRATION_ATTEMPT_LIMIT:
            raise HTTPException(status_code=429, detail={"error": "注册操作过多，请 15 分钟后再试"})
        _registration_attempts[host] = (count + 1, started_at)


def _admin_password_identity(username: str, password: str) -> dict[str, object] | None:
    admin_password = config.admin_password
    if username.strip().lower() != "admin" or not admin_password:
        return None
    if not hmac.compare_digest(password, admin_password):
        return None
    return {"id": "admin", "name": "管理员", "role": "admin", "session_version": 1}


def _auth_response(identity: dict[str, object], app_version: str) -> dict[str, object]:
    payload: dict[str, object] = {
        "ok": True,
        "version": app_version,
        "role": identity.get("role"),
        "subject_id": identity.get("id"),
        "name": identity.get("name"),
    }
    if identity.get("role") == "user" and identity.get("image_quota") is not None:
        payload["image_quota"] = identity.get("image_quota")
    return payload


def _set_session_cookie(response: Response, request: Request, token: str) -> None:
    response.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=token,
        max_age=12 * 60 * 60,
        httponly=True,
        secure=request.url.scheme == "https",
        samesite="lax",
        path="/",
    )


def _password_login_response(
    *,
    request: Request,
    response: Response,
    body: PasswordLoginRequest | None,
    app_version: str,
    required_role: str | None = None,
) -> dict[str, object]:
    username = str(body.username or "").strip() if body is not None else ""
    password = str(body.password or "") if body is not None else ""
    if not username or not password:
        raise HTTPException(status_code=400, detail={"error": "请输入账号和密码"})

    attempt_key = _login_attempt_key(username, request)
    _ensure_login_not_limited(attempt_key)
    if required_role == "admin":
        identity = _admin_password_identity(username, password)
    elif required_role == "user":
        identity = auth_service.authenticate_password(username, password)
    else:
        identity = _admin_password_identity(username, password) or auth_service.authenticate_password(username, password)

    if identity is None or (required_role is not None and identity.get("role") != required_role):
        _record_login_failure(attempt_key)
        advanced_creative_service.audit(
            {"id": username.lower(), "role": "anonymous", "name": username},
            "auth.login_failed",
            entity_type="session",
            details={"required_role": required_role or "any"},
            owner_id=username.lower(),
            ip_address=request.client.host if request.client else "",
            user_agent=request.headers.get("user-agent", ""),
        )
        raise HTTPException(status_code=401, detail={"error": "账号或密码错误"})

    _clear_login_failures(attempt_key)
    _set_session_cookie(response, request, auth_service.create_session(identity))
    advanced_creative_service.audit(
        identity,
        "auth.login_success",
        entity_type="session",
        ip_address=request.client.host if request.client else "",
        user_agent=request.headers.get("user-agent", ""),
    )
    return _auth_response(identity, app_version)


def create_router(app_version: str) -> APIRouter:
    router = APIRouter()

    @router.post("/auth/login")
    async def login(
        request: Request,
        response: Response,
        body: PasswordLoginRequest | None = None,
        authorization: str | None = Header(default=None),
    ):
        username = str(body.username or "").strip() if body is not None else ""
        password = str(body.password or "") if body is not None else ""
        if username or password:
            return _password_login_response(
                request=request,
                response=response,
                body=body,
                app_version=app_version,
            )

        # 保留已有 API 密钥调用的验证路径，避免既有接口集成被此次网页登录改造打断。
        return _auth_response(require_identity(authorization), app_version)

    @router.post("/auth/user-login")
    async def user_login(request: Request, response: Response, body: PasswordLoginRequest):
        return _password_login_response(
            request=request,
            response=response,
            body=body,
            app_version=app_version,
            required_role="user",
        )

    @router.post("/auth/admin-login")
    async def admin_login(request: Request, response: Response, body: PasswordLoginRequest):
        return _password_login_response(
            request=request,
            response=response,
            body=body,
            app_version=app_version,
            required_role="admin",
        )

    @router.post("/auth/register", status_code=status.HTTP_201_CREATED)
    async def register(
        request: Request,
        response: Response,
        body: PasswordRegistrationRequest,
    ):
        _consume_registration_attempt(request)
        try:
            auth_service.create_user(
                username=body.username,
                password=body.password,
                name=body.name,
                image_quota=_DEFAULT_REGISTERED_IMAGE_QUOTA,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail={"error": "该登录账号不可用，请更换后重试"}) from exc

        identity = auth_service.authenticate_password(body.username, body.password)
        if identity is None:
            raise HTTPException(status_code=500, detail={"error": "注册完成，但自动登录失败，请直接使用新账号登录"})
        _set_session_cookie(response, request, auth_service.create_session(identity))
        return _auth_response(identity, app_version)

    @router.post("/auth/session")
    async def get_session(authorization: str | None = Header(default=None)):
        try:
            identity = require_identity(authorization)
        except HTTPException as exc:
            if exc.status_code != 401:
                raise
            return {"ok": False, "authenticated": False, "version": app_version}
        return {**_auth_response(identity, app_version), "authenticated": True}

    @router.post("/auth/logout")
    async def logout(response: Response):
        response.delete_cookie(key=SESSION_COOKIE_NAME, path="/", httponly=True, samesite="lax")
        return {"ok": True}

    @router.get("/version")
    async def get_version():
        return {"version": app_version}

    @router.get("/api/settings")
    async def get_settings(authorization: str | None = Header(default=None)):
        require_admin(authorization)
        return {"config": config.get()}

    @router.get("/api/third-party-apps")
    async def get_third_party_apps(authorization: str | None = Header(default=None)):
        require_admin(authorization)
        return {"third_party_apps": config.get_third_party_apps_settings()}

    @router.get("/api/user-tools")
    async def get_user_tools(authorization: str | None = Header(default=None)):
        require_identity(authorization)
        return {"tools": config.get_user_tools_settings()}

    @router.post("/api/settings")
    async def save_settings(body: SettingsUpdateRequest, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        try:
            return {"config": config.update(body.model_dump(mode="python"))}
        except ValueError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc

    @router.get("/api/images")
    async def get_images(request: Request, start_date: str = "", end_date: str = "", authorization: str | None = Header(default=None)):
        require_admin(authorization)
        return list_images(resolve_image_base_url(request), start_date=start_date.strip(), end_date=end_date.strip())

    @router.get("/images/{image_path:path}", include_in_schema=False)
    async def get_image(
        image_path: str,
        request: Request,
        authorization: str | None = Header(default=None),
    ):
        require_request_identity(request, authorization)
        return get_image_response(image_path)

    @router.get("/image-thumbnails/{image_path:path}", include_in_schema=False)
    async def get_image_thumbnail(
        image_path: str,
        request: Request,
        authorization: str | None = Header(default=None),
    ):
        require_request_identity(request, authorization)
        return get_thumbnail_response(image_path)

    @router.post("/api/images/delete")
    async def delete_images_endpoint(body: ImageDeleteRequest, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        return delete_images(body.paths, start_date=body.start_date.strip(), end_date=body.end_date.strip(), all_matching=body.all_matching)

    @router.post("/api/images/download")
    async def download_images_endpoint(body: ImageDownloadRequest, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        buf = download_images_zip(body.paths)
        return StreamingResponse(
            buf,
            media_type="application/zip",
            headers={"Content-Disposition": 'attachment; filename="images.zip"'},
        )

    @router.get("/api/images/download/{image_path:path}")
    async def download_single_image_endpoint(image_path: str, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        return get_image_download_response(image_path)

    @router.get("/api/logs")
    async def get_logs(type: str = "", start_date: str = "", end_date: str = "", authorization: str | None = Header(default=None)):
        require_admin(authorization)
        return {"items": log_service.list(type=type.strip(), start_date=start_date.strip(), end_date=end_date.strip())}

    @router.post("/api/logs/delete")
    async def delete_logs(body: LogDeleteRequest, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        return log_service.delete(body.ids)

    @router.post("/api/proxy/test")
    async def test_proxy_endpoint(body: ProxyTestRequest, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        return {"result": await run_in_threadpool(test_proxy, (body.url or "").strip())}

    @router.get("/api/proxy/runtime")
    async def get_proxy_runtime_endpoint(authorization: str | None = Header(default=None)):
        require_admin(authorization)
        return {
            "runtime": config.get_public_proxy_runtime_settings(),
            "status": proxy_settings.get_runtime_status(),
        }

    @router.post("/api/proxy/runtime")
    async def save_proxy_runtime_endpoint(body: SettingsUpdateRequest, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        try:
            config.update({"proxy_runtime": body.model_dump(mode="python")})
        except ValueError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc
        return {
            "runtime": config.get_public_proxy_runtime_settings(),
            "status": proxy_settings.get_runtime_status(),
        }

    @router.post("/api/proxy/clearance/test")
    async def test_proxy_clearance_endpoint(body: ClearanceTestRequest, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        return {"result": await run_in_threadpool(test_clearance, body.target_url)}

    @router.get("/api/storage/info")
    async def get_storage_info(authorization: str | None = Header(default=None)):
        require_admin(authorization)
        storage = config.get_storage_backend()
        return {
            "backend": storage.get_backend_info(),
            "health": storage.health_check(),
        }

    @router.post("/api/backup/test")
    async def test_backup_connection(authorization: str | None = Header(default=None)):
        require_admin(authorization)
        try:
            return {"result": await run_in_threadpool(backup_service.test_connection)}
        except BackupError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc

    @router.get("/api/image-storage/readiness")
    async def get_image_storage_readiness(
        force: bool = False,
        authorization: str | None = Header(default=None),
    ):
        identity = require_admin(authorization)
        report = await run_in_threadpool(
            image_integrity_service.scan,
            identity,
            include_all=True,
            force=force,
        )
        backup_settings = config.get_backup_settings()
        backup_include = backup_settings.get("include")
        backup_state = backup_service.get_status()
        return {
            "image_protection": image_storage_service.backup_readiness(),
            "integrity": dict(report.get("summary") or {}),
            "system_backup": {
                "enabled": bool(backup_settings.get("enabled")),
                "provider": str(backup_settings.get("provider") or "local"),
                "includes_images": bool(
                    backup_include.get("images") if isinstance(backup_include, dict) else False
                ),
                "last_status": str(backup_state.get("last_status") or "idle"),
            },
            "scanned_at": str(report.get("scanned_at") or ""),
        }

    @router.post("/api/image-storage/test")
    async def test_image_storage_endpoint(authorization: str | None = Header(default=None)):
        require_admin(authorization)
        return {"result": await run_in_threadpool(image_storage_service.test_webdav)}

    @router.post("/api/image-storage/sync")
    async def sync_image_storage_endpoint(authorization: str | None = Header(default=None)):
        require_admin(authorization)
        try:
            return {"result": await run_in_threadpool(image_storage_service.sync_all)}
        except ImageStorageError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc

    @router.get("/api/backups")
    async def get_backups(authorization: str | None = Header(default=None)):
        require_admin(authorization)
        try:
            return {
                "items": await run_in_threadpool(backup_service.list_backups),
                "state": backup_service.get_status(),
                "settings": backup_service.get_settings(),
            }
        except BackupError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc

    @router.post("/api/backups/run")
    async def run_backup_endpoint(authorization: str | None = Header(default=None)):
        require_admin(authorization)
        try:
            return {"result": await run_in_threadpool(backup_service.run_backup)}
        except BackupError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc

    @router.post("/api/backups/delete")
    async def delete_backup_endpoint(body: BackupDeleteRequest, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        try:
            await run_in_threadpool(backup_service.delete_backup, body.key)
            return {"ok": True}
        except BackupError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc

    @router.get("/api/backups/detail")
    async def get_backup_detail(key: str = "", authorization: str | None = Header(default=None)):
        require_admin(authorization)
        try:
            return {"item": await run_in_threadpool(backup_service.get_backup_detail, key)}
        except BackupError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc

    @router.get("/api/backups/download")
    async def download_backup_endpoint(key: str = "", authorization: str | None = Header(default=None)):
        require_admin(authorization)
        try:
            item = await run_in_threadpool(backup_service.download_backup, key)
        except BackupError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc
        filename = str(item.get("name") or "backup.bin")
        quoted = quote(filename)
        headers = {
            "Content-Disposition": f"attachment; filename*=UTF-8''{quoted}",
            "Content-Length": str(int(item.get("size") or 0)),
        }
        return Response(
            content=bytes(item.get("payload") or b""),
            media_type=str(item.get("content_type") or "application/octet-stream"),
            headers=headers,
        )


    @router.get("/api/images/tags")
    async def list_image_tags(authorization: str | None = Header(default=None)):
        require_admin(authorization)
        return {"tags": get_all_tags()}

    @router.post("/api/images/tags")
    async def update_image_tags(body: ImageTagsRequest, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        rel = body.path.strip().lstrip("/")
        if not rel:
            raise HTTPException(status_code=400, detail={"error": "path is required"})
        tags = set_tags(rel, body.tags)
        return {"ok": True, "tags": tags}

    @router.delete("/api/images/tags/{tag}")
    async def delete_image_tag(tag: str, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        count = delete_tag(tag)
        return {"ok": True, "removed_from": count}

    @router.get("/api/images/storage")
    async def get_image_storage(authorization: str | None = Header(default=None)):
        require_admin(authorization)
        return storage_stats()

    @router.post("/api/images/storage/compress")
    async def compress_all_images(authorization: str | None = Header(default=None)):
        require_admin(authorization)
        return await run_in_threadpool(compress_images)

    @router.post("/api/images/storage/cleanup-to-target")
    async def cleanup_to_target(
        target_free_mb: int = 500,
        dry_run: bool = False,
        authorization: str | None = Header(default=None),
    ):
        require_admin(authorization)
        return await run_in_threadpool(delete_to_target, target_free_mb, dry_run)

    @router.get("/health", response_model=None)
    async def health_dashboard(format: str = Query(default="html")):
        from services.account_service import account_service as acct_svc
        stats = acct_svc.get_stats()
        storage = config.get_storage_backend()
        storage_health = storage.health_check()
        healthy = stats["active"] > 0

        stats_json = {
            "status": "ok" if healthy else "degraded",
            "healthy": healthy,
            "version": app_version,
            "storage": {"backend": storage.get_backend_info(), "health": storage_health},
            "proxy_runtime": proxy_settings.get_runtime_status(),
            "accounts": stats,
        }
        if format == "json":
            return stats_json
        return HTMLResponse(f"""<!DOCTYPE html>
<html lang="zh">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>号池健康监控 - chatgpt2api</title>
<style>
*{{margin:0;padding:0;box-sizing:border-box}}
body{{font-family:system-ui,-apple-system,sans-serif;background:#0f1117;color:#e2e8f0;min-height:100vh}}
.header{{background:#1a1d27;border-bottom:1px solid #2a2d3a;padding:16px 24px;display:flex;justify-content:space-between;align-items:center}}
.header h1{{font-size:20px}}
.status-dot{{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:8px}}
.status-ok{{background:#22c55e;box-shadow:0 0 8px #22c55e88}}
.status-degraded{{background:#f59e0b;box-shadow:0 0 8px #f59e0b88}}
.container{{max-width:960px;margin:0 auto;padding:24px}}
.cards{{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:24px}}
.card{{background:#1a1d27;border:1px solid #2a2d3a;border-radius:10px;padding:16px}}
.card .value{{font-size:28px;font-weight:700;margin:4px 0}}
.card .label{{font-size:13px;color:#94a3b8}}
.green{{color:#22c55e}}.yellow{{color:#f59e0b}}.red{{color:#ef4444}}.blue{{color:#6c63ff}}
table{{width:100%;border-collapse:collapse;background:#1a1d27;border:1px solid #2a2d3a;border-radius:10px;overflow:hidden}}
th{{background:#242836;font-weight:600;text-align:left;padding:10px 12px;font-size:12px;color:#94a3b8;text-transform:uppercase}}
td{{padding:8px 12px;border-top:1px solid #2a2d3a;font-size:14px}}tr:hover td{{background:rgba(108,99,255,.05)}}
.api-url{{font-family:monospace;font-size:12px;color:#6c63ff}}
.refresh{{font-size:12px;color:#64748b;text-align:center;margin-top:24px}}
</style>
<meta http-equiv="refresh" content="30">
</head>
<body>
<div class="header">
<h1><span class="status-dot {'status-ok' if healthy else 'status-degraded'}"></span>号池健康监控</h1>
<div style="font-size:13px;color:#94a3b8">v{app_version} · 30s 自动刷新</div>
</div>
<div class="container">
<div class="cards">
<div class="card"><div class="label">号池状态</div><div class="value {'green' if healthy else 'yellow'}">{'正常' if healthy else '异常'}</div></div>
<div class="card"><div class="label">当前账号</div><div class="value blue">{stats['total']}</div></div>
<div class="card"><div class="label">累计入库</div><div class="value">{stats['cumulative_total']}</div></div>
<div class="card"><div class="label">可用账号</div><div class="value green">{stats['active']}</div></div>
<div class="card"><div class="label">剩余额度</div><div class="value">{stats['total_quota']}</div></div>
<div class="card"><div class="label">限流</div><div class="value yellow">{stats['limited']}</div></div>
<div class="card"><div class="label">异常</div><div class="value red">{stats['abnormal']}</div></div>
<div class="card"><div class="label">禁用</div><div class="value">{stats['disabled']}</div></div>
<div class="card"><div class="label">成功/失败</div><div class="value">{stats['total_success']}<span style="font-size:18px;color:#94a3b8">/</span><span class="red">{stats['total_fail']}</span></div></div>
</div>
<h2 style="margin-bottom:12px;font-size:16px">账号类型分布</h2>
<table>
<tr><th>类型</th><th>数量</th></tr>
{''.join(f'<tr><td>{t}</td><td>{c}</td></tr>' for t,c in sorted(stats['by_type'].items()))}
</table>
<div class="refresh">JSON: <span class="api-url">/health?format=json</span></div>
</div></body></html>""")

    return router
