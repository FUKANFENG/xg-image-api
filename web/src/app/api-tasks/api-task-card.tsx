"use client";

import {
  ArrowUpRight,
  Clock3,
  ImageIcon,
  KeyRound,
  Layers3,
  Maximize2,
} from "lucide-react";

import { RuntimeImage } from "@/components/runtime-image";
import { Button } from "@/components/ui/button";
import {
  API_IMAGE_TASK_STATUS,
  formatImageTaskBytes,
  formatImageTaskDuration,
  shortImageTaskId,
} from "@/lib/api-image-task-presentation";
import type { ImageTask } from "@/lib/api";
import { cn } from "@/lib/utils";

type ApiTaskCardProps = {
  task: ImageTask;
  onSelect: (task: ImageTask) => void;
};

const statusClassName = {
  queued:
    "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-400/20 dark:bg-amber-400/10 dark:text-amber-300",
  paused:
    "border-stone-200 bg-stone-100 text-stone-600 dark:border-white/10 dark:bg-white/5 dark:text-stone-300",
  running:
    "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-400/20 dark:bg-sky-400/10 dark:text-sky-300",
  success:
    "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-400/20 dark:bg-emerald-400/10 dark:text-emerald-300",
  error:
    "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-400/20 dark:bg-rose-400/10 dark:text-rose-300",
} as const;

const statusDotClassName = {
  queued: "bg-amber-500",
  paused: "bg-stone-400",
  running: "bg-sky-500",
  success: "bg-emerald-500",
  error: "bg-rose-500",
} as const;

function readableTime(value: string) {
  const date = new Date(value.replace(" ", "T"));
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

export function ApiTaskCard({ task, onSelect }: ApiTaskCardProps) {
  const status = API_IMAGE_TASK_STATUS[task.status];
  const images = task.data || [];
  const referenceImages = task.reference_images || [];
  const firstResult = images[0];
  const resultPreviewImage = images.find(
    (item) => item.url && item.storage !== "missing",
  );
  const referencePreviewImage = referenceImages.find((item) => item.url);
  const previewUrl = resultPreviewImage?.url || referencePreviewImage?.url;
  const showingReferencePreview = !resultPreviewImage && Boolean(referencePreviewImage);
  const sourceLabel = task.source === "api" ? "同步 API" : "异步队列";
  const caller = task.caller_key_name || task.owner_id || "系统调用";

  return (
    <article className="group grid min-w-0 grid-cols-[88px_minmax(0,1fr)] gap-3 rounded-xl border border-stone-200 bg-white p-3 shadow-[0_1px_2px_rgba(28,25,23,0.03)] transition hover:border-stone-300 hover:shadow-md sm:grid-cols-[116px_minmax(0,1fr)] sm:gap-4 sm:rounded-2xl sm:p-4 lg:grid-cols-[132px_minmax(0,1fr)_220px] dark:border-white/10 dark:bg-stone-900 dark:hover:border-white/20">
      <button
        type="button"
        onClick={() => onSelect(task)}
        className="relative size-[88px] overflow-hidden rounded-lg bg-stone-100 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-stone-900 sm:size-[116px] sm:rounded-xl lg:size-[132px] dark:bg-white/5 dark:focus-visible:ring-white"
        aria-label={`查看任务 ${task.id} 详情`}
      >
        {previewUrl ? (
          <RuntimeImage
            src={previewUrl}
            alt=""
            className="h-full w-full object-cover transition duration-300 group-hover:scale-[1.02]"
          />
        ) : (
          <span className="grid h-full place-items-center">
            {task.status === "running" ? (
              <span className="relative grid size-12 place-items-center rounded-2xl bg-sky-100 text-sky-600 dark:bg-sky-500/10 dark:text-sky-300">
                <span className="absolute inset-0 animate-ping rounded-2xl bg-sky-400/20" />
                <Layers3 className="relative size-5" />
              </span>
            ) : (
              <ImageIcon className="size-8 text-stone-300 dark:text-stone-600" />
            )}
          </span>
        )}
        {showingReferencePreview ? (
          <span className="absolute top-2 left-2 rounded-md bg-violet-600/90 px-1.5 py-0.5 text-[10px] font-bold text-white shadow-sm">
            参考图
          </span>
        ) : null}
        {images.length > 1 ? (
          <span className="absolute right-2 bottom-2 rounded-md bg-black/70 px-1.5 py-0.5 text-[11px] font-semibold text-white">
            +{images.length - 1}
          </span>
        ) : null}
      </button>

      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-bold",
              statusClassName[task.status],
            )}
          >
            <span
              className={cn(
                "size-1.5 rounded-full",
                statusDotClassName[task.status],
                task.status === "running" && "animate-pulse",
              )}
            />
            {status.label}
          </span>
          <span className="rounded-full bg-stone-100 px-2.5 py-1 text-xs font-semibold text-stone-600 dark:bg-white/10 dark:text-stone-300">
            {sourceLabel}
          </span>
          <span className="hidden text-xs text-stone-400 sm:inline">
            {task.mode === "edit" ? "图片编辑" : "文生图"}
          </span>
          {referenceImages.length ? (
            <span className="rounded-full bg-violet-50 px-2.5 py-1 text-xs font-semibold text-violet-700 dark:bg-violet-400/10 dark:text-violet-300">
              参考图 {referenceImages.length} 张
            </span>
          ) : null}
          {task.child_total && task.child_total > 1 ? (
            <span className="rounded-full bg-violet-50 px-2.5 py-1 text-xs font-semibold text-violet-700 dark:bg-violet-400/10 dark:text-violet-300">
              子任务 {task.completed_children || 0}/{task.child_total}
              {task.failed_children ? ` · 失败 ${task.failed_children}` : ""}
            </span>
          ) : null}
          <span className="hidden font-mono text-[11px] text-stone-400 sm:inline">
            {shortImageTaskId(task.id)}
          </span>
        </div>

        <button
          type="button"
          onClick={() => onSelect(task)}
          className="mt-2 block w-full text-left focus-visible:rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-stone-900 dark:focus-visible:ring-white"
        >
          <p className="line-clamp-2 text-sm leading-6 font-semibold text-stone-900 sm:text-[15px] dark:text-white">
            {task.prompt || task.error || "未记录提示词"}
          </p>
        </button>

        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1.5 text-xs text-stone-500 sm:mt-3 sm:gap-x-4 sm:gap-y-2 dark:text-stone-400">
          <span className="inline-flex items-center gap-1.5">
            <KeyRound className="size-3.5" />
            <span className="max-w-40 truncate" title={caller}>
              {caller}
            </span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Clock3 className="size-3.5" />
            {readableTime(task.created_at)}
          </span>
          <span className="hidden sm:inline">
            {task.model || "默认模型"} · {task.quality || "auto"} ·{" "}
            {task.size || "自动尺寸"}
          </span>
        </div>

        {task.error ? (
          <p className="mt-2 line-clamp-1 text-xs text-rose-600 dark:text-rose-300">
            {task.error}
          </p>
        ) : null}
      </div>

      <div className="col-span-2 flex flex-col justify-between gap-3 border-t border-stone-100 pt-3 sm:col-span-2 lg:col-span-1 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-4 dark:border-white/10">
        <dl className="grid grid-cols-3 gap-2 text-xs lg:grid-cols-1">
          <div className="min-w-0">
            <dt className="text-stone-400">耗时</dt>
            <dd className="mt-1 font-semibold text-stone-700 dark:text-stone-200">
              {formatImageTaskDuration(task.duration_ms, task.elapsed_secs)}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-stone-400">
              {task.child_total && task.child_total > 1 ? "子任务" : "结果"}
            </dt>
            <dd className="mt-1 font-semibold text-stone-700 dark:text-stone-200">
              {task.child_total && task.child_total > 1
                ? `${task.completed_children || 0}/${task.child_total}`
                : `${images.length || task.result_count || 0} 张`}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-stone-400">实际图片</dt>
            <dd className="mt-1 truncate font-semibold text-stone-700 dark:text-stone-200">
              {firstResult?.width && firstResult.height
                ? `${firstResult.width}×${firstResult.height}`
                : task.status === "success"
                  ? "未获取"
                  : "待生成"}
              {firstResult?.size_bytes
                ? ` · ${formatImageTaskBytes(firstResult.size_bytes)}`
                : ""}
            </dd>
          </div>
        </dl>
        <div className="flex items-center justify-end gap-2">
          {previewUrl ? (
            <Button
              variant="ghost"
              size="icon"
              className="rounded-lg text-stone-500"
              asChild
            >
              <a
                href={previewUrl}
                target="_blank"
                rel="noreferrer"
                aria-label="在新窗口打开图片"
              >
                <ArrowUpRight className="size-4" />
              </a>
            </Button>
          ) : null}
          <Button
            type="button"
            variant="outline"
            className="h-11 rounded-lg border-stone-200 bg-white px-3 text-xs sm:h-9 dark:border-white/10 dark:bg-stone-900"
            onClick={() => onSelect(task)}
          >
            <Maximize2 className="size-3.5" />
            查看详情
          </Button>
        </div>
      </div>
    </article>
  );
}
