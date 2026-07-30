from __future__ import annotations

from pathlib import Path
from threading import Event, Thread

from fastapi import HTTPException, Request

from services.account_service import account_service
from services.auth_service import auth_service
from services.config import config

BASE_DIR = Path(__file__).resolve().parents[1]
WEB_DIST_DIR = BASE_DIR / "web_dist"
SESSION_COOKIE_NAME = "chatgpt2api_session"
_ACCOUNT_RESPONSE_SECRET_FIELDS = {
    "refresh_token",
    "refreshtoken",
    "id_token",
    "idtoken",
    "password",
    "session",
    "session_id",
    "sessionid",
    "cookie",
    "cookies",
    "code_verifier",
    "codeverifier",
    "fp",
}

_USER_TOOL_LABELS = {
    "search": "搜索",
    "ppt": "PPT 生成",
    "psd": "PSD 生成",
}


def extract_bearer_token(authorization: str | None) -> str:
    scheme, _, value = str(authorization or "").partition(" ")
    if scheme.lower() != "bearer" or not value.strip():
        return ""
    return value.strip()


def _legacy_admin_identity(token: str) -> dict[str, object] | None:
    auth_key = str(config.auth_key or "").strip()
    if auth_key and token == auth_key:
        return {"id": "admin", "name": "管理员", "role": "admin"}
    return None


def require_identity(authorization: str | None) -> dict[str, object]:
    token = extract_bearer_token(authorization)
    identity = auth_service.authenticate_session(token) or _legacy_admin_identity(token) or auth_service.authenticate_key(token)
    if identity is None:
        raise HTTPException(status_code=401, detail={"error": "登录已失效或凭据无效，请重新登录"})
    return identity


def require_auth_key(authorization: str | None) -> None:
    require_identity(authorization)


def require_admin(authorization: str | None) -> dict[str, object]:
    identity = require_identity(authorization)
    if identity.get("role") != "admin":
        raise HTTPException(status_code=403, detail={"error": "需要管理员权限才能执行这个操作"})
    return identity


def require_request_identity(request: Request, authorization: str | None = None) -> dict[str, object]:
    bearer = extract_bearer_token(authorization)
    session = str(request.cookies.get(SESSION_COOKIE_NAME) or "").strip()
    token = bearer or session
    identity = auth_service.authenticate_session(token) or _legacy_admin_identity(token) or auth_service.authenticate_key(token)
    if identity is None:
        raise HTTPException(status_code=401, detail={"error": "登录已失效或凭据无效，请重新登录"})
    return identity


def require_user_tool(authorization: str | None, tool: str) -> dict[str, object]:
    identity = require_identity(authorization)
    normalized_tool = str(tool or "").strip().lower()
    if identity.get("role") == "user" and not config.is_user_tool_enabled(normalized_tool):
        label = _USER_TOOL_LABELS.get(normalized_tool, "此工具")
        raise HTTPException(status_code=403, detail={"error": f"管理员已关闭普通用户的{label}功能"})
    return identity


def resolve_image_base_url(request: Request) -> str:
    return config.base_url or f"{request.url.scheme}://{request.headers.get('host', request.url.netloc)}"


def raise_image_quota_error(exc: Exception) -> None:
    message = str(exc)
    if "no available image quota" in message.lower():
        raise HTTPException(status_code=429, detail={"error": "no available image quota"}) from exc
    raise HTTPException(status_code=502, detail={"error": message}) from exc


def sanitize_cpa_pool(pool: dict | None) -> dict | None:
    if not isinstance(pool, dict):
        return None
    return {key: value for key, value in pool.items() if key != "secret_key"}


def sanitize_cpa_pools(pools: list[dict]) -> list[dict]:
    return [sanitized for pool in pools if (sanitized := sanitize_cpa_pool(pool)) is not None]


def sanitize_sub2api_server(server: dict | None) -> dict | None:
    if not isinstance(server, dict):
        return None
    sanitized = {key: value for key, value in server.items() if key not in {"password", "api_key"}}
    sanitized["has_api_key"] = bool(str(server.get("api_key") or "").strip())
    return sanitized


def sanitize_sub2api_servers(servers: list[dict]) -> list[dict]:
    return [sanitized for server in servers if (sanitized := sanitize_sub2api_server(server)) is not None]


def sanitize_account(account: dict | None) -> dict | None:
    """保留前端兼容字段，同时移除不应通过管理列表返回的登录凭据。"""
    if not isinstance(account, dict):
        return None
    return {
        key: value
        for key, value in account.items()
        if str(key).lower().replace("-", "_") not in _ACCOUNT_RESPONSE_SECRET_FIELDS
    }


def sanitize_accounts(accounts: list[dict]) -> list[dict]:
    return [sanitized for account in accounts if (sanitized := sanitize_account(account)) is not None]


def sanitize_account_result(result: dict | None) -> dict:
    """清理账号接口及进度接口中的 item/items，不改变原有响应结构。"""
    if not isinstance(result, dict):
        return {}
    sanitized = dict(result)
    if isinstance(sanitized.get("item"), dict):
        sanitized["item"] = sanitize_account(sanitized["item"])
    if isinstance(sanitized.get("items"), list):
        sanitized["items"] = sanitize_accounts(sanitized["items"])
    if isinstance(sanitized.get("result"), dict):
        sanitized["result"] = sanitize_account_result(sanitized["result"])
    return sanitized


def start_limited_account_watcher(stop_event: Event) -> Thread:
    interval_seconds = config.refresh_account_interval_minute * 60

    def worker() -> None:
        while not stop_event.is_set():
            try:
                limited_tokens = account_service.list_limited_tokens()
                normal_tokens = account_service.list_normal_tokens()
                expiring_tokens = account_service.list_expiring_access_tokens()
                keepalive_tokens = account_service.list_refresh_token_keepalive_tokens()
                tokens = list(dict.fromkeys([*limited_tokens, *normal_tokens, *expiring_tokens]))
                expiring_token_set = set(expiring_tokens)
                keepalive_tokens = [token for token in keepalive_tokens if token not in expiring_token_set]
                if tokens:
                    print(
                        "[account-watcher] checking "
                        f"{len(limited_tokens)} limited accounts, "
                        f"{len(normal_tokens)} normal accounts, "
                        f"{len(expiring_tokens)} expiring access tokens"
                    )
                    account_service.refresh_accounts(tokens)
                if keepalive_tokens:
                    print(f"[account-watcher] keepalive {len(keepalive_tokens)} refresh tokens")
                    result = account_service.keepalive_refresh_tokens(keepalive_tokens)
                    if result.get("errors"):
                        print(f"[account-watcher] keepalive errors: {result['errors']}")
            except Exception as exc:
                print(f"[account-watcher] fail {exc}")
            stop_event.wait(interval_seconds)

    thread = Thread(target=worker, name="account-watcher", daemon=True)
    thread.start()
    return thread


def resolve_web_asset(requested_path: str) -> Path | None:
    if not WEB_DIST_DIR.exists():
        return None
    clean_path = requested_path.strip("/")
    base_dir = WEB_DIST_DIR.resolve()
    candidates = [base_dir / "index.html"] if not clean_path else [
        base_dir / Path(clean_path),
        base_dir / clean_path / "index.html",
        base_dir / f"{clean_path}.html",
    ]
    for candidate in candidates:
        try:
            candidate.resolve().relative_to(base_dir)
        except ValueError:
            continue
        if candidate.is_file():
            return candidate
    return None
