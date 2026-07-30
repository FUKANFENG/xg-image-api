from __future__ import annotations

import io

from fastapi import APIRouter, Header, HTTPException, Query, Request
from fastapi.concurrency import run_in_threadpool
from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel, Field

from api.image_inputs import parse_image_edit_request, read_image_sources
from api.support import require_admin, require_identity, resolve_image_base_url
from services.account_service import account_service
from services.advanced_creative_service import advanced_creative_service
from services.auth_service import auth_service
from services.backup_service import backup_service
from services.config import config
from services.content_filter import check_request
from services.creative_workspace_service import creative_workspace_service
from services.creative_operations_service import creative_operations_service
from services.image_task_service import ImageQueueFullError, image_task_service
from services.image_storage_service import ImageStorageError, image_storage_service
from services.log_service import LoggedCall


class ImageGenerationTaskRequest(BaseModel):
    client_task_id: str = Field(..., min_length=1)
    prompt: str = Field(..., min_length=1)
    model: str = "gpt-image-2"
    size: str | None = None
    quality: str = "auto"
    project_id: str = ""
    asset_id: str = ""
    parent_version_id: str = ""
    branch_id: str = ""
    operation_type: str = "generate"
    conversation_id: str = ""
    asset_name: str = ""
    priority: int = Field(default=0, ge=-10, le=10)
    recipe_id: str = ""
    profile_id: str = ""
    profile_strength: str = ""


class ResumePollRequest(BaseModel):
    extra_timeout_secs: float = Field(default=30.0, ge=5.0, le=120.0)


class TaskPriorityRequest(BaseModel):
    priority: int = Field(default=0, ge=-10, le=10)


class BulkTaskRequest(BaseModel):
    task_ids: list[str] = Field(..., min_length=1, max_length=100)


def _parse_task_ids(value: str) -> list[str]:
    return [item.strip() for item in value.split(",") if item.strip()]


def _task_value_error_status(exc: ValueError) -> int:
    return 429 if isinstance(exc, ImageQueueFullError) or "图片额度不足" in str(exc) else 400


_PROFILE_STRENGTHS = {"strict", "balanced", "creative"}
_CANVAS_RATIOS = {"", "1:1", "4:3", "3:4", "16:9", "9:16", "free"}
_OUTPAINT_DIRECTIONS = {"left", "right", "top", "bottom"}


def _normalized_strength(value: object, *, default: str = "") -> str:
    normalized = str(value or default).strip().lower()
    if normalized and normalized not in _PROFILE_STRENGTHS:
        raise ValueError("一致性强度无效")
    return normalized


def _normalized_directions(value: object) -> list[str]:
    items = str(value or "").replace("，", ",").split(",")
    result: list[str] = []
    for item in items:
        normalized = item.strip().lower()
        if not normalized:
            continue
        if normalized not in _OUTPAINT_DIRECTIONS:
            raise ValueError("扩图方向无效")
        if normalized not in result:
            result.append(normalized)
    return result


def _image_dimensions(image: tuple[bytes, str, str]) -> tuple[int, int]:
    try:
        with Image.open(io.BytesIO(image[0])) as source:
            return source.size
    except (OSError, UnidentifiedImageError) as exc:
        raise ValueError(f"{image[1]} 不是有效图片") from exc


def _validate_mask_dimensions(
    images: list[tuple[bytes, str, str]],
    masks: list[tuple[bytes, str, str]] | None,
) -> None:
    if not images or not masks:
        return
    source_size = _image_dimensions(images[0])
    for mask in masks:
        if _image_dimensions(mask) != source_size:
            raise ValueError("蒙版尺寸必须与第一张编辑图片一致")


def _stored_reference(path: str) -> tuple[bytes, str, str]:
    normalized = str(path or "").strip()
    payload = image_storage_service.get_bytes(normalized)
    suffix = normalized.rsplit(".", 1)[-1].lower() if "." in normalized else "png"
    content_type = {"jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp"}.get(suffix, "image/png")
    return payload, normalized.rsplit("/", 1)[-1] or "reference.png", content_type


async def filter_or_log(call: LoggedCall, text: str) -> None:
    try:
        await run_in_threadpool(check_request, text)
    except HTTPException as exc:
        call.log("调用失败", status="failed", error=str(exc.detail))
        raise


async def enforce_feature(identity: dict[str, object], feature: str) -> None:
    try:
        await run_in_threadpool(creative_workspace_service.enforce_policy, identity, feature)
    except ValueError as exc:
        status_code = 429 if "频繁" in str(exc) else 403
        raise HTTPException(status_code=status_code, detail={"error": str(exc)}) from exc


def create_router() -> APIRouter:
    router = APIRouter()

    @router.get("/api/image-tasks")
    async def list_image_tasks(
        ids: str = Query(default=""),
        limit: int = Query(default=100, ge=1, le=200),
        offset: int = Query(default=0, ge=0),
        authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        return await run_in_threadpool(
            image_task_service.list_tasks,
            identity,
            _parse_task_ids(ids),
            limit=limit,
            offset=offset,
        )

    @router.get("/api/image-tasks/metrics")
    async def get_image_task_metrics(authorization: str | None = Header(default=None)):
        require_admin(authorization)
        task_metrics = await run_in_threadpool(image_task_service.metrics)
        account_metrics = await run_in_threadpool(account_service.image_runtime_health)
        users = await run_in_threadpool(auth_service.list_users)
        task_metrics["accounts"] = account_metrics
        task_metrics["user_quotas"] = {
            "users": len(users),
            "remaining": sum(max(0, int(user.get("image_quota") or 0)) for user in users),
            "used": sum(max(0, int(user.get("image_quota_used") or 0)) for user in users),
        }
        users_by_id = {str(user.get("id") or ""): user for user in users}
        task_metrics["user_rankings"] = [
            {
                **activity,
                "name": users_by_id.get(str(activity.get("owner_id") or ""), {}).get("name") or "管理员/历史用户",
                "username": users_by_id.get(str(activity.get("owner_id") or ""), {}).get("username"),
                "group": users_by_id.get(str(activity.get("owner_id") or ""), {}).get("group") or "default",
                "remaining_quota": users_by_id.get(str(activity.get("owner_id") or ""), {}).get("image_quota"),
                "used_quota": users_by_id.get(str(activity.get("owner_id") or ""), {}).get("image_quota_used"),
            }
            for activity in task_metrics.pop("user_activity", [])
        ]
        review = config.ai_review
        backup_settings = config.get_backup_settings()
        task_metrics["security"] = {
            "weak_admin_password": config.admin_password_is_weak,
            "ai_review_enabled": bool(review.get("enabled") and review.get("api_key")),
            "backup_enabled": bool(backup_settings.get("enabled")),
            "backup_last_status": backup_service.get_status().get("last_status"),
        }
        return task_metrics

    @router.get("/api/image-tasks/estimate")
    async def estimate_image_task(authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        return await run_in_threadpool(image_task_service.estimate, identity)

    @router.post("/api/image-tasks/generations")
    async def create_generation_task(
        body: ImageGenerationTaskRequest,
        request: Request,
        authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        await enforce_feature(identity, "image_generation")
        final_prompt = body.prompt
        selected_model = body.model
        if str(body.model or "").strip().lower() == "auto":
            selected_model = str(
                creative_operations_service.route_model(
                    identity,
                    mode="generate",
                    prompt=body.prompt,
                    quality=body.quality,
                )["model"]
            )
        profile: dict[str, object] | None = None
        try:
            if body.recipe_id:
                recipe = next(
                    (item for item in advanced_creative_service.list_recipes(identity) if item.get("id") == body.recipe_id),
                    None,
                )
                if recipe is None:
                    raise ValueError("recipe not found")
                recipe_settings = recipe.get("settings") if isinstance(recipe.get("settings"), dict) else {}
                recipe_prompt = str(recipe_settings.get("prompt") or "").strip()
                if recipe_prompt and recipe_prompt not in final_prompt:
                    final_prompt = f"{final_prompt}；配方要求：{recipe_prompt}"
            if body.profile_id:
                profile = advanced_creative_service.profile_prompt(
                    identity,
                    body.profile_id,
                    strength=body.profile_strength,
                )
                final_prompt = f"{final_prompt}；{profile['prompt_suffix']}"
        except ValueError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc
        await filter_or_log(
            LoggedCall(identity, "/api/image-tasks/generations", selected_model, "文生图任务", request_text=final_prompt),
            final_prompt,
        )
        try:
            task = await run_in_threadpool(
                image_task_service.submit_generation,
                identity,
                client_task_id=body.client_task_id,
                prompt=final_prompt,
                model=selected_model,
                size=body.size,
                quality=body.quality,
                base_url=resolve_image_base_url(request),
                workflow={
                    "project_id": body.project_id,
                    "asset_id": body.asset_id,
                    "parent_version_id": body.parent_version_id,
                    "branch_id": body.branch_id,
                    "operation_type": body.operation_type or "generate",
                    "conversation_id": body.conversation_id,
                    "asset_name": body.asset_name or body.prompt[:48],
                    "priority": body.priority,
                    "recipe_id": body.recipe_id,
                    "profile_id": body.profile_id,
                    "profile_strength": profile.get("applied_strength") if profile else "",
                    "profile_reference_paths": list(profile.get("reference_paths") or []) if profile else [],
                },
            )
            remaining_quota = auth_service.get_image_quota(identity)
            if remaining_quota is not None:
                task["remaining_image_quota"] = remaining_quota
            return task
        except ValueError as exc:
            raise HTTPException(status_code=_task_value_error_status(exc), detail={"error": str(exc)}) from exc

    @router.post("/api/image-tasks/edits")
    async def create_edit_task(
        request: Request,
        authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        await enforce_feature(identity, "image_edit")
        payload, image_sources, mask_sources = await parse_image_edit_request(request)
        client_task_id = str(payload.get("client_task_id") or "").strip()
        if not client_task_id:
            raise HTTPException(status_code=400, detail={"error": "client_task_id is required"})
        prompt = str(payload["prompt"])
        model = str(payload["model"])
        profile: dict[str, object] | None = None
        try:
            profile_strength = _normalized_strength(payload.get("profile_strength"))
            preserve_strength = _normalized_strength(
                payload.get("preserve_strength"),
                default="balanced",
            )
            canvas_ratio = str(payload.get("canvas_ratio") or "").strip().lower()
            if canvas_ratio not in _CANVAS_RATIOS:
                raise ValueError("扩图比例无效")
            outpaint_directions = _normalized_directions(payload.get("outpaint_directions"))
            recipe_id = str(payload.get("recipe_id") or "")
            if recipe_id:
                recipe = next(
                    (item for item in advanced_creative_service.list_recipes(identity) if item.get("id") == recipe_id),
                    None,
                )
                if recipe is None:
                    raise ValueError("recipe not found")
                settings = recipe.get("settings") if isinstance(recipe.get("settings"), dict) else {}
                recipe_prompt = str(settings.get("prompt") or "").strip()
                if recipe_prompt and recipe_prompt not in prompt:
                    prompt = f"{prompt}；配方要求：{recipe_prompt}"
            profile_id = str(payload.get("profile_id") or "")
            if profile_id:
                profile = advanced_creative_service.profile_prompt(
                    identity,
                    profile_id,
                    strength=profile_strength,
                )
                prompt = f"{prompt}；{profile['prompt_suffix']}"
        except ValueError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc
        await filter_or_log(LoggedCall(identity, "/api/image-tasks/edits", model, "图生图任务", request_text=prompt), prompt)
        images = await read_image_sources(image_sources)
        if profile and str(payload.get("profile_reference_included") or "").strip().lower() not in {"1", "true", "yes"}:
            reference_paths = list(profile.get("reference_paths") or [])
            images.extend(await run_in_threadpool(lambda: [_stored_reference(path) for path in reference_paths]))
        masks = await read_image_sources(mask_sources) if mask_sources else None
        if model.strip().lower() == "auto":
            model = str(
                creative_operations_service.route_model(
                    identity,
                    mode="edit",
                    prompt=prompt,
                    reference_count=len(images),
                    has_mask=bool(masks),
                    quality=str(payload.get("quality") or "auto"),
                )["model"]
            )
        try:
            _validate_mask_dimensions(images, masks)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc
        source_path = str(payload.get("source_path") or "").strip()
        if not source_path and images:
            try:
                stored_source = await run_in_threadpool(
                    image_storage_service.save,
                    images[0][0],
                    resolve_image_base_url(request),
                    images[0][1].rsplit(".", 1)[-1] if "." in images[0][1] else "png",
                )
                source_path = stored_source.rel
            except ImageStorageError:
                # Preserve the original edit API contract: the upstream image
                # handler remains responsible for rejecting malformed payloads.
                source_path = ""
        mask_paths: list[str] = []
        for mask in masks or []:
            try:
                stored_mask = await run_in_threadpool(
                    image_storage_service.save,
                    mask[0],
                    resolve_image_base_url(request),
                    mask[1].rsplit(".", 1)[-1] if "." in mask[1] else "png",
                )
                mask_paths.append(stored_mask.rel)
            except ImageStorageError:
                mask_paths = []
                break
        try:
            task = await run_in_threadpool(
                image_task_service.submit_edit,
                identity,
                client_task_id=client_task_id,
                prompt=prompt,
                model=model,
                size=payload["size"],
                quality=payload["quality"],
                base_url=resolve_image_base_url(request),
                images=images,
                masks=masks,
                workflow={
                    "project_id": str(payload.get("project_id") or ""),
                    "asset_id": str(payload.get("asset_id") or ""),
                    "parent_version_id": str(payload.get("parent_version_id") or ""),
                    "branch_id": str(payload.get("branch_id") or ""),
                    "operation_type": str(payload.get("operation_type") or "edit"),
                    "conversation_id": str(payload.get("conversation_id") or ""),
                    "source_path": source_path,
                    "source_paths": [source_path] if source_path else [],
                    "mask_path": mask_paths[0] if mask_paths else "",
                    "mask_paths": mask_paths,
                    "source_name": images[0][1] if images else "",
                    "asset_name": str(payload.get("asset_name") or (images[0][1] if images else "")),
                    "priority": int(payload.get("priority") or 0),
                    "recipe_id": str(payload.get("recipe_id") or ""),
                    "profile_id": str(payload.get("profile_id") or ""),
                    "profile_strength": profile.get("applied_strength") if profile else profile_strength,
                    "profile_reference_paths": list(profile.get("reference_paths") or []) if profile else [],
                    "canvas_ratio": canvas_ratio,
                    "outpaint_directions": outpaint_directions,
                    "preserve_strength": preserve_strength,
                },
            )
            remaining_quota = auth_service.get_image_quota(identity)
            if remaining_quota is not None:
                task["remaining_image_quota"] = remaining_quota
            return task
        except ValueError as exc:
            raise HTTPException(status_code=_task_value_error_status(exc), detail={"error": str(exc)}) from exc

    @router.post("/api/image-tasks/{task_id}/resume-poll")
    async def resume_image_poll(
        task_id: str,
        body: ResumePollRequest,
        request: Request,
        authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        try:
            return await run_in_threadpool(
                image_task_service.resume_poll,
                identity,
                task_id,
                body.extra_timeout_secs,
            )
        except ValueError as exc:
            raise HTTPException(status_code=_task_value_error_status(exc), detail={"error": str(exc)}) from exc

    async def retry_task(identity: dict[str, object], task_id: str, request: Request) -> dict[str, object]:
        current = (
            await run_in_threadpool(image_task_service.get_task, identity, task_id)
            if hasattr(image_task_service, "get_task")
            else {"mode": "generate"}
        )
        if current.get("mode") == "edit":
            workflow = current.get("workflow") if isinstance(current.get("workflow"), dict) else {}
            source_paths = workflow.get("source_paths")
            if not isinstance(source_paths, list):
                source_paths = [workflow.get("source_path")]
            mask_paths = workflow.get("mask_paths")
            if not isinstance(mask_paths, list):
                mask_paths = [workflow.get("mask_path")]
            images = await run_in_threadpool(
                lambda: [_stored_reference(str(path)) for path in source_paths if str(path or "").strip()]
            )
            masks = await run_in_threadpool(
                lambda: [_stored_reference(str(path)) for path in mask_paths if str(path or "").strip()]
            )
            if not images:
                raise ValueError("历史编辑任务的源图已不存在，请重新上传图片")
            return await run_in_threadpool(
                image_task_service.retry_edit,
                identity,
                task_id,
                base_url=resolve_image_base_url(request),
                images=images,
                masks=masks,
            )
        return await run_in_threadpool(
            image_task_service.retry_generation,
            identity,
            task_id,
            base_url=resolve_image_base_url(request),
        )

    @router.post("/api/image-tasks/{task_id}/retry")
    async def retry_image_task(
        task_id: str,
        request: Request,
        authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        await enforce_feature(identity, "image_generation")
        try:
            task = await retry_task(identity, task_id, request)
            remaining_quota = auth_service.get_image_quota(identity)
            if remaining_quota is not None:
                task["remaining_image_quota"] = remaining_quota
            await run_in_threadpool(
                advanced_creative_service.audit,
                identity,
                "queue.retry",
                entity_type="task",
                entity_id=task_id,
            )
            return task
        except ValueError as exc:
            status_code = 429 if "图片额度不足" in str(exc) else 400
            raise HTTPException(status_code=status_code, detail={"error": str(exc)}) from exc

    @router.post("/api/image-tasks/bulk-retry")
    async def bulk_retry_image_tasks(
        body: BulkTaskRequest,
        request: Request,
        authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        await enforce_feature(identity, "image_generation")
        items: list[dict[str, object]] = []
        errors: list[dict[str, str]] = []
        for task_id in dict.fromkeys(body.task_ids):
            try:
                items.append(await retry_task(identity, task_id, request))
            except (ValueError, ImageStorageError) as exc:
                errors.append({"task_id": task_id, "error": str(exc)})
        await run_in_threadpool(
            advanced_creative_service.audit,
            identity,
            "queue.bulk_retry",
            entity_type="task",
            details={"requested": len(body.task_ids), "submitted": len(items), "failed": len(errors)},
        )
        return {"items": items, "errors": errors}

    @router.post("/api/image-tasks/{task_id}/cancel")
    async def cancel_image_task(
        task_id: str,
        authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        try:
            task = await run_in_threadpool(image_task_service.cancel_task, identity, task_id)
            remaining_quota = auth_service.get_image_quota(identity)
            if remaining_quota is not None:
                task["remaining_image_quota"] = remaining_quota
            return task
        except ValueError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc

    @router.post("/api/image-tasks/{task_id}/pause")
    async def pause_image_task(task_id: str, authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        try:
            task = await run_in_threadpool(image_task_service.pause_task, identity, task_id)
            await run_in_threadpool(advanced_creative_service.audit, identity, "queue.pause", entity_type="task", entity_id=task_id)
            return task
        except ValueError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc

    @router.post("/api/image-tasks/{task_id}/resume")
    async def resume_paused_image_task(task_id: str, authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        try:
            task = await run_in_threadpool(image_task_service.resume_task, identity, task_id)
            await run_in_threadpool(advanced_creative_service.audit, identity, "queue.resume", entity_type="task", entity_id=task_id)
            return task
        except ValueError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc

    @router.put("/api/image-tasks/{task_id}/priority")
    async def update_image_task_priority(
        task_id: str,
        body: TaskPriorityRequest,
        authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        try:
            task = await run_in_threadpool(image_task_service.set_task_priority, identity, task_id, body.priority)
            await run_in_threadpool(
                advanced_creative_service.audit,
                identity,
                "queue.priority",
                entity_type="task",
                entity_id=task_id,
                details={"priority": body.priority},
            )
            return task
        except ValueError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc

    @router.get("/api/image-tasks/admin/queue")
    async def list_admin_image_queue(
        limit: int = Query(default=300, ge=1, le=2000),
        authorization: str | None = Header(default=None),
    ):
        require_admin(authorization)
        return {"items": await run_in_threadpool(image_task_service.list_admin_tasks, limit)}

    @router.get("/api/image-tasks/admin/overview")
    async def list_admin_image_task_overview(
        limit: int = Query(default=40, ge=1, le=200),
        offset: int = Query(default=0, ge=0),
        status: str = Query(default="", max_length=20),
        source: str = Query(default="", max_length=20),
        mode: str = Query(default="", max_length=20),
        query: str = Query(default="", max_length=200),
        authorization: str | None = Header(default=None),
    ):
        require_admin(authorization)
        return await run_in_threadpool(
            image_task_service.list_admin_task_page,
            limit=limit,
            offset=offset,
            status=status,
            source=source,
            mode=mode,
            query=query,
        )

    @router.delete("/api/image-tasks/{task_id}")
    async def delete_failed_image_task(
        task_id: str,
        authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        try:
            return await run_in_threadpool(image_task_service.delete_failed_task, identity, task_id)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc

    return router
