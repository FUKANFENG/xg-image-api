from __future__ import annotations

from fastapi import APIRouter, Header, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field

from api.image_inputs import (
    parse_image_edit_request,
    persist_task_reference_images,
    read_image_sources,
)
from api.support import require_admin, require_identity, require_user_tool, resolve_image_base_url
from services.content_filter import check_request, request_shape, request_text
from services.editable_file_task_service import editable_file_task_service
from services.image_task_service import image_task_service
from services.log_service import LoggedCall
from services.prompt_enhancement_service import (
    PromptEnhancementError,
    PromptEnhancementProviderError,
    configured_model as prompt_enhancement_model,
    enhance_prompt,
)
from services.protocol import (
    anthropic_v1_messages,
    openai_v1_chat_complete,
    openai_v1_models,
    openai_v1_response,
    openai_search,
)


class ImageGenerationRequest(BaseModel):
    prompt: str = Field(..., min_length=1)
    model: str = "gpt-image-2"
    n: int = Field(default=1, ge=1, le=4)
    size: str | None = None
    quality: str = "auto"
    response_format: str = "b64_json"
    history_disabled: bool = True
    stream: bool | None = None


class ChatCompletionRequest(BaseModel):
    model_config = ConfigDict(extra="allow")
    model: str | None = None
    prompt: str | None = None
    n: int | None = None
    stream: bool | None = None
    modalities: list[str] | None = None
    messages: list[dict[str, object]] | None = None


class ResponseCreateRequest(BaseModel):
    model_config = ConfigDict(extra="allow")
    model: str | None = None
    input: object | None = None
    tools: list[dict[str, object]] | None = None
    tool_choice: object | None = None
    stream: bool | None = None


class AnthropicMessageRequest(BaseModel):
    model_config = ConfigDict(extra="allow")
    model: str | None = None
    messages: list[dict[str, object]] | None = None
    system: object | None = None
    stream: bool | None = None


class SearchRequest(BaseModel):
    prompt: str = Field(..., min_length=1)


class PromptEnhancementRequest(BaseModel):
    prompt: str = Field(..., min_length=1, max_length=2_000)
    instruction: str = Field(default="", max_length=500)


class EditableFileTaskRequest(BaseModel):
    prompt: str = ""
    base64_images: list[str] = Field(default_factory=list)
    client_task_id: str | None = None


async def filter_or_log(call: LoggedCall, text: str) -> None:
    try:
        await run_in_threadpool(check_request, text)
    except HTTPException as exc:
        call.log("调用失败", status="failed", error=str(exc.detail))
        raise


async def run_scheduled_chat_image(
    identity: dict[str, object],
    payload: dict[str, object],
):
    mode, image_payload = openai_v1_chat_complete.image_scheduler_payload(payload)
    if mode == "edit":
        result = await image_task_service.run_api_edit_async(
            identity,
            image_payload,
            endpoint="/v1/chat/completions",
        )
    else:
        result = await image_task_service.run_api_generation_async(
            identity,
            image_payload,
            endpoint="/v1/chat/completions",
        )
    if payload.get("stream"):
        return openai_v1_chat_complete.stream_scheduled_image_chat_completion(
            result,
            str(image_payload["model"]),
        )
    return openai_v1_chat_complete.image_chat_response_from_result(payload, result)


async def run_scheduled_response_image(
    identity: dict[str, object],
    payload: dict[str, object],
):
    mode, image_payload = openai_v1_response.response_image_scheduler_payload(payload)
    if mode == "edit":
        result = await image_task_service.run_api_edit_async(
            identity,
            image_payload,
            endpoint="/v1/responses",
        )
    else:
        result = await image_task_service.run_api_generation_async(
            identity,
            image_payload,
            endpoint="/v1/responses",
        )
    if payload.get("stream"):
        return openai_v1_response.stream_scheduled_image_response(result, payload)
    return openai_v1_response.response_image_from_result(payload, result)


def create_router() -> APIRouter:
    router = APIRouter()

    @router.get("/v1/models")
    async def list_models(authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        try:
            response = await run_in_threadpool(openai_v1_models.list_models)
            if identity.get("role") != "user" or not isinstance(response, dict):
                return response
            data = response.get("data")
            if not isinstance(data, list):
                return response
            return {
                **response,
                "data": [
                    item
                    for item in data
                    if isinstance(item, dict) and "image" in str(item.get("id") or "").lower()
                ],
            }
        except Exception as exc:
            raise HTTPException(status_code=502, detail={"error": str(exc)}) from exc

    @router.post("/v1/images/generations")
    async def generate_images(
            body: ImageGenerationRequest,
            request: Request,
            authorization: str | None = Header(default=None),
    ):
        identity = require_admin(authorization)
        payload = body.model_dump(mode="python")
        payload["base_url"] = resolve_image_base_url(request)
        call = LoggedCall(
            identity,
            "/v1/images/generations",
            body.model,
            "文生图",
            request_text=body.prompt,
        )
        await filter_or_log(call, body.prompt)
        return await call.run_async(
            image_task_service.run_api_generation_async,
            dict(identity),
            payload,
        )

    @router.post("/v1/images/edits")
    async def edit_images(
            request: Request,
            authorization: str | None = Header(default=None),
    ):
        identity = require_admin(authorization)
        payload, image_sources, mask_sources = await parse_image_edit_request(request)
        prompt = str(payload["prompt"])
        model = str(payload["model"])
        call = LoggedCall(
            identity,
            "/v1/images/edits",
            model,
            "图生图",
            request_text=prompt,
        )
        await filter_or_log(call, prompt)
        payload["images"] = await read_image_sources(image_sources)
        base_url = resolve_image_base_url(request)
        source_paths, source_names = await run_in_threadpool(
            persist_task_reference_images,
            payload["images"],
            base_url,
        )
        mask_paths: list[str] = []
        mask_names: list[str] = []
        if mask_sources:
            payload["mask"] = await read_image_sources(mask_sources)
            mask_paths, mask_names = await run_in_threadpool(
                persist_task_reference_images,
                payload["mask"],
                base_url,
            )
        payload["_task_workflow"] = {
            "source_path": source_paths[0] if source_paths else "",
            "source_paths": source_paths,
            "source_names": source_names,
            "mask_path": mask_paths[0] if mask_paths else "",
            "mask_paths": mask_paths,
            "mask_names": mask_names,
        }
        payload["base_url"] = base_url
        return await call.run_async(
            image_task_service.run_api_edit_async,
            dict(identity),
            payload,
        )

    @router.post("/v1/chat/completions")
    async def create_chat_completion(body: ChatCompletionRequest, authorization: str | None = Header(default=None)):
        identity = require_admin(authorization)
        payload = body.model_dump(mode="python")
        model = str(payload.get("model") or "auto")
        request_preview = request_text(payload.get("prompt"), payload.get("messages"))
        image_request = openai_v1_chat_complete.is_image_chat_request(payload)
        call = LoggedCall(
            identity,
            "/v1/chat/completions",
            model,
            "对话生图" if image_request else "文本生成",
            request_text=request_preview,
            request_shape=request_shape(payload.get("messages")),
        )
        await filter_or_log(call, request_preview)
        if image_request:
            return await call.run_async(
                run_scheduled_chat_image,
                dict(identity),
                payload,
            )
        return await call.run(openai_v1_chat_complete.handle, payload)

    @router.post("/v1/responses")
    async def create_response(body: ResponseCreateRequest, authorization: str | None = Header(default=None)):
        identity = require_admin(authorization)
        payload = body.model_dump(mode="python")
        model = str(payload.get("model") or "auto")
        request_preview = request_text(payload.get("input"), payload.get("instructions"))
        image_request = not openai_v1_response.is_text_response_request(payload)
        call = LoggedCall(
            identity,
            "/v1/responses",
            model,
            "Responses 生图" if image_request else "Responses",
            request_text=request_preview,
            request_shape=request_shape(payload.get("input")),
        )
        await filter_or_log(call, request_preview)
        if image_request:
            return await call.run_async(
                run_scheduled_response_image,
                dict(identity),
                payload,
            )
        return await call.run(openai_v1_response.handle, payload)

    @router.post("/v1/messages")
    async def create_message(
            body: AnthropicMessageRequest,
            authorization: str | None = Header(default=None),
            x_api_key: str | None = Header(default=None, alias="x-api-key"),
            anthropic_version: str | None = Header(default=None, alias="anthropic-version"),
    ):
        identity = require_admin(authorization or (f"Bearer {x_api_key}" if x_api_key else None))
        payload = body.model_dump(mode="python")
        model = str(payload.get("model") or "auto")
        request_preview = request_text(payload.get("system"), payload.get("messages"), payload.get("tools"))
        call = LoggedCall(identity, "/v1/messages", model, "Messages", request_text=request_preview)
        await filter_or_log(call, request_preview)
        return await call.run(anthropic_v1_messages.handle, payload, sse="anthropic")

    @router.post("/v1/search")
    async def search(body: SearchRequest, authorization: str | None = Header(default=None)):
        identity = require_user_tool(authorization, "search")
        call = LoggedCall(identity, "/v1/search", openai_search.MODEL, "搜索", request_text=body.prompt)
        await filter_or_log(call, body.prompt)
        return await call.run(openai_search.handle, body.model_dump(mode="python"))

    @router.post("/api/prompt-enhancements")
    async def enhance_image_prompt(body: PromptEnhancementRequest, authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        source_prompt = body.prompt.strip()
        enhancement_instruction = body.instruction.strip()
        if not source_prompt:
            raise HTTPException(status_code=422, detail={"error": "请先输入需要美化的提示词。"})
        request_preview = request_text(source_prompt, enhancement_instruction)
        call = LoggedCall(identity, "/api/prompt-enhancements", prompt_enhancement_model() or "configured-provider", "提示词美化", request_text=request_preview)
        await filter_or_log(call, request_preview)
        try:
            enhanced_prompt = await run_in_threadpool(enhance_prompt, source_prompt, enhancement_instruction)
        except PromptEnhancementProviderError:
            call.log("调用降级", status="fallback", result={"preserved_prompt_length": len(source_prompt)})
            return {
                "prompt": source_prompt,
                "fallback": True,
                "message": "智能美化服务暂时不可用，已保留原提示词，可直接生成或稍后重试。",
            }
        except PromptEnhancementError as exc:
            call.log("调用失败", status="failed", error=str(exc))
            raise HTTPException(status_code=503, detail={"error": str(exc)}) from exc
        call.log("调用完成", result={"enhanced_prompt_length": len(enhanced_prompt)})
        return {"prompt": enhanced_prompt, "fallback": False, "message": ""}

    @router.get("/v1/editable-file-tasks")
    async def list_editable_file_tasks(ids: str = "", authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        task_ids = [item.strip() for item in ids.split(",") if item.strip()]
        return await run_in_threadpool(editable_file_task_service.list_tasks, identity, task_ids)

    @router.get("/files/{file_path:path}")
    async def download_editable_file(file_path: str, authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        try:
            path = await run_in_threadpool(editable_file_task_service.owned_file_path, identity, file_path)
        except (FileNotFoundError, PermissionError, ValueError) as exc:
            raise HTTPException(status_code=404, detail={"error": "file not found"}) from exc
        return FileResponse(path, filename=path.name)

    @router.post("/v1/ppt/generations")
    async def create_ppt_task(body: EditableFileTaskRequest, request: Request, authorization: str | None = Header(default=None)):
        identity = require_user_tool(authorization, "ppt")
        await filter_or_log(LoggedCall(identity, "/v1/ppt/generations", "gpt-5-5-thinking", "PPT生成任务", request_text=body.prompt), body.prompt)
        return await run_in_threadpool(
            editable_file_task_service.submit_ppt,
            identity,
            client_task_id=body.client_task_id or "",
            prompt=body.prompt,
            base64_images=body.base64_images,
            base_url=resolve_image_base_url(request),
        )

    @router.post("/v1/psd/generations")
    async def create_psd_task(body: EditableFileTaskRequest, request: Request, authorization: str | None = Header(default=None)):
        identity = require_user_tool(authorization, "psd")
        await filter_or_log(LoggedCall(identity, "/v1/psd/generations", "gpt-5-5-thinking", "PSD生成任务", request_text=body.prompt), body.prompt)
        return await run_in_threadpool(
            editable_file_task_service.submit_psd,
            identity,
            client_task_id=body.client_task_id or "",
            prompt=body.prompt,
            base64_images=body.base64_images,
            base_url=resolve_image_base_url(request),
        )

    return router
