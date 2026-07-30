from __future__ import annotations

import io
import json
import mimetypes
import uuid
from typing import Literal

from fastapi import APIRouter, File, Form, Header, HTTPException, Query, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from api.image_inputs import IMAGE_REFERENCE_FIELDS, read_image_sources
from api.support import require_admin, require_identity, resolve_image_base_url
from services.auth_service import auth_service
from services.advanced_creative_service import advanced_creative_service
from services.content_filter import check_request
from services.creative_intelligence_service import (
    DERIVATIVE_PRESETS,
    creative_intelligence_service,
)
from services.creative_workspace_service import creative_workspace_service
from services.image_service import download_images_zip
from services.image_integrity_service import image_integrity_service
from services.image_storage_service import image_storage_service
from services.image_task_service import ImageQueueFullError, image_task_service
from services.image_prompt_reverse_service import (
    ImagePromptReverseError,
    reverse_image_prompt,
)
from services.image_tool_service import process_local_image


RESTORE_MODE_INSTRUCTIONS = {
    "general": "均衡修复清晰度、纹理、曝光和色彩，保持自然观感。",
    "portrait": "重点恢复眼睛、发丝、服装等人像细节，严格保持人物身份与真实肤质，避免磨皮和改脸。",
    "old_photo": "清理划痕、折痕、霉点、褪色和局部缺损，尊重原始年代质感。",
    "product": "恢复商品轮廓、材质、包装和标签细节，保持颜色、比例、文字与品牌元素准确。",
    "text": "恢复截图、文档和界面中的文字边缘与图形线条，保持文字内容、排版和位置一致。",
    "denoise": "去除噪点、压缩色块、轻微运动模糊和重影，恢复真实边缘，避免光晕。",
}
RESTORE_STRENGTH_INSTRUCTIONS = {
    "natural": "采用轻度增强，优先保持原始颗粒、质感和细节。",
    "standard": "采用均衡增强，在清晰度提升与原图一致性之间取得平衡。",
    "strong": "采用较强的去噪、去模糊与细节恢复，同时保持构图、人物和文字不变。",
}
BASE_RESTORE_PROMPT = (
    "对上传图片进行高清修复和智能放大。严格保持原始人物身份、面部特征、表情、姿态、服装、构图、"
    "文字内容与位置、主体数量和色彩关系，不增加或删除任何主体。去除模糊、压缩噪点、锯齿、色块和"
    "轻微瑕疵，恢复自然纹理、清晰边缘与真实细节，避免过度锐化、塑料皮肤和风格化重绘。"
)

AI_TOOL_PROMPTS = {
    "cutout": "精准识别并保留主要主体，移除整个背景，输出边缘干净、发丝和半透明细节自然的透明背景 PNG。不得改变主体本身。",
    "remove_object": "移除用户指定的对象或水印，并根据周围纹理、光影和透视自然补全区域。保持其他主体、文字和构图不变。",
    "outpaint": "在用户指定方向智能扩展画布，延续原图的场景、光影、透视、质感和风格，保持原图区域不变且接缝自然。",
    "id_photo": "保持人物身份、五官、发型、服装和真实肤质不变，将证件照背景替换为用户指定的纯色，边缘自然、光线均匀。",
    "colorize": "为黑白或褪色老照片自然上色，参考时代、材质和真实肤色，修复轻微褪色但不改变人物身份、构图和历史质感。",
    "face_restore": "仅修复人脸区域的模糊、噪点和压缩损伤，恢复自然五官与皮肤纹理，严格保持人物身份、表情、年龄和构图。",
}


def _clean(value: object, default: str = "") -> str:
    text = str(value if value is not None else default).strip()
    return text or default


def _build_restore_prompt(mode: str, strength: str) -> str:
    safe_mode = mode if mode in RESTORE_MODE_INSTRUCTIONS else "general"
    safe_strength = strength if strength in RESTORE_STRENGTH_INSTRUCTIONS else "standard"
    return (
        f"[XG_HD_RESTORE mode={safe_mode} strength={safe_strength}] {BASE_RESTORE_PROMPT} "
        f"{RESTORE_MODE_INSTRUCTIONS[safe_mode]} {RESTORE_STRENGTH_INSTRUCTIONS[safe_strength]}"
    )


def _task_error_status(exc: ValueError) -> int:
    message = str(exc)
    return 429 if isinstance(exc, ImageQueueFullError) or "额度不足" in message or "频繁" in message else 400


async def _enforce_feature(identity: dict[str, object], feature: str) -> None:
    try:
        await run_in_threadpool(creative_workspace_service.enforce_policy, identity, feature)
    except ValueError as exc:
        status_code = 429 if "频繁" in str(exc) else 403
        raise HTTPException(status_code=status_code, detail={"error": str(exc)}) from exc


def _creation_context(
    identity: dict[str, object],
    prompt: str,
    recipe_id: str = "",
    profile_id: str = "",
) -> tuple[str, dict[str, object] | None, dict[str, object] | None]:
    recipe = None
    if _clean(recipe_id):
        recipe = next(
            (item for item in advanced_creative_service.list_recipes(identity) if item.get("id") == _clean(recipe_id)),
            None,
        )
        if recipe is None:
            raise ValueError("recipe not found")
    profile = advanced_creative_service.profile_prompt(identity, profile_id) if _clean(profile_id) else None
    parts = [_clean(prompt)]
    if recipe:
        recipe_prompt = _clean((recipe.get("settings") or {}).get("prompt"))
        if recipe_prompt and recipe_prompt not in parts[0]:
            parts.append(f"配方要求：{recipe_prompt}")
    if profile:
        parts.append(_clean(profile.get("prompt_suffix")))
    return "；".join(item for item in parts if item), recipe, profile


def _stored_reference(path: str) -> tuple[bytes, str, str]:
    normalized = _clean(path)
    payload = image_storage_service.get_bytes(normalized)
    content_type = mimetypes.guess_type(normalized)[0] or "image/png"
    return payload, normalized.rsplit("/", 1)[-1] or "reference.png", content_type


def _owned_asset_reference(
    identity: dict[str, object],
    asset_id: str,
    version_id: str = "",
) -> tuple[bytes, str, str]:
    asset = creative_workspace_service.get_asset(identity, _clean(asset_id))
    versions = asset.get("versions") if isinstance(asset.get("versions"), list) else []
    selected = next(
        (
            item
            for item in versions
            if isinstance(item, dict)
            and _clean(item.get("id"))
            == (_clean(version_id) or _clean(asset.get("current_version_id")))
        ),
        None,
    )
    if not isinstance(selected, dict):
        raise ValueError("作品缺少可分析的图片版本")
    path = _clean(selected.get("image_path"))
    if not path:
        raise ValueError("作品图片尚未保存到本地")
    return _stored_reference(path)


class BatchGenerationRequest(BaseModel):
    prompt: str = ""
    prompts: list[str] = Field(default_factory=list, max_length=50)
    count: int = Field(default=1, ge=1, le=50)
    name: str = ""
    model: str = "gpt-image-2"
    size: str | None = None
    quality: str = "auto"
    project_id: str = ""
    recipe_id: str = ""
    profile_id: str = ""
    priority: int = Field(default=0, ge=-10, le=10)


class ProjectCreateRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=80)
    description: str = Field(default="", max_length=500)
    tags: list[str] = Field(default_factory=list, max_length=20)


class ProjectUpdateRequest(BaseModel):
    name: str | None = Field(default=None, max_length=80)
    description: str | None = Field(default=None, max_length=500)
    favorite: bool | None = None
    tags: list[str] | None = Field(default=None, max_length=20)


class AssetUpdateRequest(BaseModel):
    name: str | None = Field(default=None, max_length=120)
    project_id: str | None = None
    favorite: bool | None = None
    tags: list[str] | None = Field(default=None, max_length=20)


class AssetCreateRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    asset_type: str = Field(default="image", max_length=24)
    project_id: str = ""
    image_path: str = ""
    image_url: str = ""
    prompt: str = ""
    tags: list[str] = Field(default_factory=list, max_length=20)
    metadata: dict[str, object] = Field(default_factory=dict)


class AssetBulkArchiveRequest(BaseModel):
    asset_ids: list[str] = Field(..., min_length=1, max_length=100)
    project_id: str | None = None


class DuplicateDetectionRequest(BaseModel):
    threshold: int = Field(default=8, ge=0, le=16)
    limit: int = Field(default=200, ge=2, le=500)


class ConversationCreateRequest(BaseModel):
    title: str = Field(default="", max_length=100)


class ConversationMessageRequest(BaseModel):
    instruction: str = Field(..., min_length=1, max_length=2000)
    model: str = "gpt-image-2"
    size: str | None = None
    quality: str = "auto"


class PolicyUpdateRequest(BaseModel):
    subject_type: Literal["user", "group"] = "user"
    features: dict[str, bool] = Field(default_factory=dict)
    rate_limit_per_minute: int = Field(default=0, ge=0, le=600)
    frozen: bool = False
    abnormal_reason: str = Field(default="", max_length=300)


class BatchQuotaRequest(BaseModel):
    user_ids: list[str] = Field(..., min_length=1, max_length=200)
    mode: Literal["set", "add"] = "add"
    amount: int = Field(..., ge=0, le=100000)


class RecipeCreateRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=80)
    category: str = Field(default="custom", max_length=40)
    description: str = Field(default="", max_length=300)
    settings: dict[str, object] = Field(default_factory=dict)
    scope_type: Literal["private", "group", "global"] = "private"
    scope_id: str = Field(default="", max_length=80)


class ShareCreateRequest(BaseModel):
    version_id: str = ""
    expires_days: int = Field(default=7, ge=1, le=365)


class ReviewCreateRequest(BaseModel):
    version_id: str = Field(..., min_length=1)


class ReviewResolveRequest(BaseModel):
    status: Literal["approved", "rejected"]
    comment: str = Field(default="", max_length=1000)


class AssetIntelligenceRequest(BaseModel):
    version_id: str = Field(default="", max_length=64)


class RankAssetsRequest(BaseModel):
    asset_ids: list[str] = Field(..., min_length=1, max_length=200)


class DerivativeCreateRequest(BaseModel):
    version_id: str = Field(default="", max_length=64)
    presets: list[Literal["xiaohongshu", "ecommerce", "wechat", "poster"]] = Field(
        default_factory=lambda: list(DERIVATIVE_PRESETS)
    )
    mode: Literal["cover", "contain"] = "contain"


class BranchCreateRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=80)
    root_version_id: str = Field(default="", max_length=64)
    metadata: dict[str, object] = Field(default_factory=dict)


class BoardCreateRequest(BaseModel):
    name: str = Field(default="未命名画板", max_length=80)
    description: str = Field(default="", max_length=500)
    project_id: str = Field(default="", max_length=64)


class BoardUpdateRequest(BaseModel):
    name: str | None = Field(default=None, max_length=80)
    description: str | None = Field(default=None, max_length=500)
    project_id: str | None = Field(default=None, max_length=64)


class BoardItemCreateRequest(BaseModel):
    item_type: Literal["image", "reference", "text", "color"] = "text"
    content: str = Field(default="", max_length=4000)
    image_path: str = Field(default="", max_length=500)
    image_url: str = Field(default="", max_length=2000)
    x: float = Field(default=40, ge=-5000, le=5000)
    y: float = Field(default=40, ge=-5000, le=5000)
    width: float = Field(default=240, ge=80, le=1600)
    height: float = Field(default=180, ge=60, le=1200)
    z_index: int = Field(default=0, ge=-1000, le=1000)
    metadata: dict[str, object] = Field(default_factory=dict)


class BoardItemUpdateRequest(BaseModel):
    content: str | None = Field(default=None, max_length=4000)
    x: float | None = Field(default=None, ge=-5000, le=5000)
    y: float | None = Field(default=None, ge=-5000, le=5000)
    width: float | None = Field(default=None, ge=80, le=1600)
    height: float | None = Field(default=None, ge=60, le=1200)
    z_index: int | None = Field(default=None, ge=-1000, le=1000)
    metadata: dict[str, object] | None = None


class NotificationSettingsRequest(BaseModel):
    in_app: bool | None = None
    browser: bool | None = None
    email: bool | None = None
    email_to: str | None = Field(default=None, max_length=320)
    webhook: bool | None = None
    webhook_url: str | None = Field(default=None, max_length=1000)
    wecom: bool | None = None
    wecom_url: str | None = Field(default=None, max_length=1000)
    events: list[Literal["task.success", "task.failed", "batch.completed", "budget.warning", "storage.missing"]] | None = None


class BudgetUpdateRequest(BaseModel):
    owner_id: str = Field(..., min_length=1, max_length=120)
    credit_limit: int = Field(..., ge=0, le=10_000_000)
    budget_type: Literal["project", "department", "client"] = "project"
    label: str = Field(default="", max_length=120)
    warning_percent: int = Field(default=80, ge=1, le=100)
    unit_cost: float = Field(default=0, ge=0, le=1_000_000)
    enabled: bool = True


def _enrich_batch(identity: dict[str, object], batch_id: str) -> dict[str, object]:
    record = creative_workspace_service.get_batch_record(identity, batch_id)
    task_ids = [_clean(item.get("task_id")) for item in record["items"] if _clean(item.get("task_id"))]
    task_response = image_task_service.list_tasks(identity, task_ids)
    task_map = {str(item.get("id") or ""): item for item in task_response["items"]}
    counts = {"queued": 0, "paused": 0, "running": 0, "success": 0, "error": 0, "cancelled": 0, "total": 0}
    items = []
    for item in record["items"]:
        task = task_map.get(_clean(item.get("task_id")))
        if task is None:
            task = {
                "id": item.get("task_id"),
                "status": "error",
                "error": item.get("submit_error") or "任务记录不存在",
                "error_code": "batch_submit_failed" if item.get("submit_error") else "task_missing",
            }
        status = _clean(task.get("status"), "error")
        if status == "error" and task.get("error_code") == "cancelled_by_user":
            counts["cancelled"] += 1
        elif status in counts:
            counts[status] += 1
        else:
            counts["error"] += 1
        counts["total"] += 1
        items.append({**item, "task": task})
    record["items"] = items
    record["counts"] = counts
    record["completed"] = counts["success"] + counts["error"] + counts["cancelled"] == counts["total"]
    return record


def create_router() -> APIRouter:
    router = APIRouter()

    @router.post("/api/workspace/batches/generations")
    async def create_generation_batch(
        body: BatchGenerationRequest,
        request: Request,
        authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        await _enforce_feature(identity, "batch")
        await _enforce_feature(identity, "image_generation")
        supplied = [_clean(item) for item in body.prompts if _clean(item)]
        if supplied:
            prompts = supplied
        else:
            prompt = _clean(body.prompt)
            if not prompt:
                raise HTTPException(status_code=400, detail={"error": "请填写提示词"})
            prompts = [prompt] * body.count
        if len(prompts) > 50:
            raise HTTPException(status_code=400, detail={"error": "单个批次最多 50 个任务"})
        try:
            prepared = [_creation_context(identity, prompt, body.recipe_id, body.profile_id) for prompt in prompts]
        except ValueError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc
        profile = prepared[0][2] if prepared else None
        profile_paths = list(profile.get("reference_paths") or []) if profile else []
        profile_references = await run_in_threadpool(
            lambda: [_stored_reference(path) for path in profile_paths]
        ) if profile_paths else []
        batch = await run_in_threadpool(
            creative_workspace_service.create_batch,
            identity,
            mode="generate",
            name=body.name or f"批量生图 · {len(prompts)} 张",
            settings={
                "model": body.model,
                "size": body.size or "",
                "quality": body.quality,
                "project_id": body.project_id,
                "recipe_id": body.recipe_id,
                "profile_id": body.profile_id,
                "priority": body.priority,
            },
        )
        base_url = resolve_image_base_url(request)
        for index, (prompt, context) in enumerate(zip(prompts, prepared, strict=True)):
            final_prompt = context[0]
            task_id = f"batch-{batch['id'][:12]}-{index + 1}-{uuid.uuid4().hex[:8]}"
            submit_error = ""
            try:
                await run_in_threadpool(check_request, final_prompt)
                workflow = {
                    "batch_id": batch["id"],
                    "project_id": body.project_id,
                    "operation_type": "profile_generate" if profile_references else "generate",
                    "asset_name": prompt[:48],
                    "recipe_id": body.recipe_id,
                    "profile_id": body.profile_id,
                    "profile_reference_paths": profile_paths,
                    "source_paths": profile_paths,
                    "source_path": profile_paths[0] if profile_paths else "",
                    "priority": body.priority,
                }
                if profile_references:
                    await run_in_threadpool(
                        image_task_service.submit_edit,
                        identity,
                        client_task_id=task_id,
                        prompt=final_prompt,
                        model=body.model,
                        size=body.size,
                        quality=body.quality,
                        base_url=base_url,
                        images=profile_references,
                        masks=None,
                        workflow=workflow,
                    )
                else:
                    await run_in_threadpool(
                        image_task_service.submit_generation,
                        identity,
                        client_task_id=task_id,
                        prompt=final_prompt,
                        model=body.model,
                        size=body.size,
                        quality=body.quality,
                        base_url=base_url,
                        workflow=workflow,
                    )
            except Exception as exc:
                submit_error = str(getattr(exc, "detail", "") or exc)
            await run_in_threadpool(
                creative_workspace_service.add_batch_item,
                identity,
                str(batch["id"]),
                task_id=task_id,
                prompt=final_prompt,
                params={"model": body.model, "size": body.size or "", "quality": body.quality,
                        "recipe_id": body.recipe_id, "profile_id": body.profile_id, "priority": body.priority},
                submit_error=submit_error,
            )
        return await run_in_threadpool(_enrich_batch, identity, str(batch["id"]))

    @router.post("/api/workspace/batches/restorations")
    async def create_restoration_batch(
        request: Request,
        authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        await _enforce_feature(identity, "batch")
        await _enforce_feature(identity, "image_edit")
        form = await request.form()
        mode = _clean(form.get("mode"), "general")
        strength = _clean(form.get("strength"), "standard")
        if mode not in RESTORE_MODE_INSTRUCTIONS or strength not in RESTORE_STRENGTH_INSTRUCTIONS:
            raise HTTPException(status_code=400, detail={"error": "修复模式或强度无效"})
        sources = [value for key, value in form.multi_items() if key in IMAGE_REFERENCE_FIELDS]
        if not sources:
            raise HTTPException(status_code=400, detail={"error": "请至少上传一张图片"})
        if len(sources) > 30:
            raise HTTPException(status_code=400, detail={"error": "单个修复批次最多 30 张图片"})
        images = await read_image_sources(sources)
        model = _clean(form.get("model"), "gpt-image-2")
        size = _clean(form.get("size")) or None
        quality = _clean(form.get("quality"), "auto")
        project_id = _clean(form.get("project_id"))
        batch_name = _clean(form.get("name")) or f"批量修复 · {len(images)} 张"
        prompt = _build_restore_prompt(mode, strength)
        batch = await run_in_threadpool(
            creative_workspace_service.create_batch,
            identity,
            mode="restore",
            name=batch_name,
            settings={
                "mode": mode,
                "strength": strength,
                "model": model,
                "size": size or "",
                "quality": quality,
                "project_id": project_id,
            },
        )
        base_url = resolve_image_base_url(request)
        for index, image in enumerate(images):
            payload, filename, mime_type = image
            stored = await run_in_threadpool(
                image_storage_service.save,
                payload,
                base_url,
                filename.rsplit(".", 1)[-1] if "." in filename else "png",
            )
            task_id = f"restore-{batch['id'][:12]}-{index + 1}-{uuid.uuid4().hex[:8]}"
            submit_error = ""
            try:
                await run_in_threadpool(
                    image_task_service.submit_edit,
                    identity,
                    client_task_id=task_id,
                    prompt=prompt,
                    model=model,
                    size=size,
                    quality=quality,
                    base_url=base_url,
                    images=[(payload, filename, mime_type)],
                    workflow={
                        "batch_id": batch["id"],
                        "project_id": project_id,
                        "operation_type": "restore",
                        "source_path": stored.rel,
                        "source_name": filename,
                        "asset_name": filename.rsplit(".", 1)[0],
                        "params": {"restore_mode": mode, "restore_strength": strength},
                    },
                )
            except Exception as exc:
                submit_error = str(getattr(exc, "detail", "") or exc)
            await run_in_threadpool(
                creative_workspace_service.add_batch_item,
                identity,
                str(batch["id"]),
                task_id=task_id,
                source_name=filename,
                source_path=stored.rel,
                prompt=prompt,
                params={
                    "model": model,
                    "size": size or "",
                    "quality": quality,
                    "mode": mode,
                    "strength": strength,
                },
                submit_error=submit_error,
            )
        return await run_in_threadpool(_enrich_batch, identity, str(batch["id"]))

    @router.get("/api/workspace/batches")
    async def list_batches(
        limit: int = Query(default=30, ge=1, le=100),
        authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        records = await run_in_threadpool(creative_workspace_service.list_batches, identity, limit)
        return {"items": records}

    @router.get("/api/workspace/batches/{batch_id}")
    async def get_batch(batch_id: str, authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        try:
            return await run_in_threadpool(_enrich_batch, identity, batch_id)
        except ValueError as exc:
            raise HTTPException(status_code=404, detail={"error": str(exc)}) from exc

    @router.delete("/api/workspace/batches/{batch_id}")
    async def delete_batch(batch_id: str, authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        removed = await run_in_threadpool(creative_workspace_service.delete_batch, identity, batch_id)
        if not removed:
            raise HTTPException(status_code=404, detail={"error": "batch not found"})
        return {"ok": True}

    @router.get("/api/workspace/batches/{batch_id}/download")
    async def download_batch(batch_id: str, authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        try:
            paths = await run_in_threadpool(creative_workspace_service.batch_result_paths, identity, batch_id)
            archive = await run_in_threadpool(download_images_zip, paths)
        except ValueError as exc:
            raise HTTPException(status_code=404, detail={"error": str(exc)}) from exc
        return StreamingResponse(
            archive,
            media_type="application/zip",
            headers={"Content-Disposition": f'attachment; filename="xg-batch-{batch_id[:12]}.zip"'},
        )

    @router.post("/api/workspace/batches/{batch_id}/items/{item_id}/retry")
    async def retry_batch_item(
        batch_id: str,
        item_id: str,
        request: Request,
        authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        try:
            batch = await run_in_threadpool(creative_workspace_service.get_batch_record, identity, batch_id)
            item = await run_in_threadpool(creative_workspace_service.get_batch_item, identity, batch_id, item_id)
            task_id = _clean(item.get("task_id"))
            existing = await run_in_threadpool(image_task_service.list_tasks, identity, [task_id])
            current = existing["items"][0] if existing["items"] else None
            if current is not None and current.get("status") != "error":
                raise ValueError("只有失败任务可以重试")
            params = item.get("params") if isinstance(item.get("params"), dict) else {}
            workflow = {
                "batch_id": batch_id,
                "project_id": _clean(batch["settings"].get("project_id")),
                "operation_type": "generate" if batch["mode"] == "generate" else "restore",
                "source_path": _clean(item.get("source_path")),
                "source_name": _clean(item.get("source_name")),
                "asset_name": (_clean(item.get("source_name")) or _clean(item.get("prompt"))[:48]),
                "params": {
                    "restore_mode": _clean(params.get("mode")),
                    "restore_strength": _clean(params.get("strength")),
                },
            }
            base_url = resolve_image_base_url(request)
            if batch["mode"] == "generate":
                if current is not None:
                    await run_in_threadpool(
                        image_task_service.retry_generation,
                        identity,
                        task_id,
                        base_url=base_url,
                    )
                else:
                    await run_in_threadpool(check_request, _clean(item.get("prompt")))
                    await run_in_threadpool(
                        image_task_service.submit_generation,
                        identity,
                        client_task_id=task_id,
                        prompt=_clean(item.get("prompt")),
                        model=_clean(params.get("model"), "gpt-image-2"),
                        size=_clean(params.get("size")) or None,
                        quality=_clean(params.get("quality"), "auto"),
                        base_url=base_url,
                        workflow=workflow,
                    )
            else:
                source_path = _clean(item.get("source_path"))
                payload = await run_in_threadpool(image_storage_service.get_bytes, source_path)
                filename = _clean(item.get("source_name"), "source.png")
                mime_type = mimetypes.guess_type(filename)[0] or "image/png"
                image_input = [(payload, filename, mime_type)]
                if current is not None:
                    await run_in_threadpool(
                        image_task_service.retry_edit,
                        identity,
                        task_id,
                        base_url=base_url,
                        images=image_input,
                    )
                else:
                    await run_in_threadpool(
                        image_task_service.submit_edit,
                        identity,
                        client_task_id=task_id,
                        prompt=_clean(item.get("prompt")),
                        model=_clean(params.get("model"), "gpt-image-2"),
                        size=_clean(params.get("size")) or None,
                        quality=_clean(params.get("quality"), "auto"),
                        base_url=base_url,
                        images=image_input,
                        workflow=workflow,
                    )
            await run_in_threadpool(
                creative_workspace_service.clear_batch_item_error,
                identity,
                batch_id,
                item_id,
            )
            return await run_in_threadpool(_enrich_batch, identity, batch_id)
        except ValueError as exc:
            raise HTTPException(status_code=_task_error_status(exc), detail={"error": str(exc)}) from exc

    @router.post("/api/workspace/projects")
    async def create_project(body: ProjectCreateRequest, authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        try:
            return await run_in_threadpool(
                creative_workspace_service.create_project,
                identity,
                name=body.name,
                description=body.description,
                tags=body.tags,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc

    @router.get("/api/workspace/projects")
    async def list_projects(
        query: str = "",
        tag: str = "",
        favorite: bool | None = None,
        authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        items = await run_in_threadpool(
            creative_workspace_service.list_projects,
            identity,
            query=query,
            tag=tag,
            favorite=favorite,
        )
        return {"items": items}

    @router.patch("/api/workspace/projects/{project_id}")
    async def update_project(
        project_id: str,
        body: ProjectUpdateRequest,
        authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        try:
            return await run_in_threadpool(
                creative_workspace_service.update_project,
                identity,
                project_id,
                body.model_dump(exclude_unset=True),
            )
        except ValueError as exc:
            raise HTTPException(status_code=404, detail={"error": str(exc)}) from exc

    @router.delete("/api/workspace/projects/{project_id}")
    async def delete_project(project_id: str, authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        removed = await run_in_threadpool(creative_workspace_service.delete_project, identity, project_id)
        if not removed:
            raise HTTPException(status_code=404, detail={"error": "project not found"})
        return {"ok": True}

    @router.get("/api/workspace/assets")
    async def list_assets(
        project_id: str | None = None,
        asset_type: str = "",
        query: str = "",
        tag: str = "",
        favorite: bool | None = None,
        limit: int = Query(default=100, ge=1, le=200),
        offset: int = Query(default=0, ge=0),
        authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        items = await run_in_threadpool(
            creative_workspace_service.list_assets_page,
            identity,
            project_id=project_id,
            asset_type=asset_type,
            query=query,
            tag=tag,
            favorite=favorite,
            limit=limit,
            offset=offset,
        )
        return items

    @router.post("/api/workspace/assets")
    async def archive_asset(body: AssetCreateRequest, authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        if body.image_path and not await run_in_threadpool(image_storage_service.exists, body.image_path):
            raise HTTPException(status_code=404, detail={"error": "image not found"})
        try:
            return await run_in_threadpool(
                creative_workspace_service.archive_asset,
                identity,
                name=body.name,
                asset_type=body.asset_type,
                project_id=body.project_id,
                image_path=body.image_path,
                image_url=body.image_url,
                prompt=body.prompt,
                tags=body.tags,
                metadata=body.metadata,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc

    @router.get("/api/workspace/assets/integrity")
    async def inspect_asset_integrity(
        force: bool = False,
        include_all: bool = False,
        authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        if include_all and _clean(identity.get("role")).lower() != "admin":
            raise HTTPException(status_code=403, detail={"error": "admin permission required"})
        return await run_in_threadpool(
            image_integrity_service.scan,
            identity,
            include_all=include_all,
            force=force,
        )

    @router.post("/api/workspace/assets/integrity/repair")
    async def repair_asset_integrity(
        include_all: bool = False,
        authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        if include_all and _clean(identity.get("role")).lower() != "admin":
            raise HTTPException(status_code=403, detail={"error": "admin permission required"})
        result = await run_in_threadpool(
            image_integrity_service.repair,
            identity,
            include_all=include_all,
        )
        await run_in_threadpool(
            advanced_creative_service.audit,
            identity,
            "asset.integrity_repair",
            entity_type="asset",
            details={
                "restored": len(result.get("restored") or []),
                "backed_up": len(result.get("backed_up") or []),
                "failed": len(result.get("failed") or []),
            },
        )
        return result

    @router.post("/api/workspace/assets/bulk-archive")
    async def bulk_archive_assets(
        body: AssetBulkArchiveRequest,
        authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        try:
            result = await run_in_threadpool(
                creative_workspace_service.bulk_archive_assets,
                identity,
                body.asset_ids,
                body.project_id,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc
        await run_in_threadpool(
            advanced_creative_service.audit,
            identity,
            "asset.bulk_archive",
            entity_type="asset",
            details={"asset_ids": body.asset_ids, "project_id": body.project_id or ""},
        )
        return result

    @router.post("/api/workspace/assets/detect-duplicates")
    async def detect_duplicate_assets(
        body: DuplicateDetectionRequest,
        authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        return await run_in_threadpool(
            advanced_creative_service.detect_duplicate_assets,
            identity,
            threshold=body.threshold,
            limit=body.limit,
        )

    @router.get("/api/workspace/assets/{asset_id}")
    async def get_asset(asset_id: str, authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        try:
            return await run_in_threadpool(creative_workspace_service.get_asset, identity, asset_id)
        except ValueError as exc:
            raise HTTPException(status_code=404, detail={"error": str(exc)}) from exc

    @router.patch("/api/workspace/assets/{asset_id}")
    async def update_asset(
        asset_id: str,
        body: AssetUpdateRequest,
        authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        try:
            return await run_in_threadpool(
                creative_workspace_service.update_asset,
                identity,
                asset_id,
                body.model_dump(exclude_unset=True),
            )
        except ValueError as exc:
            raise HTTPException(status_code=404, detail={"error": str(exc)}) from exc

    @router.delete("/api/workspace/assets/{asset_id}")
    async def delete_asset(asset_id: str, authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        removed = await run_in_threadpool(creative_workspace_service.delete_asset, identity, asset_id)
        if not removed:
            raise HTTPException(status_code=404, detail={"error": "asset not found"})
        return {"ok": True}

    @router.post("/api/workspace/assets/{asset_id}/versions/{version_id}/activate")
    async def activate_version(asset_id: str, version_id: str, authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        try:
            return await run_in_threadpool(
                creative_workspace_service.set_current_version,
                identity,
                asset_id,
                version_id,
            )
        except ValueError as exc:
            raise HTTPException(status_code=404, detail={"error": str(exc)}) from exc

    @router.get("/api/workspace/assets/{asset_id}/conversations")
    async def list_asset_conversations(asset_id: str, authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        try:
            items = await run_in_threadpool(creative_workspace_service.list_conversations, identity, asset_id)
            return {"items": items}
        except ValueError as exc:
            raise HTTPException(status_code=404, detail={"error": str(exc)}) from exc

    @router.post("/api/workspace/assets/{asset_id}/conversations")
    async def create_asset_conversation(
        asset_id: str,
        body: ConversationCreateRequest,
        authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        try:
            return await run_in_threadpool(
                creative_workspace_service.create_conversation,
                identity,
                asset_id,
                body.title,
            )
        except ValueError as exc:
            raise HTTPException(status_code=404, detail={"error": str(exc)}) from exc

    @router.get("/api/workspace/conversations/{conversation_id}")
    async def get_conversation(conversation_id: str, authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        try:
            return await run_in_threadpool(creative_workspace_service.get_conversation, identity, conversation_id)
        except ValueError as exc:
            raise HTTPException(status_code=404, detail={"error": str(exc)}) from exc

    @router.post("/api/workspace/conversations/{conversation_id}/messages")
    async def submit_conversation_message(
        conversation_id: str,
        body: ConversationMessageRequest,
        request: Request,
        authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        await run_in_threadpool(check_request, body.instruction)
        await _enforce_feature(identity, "conversation")
        task_id = f"conversation-{conversation_id[:10]}-{uuid.uuid4().hex[:12]}"
        try:
            context = await run_in_threadpool(
                creative_workspace_service.conversation_context,
                identity,
                conversation_id,
            )
            current_version = context.get("current_version")
            if not isinstance(current_version, dict):
                raise ValueError("当前作品没有可继续修改的图片版本")
            source_path = _clean(current_version.get("image_path"))
            if not source_path:
                raise ValueError("当前版本缺少本地图片，请先重新归档该图片")
            source = await run_in_threadpool(image_storage_service.get_bytes, source_path)
            await run_in_threadpool(
                creative_workspace_service.add_conversation_instruction,
                identity,
                conversation_id,
                content=body.instruction,
                task_id=task_id,
            )
            history = context.get("instructions") if isinstance(context.get("instructions"), list) else []
            history_text = "\n".join(f"{index + 1}. {item}" for index, item in enumerate(history[-5:]))
            prompt = (
                "你正在对同一张作品进行连续修改。必须以上传的当前版本为唯一画面基础，保持未被本轮要求修改的"
                "人物身份、主体数量、构图、文字和风格连续。"
                + (f"\n此前修改要求：\n{history_text}" if history_text else "")
                + f"\n本轮修改要求：{body.instruction.strip()}"
            )
            task = await run_in_threadpool(
                image_task_service.submit_edit,
                identity,
                client_task_id=task_id,
                prompt=prompt,
                model=body.model,
                size=body.size,
                quality=body.quality,
                base_url=resolve_image_base_url(request),
                images=[(source, source_path.rsplit("/", 1)[-1], mimetypes.guess_type(source_path)[0] or "image/png")],
                workflow={
                    "project_id": _clean(context["asset"].get("project_id")),
                    "asset_id": context["asset"]["id"],
                    "parent_version_id": current_version["id"],
                    "branch_id": _clean(current_version.get("branch_id")),
                    "operation_type": "edit",
                    "conversation_id": conversation_id,
                    "source_path": source_path,
                    "source_name": source_path.rsplit("/", 1)[-1],
                    "asset_name": context["asset"]["name"],
                },
            )
            return {
                "task": task,
                "conversation": await run_in_threadpool(
                    creative_workspace_service.get_conversation,
                    identity,
                    conversation_id,
                ),
            }
        except ValueError as exc:
            await run_in_threadpool(
                creative_workspace_service.fail_conversation_task,
                identity,
                conversation_id,
                task_id,
                str(exc),
            )
            raise HTTPException(status_code=_task_error_status(exc), detail={"error": str(exc)}) from exc

    @router.post("/api/workspace/tools/reverse-prompt")
    async def reverse_prompt_from_image(
        request: Request,
        authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        await _enforce_feature(identity, "ai_tools")
        await _enforce_feature(identity, "tool:reverse_prompt")
        form = await request.form()
        detail = _clean(form.get("detail"), "standard")
        purpose = _clean(form.get("purpose"))
        await run_in_threadpool(check_request, purpose or "图片反推提示词")
        sources = [value for key, value in form.multi_items() if key in IMAGE_REFERENCE_FIELDS]
        images = await read_image_sources(sources) if sources else []
        try:
            if images:
                payload, filename, mime_type = images[0]
            else:
                asset_id = _clean(form.get("asset_id"))
                if not asset_id:
                    raise ValueError("请上传图片或选择自己的历史作品")
                payload, filename, mime_type = await run_in_threadpool(
                    _owned_asset_reference,
                    identity,
                    asset_id,
                    _clean(form.get("version_id")),
                )
            return await run_in_threadpool(
                reverse_image_prompt,
                payload,
                filename,
                mime_type,
                detail=detail,
                purpose=purpose,
            )
        except ImagePromptReverseError as exc:
            raise HTTPException(status_code=503, detail={"error": str(exc)}) from exc
        except (FileNotFoundError, ValueError) as exc:
            status_code = 404 if _clean(form.get("asset_id")) else 400
            raise HTTPException(status_code=status_code, detail={"error": str(exc)}) from exc

    @router.post("/api/workspace/tools/ai")
    async def run_ai_image_tool(
        request: Request,
        authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        form = await request.form()
        operation = _clean(form.get("operation"))
        if operation not in AI_TOOL_PROMPTS:
            raise HTTPException(status_code=400, detail={"error": "不支持的 AI 图片工具"})
        await _enforce_feature(identity, "ai_tools")
        await _enforce_feature(identity, f"tool:{operation}")
        sources = [value for key, value in form.multi_items() if key in IMAGE_REFERENCE_FIELDS]
        images = await read_image_sources(sources)
        if not images:
            raise HTTPException(status_code=400, detail={"error": "请上传一张图片"})
        payload, filename, mime_type = images[0]
        base_url = resolve_image_base_url(request)
        source_path = _clean(form.get("source_path"))
        if not source_path:
            stored_source = await run_in_threadpool(
                image_storage_service.save,
                payload,
                base_url,
                filename.rsplit(".", 1)[-1] if "." in filename else "png",
            )
            source_path = stored_source.rel
        instruction = _clean(form.get("instruction"))
        prompt = AI_TOOL_PROMPTS[operation]
        if instruction:
            prompt += f"\n用户补充要求：{instruction}"
        await run_in_threadpool(check_request, instruction or prompt)
        task_id = f"tool-{operation}-{uuid.uuid4().hex[:16]}"
        try:
            task = await run_in_threadpool(
                image_task_service.submit_edit,
                identity,
                client_task_id=task_id,
                prompt=prompt,
                model=_clean(form.get("model"), "gpt-image-2"),
                size=_clean(form.get("size")) or None,
                quality=_clean(form.get("quality"), "auto"),
                base_url=base_url,
                images=[(payload, filename, mime_type)],
                workflow={
                    "project_id": _clean(form.get("project_id")),
                    "asset_id": _clean(form.get("asset_id")),
                    "parent_version_id": _clean(form.get("parent_version_id")),
                    "branch_id": _clean(form.get("branch_id")),
                    "operation_type": operation,
                    "source_path": source_path,
                    "source_name": filename,
                    "asset_name": _clean(form.get("asset_name"), filename.rsplit(".", 1)[0]),
                    "params": {"instruction": instruction},
                },
            )
            return task
        except ValueError as exc:
            raise HTTPException(status_code=_task_error_status(exc), detail={"error": str(exc)}) from exc

    @router.post("/api/workspace/tools/local")
    async def run_local_image_tool(
        request: Request,
        authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        await _enforce_feature(identity, "local_tools")
        form = await request.form()
        sources = [value for key, value in form.multi_items() if key in IMAGE_REFERENCE_FIELDS]
        images = await read_image_sources(sources)
        if not images:
            raise HTTPException(status_code=400, detail={"error": "请上传一张图片"})
        payload, filename, _ = images[0]
        operation = _clean(form.get("operation"))
        try:
            result = await run_in_threadpool(
                process_local_image,
                payload,
                operation=operation,
                width=form.get("width") or 0,
                height=form.get("height") or 0,
                quality=form.get("quality") or 82,
                output_format=_clean(form.get("output_format"), "png"),
            )
            base_url = resolve_image_base_url(request)
            stored_source = await run_in_threadpool(
                image_storage_service.save,
                payload,
                base_url,
                filename.rsplit(".", 1)[-1] if "." in filename else "png",
            )
            stored_result = await run_in_threadpool(
                image_storage_service.save,
                result.payload,
                base_url,
                result.extension,
            )
            task_id = f"local-{operation}-{uuid.uuid4().hex[:16]}"
            versions = await run_in_threadpool(
                creative_workspace_service.record_task_success,
                {
                    "id": task_id,
                    "owner_id": identity.get("id"),
                    "owner_role": identity.get("role"),
                    "status": "success",
                    "mode": "edit",
                    "model": "local-pillow",
                    "size": f"{result.width}x{result.height}",
                    "quality": str(form.get("quality") or 82),
                    "prompt": f"本地图片工具：{operation}",
                    "data": [{"url": stored_result.url}],
                    "workflow": {
                        "project_id": _clean(form.get("project_id")),
                        "asset_id": _clean(form.get("asset_id")),
                        "parent_version_id": _clean(form.get("parent_version_id")),
                        "branch_id": _clean(form.get("branch_id")),
                        "operation_type": operation,
                        "source_path": stored_source.rel,
                        "source_name": filename,
                        "asset_name": _clean(form.get("asset_name"), filename.rsplit(".", 1)[0]),
                        "params": {
                            "width": result.width,
                            "height": result.height,
                            "format": result.extension,
                        },
                    },
                },
            )
            if versions:
                creative_intelligence_service.schedule_asset_intelligence(identity, versions)
            return {
                "ok": True,
                "url": stored_result.url,
                "path": stored_result.rel,
                "content_type": result.content_type,
                "width": result.width,
                "height": result.height,
                "original_bytes": result.original_bytes,
                "output_bytes": len(result.payload),
                "asset_id": versions[0]["asset_id"] if versions else "",
                "version_id": versions[0]["id"] if versions else "",
            }
        except ValueError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc

    @router.get("/api/workspace/recipes")
    async def list_recipes(
        category: str = Query(default=""),
        authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        return {"items": await run_in_threadpool(advanced_creative_service.list_recipes, identity, category)}

    @router.post("/api/workspace/recipes")
    async def create_recipe(body: RecipeCreateRequest, authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        try:
            return await run_in_threadpool(
                advanced_creative_service.create_recipe,
                identity,
                name=body.name,
                category=body.category,
                description=body.description,
                settings=body.settings,
                scope_type=body.scope_type,
                scope_id=body.scope_id,
            )
        except ValueError as exc:
            raise HTTPException(status_code=403 if "administrators" in str(exc) else 400, detail={"error": str(exc)}) from exc

    @router.delete("/api/workspace/recipes/{recipe_id}")
    async def delete_recipe(recipe_id: str, authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        removed = await run_in_threadpool(advanced_creative_service.delete_recipe, identity, recipe_id)
        if not removed:
            raise HTTPException(status_code=404, detail={"error": "recipe not found"})
        return {"ok": True}

    @router.get("/api/workspace/profiles")
    async def list_consistency_profiles(
        profile_type: str = Query(default=""),
        authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        return {"items": await run_in_threadpool(advanced_creative_service.list_profiles, identity, profile_type)}

    @router.post("/api/workspace/profiles")
    async def create_consistency_profile(
        request: Request,
        profile_type: str = Form(...),
        name: str = Form(...),
        instructions: str = Form(default=""),
        default_strength: str = Form(default="balanced"),
        colors: str = Form(default=""),
        fonts: str = Form(default=""),
        logos: list[UploadFile] = File(default=[]),
        references: list[UploadFile] = File(default=[]),
        authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        if len(logos) > 4 or len(references) > 8:
            raise HTTPException(status_code=400, detail={"error": "Logo 最多 4 张，参考图最多 8 张"})

        async def save_files(files: list[UploadFile]) -> list[str]:
            paths: list[str] = []
            for upload in files:
                payload = await upload.read(50 * 1024 * 1024 + 1)
                if not payload or len(payload) > 50 * 1024 * 1024:
                    raise HTTPException(status_code=400, detail={"error": f"{upload.filename or '图片'} 为空或超过 50 MB"})
                extension = (upload.filename or "image.png").rsplit(".", 1)[-1]
                stored = await run_in_threadpool(
                    image_storage_service.save, payload, resolve_image_base_url(request), extension
                )
                paths.append(stored.rel)
            return paths

        try:
            logo_paths = await save_files(logos)
            reference_paths = await save_files(references)
            return await run_in_threadpool(
                advanced_creative_service.create_profile,
                identity,
                profile_type=profile_type,
                name=name,
                instructions=instructions,
                colors=[item.strip() for item in colors.split(",") if item.strip()],
                fonts=[item.strip() for item in fonts.split(",") if item.strip()],
                logo_paths=logo_paths,
                reference_paths=reference_paths,
                default_strength=default_strength,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc

    @router.delete("/api/workspace/profiles/{profile_id}")
    async def delete_consistency_profile(profile_id: str, authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        removed = await run_in_threadpool(advanced_creative_service.delete_profile, identity, profile_id)
        if not removed:
            raise HTTPException(status_code=404, detail={"error": "profile not found"})
        return {"ok": True}

    @router.post("/api/workspace/assets/{asset_id}/versions/local")
    async def save_canvas_version(
        asset_id: str,
        request: Request,
        image: UploadFile = File(...),
        prompt: str = Form(default=""),
        operation: str = Form(default="canvas"),
        parent_version_id: str = Form(default=""),
        params: str = Form(default="{}"),
        authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        await _enforce_feature(identity, "local_tools")
        payload = await image.read(50 * 1024 * 1024 + 1)
        if not payload or len(payload) > 50 * 1024 * 1024:
            raise HTTPException(status_code=400, detail={"error": "画布图片为空或超过 50 MB"})
        try:
            parsed_params = json.loads(params)
        except json.JSONDecodeError as exc:
            raise HTTPException(status_code=400, detail={"error": "画布参数格式无效"}) from exc
        try:
            return await run_in_threadpool(
                advanced_creative_service.save_local_version,
                identity,
                asset_id,
                payload,
                filename=image.filename or "canvas.png",
                prompt=prompt,
                operation=operation,
                parent_version_id=parent_version_id,
                params=parsed_params if isinstance(parsed_params, dict) else {},
                base_url=resolve_image_base_url(request),
            )
        except ValueError as exc:
            raise HTTPException(status_code=404, detail={"error": str(exc)}) from exc

    @router.delete("/api/workspace/assets/{asset_id}/versions/{version_id}")
    async def trash_asset_version(
        asset_id: str,
        version_id: str,
        authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        try:
            asset = await run_in_threadpool(creative_workspace_service.get_asset, identity, asset_id)
        except ValueError as exc:
            raise HTTPException(status_code=404, detail={"error": str(exc)}) from exc
        if not any(_clean(item.get("id")) == _clean(version_id) for item in asset.get("versions", [])):
            raise HTTPException(status_code=404, detail={"error": "version not found"})
        removed = await run_in_threadpool(advanced_creative_service.trash, identity, "version", version_id)
        return {"ok": removed}

    @router.get("/api/workspace/search/assets")
    async def smart_asset_search(
        query: str = Query(default=""),
        person: str = Query(default=""),
        color: str = Query(default=""),
        style: str = Query(default=""),
        date_from: str = Query(default=""),
        date_to: str = Query(default=""),
        similar_to: str = Query(default=""),
        limit: int = Query(default=100, ge=1, le=500),
        authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        items = await run_in_threadpool(
            advanced_creative_service.search_assets,
            identity,
            query=query,
            person=person,
            color=color,
            style=style,
            date_from=date_from,
            date_to=date_to,
            similar_to=similar_to,
            limit=limit,
        )
        return {"items": items}

    @router.post("/api/workspace/assets/{asset_id}/analyze")
    async def analyze_asset(asset_id: str, authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        try:
            return await run_in_threadpool(advanced_creative_service.analyze_asset, identity, asset_id)
        except ValueError as exc:
            raise HTTPException(status_code=404, detail={"error": str(exc)}) from exc

    @router.post("/api/workspace/assets/{asset_id}/shares")
    async def create_asset_share(
        asset_id: str,
        body: ShareCreateRequest,
        authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        try:
            return await run_in_threadpool(
                advanced_creative_service.create_share,
                identity,
                asset_id,
                body.version_id,
                body.expires_days,
            )
        except ValueError as exc:
            raise HTTPException(status_code=404, detail={"error": str(exc)}) from exc

    @router.delete("/api/workspace/shares/{token}")
    async def revoke_asset_share(token: str, authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        removed = await run_in_threadpool(advanced_creative_service.revoke_share, identity, token)
        if not removed:
            raise HTTPException(status_code=404, detail={"error": "share not found"})
        return {"ok": True}

    @router.get("/api/shared/{token}")
    async def get_shared_asset(token: str):
        try:
            return await run_in_threadpool(advanced_creative_service.get_public_share, token)
        except ValueError as exc:
            raise HTTPException(status_code=404, detail={"error": str(exc)}) from exc

    @router.get("/api/shared/{token}/download")
    async def download_shared_asset(token: str):
        try:
            shared = await run_in_threadpool(advanced_creative_service.get_public_share, token, count_download=True)
            image_url = _clean(shared["version"].get("image_url"))
            marker = "/images/"
            if marker not in image_url:
                raise ValueError("shared image is unavailable")
            relative = image_url.split(marker, 1)[1].split("?", 1)[0]
            payload = await run_in_threadpool(image_storage_service.get_bytes, relative)
        except ValueError as exc:
            raise HTTPException(status_code=404, detail={"error": str(exc)}) from exc
        return StreamingResponse(
            io.BytesIO(payload),
            media_type=mimetypes.guess_type(relative)[0] or "image/png",
            headers={"Content-Disposition": f'attachment; filename="{relative.rsplit("/", 1)[-1]}"'},
        )

    @router.post("/api/workspace/assets/{asset_id}/reviews")
    async def submit_asset_review(
        asset_id: str,
        body: ReviewCreateRequest,
        authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        try:
            return await run_in_threadpool(
                advanced_creative_service.submit_review, identity, asset_id, body.version_id
            )
        except ValueError as exc:
            raise HTTPException(status_code=404, detail={"error": str(exc)}) from exc

    @router.get("/api/workspace/reviews")
    async def list_asset_reviews(
        status: str = Query(default=""),
        authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        return {"items": await run_in_threadpool(advanced_creative_service.list_reviews, identity, status)}

    @router.patch("/api/workspace/reviews/{review_id}")
    async def resolve_asset_review(
        review_id: str,
        body: ReviewResolveRequest,
        authorization: str | None = Header(default=None),
    ):
        identity = require_admin(authorization)
        try:
            return await run_in_threadpool(
                advanced_creative_service.resolve_review, identity, review_id, body.status, body.comment
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc

    @router.get("/api/workspace/trash")
    async def list_workspace_trash(authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        return {"items": await run_in_threadpool(advanced_creative_service.list_trash, identity)}

    @router.post("/api/workspace/trash/{trash_id}/restore")
    async def restore_workspace_trash(trash_id: str, authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        restored = await run_in_threadpool(advanced_creative_service.restore_trash, identity, trash_id)
        if not restored:
            raise HTTPException(status_code=404, detail={"error": "trash item not found"})
        return {"ok": True}

    @router.delete("/api/workspace/trash/{trash_id}")
    async def purge_workspace_trash(trash_id: str, authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        removed = await run_in_threadpool(advanced_creative_service.purge_trash, identity, trash_id)
        if not removed:
            raise HTTPException(status_code=404, detail={"error": "trash item not found"})
        return {"ok": True}

    @router.post("/api/workspace/admin/trash/cleanup")
    async def cleanup_workspace_trash(authorization: str | None = Header(default=None)):
        require_admin(authorization)
        return {"removed": await run_in_threadpool(advanced_creative_service.cleanup_trash)}

    @router.get("/api/workspace/admin/audits")
    async def list_workspace_audits(
        action: str = Query(default=""),
        actor_id: str = Query(default=""),
        limit: int = Query(default=200, ge=1, le=1000),
        authorization: str | None = Header(default=None),
    ):
        identity = require_admin(authorization)
        return {
            "items": await run_in_threadpool(
                advanced_creative_service.list_audits,
                identity,
                action=action,
                actor_id=actor_id,
                limit=limit,
            )
        }

    @router.get("/api/workspace/intelligence/health")
    async def creative_intelligence_health(authorization: str | None = Header(default=None)):
        require_identity(authorization)
        return await run_in_threadpool(creative_intelligence_service.health)

    @router.post("/api/workspace/assets/{asset_id}/intelligence/index")
    async def index_asset_version(
        asset_id: str,
        body: AssetIntelligenceRequest,
        authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        try:
            return await run_in_threadpool(
                creative_intelligence_service.index_version,
                identity,
                asset_id,
                body.version_id,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc
        except Exception as exc:
            raise HTTPException(status_code=503, detail={"error": "语义索引模型暂时不可用"}) from exc

    @router.post("/api/workspace/intelligence/index-history")
    async def index_asset_history(
        limit: int = Query(default=500, ge=1, le=2000),
        authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        return await run_in_threadpool(creative_intelligence_service.index_owner_assets, identity, limit)

    @router.get("/api/workspace/search/semantic")
    async def semantic_asset_search(
        query: str = Query(..., min_length=1, max_length=500),
        project_id: str = Query(default="", max_length=64),
        asset_type: str = Query(default="", max_length=40),
        minimum_score: float = Query(default=0.0, ge=-1.0, le=1.0),
        limit: int = Query(default=40, ge=1, le=200),
        authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        try:
            items = await run_in_threadpool(
                creative_intelligence_service.semantic_search,
                identity,
                query,
                project_id=project_id,
                asset_type=asset_type,
                minimum_score=minimum_score,
                limit=limit,
            )
            return {"items": items}
        except ValueError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc
        except Exception as exc:
            raise HTTPException(status_code=503, detail={"error": "语义搜索模型暂时不可用"}) from exc

    @router.get("/api/workspace/assets/{asset_id}/quality")
    async def get_asset_quality(
        asset_id: str,
        version_id: str = Query(default="", max_length=64),
        authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        try:
            return await run_in_threadpool(creative_intelligence_service.get_quality, identity, asset_id, version_id)
        except ValueError as exc:
            raise HTTPException(status_code=404, detail={"error": str(exc)}) from exc

    @router.post("/api/workspace/assets/{asset_id}/quality")
    async def score_asset_quality(
        asset_id: str,
        body: AssetIntelligenceRequest,
        authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        try:
            return await run_in_threadpool(
                creative_intelligence_service.score_version,
                identity,
                asset_id,
                body.version_id,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc

    @router.post("/api/workspace/assets/quality/rank")
    async def rank_assets_by_quality(
        body: RankAssetsRequest,
        authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        return {
            "items": await run_in_threadpool(
                creative_intelligence_service.rank_assets,
                identity,
                body.asset_ids,
            )
        }

    @router.post("/api/workspace/assets/quality/queue")
    async def queue_assets_quality(
        body: RankAssetsRequest,
        authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        try:
            return await run_in_threadpool(
                creative_intelligence_service.queue_quality_ranking,
                identity,
                body.asset_ids,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc

    @router.get("/api/workspace/assets/{asset_id}/derivatives")
    async def list_asset_derivatives(asset_id: str, authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        try:
            return {"items": await run_in_threadpool(creative_intelligence_service.list_derivatives, identity, asset_id)}
        except ValueError as exc:
            raise HTTPException(status_code=404, detail={"error": str(exc)}) from exc

    @router.post("/api/workspace/assets/{asset_id}/derivatives")
    async def create_asset_derivatives(
        asset_id: str,
        body: DerivativeCreateRequest,
        request: Request,
        authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        await _enforce_feature(identity, "local_tools")
        try:
            items = await run_in_threadpool(
                creative_intelligence_service.generate_derivatives,
                identity,
                asset_id,
                version_id=body.version_id,
                presets=list(body.presets),
                mode=body.mode,
                base_url=resolve_image_base_url(request),
            )
            return {"items": items}
        except ValueError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc

    @router.get("/api/workspace/assets/{asset_id}/version-tree")
    async def get_asset_version_tree(asset_id: str, authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        try:
            return await run_in_threadpool(creative_intelligence_service.version_tree, identity, asset_id)
        except ValueError as exc:
            raise HTTPException(status_code=404, detail={"error": str(exc)}) from exc

    @router.post("/api/workspace/assets/{asset_id}/branches")
    async def create_asset_branch(
        asset_id: str,
        body: BranchCreateRequest,
        authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        try:
            return await run_in_threadpool(
                creative_intelligence_service.create_branch,
                identity,
                asset_id,
                name=body.name,
                root_version_id=body.root_version_id,
                metadata=body.metadata,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc

    @router.get("/api/workspace/boards")
    async def list_inspiration_boards(authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        return {"items": await run_in_threadpool(creative_intelligence_service.list_boards, identity)}

    @router.post("/api/workspace/boards")
    async def create_inspiration_board(
        body: BoardCreateRequest,
        authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        try:
            return await run_in_threadpool(
                creative_intelligence_service.create_board,
                identity,
                name=body.name,
                description=body.description,
                project_id=body.project_id,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc

    @router.get("/api/workspace/boards/{board_id}")
    async def get_inspiration_board(board_id: str, authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        try:
            return await run_in_threadpool(creative_intelligence_service.get_board, identity, board_id)
        except ValueError as exc:
            raise HTTPException(status_code=404, detail={"error": str(exc)}) from exc

    @router.patch("/api/workspace/boards/{board_id}")
    async def update_inspiration_board(
        board_id: str,
        body: BoardUpdateRequest,
        authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        try:
            return await run_in_threadpool(
                creative_intelligence_service.update_board,
                identity,
                board_id,
                body.model_dump(exclude_unset=True),
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc

    @router.delete("/api/workspace/boards/{board_id}")
    async def delete_inspiration_board(board_id: str, authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        removed = await run_in_threadpool(creative_intelligence_service.delete_board, identity, board_id)
        if not removed:
            raise HTTPException(status_code=404, detail={"error": "board not found"})
        return {"ok": True}

    @router.post("/api/workspace/boards/{board_id}/items")
    async def create_inspiration_board_item(
        board_id: str,
        body: BoardItemCreateRequest,
        authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        try:
            return await run_in_threadpool(
                creative_intelligence_service.add_board_item,
                identity,
                board_id,
                **body.model_dump(),
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc

    @router.post("/api/workspace/boards/{board_id}/items/upload")
    async def upload_inspiration_board_item(
        board_id: str,
        request: Request,
        image: UploadFile = File(...),
        item_type: Literal["image", "reference"] = Form(default="reference"),
        x: float = Form(default=40),
        y: float = Form(default=40),
        width: float = Form(default=240),
        height: float = Form(default=180),
        authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        payload = await image.read(50 * 1024 * 1024 + 1)
        if not payload or len(payload) > 50 * 1024 * 1024:
            raise HTTPException(status_code=400, detail={"error": "画板图片为空或超过 50 MB"})
        extension = (image.filename or "board.png").rsplit(".", 1)[-1]
        try:
            stored = await run_in_threadpool(
                image_storage_service.save,
                payload,
                resolve_image_base_url(request),
                extension,
            )
            return await run_in_threadpool(
                creative_intelligence_service.add_board_item,
                identity,
                board_id,
                item_type=item_type,
                image_path=stored.rel,
                image_url=stored.url,
                x=x,
                y=y,
                width=width,
                height=height,
                metadata={"filename": image.filename or "board.png"},
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc

    @router.patch("/api/workspace/boards/{board_id}/items/{item_id}")
    async def update_inspiration_board_item(
        board_id: str,
        item_id: str,
        body: BoardItemUpdateRequest,
        authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        try:
            return await run_in_threadpool(
                creative_intelligence_service.update_board_item,
                identity,
                board_id,
                item_id,
                body.model_dump(exclude_unset=True),
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc

    @router.delete("/api/workspace/boards/{board_id}/items/{item_id}")
    async def delete_inspiration_board_item(
        board_id: str,
        item_id: str,
        authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        removed = await run_in_threadpool(
            creative_intelligence_service.delete_board_item,
            identity,
            board_id,
            item_id,
        )
        if not removed:
            raise HTTPException(status_code=404, detail={"error": "board item not found"})
        return {"ok": True}

    @router.get("/api/workspace/boards/{board_id}/draft")
    async def get_inspiration_board_draft(board_id: str, authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        try:
            return await run_in_threadpool(creative_intelligence_service.board_creation_draft, identity, board_id)
        except ValueError as exc:
            raise HTTPException(status_code=404, detail={"error": str(exc)}) from exc

    @router.get("/api/workspace/notifications")
    async def list_creative_notifications(
        limit: int = Query(default=50, ge=1, le=200),
        authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        return {"items": await run_in_threadpool(creative_intelligence_service.list_notifications, identity, limit)}

    @router.post("/api/workspace/notifications/read")
    async def read_creative_notifications(
        notification_id: str = Query(default="", max_length=64),
        authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        return {"updated": await run_in_threadpool(creative_intelligence_service.mark_notification_read, identity, notification_id)}

    @router.get("/api/workspace/notifications/settings")
    async def get_creative_notification_settings(authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        return await run_in_threadpool(creative_intelligence_service.get_notification_settings, identity)

    @router.patch("/api/workspace/notifications/settings")
    async def update_creative_notification_settings(
        body: NotificationSettingsRequest,
        authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        try:
            return await run_in_threadpool(
                creative_intelligence_service.update_notification_settings,
                identity,
                body.model_dump(exclude_unset=True),
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc

    @router.post("/api/workspace/notifications/test")
    async def test_creative_notification(authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        return await run_in_threadpool(
            creative_intelligence_service.create_notification,
            identity,
            event="task.success",
            title="通知测试成功",
            message="XG 生图通知链路已连接。",
            payload={"test": True},
        )

    @router.get("/api/workspace/projects/{project_id}/budget")
    async def get_project_budget(project_id: str, authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        owned_projects = await run_in_threadpool(creative_workspace_service.list_projects, identity)
        if not any(_clean(item.get("id")) == _clean(project_id) for item in owned_projects):
            raise HTTPException(status_code=404, detail={"error": "project not found"})
        try:
            return await run_in_threadpool(
                creative_intelligence_service.get_budget,
                _clean(identity.get("id")),
                project_id,
            )
        except ValueError as exc:
            if str(exc) == "budget not found":
                return {"project_id": project_id, "configured": False}
            raise HTTPException(status_code=404, detail={"error": str(exc)}) from exc

    @router.put("/api/workspace/admin/projects/{project_id}/budget")
    async def update_project_budget(
        project_id: str,
        body: BudgetUpdateRequest,
        authorization: str | None = Header(default=None),
    ):
        require_admin(authorization)
        try:
            return await run_in_threadpool(
                creative_intelligence_service.set_budget,
                owner_id=body.owner_id,
                project_id=project_id,
                credit_limit=body.credit_limit,
                budget_type=body.budget_type,
                label=body.label,
                warning_percent=body.warning_percent,
                unit_cost=body.unit_cost,
                enabled=body.enabled,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc

    @router.get("/api/workspace/admin/projects/{project_id}/budget")
    async def get_admin_project_budget(project_id: str, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        projects = await run_in_threadpool(creative_intelligence_service.list_budget_projects)
        project = next((item for item in projects if _clean(item.get("id")) == _clean(project_id)), None)
        if project is None:
            raise HTTPException(status_code=404, detail={"error": "project not found"})
        try:
            return await run_in_threadpool(
                creative_intelligence_service.get_budget,
                _clean(project.get("owner_id")),
                project_id,
            )
        except ValueError as exc:
            if str(exc) == "budget not found":
                return {
                    "project_id": project_id,
                    "owner_id": project.get("owner_id"),
                    "configured": False,
                }
            raise HTTPException(status_code=404, detail={"error": str(exc)}) from exc

    @router.get("/api/workspace/admin/budgets")
    async def list_project_budgets(authorization: str | None = Header(default=None)):
        require_admin(authorization)
        return {"items": await run_in_threadpool(creative_intelligence_service.list_budgets)}

    @router.get("/api/workspace/admin/budget-projects")
    async def list_budget_projects(authorization: str | None = Header(default=None)):
        require_admin(authorization)
        return {"items": await run_in_threadpool(creative_intelligence_service.list_budget_projects)}

    @router.get("/api/workspace/projects/{project_id}/delivery")
    async def download_project_delivery(project_id: str, authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        try:
            archive, filename = await run_in_threadpool(
                creative_intelligence_service.build_delivery_package,
                identity,
                project_id=project_id,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc
        return StreamingResponse(
            archive,
            media_type="application/zip",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    @router.get("/api/workspace/assets/{asset_id}/delivery")
    async def download_asset_delivery(
        asset_id: str,
        mode: Literal["original", "current", "all", "delivery"] = Query(default="delivery"),
        authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        if mode == "delivery":
            try:
                archive, filename = await run_in_threadpool(
                    creative_intelligence_service.build_delivery_package,
                    identity,
                    asset_id=asset_id,
                )
            except ValueError as exc:
                raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc
            return StreamingResponse(
                archive,
                media_type="application/zip",
                headers={"Content-Disposition": f'attachment; filename="{filename}"'},
            )
        try:
            asset = await run_in_threadpool(creative_workspace_service.get_asset, identity, asset_id)
        except ValueError as exc:
            raise HTTPException(status_code=404, detail={"error": str(exc)}) from exc
        versions = list(asset.get("versions") or [])
        if not versions:
            raise HTTPException(status_code=404, detail={"error": "asset has no versions"})
        if mode == "original":
            selected = versions[:1]
        elif mode == "current":
            selected = [item for item in versions if item.get("id") == asset.get("current_version_id")]
        else:
            selected = versions
        paths = [_clean(item.get("image_path")) for item in selected if _clean(item.get("image_path"))]
        archive = await run_in_threadpool(download_images_zip, paths)
        return StreamingResponse(
            archive,
            media_type="application/zip",
            headers={"Content-Disposition": f'attachment; filename="xg-delivery-{asset_id[:12]}.zip"'},
        )

    @router.get("/api/workspace/admin/policies")
    async def list_admin_policies(authorization: str | None = Header(default=None)):
        require_admin(authorization)
        return {"items": await run_in_threadpool(creative_workspace_service.list_policies)}

    @router.put("/api/workspace/admin/policies/{subject_id}")
    async def update_admin_policy(
        subject_id: str,
        body: PolicyUpdateRequest,
        authorization: str | None = Header(default=None),
    ):
        identity = require_admin(authorization)
        try:
            result = await run_in_threadpool(
                creative_workspace_service.update_policy,
                subject_id,
                subject_type=body.subject_type,
                features=body.features,
                rate_limit_per_minute=body.rate_limit_per_minute,
                frozen=body.frozen,
                abnormal_reason=body.abnormal_reason,
            )
            await run_in_threadpool(
                advanced_creative_service.audit,
                identity,
                "policy.update",
                entity_type=body.subject_type,
                entity_id=subject_id,
                details={"features": body.features, "rate_limit_per_minute": body.rate_limit_per_minute,
                         "frozen": body.frozen},
            )
            return result
        except ValueError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc

    @router.post("/api/workspace/admin/users/quota-batch")
    async def update_users_quota_batch(
        body: BatchQuotaRequest,
        authorization: str | None = Header(default=None),
    ):
        identity = require_admin(authorization)
        users = {str(item.get("id") or ""): item for item in await run_in_threadpool(auth_service.list_users)}
        updated = []
        missing = []
        for user_id in dict.fromkeys(_clean(item) for item in body.user_ids if _clean(item)):
            user = users.get(user_id)
            if user is None:
                missing.append(user_id)
                continue
            current = int(user.get("image_quota") or 0)
            next_quota = body.amount if body.mode == "set" else min(100000, current + body.amount)
            item = await run_in_threadpool(auth_service.update_user, user_id, {"image_quota": next_quota})
            if item is not None:
                updated.append(item)
        await run_in_threadpool(
            advanced_creative_service.audit,
            identity,
            "quota.batch_update",
            entity_type="user",
            details={"user_ids": body.user_ids, "mode": body.mode, "amount": body.amount,
                     "updated_count": len(updated), "missing_ids": missing},
        )
        return {"updated": updated, "missing_ids": missing, "items": await run_in_threadpool(auth_service.list_users)}

    return router
