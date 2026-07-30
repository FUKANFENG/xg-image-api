"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BookmarkCheck,
  BookmarkPlus,
  ChevronLeft,
  ChevronRight,
  ImageIcon,
  LoaderCircle,
  MoreHorizontal,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  fetchInspirationCandidates,
  curateInspirationFromTask,
  type InspirationCandidate,
  type InspirationCandidatePagination,
} from "@/lib/api";

const CANDIDATES_PER_PAGE = 9;

const EMPTY_PAGINATION: InspirationCandidatePagination = {
  page: 1,
  page_size: CANDIDATES_PER_PAGE,
  total: 0,
  total_pages: 1,
};

function compactPrompt(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function getVisiblePages(
  page: number,
  totalPages: number,
): Array<number | "ellipsis"> {
  if (totalPages <= 5) {
    return Array.from({ length: totalPages }, (_, index) => index + 1);
  }

  const pageNumbers = [1, page - 1, page, page + 1, totalPages]
    .filter((value) => value >= 1 && value <= totalPages)
    .filter((value, index, values) => values.indexOf(value) === index)
    .sort((left, right) => left - right);
  const controls: Array<number | "ellipsis"> = [];
  pageNumbers.forEach((value, index) => {
    const previous = pageNumbers[index - 1];
    if (previous && value - previous > 1) {
      controls.push("ellipsis");
    }
    controls.push(value);
  });
  return controls;
}

export function InspirationCandidates() {
  const [items, setItems] = useState<InspirationCandidate[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [publishingKey, setPublishingKey] = useState("");
  const [page, setPage] = useState(1);
  const [pagination, setPagination] =
    useState<InspirationCandidatePagination>(EMPTY_PAGINATION);
  const requestIdRef = useRef(0);

  const load = useCallback(async (requestedPage: number) => {
    const requestId = ++requestIdRef.current;
    setIsLoading(true);
    try {
      const result = await fetchInspirationCandidates(
        requestedPage,
        CANDIDATES_PER_PAGE,
      );
      if (requestId !== requestIdRef.current) {
        return;
      }
      setItems(result.items);
      setPagination(result.pagination);
      setPage(result.pagination.page);
    } catch (error) {
      if (requestId !== requestIdRef.current) {
        return;
      }
      toast.error(error instanceof Error ? error.message : "灵感候选加载失败");
    } finally {
      if (requestId === requestIdRef.current) {
        setIsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load(1);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const visiblePages = useMemo(
    () => getVisiblePages(page, pagination.total_pages),
    [page, pagination.total_pages],
  );

  const changePage = (nextPage: number) => {
    if (
      isLoading ||
      nextPage < 1 ||
      nextPage > pagination.total_pages ||
      nextPage === page
    ) {
      return;
    }
    void load(nextPage);
  };

  const publish = async (candidate: InspirationCandidate) => {
    const key = `${candidate.owner_id}:${candidate.task_id}:${candidate.image_index}`;
    setPublishingKey(key);
    try {
      const result = await curateInspirationFromTask(candidate);
      setItems((current) =>
        current.map((item) =>
          item.owner_id === candidate.owner_id &&
          item.task_id === candidate.task_id &&
          item.image_index === candidate.image_index
            ? { ...item, is_curated: true }
            : item,
        ),
      );
      toast.success(
        result.created ? "已收录到用户灵感库" : "该作品已经收录过了",
      );
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "收录失败，请稍后重试",
      );
    } finally {
      setPublishingKey("");
    }
  };

  return (
    <section
      aria-labelledby="inspiration-candidates-heading"
      className="overflow-hidden rounded-2xl border border-violet-100 bg-violet-50/45 shadow-sm dark:border-violet-300/15 dark:bg-violet-400/[0.05]"
    >
      <div className="flex flex-col gap-3 border-b border-violet-100/80 px-4 py-4 dark:border-violet-300/15 sm:flex-row sm:items-center sm:justify-between sm:px-5">
        <div className="flex min-w-0 items-start gap-3">
          <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-violet-600 text-white shadow-sm dark:bg-violet-400 dark:text-violet-950">
            <Sparkles className="size-4" aria-hidden="true" />
          </div>
          <div>
            <div className="text-xs font-semibold tracking-[0.14em] text-violet-700 dark:text-violet-200">
              CURATION QUEUE
            </div>
            <h2
              id="inspiration-candidates-heading"
              className="mt-0.5 text-base font-semibold text-stone-950 dark:text-white"
            >
              待收录灵感
            </h2>
            <p className="mt-1 text-xs leading-5 text-stone-600 dark:text-stone-300">
              只展示已完成的用户文生图；点击一次即可把成图与提示词发布到用户灵感库。
            </p>
          </div>
        </div>
        <Button
          type="button"
          variant="outline"
          className="h-10 shrink-0 rounded-xl border-violet-200 bg-white text-violet-800 hover:bg-violet-50 dark:border-violet-300/25 dark:bg-white/[0.04] dark:text-violet-100 dark:hover:bg-violet-400/10"
          onClick={() => void load(page)}
          disabled={isLoading}
        >
          <RefreshCw
            className={`size-4 ${isLoading ? "animate-spin" : ""}`}
            aria-hidden="true"
          />
          刷新候选
        </Button>
      </div>

      {isLoading ? (
        <div
          className="grid min-h-40 place-items-center text-sm text-stone-500 dark:text-stone-400"
          aria-live="polite"
        >
          <span className="inline-flex items-center gap-2">
            <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
            正在读取用户作品
          </span>
        </div>
      ) : items.length === 0 ? (
        <div className="flex min-h-40 flex-col items-center justify-center px-5 text-center">
          <ImageIcon className="size-5 text-violet-500" aria-hidden="true" />
          <p className="mt-3 text-sm font-semibold text-stone-800 dark:text-stone-100">
            暂时没有可收录作品
          </p>
          <p className="mt-1 text-xs leading-5 text-stone-500 dark:text-stone-400">
            用户完成文生图后，会自动出现在这里供管理员筛选。
          </p>
        </div>
      ) : (
        <>
          <div className="grid gap-3 p-3 sm:grid-cols-2 xl:grid-cols-3">
            {items.map((candidate) => {
              const key = `${candidate.owner_id}:${candidate.task_id}:${candidate.image_index}`;
              const publishing = publishingKey === key;
              return (
                <article
                  key={key}
                  className="overflow-hidden rounded-xl border border-white/90 bg-white shadow-[0_10px_24px_-22px_rgba(76,29,149,0.55)] dark:border-white/10 dark:bg-stone-900"
                >
                  <div className="flex gap-3 p-3">
                    {/* Candidate images are stored by this application before reaching this admin-only queue. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={candidate.preview_url}
                      alt="用户生成作品预览"
                      className="size-20 shrink-0 rounded-lg object-cover"
                      loading="lazy"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="line-clamp-3 text-xs leading-5 text-stone-600 dark:text-stone-300">
                        {compactPrompt(candidate.prompt)}
                      </p>
                      <p className="mt-2 text-[11px] font-medium text-stone-400 dark:text-stone-500">
                        {candidate.size} · {candidate.quality}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-2 border-t border-stone-100 px-3 py-2.5 dark:border-white/10">
                    <span
                      className={
                        candidate.is_curated
                          ? "text-xs font-semibold text-emerald-700 dark:text-emerald-300"
                          : "text-xs text-stone-500 dark:text-stone-400"
                      }
                    >
                      {candidate.is_curated ? "已收录" : "用户文生图"}
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      className="h-10 rounded-lg bg-violet-700 text-white hover:bg-violet-800 dark:bg-violet-500 dark:hover:bg-violet-400"
                      onClick={() => void publish(candidate)}
                      disabled={candidate.is_curated || publishing}
                    >
                      {publishing ? (
                        <LoaderCircle
                          className="size-4 animate-spin"
                          aria-hidden="true"
                        />
                      ) : candidate.is_curated ? (
                        <BookmarkCheck className="size-4" aria-hidden="true" />
                      ) : (
                        <BookmarkPlus className="size-4" aria-hidden="true" />
                      )}
                      {candidate.is_curated ? "已收录" : "收录灵感"}
                    </Button>
                  </div>
                </article>
              );
            })}
          </div>

          {pagination.total_pages > 1 ? (
            <nav
              aria-label="待收录灵感分页"
              className="flex flex-col gap-3 border-t border-violet-100/80 px-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5 dark:border-violet-300/15"
            >
              <p
                className="text-xs leading-5 text-stone-500 dark:text-stone-400"
                aria-live="polite"
              >
                第{" "}
                <span className="font-semibold tabular-nums text-stone-700 dark:text-stone-200">
                  {page}
                </span>{" "}
                / {pagination.total_pages} 页 · 共 {pagination.total} 条候选
              </p>
              <div className="flex flex-wrap items-center gap-1.5">
                <Button
                  type="button"
                  variant="outline"
                  className="h-11 min-w-11 rounded-xl border-violet-200 bg-white px-3 text-violet-800 hover:bg-violet-50 disabled:cursor-not-allowed disabled:opacity-45 dark:border-violet-300/25 dark:bg-white/[0.04] dark:text-violet-100 dark:hover:bg-violet-400/10"
                  onClick={() => changePage(page - 1)}
                  disabled={isLoading || page <= 1}
                  aria-label="上一页候选"
                  title="上一页"
                >
                  <ChevronLeft className="size-4" aria-hidden="true" />
                  <span className="hidden sm:inline">上一页</span>
                </Button>
                {visiblePages.map((value, index) =>
                  value === "ellipsis" ? (
                    <span
                      key={`ellipsis-${index}`}
                      className="grid size-11 place-items-center text-stone-400"
                      aria-hidden="true"
                    >
                      <MoreHorizontal className="size-4" />
                    </span>
                  ) : (
                    <Button
                      key={value}
                      type="button"
                      variant="outline"
                      className={
                        value === page
                          ? "size-11 rounded-xl border-violet-700 bg-violet-700 p-0 font-semibold text-white hover:bg-violet-800 dark:border-violet-400 dark:bg-violet-500 dark:hover:bg-violet-400"
                          : "size-11 rounded-xl border-violet-200 bg-white p-0 text-violet-800 hover:bg-violet-50 disabled:cursor-not-allowed disabled:opacity-45 dark:border-violet-300/25 dark:bg-white/[0.04] dark:text-violet-100 dark:hover:bg-violet-400/10"
                      }
                      onClick={() => changePage(value)}
                      disabled={isLoading || value === page}
                      aria-current={value === page ? "page" : undefined}
                      aria-label={`第 ${value} 页`}
                    >
                      {value}
                    </Button>
                  ),
                )}
                <Button
                  type="button"
                  variant="outline"
                  className="h-11 min-w-11 rounded-xl border-violet-200 bg-white px-3 text-violet-800 hover:bg-violet-50 disabled:cursor-not-allowed disabled:opacity-45 dark:border-violet-300/25 dark:bg-white/[0.04] dark:text-violet-100 dark:hover:bg-violet-400/10"
                  onClick={() => changePage(page + 1)}
                  disabled={isLoading || page >= pagination.total_pages}
                  aria-label="下一页候选"
                  title="下一页"
                >
                  <span className="hidden sm:inline">下一页</span>
                  <ChevronRight className="size-4" aria-hidden="true" />
                </Button>
              </div>
            </nav>
          ) : null}
        </>
      )}
    </section>
  );
}
