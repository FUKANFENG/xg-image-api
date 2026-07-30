from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

import requests


BASE_URL = os.environ.get("XG_BASE_URL", "http://127.0.0.1:3000").rstrip("/")
ADMIN_PASSWORD = os.environ.get("XG_ADMIN_PASSWORD", "")
IMAGE_PATH = Path(__file__).resolve().parents[1] / "web" / "public" / "inspiration" / "tea-product.png"


def expect(response: requests.Response, status: int | tuple[int, ...] = 200):
    accepted = (status,) if isinstance(status, int) else status
    if response.status_code not in accepted:
        raise RuntimeError(f"{response.request.method} {response.url} -> {response.status_code}: {response.text[:300]}")
    if response.headers.get("content-type", "").startswith("application/json"):
        return response.json()
    return response.content


def main() -> None:
    if not ADMIN_PASSWORD:
        raise RuntimeError("XG_ADMIN_PASSWORD is required")
    suffix = f"{int(time.time() * 1000)}-{os.getpid()}"
    username = f"xgreg{suffix[-12:]}"
    password = "Regression!24680"
    user = requests.Session()
    admin = requests.Session()
    created_user_id = ""
    recipe_id = profile_id = project_id = asset_id = share_token = ""
    checks: list[str] = []
    try:
        for route in ("/studio/", "/canvas/", "/presets/", "/queue/", "/collaboration/", "/share/?token=missing"):
            expect(requests.get(f"{BASE_URL}{route}", timeout=15))
            checks.append(f"page:{route}")

        registration = expect(user.post(f"{BASE_URL}/auth/register", json={"username": username, "password": password, "name": "回归用户"}, timeout=15), 201)
        if registration.get("image_quota") != 100:
            raise RuntimeError(f"default quota mismatch: {registration.get('image_quota')}")
        created_user_id = registration["subject_id"]
        checks.append("registration:quota100")

        expect(admin.post(f"{BASE_URL}/auth/admin-login", json={"username": "admin", "password": ADMIN_PASSWORD}, timeout=15))
        checks.append("admin:login")

        project = expect(user.post(f"{BASE_URL}/api/workspace/projects", json={"name": f"回归项目-{suffix}", "description": "advanced creative regression", "tags": ["regression"]}, timeout=15))
        project_id = project["id"]
        recipe = expect(user.post(f"{BASE_URL}/api/workspace/recipes", json={"name": f"回归配方-{suffix}", "category": "poster", "description": "test", "settings": {"prompt": "极简海报", "size": "1024x1024", "quality": "auto"}}, timeout=15))
        recipe_id = recipe["id"]
        with IMAGE_PATH.open("rb") as image:
            profile = expect(user.post(f"{BASE_URL}/api/workspace/profiles", data={"profile_type": "product", "name": f"回归产品-{suffix}", "instructions": "保持产品结构与色彩", "colors": "#7c3aed", "fonts": "Inter"}, files={"references": (IMAGE_PATH.name, image, "image/png")}, timeout=30))
        profile_id = profile["id"]
        checks.extend(("project:create", "recipe:create", "profile:create"))

        asset = expect(user.post(f"{BASE_URL}/api/workspace/assets", json={"name": f"回归作品-{suffix}", "asset_type": "image", "project_id": project_id, "prompt": "回归测试产品图", "tags": ["regression", "product"]}, timeout=15))
        asset_id = asset["id"]
        with IMAGE_PATH.open("rb") as image:
            asset = expect(user.post(f"{BASE_URL}/api/workspace/assets/{asset_id}/versions/local", data={"prompt": "回归测试产品图", "operation": "canvas", "params": json.dumps({"size": "1024x1024"})}, files={"image": (IMAGE_PATH.name, image, "image/png")}, timeout=30))
        version_id = asset["current_version_id"]
        checks.append("canvas:save-version")

        expect(user.post(f"{BASE_URL}/api/workspace/assets/{asset_id}/analyze", json={}, timeout=30))
        search = expect(user.get(f"{BASE_URL}/api/workspace/search/assets", params={"query": "回归作品", "style": "product"}, timeout=15))
        if not any(item["id"] == asset_id for item in search["items"]):
            raise RuntimeError("smart search did not return the created asset")
        checks.append("search:analyze-query")

        share = expect(user.post(f"{BASE_URL}/api/workspace/assets/{asset_id}/shares", json={"version_id": version_id, "expires_days": 2}, timeout=15))
        share_token = share["token"]
        expect(requests.get(f"{BASE_URL}/api/shared/{share_token}", timeout=15))
        download = expect(requests.get(f"{BASE_URL}/api/shared/{share_token}/download", timeout=30))
        if not download:
            raise RuntimeError("public share download is empty")
        delivery = expect(user.get(f"{BASE_URL}/api/workspace/assets/{asset_id}/delivery", params={"mode": "delivery"}, timeout=30))
        if not delivery.startswith(b"PK"):
            raise RuntimeError("delivery package is not a zip archive")
        checks.extend(("share:public-download", "delivery:zip"))

        review = expect(user.post(f"{BASE_URL}/api/workspace/assets/{asset_id}/reviews", json={"version_id": version_id}, timeout=15))
        resolved = expect(admin.patch(f"{BASE_URL}/api/workspace/reviews/{review['id']}", json={"status": "approved", "comment": "回归审核通过"}, timeout=15))
        if resolved["status"] != "approved":
            raise RuntimeError("review status was not updated")
        checks.append("review:submit-approve")

        expect(user.get(f"{BASE_URL}/api/image-tasks", timeout=15))
        expect(admin.get(f"{BASE_URL}/api/image-tasks/admin/queue", timeout=15))
        expect(admin.get(f"{BASE_URL}/api/workspace/admin/audits", params={"limit": 20}, timeout=15))
        checks.extend(("queue:user-admin", "audit:list"))

        expect(user.delete(f"{BASE_URL}/api/workspace/assets/{asset_id}/versions/{version_id}", timeout=15))
        trash = expect(user.get(f"{BASE_URL}/api/workspace/trash", timeout=15))["items"]
        version_trash = next(item for item in trash if item["entity_type"] == "version" and item["entity_id"] == version_id)
        expect(user.post(f"{BASE_URL}/api/workspace/trash/{version_trash['id']}/restore", json={}, timeout=15))
        checks.append("trash:version-restore")

        expect(user.delete(f"{BASE_URL}/api/workspace/shares/{share_token}", timeout=15))
        if requests.get(f"{BASE_URL}/api/shared/{share_token}", timeout=15).status_code != 404:
            raise RuntimeError("revoked share is still public")
        share_token = ""
        checks.append("share:revoke")

        print(json.dumps({"ok": True, "round": suffix, "checks": checks, "count": len(checks)}, ensure_ascii=False))
    finally:
        if share_token:
            user.delete(f"{BASE_URL}/api/workspace/shares/{share_token}", timeout=10)
        if recipe_id:
            user.delete(f"{BASE_URL}/api/workspace/recipes/{recipe_id}", timeout=10)
        if profile_id:
            user.delete(f"{BASE_URL}/api/workspace/profiles/{profile_id}", timeout=10)
        for entity_type, entity_id in (("asset", asset_id), ("project", project_id)):
            if not entity_id:
                continue
            user.delete(f"{BASE_URL}/api/workspace/{'assets' if entity_type == 'asset' else 'projects'}/{entity_id}", timeout=10)
            response = user.get(f"{BASE_URL}/api/workspace/trash", timeout=10)
            if response.ok:
                item = next((entry for entry in response.json()["items"] if entry["entity_type"] == entity_type and entry["entity_id"] == entity_id), None)
                if item:
                    user.delete(f"{BASE_URL}/api/workspace/trash/{item['id']}", timeout=10)
        if created_user_id:
            admin.delete(f"{BASE_URL}/api/auth/users/{created_user_id}", timeout=10)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        sys.exit(1)
