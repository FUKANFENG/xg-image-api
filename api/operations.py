from __future__ import annotations

import mimetypes

from fastapi import APIRouter, File, Form, Header, HTTPException, Query, UploadFile
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from api.support import require_admin, require_identity
from services.account_service import account_service
from services.advanced_creative_service import advanced_creative_service
from services.auth_service import auth_service
from services.backup_service import BackupError, backup_service
from services.creative_intelligence_service import creative_intelligence_service
from services.creative_operations_service import creative_operations_service
from services.creative_workspace_service import creative_workspace_service
from services.image_prompt_reverse_service import ImagePromptReverseError, suggest_local_edits
from services.image_storage_service import image_storage_service
from services.image_task_service import image_task_service


def _clean(value: object, limit: int = 4_000) -> str:
    return str(value or "").strip()[:limit]


def _error(code: str, message: str, status_code: int = 400) -> HTTPException:
    return HTTPException(status_code=status_code, detail={"code": code, "message": message})


def _scope_identity(identity: dict[str, object], owner_id: str) -> dict[str, object]:
    requested = _clean(owner_id, 128)
    if not requested or requested == _clean(identity.get("id"), 128):
        return identity
    if _clean(identity.get("role"), 32).lower() not in {"admin", "administrator"}:
        raise _error("FORBIDDEN", "无权查看其他用户数据", 403)
    user = next((item for item in auth_service.list_users() if _clean(item.get("id"), 128) == requested), None)
    if user is None:
        raise _error("NOT_FOUND", "用户不存在", 404)
    return {
        "id": requested,
        "role": "user",
        "name": _clean(user.get("name"), 120),
        "group": _clean(user.get("group"), 40) or "default",
    }


class ModelRouteRequest(BaseModel):
    mode: str = "generate"
    prompt: str = Field(default="", max_length=12_000)
    reference_count: int = Field(default=0, ge=0, le=20)
    has_mask: bool = False
    quality: str = "auto"
    available_models: list[str] = Field(default_factory=list, max_length=50)


class TemplateRenderRequest(BaseModel):
    template: str = Field(..., min_length=1, max_length=12_000)
    variables: dict[str, object] = Field(default_factory=dict)


class TemplateSaveRequest(TemplateRenderRequest):
    name: str = Field(default="", max_length=120)


class ScheduleCreateRequest(BaseModel):
    prompts: list[str] = Field(default_factory=list, max_length=50)
    template: str = Field(default="", max_length=12_000)
    variables: dict[str, object] = Field(default_factory=dict)
    model: str = "auto"
    size: str = "1024x1024"
    quality: str = "auto"
    project_id: str = ""
    run_at: str
    low_peak_only: bool = False
    window_start: int = Field(default=0, ge=0, le=23)
    window_end: int = Field(default=7, ge=0, le=23)


class ReviewCommentRequest(BaseModel):
    body: str = Field(..., min_length=1, max_length=2_000)


class ReviewAnnotationRequest(BaseModel):
    label: str = Field(default="", max_length=120)
    x: float = Field(..., ge=0, le=1)
    y: float = Field(..., ge=0, le=1)
    width: float = Field(..., gt=0, le=1)
    height: float = Field(..., gt=0, le=1)
    body: str = Field(default="", max_length=1_000)


class ReviewConfirmationRequest(BaseModel):
    decision: str
    comment: str = Field(default="", max_length=1_000)


class DisasterVerifyRequest(BaseModel):
    key: str = Field(..., min_length=1, max_length=1_000)


class DisasterRestoreRequest(BaseModel):
    run_id: str = Field(..., min_length=1, max_length=64)
    restore_token: str = Field(..., min_length=1, max_length=128)
    confirmation: str = Field(..., min_length=1, max_length=64)


def dispatch_scheduled_generation(schedule: dict[str, object]) -> list[str]:
    identity = schedule.get("identity") if isinstance(schedule.get("identity"), dict) else {}
    if _clean(identity.get("role"), 32) == "user":
        current = next(
            (item for item in auth_service.list_users() if item.get("id") == identity.get("id") and item.get("enabled")),
            None,
        )
        if current is None:
            raise ValueError("定时任务所属用户已禁用或不存在")
        identity = {
            "id": current.get("id"), "role": "user", "name": current.get("name"), "group": current.get("group") or "default"
        }
    schedule_id = _clean(schedule.get("id"), 64)
    route = creative_operations_service.route_model(
        identity,
        mode="generate",
        prompt="\n".join(_clean(item, 1_000) for item in schedule.get("prompts") or []),
        quality=_clean(schedule.get("quality"), 20),
    )
    requested_model = _clean(schedule.get("model"), 100)
    model = str(route["model"]) if requested_model.lower() == "auto" else requested_model or str(route["model"])
    task_ids: list[str] = []
    for index, prompt in enumerate(schedule.get("prompts") or []):
        task_id = f"schedule-{schedule_id[:16]}-{index + 1}"
        task = image_task_service.submit_generation(
            identity,
            client_task_id=task_id,
            prompt=_clean(prompt, 12_000),
            model=model,
            size=_clean(schedule.get("size"), 40) or None,
            quality=_clean(schedule.get("quality"), 20) or "auto",
            workflow={
                "project_id": _clean(schedule.get("project_id"), 64),
                "operation_type": "scheduled_generate",
                "asset_name": _clean(prompt, 48),
                "schedule_id": schedule_id,
            },
        )
        task_ids.append(_clean(task.get("id"), 128))
    return task_ids


def create_router() -> APIRouter:
    router = APIRouter(prefix="/api/operations", tags=["operations"])

    @router.get("/health")
    async def operations_health(authorization: str | None = Header(default=None)):
        require_admin(authorization)
        return {"data": await run_in_threadpool(creative_operations_service.health)}

    @router.get("/accounts/scheduler")
    async def scheduler_overview(authorization: str | None = Header(default=None)):
        require_admin(authorization)
        health = await run_in_threadpool(account_service.image_runtime_health)
        accounts = list(health.get("accounts") or [])
        for item in accounts:
            factors = item.get("scheduler_factors") if isinstance(item.get("scheduler_factors"), dict) else {}
            reasons: list[str] = []
            if item.get("circuit_state") != "closed":
                reasons.append("熔断或半开，暂时降权")
            if int(item.get("quota") or 0) <= 1:
                reasons.append("剩余额度偏低")
            if int(factors.get("failure_streak_penalty_ms") or 0) > 0:
                reasons.append("连续失败触发惩罚")
            if not reasons:
                reasons.append("可用，按并发占用和综合评分参与调度")
            item["selection_reason"] = "；".join(reasons)
        return {"data": {**health, "accounts": accounts, "strategy": "inflight_first_then_quota_reliability_latency"}}

    @router.get("/quota-ledger")
    async def quota_ledger(
        owner_id: str = Query(default=""),
        action: str = Query(default=""),
        task_id: str = Query(default=""),
        limit: int = Query(default=50, ge=1, le=200),
        offset: int = Query(default=0, ge=0),
        authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        result = await run_in_threadpool(
            auth_service.list_image_credit_events,
            identity,
            owner_id=owner_id,
            action=action,
            task_id=task_id,
            limit=limit,
            offset=offset,
        )
        return {"data": result["items"], "pagination": result["pagination"]}

    @router.get("/tasks/{task_id}/timeline")
    async def task_timeline(task_id: str, authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        try:
            return {"data": await run_in_threadpool(image_task_service.task_timeline, identity, task_id)}
        except ValueError as exc:
            raise _error("TASK_NOT_FOUND", str(exc), 404) from exc

    @router.post("/model-route")
    async def model_route(body: ModelRouteRequest, authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        return {
            "data": creative_operations_service.route_model(
                identity,
                mode=body.mode,
                prompt=body.prompt,
                reference_count=body.reference_count,
                has_mask=body.has_mask,
                quality=body.quality,
                available_models=body.available_models,
            )
        }

    @router.post("/prompt-templates/render")
    async def render_prompt_template(body: TemplateRenderRequest, authorization: str | None = Header(default=None)):
        require_identity(authorization)
        try:
            return {"data": creative_operations_service.render_template(body.template, body.variables)}
        except ValueError as exc:
            raise _error("INVALID_TEMPLATE", str(exc), 422) from exc

    @router.get("/prompt-templates")
    async def list_prompt_templates(authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        return {"data": await run_in_threadpool(creative_operations_service.list_templates, identity)}

    @router.post("/prompt-templates")
    async def save_prompt_template(body: TemplateSaveRequest, authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        try:
            return {"data": await run_in_threadpool(creative_operations_service.save_template, identity, name=body.name, template=body.template, variables=body.variables)}
        except ValueError as exc:
            raise _error("INVALID_TEMPLATE", str(exc), 422) from exc

    @router.delete("/prompt-templates/{template_id}")
    async def delete_prompt_template(template_id: str, authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        removed = await run_in_threadpool(creative_operations_service.delete_template, identity, template_id)
        if not removed:
            raise _error("NOT_FOUND", "模板不存在", 404)
        return {"data": {"ok": True}}

    @router.get("/schedules")
    async def schedules(
        limit: int = Query(default=50, ge=1, le=200),
        offset: int = Query(default=0, ge=0),
        authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        result = await run_in_threadpool(creative_operations_service.list_schedules, identity, limit=limit, offset=offset)
        return {"data": result["items"], "pagination": result["pagination"]}

    @router.post("/schedules")
    async def create_schedule(body: ScheduleCreateRequest, authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        try:
            prompts = [_clean(item, 12_000) for item in body.prompts if _clean(item, 12_000)]
            if body.template:
                prompts.extend(creative_operations_service.render_template(body.template, body.variables)["items"])
            route = creative_operations_service.route_model(identity, mode="generate", prompt="\n".join(prompts), quality=body.quality)
            model = str(route["model"]) if body.model.strip().lower() == "auto" else body.model
            item = await run_in_threadpool(
                creative_operations_service.create_schedule,
                identity,
                prompts=prompts,
                model=model,
                size=body.size,
                quality=body.quality,
                project_id=body.project_id,
                run_at=body.run_at,
                low_peak_only=body.low_peak_only,
                window_start=body.window_start,
                window_end=body.window_end,
            )
            return {"data": item}
        except ValueError as exc:
            raise _error("INVALID_SCHEDULE", str(exc), 422) from exc

    @router.delete("/schedules/{schedule_id}")
    async def cancel_schedule(schedule_id: str, authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        removed = await run_in_threadpool(creative_operations_service.cancel_schedule, identity, schedule_id)
        if not removed:
            raise _error("NOT_FOUND", "定时任务不存在或已结束", 404)
        return {"data": {"ok": True}}

    @router.post("/local-edit/suggestions")
    async def local_edit_suggestions(
        image: UploadFile | None = File(default=None),
        image_path: str = Form(default=""),
        instruction: str = Form(default=""),
        authorization: str | None = Header(default=None),
    ):
        require_identity(authorization)
        try:
            if image is not None:
                payload = await image.read()
                if len(payload) > 50 * 1024 * 1024:
                    raise ValueError("单张图片不能超过 50 MB")
                filename = image.filename or "upload.png"
                mime_type = image.content_type or mimetypes.guess_type(filename)[0] or "image/png"
            elif _clean(image_path, 500):
                payload = await run_in_threadpool(image_storage_service.get_bytes, _clean(image_path, 500))
                filename = _clean(image_path, 500).rsplit("/", 1)[-1]
                mime_type = mimetypes.guess_type(filename)[0] or "image/png"
            else:
                raise ValueError("请上传图片或从作品中选择图片")
            result = await run_in_threadpool(suggest_local_edits, payload, filename, mime_type, instruction=instruction)
            return {"data": result}
        except (ValueError, ImagePromptReverseError) as exc:
            raise _error("LOCAL_EDIT_ANALYSIS_FAILED", str(exc), 422) from exc

    @router.get("/analytics/usability")
    async def usability(owner_id: str = Query(default=""), authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        scoped = _scope_identity(identity, owner_id)
        assets = await run_in_threadpool(creative_workspace_service.list_assets, scoped, limit=200)
        ranked = await run_in_threadpool(creative_intelligence_service.rank_assets, scoped, [str(item["id"]) for item in assets]) if assets else []
        ledger = await run_in_threadpool(auth_service.list_image_credit_events, scoped, action="consume", limit=1, offset=0)
        metrics = creative_operations_service.usability_metrics(ranked, int(ledger["pagination"]["total"]))
        return {"data": {**metrics, "asset_count": len(assets)}}

    @router.get("/reviews/{review_id}/comments")
    async def review_comments(review_id: str, authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        try:
            review = await run_in_threadpool(advanced_creative_service.get_review, identity, review_id)
            return {"data": await run_in_threadpool(creative_operations_service.list_review_comments, review)}
        except ValueError as exc:
            raise _error("REVIEW_NOT_FOUND", str(exc), 404) from exc

    @router.post("/reviews/{review_id}/comments")
    async def add_review_comment(review_id: str, body: ReviewCommentRequest, authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        try:
            review = await run_in_threadpool(advanced_creative_service.get_review, identity, review_id)
            return {"data": await run_in_threadpool(creative_operations_service.add_review_comment, identity, review, body.body)}
        except ValueError as exc:
            raise _error("REVIEW_COMMENT_FAILED", str(exc), 422) from exc

    @router.get("/reviews/{review_id}/annotations")
    async def review_annotations(review_id: str, authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        try:
            review = await run_in_threadpool(advanced_creative_service.get_review, identity, review_id)
            return {"data": await run_in_threadpool(creative_operations_service.list_review_annotations, review)}
        except ValueError as exc:
            raise _error("REVIEW_NOT_FOUND", str(exc), 404) from exc

    @router.post("/reviews/{review_id}/annotations")
    async def add_review_annotation(review_id: str, body: ReviewAnnotationRequest, authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        try:
            review = await run_in_threadpool(advanced_creative_service.get_review, identity, review_id)
            item = await run_in_threadpool(
                creative_operations_service.add_review_annotation,
                identity,
                review,
                label=body.label,
                x=body.x,
                y=body.y,
                width=body.width,
                height=body.height,
                body=body.body,
            )
            return {"data": item}
        except ValueError as exc:
            raise _error("REVIEW_ANNOTATION_FAILED", str(exc), 422) from exc

    @router.post("/reviews/{review_id}/confirm")
    async def confirm_review(review_id: str, body: ReviewConfirmationRequest, authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        try:
            review = await run_in_threadpool(advanced_creative_service.get_review, identity, review_id)
            return {"data": await run_in_threadpool(creative_operations_service.confirm_review, identity, review, body.decision, body.comment)}
        except ValueError as exc:
            raise _error("REVIEW_CONFIRMATION_FAILED", str(exc), 422) from exc

    @router.get("/provenance/{asset_id}")
    async def provenance(asset_id: str, owner_id: str = Query(default=""), authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        scoped = _scope_identity(identity, owner_id)
        try:
            await run_in_threadpool(creative_workspace_service.get_asset, scoped, asset_id)
            return {"data": await run_in_threadpool(creative_operations_service.list_provenance, scoped, asset_id)}
        except ValueError as exc:
            raise _error("ASSET_NOT_FOUND", str(exc), 404) from exc

    @router.post("/disaster/verify")
    async def verify_disaster_restore(body: DisasterVerifyRequest, authorization: str | None = Header(default=None)):
        identity = require_admin(authorization)
        try:
            detail = await run_in_threadpool(backup_service.verify_restore, body.key)
            run, token = await run_in_threadpool(creative_operations_service.create_restore_verification, str(identity["id"]), body.key, detail)
            return {"data": {**run, "restore_token": token, "confirmation_required": "确认恢复"}}
        except (BackupError, ValueError) as exc:
            raise _error("BACKUP_VERIFY_FAILED", str(exc), 422) from exc

    @router.post("/disaster/restore")
    async def restore_disaster_backup(body: DisasterRestoreRequest, authorization: str | None = Header(default=None)):
        identity = require_admin(authorization)
        if body.confirmation != "确认恢复":
            raise _error("CONFIRMATION_REQUIRED", "请输入“确认恢复”后再执行", 422)
        try:
            metrics = await run_in_threadpool(image_task_service.metrics)
            queue = metrics.get("queue") if isinstance(metrics.get("queue"), dict) else {}
            active_tasks = sum(int(queue.get(key) or 0) for key in ("queued", "paused", "running"))
            if active_tasks:
                raise BackupError(f"仍有 {active_tasks} 个图片任务未结束，不能执行灾备恢复")
            run = await run_in_threadpool(creative_operations_service.validate_restore_token, str(identity["id"]), body.run_id, body.restore_token)
            result = await run_in_threadpool(backup_service.restore_backup, str(run["backup_key"]), run_id=body.run_id)
            await run_in_threadpool(creative_operations_service.finish_restore, body.run_id, status="completed", rollback_path=str(result["rollback_path"]), detail=result)
            return {"data": result}
        except (BackupError, ValueError) as exc:
            await run_in_threadpool(creative_operations_service.finish_restore, body.run_id, status="failed", detail={"error": str(exc)})
            raise _error("BACKUP_RESTORE_FAILED", str(exc), 422) from exc

    return router
