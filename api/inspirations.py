from __future__ import annotations

from fastapi import APIRouter, Header, HTTPException, Query
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from api.support import require_admin, require_identity
from services.image_task_service import image_task_service
from services.inspiration_service import inspiration_service


class InspirationFromTaskRequest(BaseModel):
    owner_id: str = Field(..., min_length=1, max_length=160)
    task_id: str = Field(..., min_length=1, max_length=160)
    image_index: int = Field(default=0, ge=0, le=8)


def create_router() -> APIRouter:
    router = APIRouter()

    @router.get("/api/inspirations")
    async def list_inspirations(authorization: str | None = Header(default=None)):
        require_identity(authorization)
        return {"items": await run_in_threadpool(inspiration_service.list_public)}

    @router.get("/inspiration-images/{image_name}", include_in_schema=False)
    async def get_inspiration_image(image_name: str, authorization: str | None = Header(default=None)):
        require_identity(authorization)
        try:
            path = await run_in_threadpool(inspiration_service.get_archived_image_path, image_name)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail={"error": str(exc)}) from exc
        return FileResponse(path, media_type="image/png")

    @router.get("/api/admin/inspiration-candidates")
    async def list_inspiration_candidates(
        page: int = Query(default=1, ge=1),
        page_size: int = Query(default=24, ge=1, le=100),
        limit: int | None = Query(default=None, ge=1, le=100),
        authorization: str | None = Header(default=None),
    ):
        require_admin(authorization)
        # Keep the previous limit parameter working for existing internal integrations.
        effective_page_size = limit if limit is not None else page_size
        candidate_page = await run_in_threadpool(
            image_task_service.list_admin_inspiration_candidate_page,
            page,
            effective_page_size,
        )
        candidates = candidate_page["items"]
        for candidate in candidates:
            candidate["is_curated"] = inspiration_service.has_source(
                str(candidate.get("owner_id") or ""),
                str(candidate.get("task_id") or ""),
                int(candidate.get("image_index") or 0),
            )
        return {
            "items": candidates,
            "pagination": {
                "page": candidate_page["page"],
                "page_size": candidate_page["page_size"],
                "total": candidate_page["total"],
                "total_pages": candidate_page["total_pages"],
            },
        }

    @router.post("/api/admin/inspirations/from-task")
    async def curate_inspiration_from_task(
        body: InspirationFromTaskRequest,
        authorization: str | None = Header(default=None),
    ):
        require_admin(authorization)
        try:
            source = await run_in_threadpool(
                image_task_service.get_admin_inspiration_source,
                body.owner_id,
                body.task_id,
                body.image_index,
            )
            item, created = await run_in_threadpool(inspiration_service.curate_from_task, source)
            return {"item": item, "created": created}
        except LookupError as exc:
            raise HTTPException(status_code=404, detail={"error": str(exc)}) from exc
        except ValueError as exc:
            raise HTTPException(status_code=422, detail={"error": str(exc)}) from exc

    return router
