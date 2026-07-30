"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
} from "react";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  ClipboardPaste,
  Clock3,
  Download,
  Eye,
  ImageIcon,
  ImagePlus,
  LoaderCircle,
  RefreshCw,
  SlidersHorizontal,
  Sparkles,
  Square,
  Trash2,
  WandSparkles,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { ImageLightbox } from "@/components/image-lightbox";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  cancelImageTask,
  createImageEditTask,
  createImageGenerationTask,
  deleteFailedImageTask,
  enhanceImagePrompt,
  fetchAuthSession,
  fetchConsistencyProfiles,
  fetchCreativeRecipes,
  fetchImageQueueEstimate,
  fetchImageTasks,
  fetchModels,
  fetchStoredCreativeImageFile,
  retryImageGenerationTask,
  resumeImagePoll,
  type ConsistencyProfile,
  type ConsistencyStrength,
  type CreativeRecipe,
  type ImageModel,
  type ImageQueueEstimate,
  type ImageTask,
} from "@/lib/api";
import { consumeStudioPromptDraft } from "@/lib/creative-drafts";
import {
  imageSourceToReferenceFile,
  MAX_REFERENCE_IMAGES,
  validateReferenceImages,
} from "@/lib/image-references";
import {
  INSPIRATION_DRAFT_STORAGE_KEY,
  type InspirationDraft,
} from "@/lib/inspiration-templates";
import {
  getImageTaskErrorPresentation,
  getImageTaskProgressPresentation,
} from "@/lib/image-task-presentation";
import {
  getUserWebImageModels,
  resolveUserWebImageModel,
  USER_DEFAULT_IMAGE_MODEL,
} from "@/lib/image-model-policy";
import { paginateItems } from "@/lib/pagination";
import { createSingleFlightState, runSingleFlight } from "@/lib/single-flight";
import { useAuthGuard } from "@/lib/use-auth-guard";
import { cn } from "@/lib/utils";

const DEFAULT_IMAGE_MODEL = USER_DEFAULT_IMAGE_MODEL;
const TASK_POLL_INTERVAL_MS = 2_500;
const MAX_RENDERED_TASKS = 48;
const GALLERY_PAGE_SIZE = 6;

const sizeOptions = [
  { value: "1024x1024", label: "正方形 · 1024 × 1024" },
  { value: "1536x1024", label: "横向 · 1536 × 1024" },
  { value: "1024x1536", label: "纵向 · 1024 × 1536" },
];

const qualityOptions = [
  { value: "auto", label: "自动" },
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
];

function getImageModelDisplayName(model: ImageModel) {
  return model === USER_DEFAULT_IMAGE_MODEL ? "GPT Image 2" : model;
}

type StudioImage = {
  id: string;
  src: string;
};

type ReferenceImage = {
  id: string;
  file: File;
  previewUrl: string;
  sourceProfileId?: string;
};

function clipboardImageFileName(mimeType: string, index: number) {
  const extensionByMimeType: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
  };
  const extension = extensionByMimeType[mimeType.toLowerCase()] || "png";
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `截图-${timestamp}-${index + 1}.${extension}`;
}

async function readClipboardImageFiles() {
  if (!navigator.clipboard?.read) {
    throw new Error(
      "当前浏览器不支持一键读取剪贴板，请在参考图区按 Ctrl+V，或选择图片上传。",
    );
  }

  const clipboardItems = await navigator.clipboard.read();
  const imageFiles: File[] = [];
  for (const item of clipboardItems) {
    const imageType = item.types.find((type) => type.startsWith("image/"));
    if (!imageType) {
      continue;
    }
    const blob = await item.getType(imageType);
    imageFiles.push(
      new File([blob], clipboardImageFileName(imageType, imageFiles.length), {
        type: imageType,
        lastModified: Date.now(),
      }),
    );
  }

  if (imageFiles.length === 0) {
    throw new Error("剪贴板里没有截图，请先截图或复制一张图片后再试。");
  }
  return imageFiles;
}

function createClientTaskId() {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeImageUrl(value: string) {
  const source = String(value || "").trim();
  if (!source) {
    return "";
  }
  if (source.startsWith("/")) {
    return source;
  }
  try {
    const url = new URL(source);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : "";
  } catch {
    return "";
  }
}

function getTaskImages(task: ImageTask): StudioImage[] {
  return (task.data || []).flatMap((item, index) => {
    if (item.b64_json) {
      return [
        {
          id: `${task.id}-${index}-base64`,
          src: `data:image/png;base64,${item.b64_json}`,
        },
      ];
    }
    const src = normalizeImageUrl(item.url || "");
    return src ? [{ id: `${task.id}-${index}-url`, src }] : [];
  });
}

function triggerImageDownload(src: string, fileName: string) {
  const link = document.createElement("a");
  link.href = src;
  link.download = fileName;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

async function downloadStudioImage(
  image: StudioImage,
  taskId: string,
  index: number,
) {
  const fileName = `xg-image-${taskId}-${index + 1}.png`;
  let objectUrl = "";
  try {
    const response = await fetch(image.src);
    if (!response.ok) {
      throw new Error(`image download failed: ${response.status}`);
    }
    objectUrl = URL.createObjectURL(await response.blob());
    triggerImageDownload(objectUrl, fileName);
  } catch {
    // A cross-origin storage URL may not allow fetch; let the browser make a direct download attempt.
    triggerImageDownload(image.src, fileName);
  } finally {
    if (objectUrl) {
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
    }
  }
}

function formatTaskTime(value: string) {
  const timestamp = new Date(String(value || "").replace(" ", "T"));
  if (Number.isNaN(timestamp.getTime())) {
    return "刚刚";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);
}

function formatElapsedTime(seconds: number) {
  const totalSeconds = Math.max(
    0,
    Math.floor(Number.isFinite(seconds) ? seconds : 0),
  );
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const remainingSeconds = totalSeconds % 60;
  const twoDigits = (value: number) => String(value).padStart(2, "0");
  return hours > 0
    ? `${twoDigits(hours)}:${twoDigits(minutes)}:${twoDigits(remainingSeconds)}`
    : `${twoDigits(minutes)}:${twoDigits(remainingSeconds)}`;
}

function formatEstimateRange(estimate: ImageQueueEstimate) {
  const format = (seconds: number) =>
    seconds < 60
      ? `${Math.max(1, Math.round(seconds))} 秒`
      : `${Math.max(1, Math.ceil(seconds / 60))} 分钟`;
  const { low, high } = estimate.estimated_range_secs;
  return low === high ? format(low) : `${format(low)}–${format(high)}`;
}

function getTaskElapsedSeconds(
  task: ImageTask,
  nowMs: number,
  snapshotAtMs: number,
) {
  if (
    typeof task.elapsed_secs === "number" &&
    Number.isFinite(task.elapsed_secs)
  ) {
    return Math.max(
      0,
      task.elapsed_secs + Math.max(0, nowMs - snapshotAtMs) / 1_000,
    );
  }

  const createdAt = new Date(
    String(task.created_at || "").replace(" ", "T"),
  ).getTime();
  return Number.isNaN(createdAt) ? 0 : Math.max(0, (nowMs - createdAt) / 1_000);
}

function getTaskDurationLabel(task: ImageTask, liveElapsedSeconds: number) {
  const isPending = ["queued", "paused", "running"].includes(task.status);
  if (isPending) {
    return `已用时 ${formatElapsedTime(liveElapsedSeconds)}`;
  }
  if (
    typeof task.duration_ms === "number" &&
    Number.isFinite(task.duration_ms)
  ) {
    return `${task.status === "success" ? "生成耗时" : "任务耗时"} ${formatElapsedTime(task.duration_ms / 1_000)}`;
  }
  return "耗时未记录";
}

function getTaskStatus(task: ImageTask) {
  switch (task.status) {
    case "success":
      return {
        label: "已完成",
        title: "图片已完成",
        detail: "结果已准备好",
        className:
          "bg-emerald-50 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300",
      };
    case "error":
      const errorPresentation = getImageTaskErrorPresentation(
        task.error_code,
        task.error,
      );
      return {
        label: task.error_code === "cancelled_by_user" ? "已停止" : "需处理",
        title: errorPresentation.title,
        detail: errorPresentation.detail,
        action: errorPresentation.action,
        className:
          task.error_code === "cancelled_by_user"
            ? "bg-stone-100 text-stone-600 dark:bg-white/10 dark:text-stone-300"
            : "bg-rose-50 text-rose-700 dark:bg-rose-400/10 dark:text-rose-300",
      };
    case "running":
      const progress = getImageTaskProgressPresentation(task.progress);
      return {
        label: progress.label,
        title: `正在${progress.label}`,
        detail: "任务状态会自动更新，离开当前页面也不会中断生成。",
        className:
          "bg-violet-50 text-violet-700 dark:bg-violet-400/10 dark:text-violet-200",
      };
    case "paused":
      return {
        label: "已暂停",
        title: "任务已暂停",
        detail: "任务和已预留额度均已保留，可在队列页调整优先级或继续执行。",
        className:
          "bg-sky-50 text-sky-700 dark:bg-sky-400/10 dark:text-sky-200",
      };
    default:
      return {
        label: "等待中",
        title: "任务正在排队",
        detail: task.queue_position
          ? `前方 ${Math.max(0, task.queue_position - 1)} 个任务，预计等待约 ${Math.max(1, Math.ceil((task.estimated_wait_secs || 0) / 60))} 分钟。`
          : "任务已提交，正在等待可用绘图通道。",
        className:
          "bg-amber-50 text-amber-700 dark:bg-amber-400/10 dark:text-amber-200",
      };
  }
}

function StudioTaskCard({
  task,
  variant = "gallery",
  elapsedSeconds = 0,
  onRetry,
  onCancel,
  onRecreate,
  onDelete,
  onRemix,
  preparingRemixImageId = "",
  isRetrying = false,
  isCancelling = false,
  isDeleting = false,
  isFeatured = false,
}: {
  task: ImageTask;
  variant?: "gallery" | "status";
  elapsedSeconds?: number;
  onRetry?: (task: ImageTask) => void | Promise<void>;
  onCancel?: (task: ImageTask) => void | Promise<void>;
  onRecreate?: (task: ImageTask) => void;
  onDelete?: (task: ImageTask) => void | Promise<void>;
  onRemix?: (
    image: StudioImage,
    index: number,
    task: ImageTask,
  ) => void | Promise<void>;
  preparingRemixImageId?: string;
  isRetrying?: boolean;
  isCancelling?: boolean;
  isDeleting?: boolean;
  isFeatured?: boolean;
}) {
  const images = getTaskImages(task);
  const status = getTaskStatus(task);
  const progressPresentation = getImageTaskProgressPresentation(
    task.status === "queued" || task.status === "paused"
      ? "queued"
      : task.progress,
  );
  const isPending = ["queued", "paused", "running"].includes(task.status);
  const isGenerating = task.status === "running";
  const durationLabel = getTaskDurationLabel(task, elapsedSeconds);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [previewIndex, setPreviewIndex] = useState(0);

  const openPreview = (index: number) => {
    setPreviewIndex(index);
    setIsPreviewOpen(true);
  };

  if (variant === "status") {
    return (
      <article
        className={cn(
          "relative overflow-hidden rounded-2xl border p-4 shadow-[0_12px_28px_-24px_rgba(41,37,36,0.42)] transition-shadow duration-200 hover:shadow-[0_16px_32px_-24px_rgba(109,40,217,0.2)] motion-reduce:transition-none",
          isFeatured && isPending
            ? "border-violet-200/90 bg-gradient-to-br from-white via-violet-50/70 to-fuchsia-50/50 dark:border-violet-400/25 dark:from-stone-900 dark:via-violet-950/35 dark:to-stone-900"
            : "border-stone-200/80 bg-white dark:border-white/10 dark:bg-stone-900",
        )}
      >
        <div
          className={cn(
            "relative",
            isFeatured &&
              "grid gap-4 md:grid-cols-[minmax(0,1fr)_13rem] md:items-stretch",
          )}
        >
          <div className="flex min-w-0 flex-col">
            <div className="flex items-center justify-between gap-3">
              <span
                className={cn(
                  "rounded-full px-2.5 py-1 text-xs font-semibold",
                  status.className,
                )}
              >
                {status.label}
              </span>
              <span className="inline-flex shrink-0 items-center gap-1 text-xs text-stone-500 dark:text-stone-400">
                <Clock3 className="size-3.5" aria-hidden="true" />
                {formatTaskTime(task.created_at)}
              </span>
            </div>
            <div className="mt-4 flex min-w-0 gap-3">
              <span
                aria-hidden="true"
                className={cn(
                  "relative grid size-11 shrink-0 place-items-center rounded-2xl",
                  isPending
                    ? "bg-violet-100 text-violet-700 dark:bg-violet-400/15 dark:text-violet-200"
                    : "bg-stone-100 text-stone-400 dark:bg-white/10",
                )}
              >
                {isGenerating ? (
                  <span className="absolute inset-0 rounded-2xl border border-violet-300/70 motion-safe:animate-ping motion-reduce:animate-none dark:border-violet-300/35" />
                ) : null}
                {isPending ? (
                  <LoaderCircle
                    className={cn(
                      "relative size-5",
                      isGenerating && "animate-spin motion-reduce:animate-none",
                    )}
                  />
                ) : (
                  <ImageIcon className="size-5" />
                )}
              </span>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-stone-800 dark:text-stone-100">
                  {status.title}
                </p>
                <p className="mt-1 text-sm leading-6 text-stone-600 dark:text-stone-300">
                  {status.detail}
                </p>
              </div>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
              <span className="rounded-lg bg-white/80 px-2.5 py-1.5 font-medium text-stone-700 shadow-sm dark:bg-white/10 dark:text-stone-200">
                {task.model || DEFAULT_IMAGE_MODEL}
              </span>
              {task.size ? (
                <span className="rounded-lg bg-white/80 px-2.5 py-1.5 text-stone-600 shadow-sm dark:bg-white/10 dark:text-stone-300">
                  {task.size}
                </span>
              ) : null}
              <span
                className="inline-flex items-center gap-1.5 rounded-lg bg-white/80 px-2.5 py-1.5 text-stone-600 shadow-sm dark:bg-white/10 dark:text-stone-300"
                aria-label={durationLabel}
              >
                <Clock3 className="size-3.5" aria-hidden="true" />
                <span className="tabular-nums">{durationLabel}</span>
              </span>
            </div>
            {isPending ? (
              <div
                className="mt-4 rounded-xl border border-violet-100 bg-violet-50/45 p-3 dark:border-violet-400/15 dark:bg-violet-400/[0.06]"
                aria-label={`当前阶段：${progressPresentation.label}`}
              >
                <div className="flex items-center justify-between gap-3 text-xs font-semibold text-violet-800 dark:text-violet-100">
                  <span>生成进度</span>
                  <span className="tabular-nums font-medium text-violet-700/75 dark:text-violet-200/75">
                    {durationLabel}
                  </span>
                </div>
                <div className="mt-3 grid grid-cols-5 gap-1" aria-hidden="true">
                  {progressPresentation.stages.map((stage, index) => (
                    <div key={stage} className="min-w-0 text-center">
                      <span
                        className={cn(
                          "mx-auto block h-1.5 rounded-full transition-colors duration-200 motion-reduce:transition-none",
                          index <= progressPresentation.activeIndex
                            ? "bg-violet-600 dark:bg-violet-300"
                            : "bg-violet-100 dark:bg-violet-400/15",
                        )}
                      />
                      <span
                        className={cn(
                          "mt-1.5 hidden truncate text-[10px] sm:block",
                          index === progressPresentation.activeIndex
                            ? "font-semibold text-violet-800 dark:text-violet-100"
                            : "text-violet-500/70 dark:text-violet-200/55",
                        )}
                      >
                        {stage}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
            {task.prompt ? (
              <div className="mt-4 rounded-xl border border-stone-200/80 bg-white/65 px-3 py-2.5 dark:border-white/10 dark:bg-white/[0.04]">
                <p className="text-[11px] font-semibold tracking-wide text-stone-500 dark:text-stone-400">
                  提示词
                </p>
                <p
                  className="mt-1 line-clamp-2 text-xs leading-5 text-stone-700 dark:text-stone-200"
                  title={task.prompt}
                >
                  {task.prompt}
                </p>
              </div>
            ) : null}
            {isPending && onCancel ? (
              <Button
                type="button"
                variant="outline"
                className="mt-4 h-11 w-full rounded-xl border-stone-200 bg-white/80 text-stone-700 hover:border-rose-200 hover:bg-rose-50 hover:text-rose-700 dark:border-white/15 dark:bg-white/[0.05] dark:text-stone-200 dark:hover:border-rose-400/30 dark:hover:bg-rose-400/10 dark:hover:text-rose-200"
                onClick={() => void onCancel(task)}
                disabled={isCancelling}
                aria-label="停止当前图片生成任务"
              >
                {isCancelling ? (
                  <LoaderCircle className="size-4 animate-spin" />
                ) : (
                  <Square className="size-3.5 fill-current" />
                )}
                {isCancelling ? "正在停止" : "停止生成"}
              </Button>
            ) : null}
            {task.status === "error" ? (
              <div
                className={cn(
                  "mt-4 grid gap-2",
                  task.mode === "generate" ? "sm:grid-cols-2" : "grid-cols-1",
                )}
              >
                {task.mode === "generate" ? (
                  <Button
                    type="button"
                    variant={task.retryable ? "default" : "outline"}
                    className={cn(
                      "h-11 w-full rounded-xl",
                      task.retryable &&
                        "bg-violet-700 text-white hover:bg-violet-800 dark:bg-violet-500 dark:hover:bg-violet-400",
                    )}
                    onClick={() => {
                      if (task.retryable) {
                        void onRetry?.(task);
                      } else {
                        onRecreate?.(task);
                      }
                    }}
                    disabled={isRetrying || isDeleting}
                    aria-label={
                      task.retryable
                        ? task.recovery_mode === "resume_poll"
                          ? "从上次断点继续生成"
                          : "使用原提示词重新生成"
                        : "重新填写提示词后生成"
                    }
                  >
                    {isRetrying ? (
                      <LoaderCircle className="size-4 animate-spin" />
                    ) : (
                      <RefreshCw className="size-4" />
                    )}
                    {isRetrying
                      ? task.recovery_mode === "resume_poll"
                        ? "正在续跑"
                        : "正在重新提交"
                      : task.retryable
                        ? task.recovery_mode === "resume_poll"
                          ? "继续生成"
                          : "重新生成"
                        : "重新填写提示词"}
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="outline"
                  className="h-11 w-full rounded-xl border-rose-200 bg-rose-50/50 text-rose-700 hover:bg-rose-100 hover:text-rose-800 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200 dark:hover:bg-rose-500/20 dark:hover:text-rose-100"
                  onClick={() => void onDelete?.(task)}
                  disabled={isRetrying || isDeleting}
                  aria-label="删除失败任务记录"
                >
                  {isDeleting ? (
                    <LoaderCircle className="size-4 animate-spin" />
                  ) : (
                    <Trash2 className="size-4" />
                  )}
                  {isDeleting ? "正在删除" : "删除记录"}
                </Button>
              </div>
            ) : null}
          </div>
          {isFeatured && isPending ? (
            <div
              aria-hidden="true"
              className="relative min-h-44 overflow-hidden rounded-2xl border border-violet-100/80 bg-[radial-gradient(circle_at_28%_28%,rgba(196,181,253,0.78),transparent_30%),radial-gradient(circle_at_76%_72%,rgba(251,207,232,0.78),transparent_34%),linear-gradient(135deg,rgba(255,255,255,0.92),rgba(245,243,255,0.86))] dark:border-violet-400/20 dark:bg-[radial-gradient(circle_at_28%_28%,rgba(109,40,217,0.34),transparent_30%),radial-gradient(circle_at_76%_72%,rgba(190,24,93,0.3),transparent_34%),linear-gradient(135deg,rgba(24,24,27,0.94),rgba(46,16,101,0.72))]"
            >
              <span className="absolute -left-10 -top-10 size-32 rounded-full bg-white/75 blur-2xl motion-safe:animate-[xg-generation-glow_3.2s_ease-in-out_infinite] motion-reduce:animate-none dark:bg-violet-300/20" />
              <span className="absolute -right-10 -bottom-10 size-36 rounded-full bg-fuchsia-200/70 blur-2xl motion-safe:animate-[xg-generation-glow_3.2s_ease-in-out_infinite_reverse] motion-reduce:animate-none dark:bg-fuchsia-400/15" />
              <div className="absolute inset-4 rounded-xl border border-white/60 bg-white/30 dark:border-white/10 dark:bg-white/[0.03]" />
              <div className="relative z-10 flex h-full min-h-44 flex-col items-center justify-center gap-3 text-center">
                <span className="grid size-12 place-items-center rounded-2xl bg-white/80 text-violet-700 shadow-[0_12px_26px_-16px_rgba(109,40,217,0.72)] dark:bg-stone-950/65 dark:text-violet-200">
                  <Sparkles className="size-5 motion-safe:animate-pulse motion-reduce:animate-none" />
                </span>
                <div>
                  <p className="text-sm font-semibold text-violet-950 dark:text-violet-100">
                    生成画布已启动
                  </p>
                  <p className="mt-1 text-xs text-violet-800/75 dark:text-violet-200/75">
                    画面将在完成后自动展示
                  </p>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </article>
    );
  }

  return (
    <article className="group overflow-hidden rounded-[1.35rem] border border-stone-200/80 bg-white shadow-[0_14px_34px_-28px_rgba(41,37,36,0.42)] transition-shadow duration-200 hover:shadow-[0_20px_42px_-26px_rgba(109,40,217,0.24)] motion-reduce:transition-none dark:border-white/10 dark:bg-stone-900">
      <div
        className={cn(
          "grid gap-px overflow-hidden bg-stone-200 dark:bg-white/10",
          images.length === 1 ? "grid-cols-1" : "grid-cols-2",
        )}
      >
        {images.map((image, index) => (
          <div
            key={image.id}
            className="relative aspect-square overflow-hidden bg-stone-100 dark:bg-white/10"
          >
            <button
              type="button"
              onClick={() => openPreview(index)}
              className="relative block size-full cursor-zoom-in overflow-hidden text-left outline-none ring-inset transition focus-visible:ring-2 focus-visible:ring-violet-600"
              aria-label={`预览第 ${index + 1} 张生成结果`}
            >
              {/* Dynamic task URLs and data URLs cannot use the static image optimizer. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={image.src}
                alt={`生成结果 ${index + 1}`}
                className="size-full object-cover transition duration-300 group-hover:scale-[1.02] motion-reduce:transition-none"
                loading="lazy"
              />
              <span className="pointer-events-none absolute bottom-2 left-2 inline-flex h-9 items-center gap-1.5 rounded-full bg-black/60 px-3 text-xs font-medium text-white opacity-100 transition sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 motion-reduce:transition-none">
                <Eye className="size-4" aria-hidden="true" />
                预览
              </span>
            </button>
            <button
              type="button"
              onClick={() => void downloadStudioImage(image, task.id, index)}
              className="absolute top-2 right-2 z-10 inline-flex size-11 items-center justify-center rounded-full bg-black/65 text-white shadow-sm transition hover:bg-black/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-stone-900"
              aria-label={`下载第 ${index + 1} 张生成结果`}
              title="下载图片"
            >
              <Download className="size-4" aria-hidden="true" />
            </button>
            {onRemix ? (
              <button
                type="button"
                onClick={() => void onRemix(image, index, task)}
                className="absolute right-2 bottom-2 z-10 inline-flex h-11 items-center justify-center gap-1.5 rounded-full bg-white/92 px-3 text-xs font-semibold text-violet-800 shadow-sm backdrop-blur transition hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2 dark:bg-stone-950/90 dark:text-violet-200 dark:hover:bg-stone-950 dark:focus-visible:ring-offset-stone-900"
                aria-label={`基于第 ${index + 1} 张生成结果进行二创`}
                disabled={Boolean(preparingRemixImageId)}
              >
                {preparingRemixImageId === image.id ? (
                  <LoaderCircle
                    className="size-3.5 animate-spin"
                    aria-hidden="true"
                  />
                ) : (
                  <WandSparkles className="size-3.5" aria-hidden="true" />
                )}
                {preparingRemixImageId === image.id ? "读取中" : "二创"}
              </button>
            ) : null}
          </div>
        ))}
      </div>

      <div className="space-y-3 p-3.5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1.5">
            <span
              className={cn(
                "inline-flex rounded-full px-2.5 py-1 text-xs font-semibold",
                status.className,
              )}
            >
              {status.label}
            </span>
            <p
              className="truncate text-sm font-medium text-stone-800 dark:text-stone-100"
              title={task.model || DEFAULT_IMAGE_MODEL}
            >
              {task.model || DEFAULT_IMAGE_MODEL}
            </p>
          </div>
          <div className="shrink-0 space-y-1.5 text-right text-xs text-stone-500 dark:text-stone-400">
            {task.size ? (
              <span className="inline-flex rounded-md bg-stone-100 px-2 py-1 dark:bg-white/10">
                {task.size}
              </span>
            ) : null}
            <span
              className="block"
              title={`创建于 ${formatTaskTime(task.created_at)}`}
            >
              {formatTaskTime(task.created_at)}
            </span>
          </div>
        </div>
        <div className="rounded-xl border border-stone-200/80 bg-stone-50/80 px-3 py-2.5 dark:border-white/10 dark:bg-white/[0.04]">
          <div className="flex items-center justify-between gap-3">
            <p className="text-[11px] font-semibold tracking-wide text-stone-500 dark:text-stone-400">
              提示词
            </p>
            <span
              className="inline-flex shrink-0 items-center gap-1.5 text-xs text-stone-500 dark:text-stone-300"
              aria-label={durationLabel}
            >
              <Clock3 className="size-3.5" aria-hidden="true" />
              <span className="tabular-nums">{durationLabel}</span>
            </span>
          </div>
          {task.prompt ? (
            <p
              className="mt-1.5 line-clamp-3 text-sm leading-6 text-stone-700 dark:text-stone-200"
              title={task.prompt}
            >
              {task.prompt}
            </p>
          ) : (
            <p className="mt-1.5 text-sm leading-6 text-stone-400 dark:text-stone-500">
              历史记录未保留提示词
            </p>
          )}
        </div>
      </div>

      {images.length > 0 ? (
        <ImageLightbox
          images={images.map((image) => ({ ...image, sizeLabel: task.size }))}
          currentIndex={previewIndex}
          open={isPreviewOpen}
          onOpenChange={setIsPreviewOpen}
          onIndexChange={setPreviewIndex}
        />
      ) : null}
    </article>
  );
}

export default function StudioPage() {
  const { isCheckingAuth, session } = useAuthGuard(["user"]);
  const subjectId = session?.subjectId;
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const referenceInputRef = useRef<HTMLInputElement>(null);
  const gallerySectionRef = useRef<HTMLElement>(null);
  const referenceImagesRef = useRef<ReferenceImage[]>([]);
  const selectedProfileRef = useRef("");
  const taskMutationVersionRef = useRef(0);
  const taskFetchFlightRef = useRef(
    createSingleFlightState<{
      data: Awaited<ReturnType<typeof fetchImageTasks>>;
      mutationVersion: number;
    }>(),
  );
  const [prompt, setPrompt] = useState("");
  const [promptBeforeEnhancement, setPromptBeforeEnhancement] = useState("");
  const [enhancementInstruction, setEnhancementInstruction] = useState("");
  const [model, setModel] = useState<ImageModel>(DEFAULT_IMAGE_MODEL);
  const [models, setModels] = useState<ImageModel[]>([DEFAULT_IMAGE_MODEL]);
  const [size, setSize] = useState(sizeOptions[0].value);
  const [quality, setQuality] = useState("auto");
  const [recipeId, setRecipeId] = useState("");
  const [profileId, setProfileId] = useState("");
  const [profileStrength, setProfileStrength] =
    useState<ConsistencyStrength>("balanced");
  const [priority, setPriority] = useState(0);
  const [recipes, setRecipes] = useState<CreativeRecipe[]>([]);
  const [profiles, setProfiles] = useState<ConsistencyProfile[]>([]);
  const [referenceImages, setReferenceImages] = useState<ReferenceImage[]>([]);
  const [workflowDraft, setWorkflowDraft] = useState<{
    asset_id?: string;
    parent_version_id?: string;
    branch_id?: string;
  }>({});
  const [isReferencePanelOpen, setIsReferencePanelOpen] = useState(false);
  const [referenceError, setReferenceError] = useState("");
  const [isDraggingReference, setIsDraggingReference] = useState(false);
  const [isReadingClipboard, setIsReadingClipboard] = useState(false);
  const [preparingRemixImageId, setPreparingRemixImageId] = useState("");
  const [tasks, setTasks] = useState<ImageTask[]>([]);
  const [queueEstimate, setQueueEstimate] = useState<ImageQueueEstimate | null>(
    null,
  );
  const [galleryPage, setGalleryPage] = useState(1);
  const [resultView, setResultView] = useState<"current" | "gallery">(
    "current",
  );
  const [taskSnapshotAtMs, setTaskSnapshotAtMs] = useState(() => Date.now());
  const [clockNowMs, setClockNowMs] = useState(() => Date.now());
  const [isLoadingTasks, setIsLoadingTasks] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isEnhancingPrompt, setIsEnhancingPrompt] = useState(false);
  const [promptError, setPromptError] = useState("");
  const [taskLoadError, setTaskLoadError] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const [remainingQuota, setRemainingQuota] = useState<number | null>(null);
  const [retryingTaskIds, setRetryingTaskIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [cancellingTaskIds, setCancellingTaskIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [deletingTaskIds, setDeletingTaskIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [deleteConfirmTask, setDeleteConfirmTask] = useState<ImageTask | null>(
    null,
  );

  const hasReferenceImages = referenceImages.length > 0;
  const selectedSizeLabel =
    sizeOptions.find((option) => option.value === size)?.label || size;
  const selectedQualityLabel =
    qualityOptions.find((option) => option.value === quality)?.label || "自动";
  const selectedModelLabel = getImageModelDisplayName(model);

  const replaceReferenceImages = useCallback((next: ReferenceImage[]) => {
    referenceImagesRef.current = next;
    setReferenceImages(next);
  }, []);

  const addReferenceFiles = useCallback(
    (files: Iterable<File>) => {
      setIsReferencePanelOpen(true);
      const validation = validateReferenceImages(
        files,
        referenceImagesRef.current.length,
      );
      const errorMessage = validation.errors.join(" ");
      setReferenceError(errorMessage);
      if (errorMessage) {
        setAnnouncement(errorMessage);
      }
      if (validation.accepted.length === 0) {
        return false;
      }

      const additions = validation.accepted.map((file) => ({
        id: createClientTaskId(),
        file,
        previewUrl: URL.createObjectURL(file),
      }));
      const next = [...referenceImagesRef.current, ...additions];
      replaceReferenceImages(next);
      if (!errorMessage) {
        setAnnouncement(
          `已添加 ${validation.accepted.length} 张参考图，当前为图片二创模式。`,
        );
      }
      return true;
    },
    [replaceReferenceImages],
  );

  const selectConsistencyProfile = async (nextId: string) => {
    selectedProfileRef.current = nextId;
    setProfileId(nextId);
    const retained = referenceImagesRef.current.filter((image) => {
      if (!image.sourceProfileId) return true;
      URL.revokeObjectURL(image.previewUrl);
      return false;
    });
    replaceReferenceImages(retained);
    const profile = profiles.find((item) => item.id === nextId);
    if (!profile || !nextId) {
      setProfileStrength("balanced");
      return;
    }
    setProfileStrength(profile.default_strength);
    const paths = [...profile.logo_paths, ...profile.reference_paths].slice(
      0,
      Math.max(0, MAX_REFERENCE_IMAGES - retained.length),
    );
    if (!paths.length) return;
    setIsReferencePanelOpen(true);
    try {
      const files = await Promise.all(
        paths.map((path, index) =>
          fetchStoredCreativeImageFile(
            path,
            `${profile.name}-${index + 1}.png`,
          ),
        ),
      );
      if (selectedProfileRef.current !== nextId) return;
      const additions = files.map((file) => ({
        id: createClientTaskId(),
        file,
        previewUrl: URL.createObjectURL(file),
        sourceProfileId: nextId,
      }));
      replaceReferenceImages([...retained, ...additions]);
      setAnnouncement(
        `已载入 ${additions.length} 张「${profile.name}」一致性参考图。`,
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "一致性参考图加载失败";
      setReferenceError(message);
      toast.error(message);
    }
  };

  const removeReferenceImage = (id: string) => {
    const removed = referenceImagesRef.current.find((image) => image.id === id);
    if (removed) {
      URL.revokeObjectURL(removed.previewUrl);
    }
    const next = referenceImagesRef.current.filter((image) => image.id !== id);
    replaceReferenceImages(next);
    setReferenceError("");
    setAnnouncement(
      next.length > 0
        ? `已移除参考图，还剩 ${next.length} 张。`
        : "参考图已清空，已切回文字生图模式。",
    );
  };

  const clearReferenceImages = () => {
    referenceImagesRef.current.forEach((image) =>
      URL.revokeObjectURL(image.previewUrl),
    );
    replaceReferenceImages([]);
    setIsReferencePanelOpen(false);
    setReferenceError("");
    if (referenceInputRef.current) {
      referenceInputRef.current.value = "";
    }
  };

  const visibleTasks = useMemo(
    () => tasks.slice(0, MAX_RENDERED_TASKS),
    [tasks],
  );
  const { galleryTasks, statusTasks, completedTaskCount, activeTaskCount } =
    useMemo(() => {
      const gallery: ImageTask[] = [];
      const status: ImageTask[] = [];
      let completed = 0;
      let active = 0;

      for (const task of visibleTasks) {
        if (task.status === "success") {
          completed += 1;
        }
        if (["queued", "paused", "running"].includes(task.status)) {
          active += 1;
        }
        if (getTaskImages(task).length > 0) {
          gallery.push(task);
        } else {
          status.push(task);
        }
      }

      return {
        galleryTasks: gallery,
        statusTasks: status,
        completedTaskCount: completed,
        activeTaskCount: active,
      };
    }, [visibleTasks]);
  const pagedGallery = useMemo(
    () => paginateItems(galleryTasks, galleryPage, GALLERY_PAGE_SIZE),
    [galleryPage, galleryTasks],
  );
  const currentViewTasks = useMemo(
    () => (statusTasks.length > 0 ? statusTasks : visibleTasks.slice(0, 1)),
    [statusTasks, visibleTasks],
  );
  const hasPendingTasks = tasks.some((task) =>
    ["queued", "paused", "running"].includes(task.status),
  );
  const changeGalleryPage = (nextPage: number) => {
    const targetPage = Math.min(Math.max(1, nextPage), pagedGallery.totalPages);
    if (targetPage === pagedGallery.page) {
      return;
    }

    setGalleryPage(targetPage);
    gallerySectionRef.current?.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
      block: "start",
    });
    setAnnouncement(
      `已切换至最近作品第 ${targetPage} 页，共 ${pagedGallery.totalPages} 页。`,
    );
  };
  const markTaskSnapshot = useCallback(() => {
    const nowMs = Date.now();
    setTaskSnapshotAtMs(nowMs);
    setClockNowMs(nowMs);
  }, []);
  const loadQueueEstimate = useCallback(async () => {
    try {
      setQueueEstimate(await fetchImageQueueEstimate());
    } catch {
      setQueueEstimate(null);
    }
  }, []);

  const loadTasks = useCallback(
    async (silent = false) => {
      if (!silent) {
        setIsRefreshing(true);
      }
      try {
        const snapshot = await runSingleFlight(
          taskFetchFlightRef.current,
          async () => {
            const mutationVersion = taskMutationVersionRef.current;
            return { data: await fetchImageTasks([]), mutationVersion };
          },
        );
        if (snapshot.mutationVersion === taskMutationVersionRef.current) {
          setTasks(
            Array.isArray(snapshot.data.items) ? snapshot.data.items : [],
          );
          markTaskSnapshot();
        }
        setTaskLoadError("");
        if (!silent) {
          try {
            const profile = await fetchAuthSession();
            setRemainingQuota(
              profile.authenticated && typeof profile.image_quota === "number"
                ? profile.image_quota
                : null,
            );
          } catch {
            // 任务列表已经成功返回；下次手动刷新时再同步剩余额度。
          }
        }
      } catch (error) {
        if (!silent) {
          const message =
            error instanceof Error ? error.message : "读取任务记录失败";
          setTaskLoadError(message);
          toast.error(message);
        }
      } finally {
        setIsLoadingTasks(false);
        if (!silent) {
          setIsRefreshing(false);
        }
      }
    },
    [markTaskSnapshot],
  );

  useEffect(() => {
    if (!subjectId) {
      return;
    }

    let active = true;
    const loadModels = async () => {
      try {
        const data = await fetchModels();
        const available = getUserWebImageModels(
          Array.isArray(data.data) ? data.data : [],
        );
        if (!active) {
          return;
        }
        setModels(available);
        setModel((current) => resolveUserWebImageModel(current, available));
      } catch {
        if (active) {
          setModels([DEFAULT_IMAGE_MODEL]);
          setModel(DEFAULT_IMAGE_MODEL);
        }
      }
    };

    void loadModels();
    void Promise.all([fetchCreativeRecipes(), fetchConsistencyProfiles()])
      .then(([recipeData, profileData]) => {
        if (!active) return;
        setRecipes(recipeData.items);
        setProfiles(profileData.items);
      })
      .catch(() => {
        if (!active) return;
        setRecipes([]);
        setProfiles([]);
      });
    const initialLoadTimer = window.setTimeout(() => {
      void loadTasks();
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(initialLoadTimer);
    };
  }, [loadTasks, subjectId]);

  useEffect(() => {
    if (!subjectId) {
      return;
    }
    const initialTimer = window.setTimeout(() => {
      void loadQueueEstimate();
    }, 0);
    const timer = window.setInterval(() => {
      void loadQueueEstimate();
    }, 10_000);
    return () => {
      window.clearTimeout(initialTimer);
      window.clearInterval(timer);
    };
  }, [loadQueueEstimate, subjectId]);

  useEffect(() => {
    if (!subjectId) {
      return;
    }

    const draft = consumeStudioPromptDraft();
    if (!draft) return;
    const restoreTimer = window.setTimeout(() => {
      setPrompt(draft.prompt.slice(0, 2_000));
      setPromptError("");
      setWorkflowDraft({
        asset_id: draft.assetId,
        parent_version_id: draft.versionId,
        branch_id: draft.branchId,
      });
      const draftReferences = (
        draft.referenceUrls?.length
          ? draft.referenceUrls
          : draft.referenceUrl
            ? [draft.referenceUrl]
            : []
      ).slice(0, 4);
      if (draftReferences.length) {
        void Promise.all(
          draftReferences.map(async (url, index) => {
            const response = await fetch(url);
            if (!response.ok) throw new Error("版本图片读取失败");
            const blob = await response.blob();
            const extension = blob.type.includes("jpeg")
              ? "jpg"
              : blob.type.split("/")[1] || "png";
            return new File([blob], `画板参考图-${index + 1}.${extension}`, {
              type: blob.type || "image/png",
            });
          }),
        )
          .then((files) => addReferenceFiles(files))
          .catch(() =>
            setReferenceError("版本图片读取失败，请返回智能资产页重试。"),
          );
      }
      const sourceLabel =
        draft.source === "board"
          ? "灵感画板"
          : draft.source === "intelligence"
            ? "版本分支"
            : "图片反推";
      setAnnouncement(`${sourceLabel}内容已带入，可继续调整后生成。`);
      toast.success(`${sourceLabel}已填入创作台`);
      promptRef.current?.scrollIntoView({ block: "center" });
      promptRef.current?.focus({ preventScroll: true });
    }, 0);
    return () => window.clearTimeout(restoreTimer);
  }, [addReferenceFiles, subjectId]);

  useEffect(() => {
    if (!subjectId) {
      return;
    }

    const rawDraft = window.sessionStorage.getItem(
      INSPIRATION_DRAFT_STORAGE_KEY,
    );
    if (!rawDraft) {
      return;
    }
    window.sessionStorage.removeItem(INSPIRATION_DRAFT_STORAGE_KEY);

    let draft: Partial<InspirationDraft>;
    try {
      draft = JSON.parse(rawDraft) as Partial<InspirationDraft>;
    } catch {
      const errorTimer = window.setTimeout(
        () => setAnnouncement("模板内容读取失败，请重新从灵感库选择。"),
        0,
      );
      return () => window.clearTimeout(errorTimer);
    }

    const nextPrompt =
      typeof draft.prompt === "string"
        ? draft.prompt.trim().slice(0, 2_000)
        : "";
    if (!nextPrompt) {
      return;
    }

    const restoreTimer = window.setTimeout(() => {
      setPrompt(nextPrompt);
      setPromptError("");
      if (
        typeof draft.size === "string" &&
        sizeOptions.some((option) => option.value === draft.size)
      ) {
        setSize(draft.size);
      }
      if (
        typeof draft.quality === "string" &&
        qualityOptions.some((option) => option.value === draft.quality)
      ) {
        setQuality(draft.quality);
      }
      const templateTitle =
        typeof draft.title === "string" ? draft.title.trim() : "";
      setWorkflowDraft({
        asset_id:
          typeof draft.asset_id === "string" ? draft.asset_id : undefined,
        parent_version_id:
          typeof draft.parent_version_id === "string"
            ? draft.parent_version_id
            : undefined,
      });
      if (typeof draft.reference_url === "string" && draft.reference_url) {
        void fetch(draft.reference_url)
          .then(async (response) => {
            if (!response.ok) throw new Error("版本图片读取失败");
            const blob = await response.blob();
            const extension = blob.type.includes("jpeg")
              ? "jpg"
              : blob.type.split("/")[1] || "png";
            addReferenceFiles([
              new File([blob], `版本参考图.${extension}`, {
                type: blob.type || "image/png",
              }),
            ]);
          })
          .catch(() =>
            setReferenceError("版本图片读取失败，请返回项目页重试。"),
          );
      }
      const message = templateTitle
        ? `已带入「${templateTitle}」模板，可继续调整后生成。`
        : "模板已带入创作台，可继续调整后生成。";
      setAnnouncement(message);
      toast.success("模板已带入创作台");
      promptRef.current?.scrollIntoView({ block: "center" });
      promptRef.current?.focus({ preventScroll: true });
    }, 0);
    return () => window.clearTimeout(restoreTimer);
  }, [addReferenceFiles, subjectId]);

  useEffect(() => {
    if (!hasPendingTasks) {
      return;
    }
    const tick = () => setClockNowMs(Date.now());
    tick();
    const displayTimer = window.setInterval(tick, 1_000);
    return () => window.clearInterval(displayTimer);
  }, [hasPendingTasks]);

  useEffect(() => {
    if (!hasPendingTasks) {
      return;
    }
    const timer = window.setInterval(() => {
      void loadTasks(true);
    }, TASK_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [hasPendingTasks, loadTasks]);

  useEffect(
    () => () => {
      referenceImagesRef.current.forEach((image) =>
        URL.revokeObjectURL(image.previewUrl),
      );
    },
    [],
  );

  const handleReferencePaste = (event: ClipboardEvent<HTMLElement>) => {
    const files = Array.from(event.clipboardData.files || []);
    if (files.length === 0) {
      return;
    }
    event.preventDefault();
    addReferenceFiles(files);
  };

  const handlePasteScreenshot = async () => {
    setIsReferencePanelOpen(true);
    setReferenceError("");
    setIsReadingClipboard(true);
    try {
      const files = await readClipboardImageFiles();
      addReferenceFiles(files);
    } catch (error) {
      const message =
        error instanceof DOMException && error.name === "NotAllowedError"
          ? "浏览器未允许读取剪贴板，请在参考图区按 Ctrl+V，或选择图片上传。"
          : error instanceof Error
            ? error.message
            : "读取截图失败，请在参考图区按 Ctrl+V，或选择图片上传。";
      setReferenceError(message);
      setAnnouncement(message);
    } finally {
      setIsReadingClipboard(false);
    }
  };

  const handleReferenceDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (event.dataTransfer.types.includes("Files")) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      setIsDraggingReference(true);
    }
  };

  const handleReferenceDragLeave = (event: DragEvent<HTMLDivElement>) => {
    const nextTarget = event.relatedTarget;
    if (
      nextTarget instanceof Node &&
      event.currentTarget.contains(nextTarget)
    ) {
      return;
    }
    setIsDraggingReference(false);
  };

  const handleReferenceDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) {
      return;
    }
    event.preventDefault();
    setIsDraggingReference(false);
    addReferenceFiles(Array.from(event.dataTransfer.files || []));
  };

  const handleSubmit = async () => {
    if (queueEstimate?.accepting === false) {
      const message = "当前图片队列已满，请稍后再提交。";
      setAnnouncement(message);
      toast.warning(message);
      return;
    }
    const normalizedPrompt = prompt.trim();
    if (!normalizedPrompt) {
      const message = hasReferenceImages
        ? "请描述你希望如何修改参考图。"
        : "请先写下你想生成的画面。";
      setPromptError(message);
      setAnnouncement(message);
      promptRef.current?.focus();
      return;
    }

    const submissionModel = resolveUserWebImageModel(model, models);
    if (submissionModel !== model) {
      setModel(submissionModel);
    }

    setPromptError("");
    setIsSubmitting(true);
    try {
      const referenceFiles = referenceImagesRef.current.map(
        (image) => image.file,
      );
      const task =
        referenceFiles.length > 0
          ? await createImageEditTask(
              createClientTaskId(),
              referenceFiles,
              normalizedPrompt,
              submissionModel,
              size,
              quality,
              {
                ...workflowDraft,
                operation_type: "edit",
                priority,
                recipe_id: recipeId,
                profile_id: profileId,
                profile_strength: profileStrength,
                profile_reference_included: Boolean(
                  profileId &&
                  referenceImagesRef.current.some(
                    (image) => image.sourceProfileId === profileId,
                  ),
                ),
              },
            )
          : await createImageGenerationTask(
              createClientTaskId(),
              normalizedPrompt,
              submissionModel,
              size,
              quality,
              {
                ...workflowDraft,
                operation_type: "generate",
                priority,
                recipe_id: recipeId,
                profile_id: profileId,
                profile_strength: profileStrength,
              },
            );
      taskMutationVersionRef.current += 1;
      setTasks((current) => [
        task,
        ...current.filter((item) => item.id !== task.id),
      ]);
      setResultView("current");
      markTaskSnapshot();
      if (typeof task.remaining_image_quota === "number") {
        setRemainingQuota(task.remaining_image_quota);
      }
      setPrompt("");
      setPromptBeforeEnhancement("");
      if (referenceFiles.length > 0) {
        const retained = referenceImagesRef.current.filter((image) => {
          const keep = Boolean(
            profileId && image.sourceProfileId === profileId,
          );
          if (!keep) URL.revokeObjectURL(image.previewUrl);
          return keep;
        });
        replaceReferenceImages(retained);
        setIsReferencePanelOpen(retained.length > 0);
      }
      setWorkflowDraft({});
      setAnnouncement(
        referenceFiles.length > 0
          ? "图片二创任务已提交，结果会自动显示在下方。"
          : "创作任务已提交，结果会自动显示在下方。",
      );
      toast.success(
        referenceFiles.length > 0 ? "已开始图片二创" : "已开始创作",
      );
      void loadQueueEstimate();
      void loadTasks(true);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "提交创作任务失败";
      setPromptError(message);
      setAnnouncement(message);
      toast.error(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleEnhancePrompt = async () => {
    const sourcePrompt = prompt.trim();
    if (!sourcePrompt) {
      const message = "请先输入需要美化的画面描述。";
      setPromptError(message);
      setAnnouncement(message);
      promptRef.current?.focus();
      return;
    }

    setIsEnhancingPrompt(true);
    setPromptError("");
    try {
      const result = await enhanceImagePrompt(
        sourcePrompt,
        enhancementInstruction.trim(),
      );
      const enhancedPrompt = result.prompt.trim();
      if (!enhancedPrompt) {
        throw new Error("提示词美化未返回有效内容，请保留原提示词后重试。");
      }
      if (result.fallback) {
        const message =
          result.message || "智能美化服务暂时不可用，已保留原提示词。";
        setAnnouncement(message);
        toast.warning(message);
        promptRef.current?.focus({ preventScroll: true });
        return;
      }
      setPromptBeforeEnhancement((current) => current || sourcePrompt);
      setPrompt(enhancedPrompt);
      setAnnouncement(
        enhancementInstruction.trim()
          ? "提示词已按你的美化要求完成优化，可继续调整或还原初稿。"
          : "提示词已美化，可继续调整或还原初稿后再生成。",
      );
      toast.success("提示词已美化");
      promptRef.current?.focus({ preventScroll: true });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "提示词美化失败，请保留原提示词后重试。";
      setPromptError(message);
      setAnnouncement(message);
      toast.error(message);
    } finally {
      setIsEnhancingPrompt(false);
    }
  };

  const handleRetry = async (task: ImageTask) => {
    if (retryingTaskIds.has(task.id)) {
      return;
    }

    setRetryingTaskIds((current) => new Set(current).add(task.id));
    try {
      const isCheckpointResume = task.recovery_mode === "resume_poll";
      const retriedTask = isCheckpointResume
        ? await resumeImagePoll(task.id, 30)
        : await retryImageGenerationTask(task.id);
      taskMutationVersionRef.current += 1;
      setTasks((current) =>
        current.map((item) => (item.id === task.id ? retriedTask : item)),
      );
      setResultView("current");
      markTaskSnapshot();
      if (typeof retriedTask.remaining_image_quota === "number") {
        setRemainingQuota(retriedTask.remaining_image_quota);
      }
      setAnnouncement(
        isCheckpointResume
          ? "已从原会话断点继续等待，不会重复创建生图任务。"
          : "已使用原提示词重新提交生成任务，结果会自动显示在作品画廊中。",
      );
      toast.success(isCheckpointResume ? "已从断点继续生成" : "已重新提交生成");
      void loadQueueEstimate();
      void loadTasks(true);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "重新生成失败，请稍后再试。";
      setAnnouncement(message);
      toast.error(message);
    } finally {
      setRetryingTaskIds((current) => {
        const next = new Set(current);
        next.delete(task.id);
        return next;
      });
    }
  };

  const handleCancel = async (task: ImageTask) => {
    if (
      (task.status !== "queued" && task.status !== "running") ||
      cancellingTaskIds.has(task.id)
    ) {
      return;
    }

    setCancellingTaskIds((current) => new Set(current).add(task.id));
    try {
      const stoppedTask = await cancelImageTask(task.id);
      taskMutationVersionRef.current += 1;
      setTasks((current) =>
        current.map((item) => (item.id === task.id ? stoppedTask : item)),
      );
      markTaskSnapshot();
      if (typeof stoppedTask.remaining_image_quota === "number") {
        setRemainingQuota(stoppedTask.remaining_image_quota);
      }
      if (stoppedTask.error_code === "cancelled_by_user") {
        setAnnouncement("图片任务已停止，预留额度会自动退回。");
        toast.success("已停止生成");
      } else {
        setAnnouncement("任务已在停止操作前结束，状态已同步。");
        toast("任务状态已更新");
      }
      void loadTasks(true);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "停止生成失败，请稍后再试。";
      setAnnouncement(message);
      toast.error(message);
    } finally {
      setCancellingTaskIds((current) => {
        const next = new Set(current);
        next.delete(task.id);
        return next;
      });
    }
  };

  const handleRecreate = (task: ImageTask) => {
    setModel(resolveUserWebImageModel(task.model, models));
    if (task.size && sizeOptions.some((option) => option.value === task.size)) {
      setSize(task.size);
    }
    if (
      task.quality &&
      qualityOptions.some((option) => option.value === task.quality)
    ) {
      setQuality(task.quality);
    }

    const message =
      "该历史任务没有保存原始提示词，请重新填写后生成。模型、画幅和质量已为你带回。";
    setPromptError(message);
    setAnnouncement(message);
    toast(message);
    promptRef.current?.scrollIntoView({ block: "center" });
    promptRef.current?.focus({ preventScroll: true });
  };

  const handleRemix = async (
    image: StudioImage,
    index: number,
    task: ImageTask,
  ) => {
    if (
      preparingRemixImageId ||
      referenceImagesRef.current.length >= MAX_REFERENCE_IMAGES
    ) {
      if (referenceImagesRef.current.length >= MAX_REFERENCE_IMAGES) {
        const message = `最多添加 ${MAX_REFERENCE_IMAGES} 张参考图，请先移除一张。`;
        setReferenceError(message);
        setAnnouncement(message);
        toast.error(message);
      }
      return;
    }

    setPreparingRemixImageId(image.id);
    try {
      const file = await imageSourceToReferenceFile(
        image.src,
        `xg-${task.id}-${index + 1}.png`,
      );
      if (!addReferenceFiles([file])) {
        return;
      }
      setModel(resolveUserWebImageModel(task.model, models));
      if (
        task.size &&
        sizeOptions.some((option) => option.value === task.size)
      ) {
        setSize(task.size);
      }
      if (
        task.quality &&
        qualityOptions.some((option) => option.value === task.quality)
      ) {
        setQuality(task.quality);
      }
      setAnnouncement(
        "作品已加入参考图，请描述你希望如何修改。模型、画幅和质量已同步。",
      );
      toast.success("作品已加入二创参考图");
      promptRef.current?.scrollIntoView({
        block: "center",
        behavior: "smooth",
      });
      promptRef.current?.focus({ preventScroll: true });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "读取作品图片失败，请稍后重试。";
      setReferenceError(message);
      setAnnouncement(message);
      toast.error(message);
    } finally {
      setPreparingRemixImageId("");
    }
  };

  const openDeleteConfirm = (task: ImageTask) => {
    if (
      task.status !== "error" ||
      retryingTaskIds.has(task.id) ||
      deletingTaskIds.has(task.id)
    ) {
      return;
    }
    setDeleteConfirmTask(task);
  };

  const handleDeleteFailedTask = async (task: ImageTask) => {
    if (
      task.status !== "error" ||
      retryingTaskIds.has(task.id) ||
      deletingTaskIds.has(task.id)
    ) {
      return;
    }

    setDeletingTaskIds((current) => new Set(current).add(task.id));
    try {
      await deleteFailedImageTask(task.id);
      taskMutationVersionRef.current += 1;
      setTasks((current) => current.filter((item) => item.id !== task.id));
      markTaskSnapshot();
      setDeleteConfirmTask(null);
      setAnnouncement("失败任务记录已删除。");
      toast.success("失败记录已删除");
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "删除失败记录失败，请稍后再试。";
      setAnnouncement(message);
      toast.error(message);
    } finally {
      setDeletingTaskIds((current) => {
        const next = new Set(current);
        next.delete(task.id);
        return next;
      });
    }
  };

  if (isCheckingAuth || !session) {
    return (
      <div
        className="flex min-h-[40vh] items-center justify-center"
        aria-live="polite"
      >
        <LoaderCircle className="size-5 animate-spin text-stone-400" />
        <span className="sr-only">正在验证访问权限</span>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[1600px] pb-10 sm:pb-14">
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>

      <Dialog
        open={Boolean(deleteConfirmTask)}
        onOpenChange={(open) => {
          if (
            !open &&
            deleteConfirmTask &&
            !deletingTaskIds.has(deleteConfirmTask.id)
          ) {
            setDeleteConfirmTask(null);
          }
        }}
      >
        <DialogContent
          showCloseButton={false}
          className="w-[min(92vw,420px)] gap-0 overflow-hidden rounded-2xl border border-rose-100 bg-white p-0 shadow-[0_28px_70px_-34px_rgba(127,29,29,0.42)] dark:border-rose-400/20 dark:bg-stone-900"
        >
          <div className="flex items-start gap-3 px-5 pt-5 sm:px-6 sm:pt-6">
            <span
              aria-hidden="true"
              className="grid size-11 shrink-0 place-items-center rounded-xl bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-200"
            >
              <Trash2 className="size-5" />
            </span>
            <DialogHeader className="gap-1.5 pt-0.5">
              <DialogTitle className="text-lg font-semibold tracking-normal text-stone-950 dark:text-white">
                删除失败记录？
              </DialogTitle>
              <DialogDescription className="text-sm leading-6 text-stone-600 dark:text-stone-300">
                删除后无法恢复这条失败记录，不会影响已生成的作品。
              </DialogDescription>
            </DialogHeader>
          </div>
          <DialogFooter className="mt-5 border-t border-stone-100 bg-stone-50 px-5 py-4 sm:flex-row sm:items-center sm:justify-end sm:px-6 dark:border-white/10 dark:bg-white/[0.03]">
            <Button
              type="button"
              variant="outline"
              className="h-11 rounded-xl border-stone-200 bg-white px-4 text-stone-700 hover:bg-stone-100 dark:border-white/15 dark:bg-white/[0.04] dark:text-stone-200 dark:hover:bg-white/10"
              onClick={() => setDeleteConfirmTask(null)}
              disabled={Boolean(
                deleteConfirmTask && deletingTaskIds.has(deleteConfirmTask.id),
              )}
            >
              取消
            </Button>
            <Button
              type="button"
              className="h-11 rounded-xl bg-rose-600 px-4 text-white shadow-[0_10px_20px_-12px_rgba(190,24,93,0.9)] hover:bg-rose-700 focus-visible:ring-rose-500 dark:bg-rose-500 dark:hover:bg-rose-400"
              onClick={() =>
                deleteConfirmTask &&
                void handleDeleteFailedTask(deleteConfirmTask)
              }
              disabled={
                !deleteConfirmTask || deletingTaskIds.has(deleteConfirmTask.id)
              }
            >
              {deleteConfirmTask &&
              deletingTaskIds.has(deleteConfirmTask.id) ? (
                <LoaderCircle
                  className="size-4 animate-spin"
                  aria-hidden="true"
                />
              ) : (
                <Trash2 className="size-4" aria-hidden="true" />
              )}
              {deleteConfirmTask && deletingTaskIds.has(deleteConfirmTask.id)
                ? "正在删除"
                : "确认删除"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <section className="relative overflow-hidden rounded-2xl border border-stone-200/80 bg-white px-5 py-5 shadow-[0_18px_50px_-40px_rgba(28,25,23,0.45)] dark:border-white/10 dark:bg-stone-900 sm:px-7 lg:px-8">
        <div
          className="absolute inset-y-0 left-0 w-1 bg-violet-600 dark:bg-violet-400"
          aria-hidden="true"
        />
        <div className="relative flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-2xl space-y-3">
            <span className="inline-flex items-center gap-2 rounded-full bg-violet-50 px-3 py-1.5 text-xs font-semibold tracking-wide text-violet-700 dark:bg-violet-400/10 dark:text-violet-200">
              <Sparkles className="size-3.5" aria-hidden="true" />
              XG生图 · 个人工作台
            </span>
            <div className="space-y-2">
              <h1 className="text-2xl font-semibold tracking-tight text-stone-950 sm:text-3xl dark:text-white">
                把灵感变成画面
              </h1>
              <p className="max-w-xl text-sm leading-6 text-stone-600 sm:text-base dark:text-stone-300">
                输入提示词生成新图片，或上传参考图进行二创。完成的作品仅当前账号可见。
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-stone-500 dark:text-stone-400">
              <span className="inline-flex items-center gap-1.5">
                <ImageIcon
                  className="size-4 text-violet-600 dark:text-violet-300"
                  aria-hidden="true"
                />
                独立保存你的创作记录
              </span>
              <span>支持查看和下载结果</span>
            </div>
          </div>
          {remainingQuota !== null ? (
            <aside className="min-w-52 border-t border-stone-200 pt-5 dark:border-white/10 lg:border-t-0 lg:border-l lg:pl-7 lg:pt-0">
              <div className="flex items-center gap-2 text-xs font-semibold tracking-wide text-violet-700 dark:text-violet-200">
                <Sparkles className="size-3.5" aria-hidden="true" />
                可用生图额度
              </div>
              <div className="mt-2 flex items-baseline gap-1 text-stone-950 dark:text-white">
                <strong className="text-4xl font-semibold tracking-tight tabular-nums">
                  {remainingQuota}
                </strong>
                <span className="text-sm font-medium text-stone-500 dark:text-stone-300">
                  张
                </span>
              </div>
              <p className="mt-1 text-xs leading-5 text-stone-500 dark:text-stone-400">
                按当前账号独立计算
              </p>
            </aside>
          ) : null}
        </div>
      </section>

      <div
        data-testid="studio-workspace-grid"
        className="mt-5 grid items-start gap-5 xl:grid-cols-[minmax(400px,520px)_minmax(0,1fr)] 2xl:grid-cols-[minmax(440px,540px)_minmax(0,1fr)]"
      >
        <Card
          data-testid="studio-create-panel"
          className="min-w-0 overflow-hidden rounded-2xl border border-stone-200/80 bg-white shadow-[0_20px_55px_-46px_rgba(28,25,23,0.5)] xl:sticky xl:top-24 xl:self-start dark:border-white/10 dark:bg-stone-900"
        >
          <CardHeader className="border-b border-stone-200/70 bg-stone-50/55 p-5 sm:p-6 dark:border-white/10 dark:bg-white/[0.025]">
            <div className="w-full">
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <CardTitle className="text-xl tracking-tight text-stone-950 dark:text-white">
                      开始创作
                    </CardTitle>
                    <span
                      className={cn(
                        "rounded-full px-2.5 py-1 text-xs font-semibold",
                        hasReferenceImages
                          ? "bg-violet-100 text-violet-800 dark:bg-violet-400/15 dark:text-violet-200"
                          : "bg-stone-100 text-stone-600 dark:bg-white/10 dark:text-stone-300",
                      )}
                    >
                      {hasReferenceImages ? "图片二创" : "文字生图"}
                    </span>
                  </div>
                  <CardDescription className="max-w-2xl leading-6">
                    {hasReferenceImages
                      ? "参考图已就绪，请描述保留什么、修改什么。"
                      : "用清晰的画面、光线和风格描述，得到更稳定的结果。"}
                  </CardDescription>
                </div>
                <span
                  aria-hidden="true"
                  className="grid size-11 shrink-0 place-items-center rounded-xl border border-violet-100 bg-white text-violet-700 shadow-sm dark:border-violet-400/20 dark:bg-white/[0.06] dark:text-violet-200"
                >
                  <Sparkles className="size-5" />
                </span>
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-5 sm:p-6">
            <div className="w-full space-y-5">
              <div className="overflow-hidden rounded-2xl border border-stone-200 bg-white transition-colors focus-within:border-violet-400 focus-within:ring-2 focus-within:ring-violet-500/15 dark:border-white/10 dark:bg-white/[0.025] dark:focus-within:border-violet-400">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label
                    htmlFor="studio-prompt"
                    className="px-4 pt-3 text-sm font-semibold text-stone-800 dark:text-stone-100"
                  >
                    画面描述
                  </label>
                  <div className="flex items-center gap-1.5 px-3 pt-2">
                    {promptBeforeEnhancement ? (
                      <Button
                        type="button"
                        variant="ghost"
                        className="h-9 rounded-lg px-2.5 text-xs text-stone-500 hover:bg-stone-100 hover:text-stone-800 dark:text-stone-300 dark:hover:bg-white/10 dark:hover:text-white"
                        onClick={() => {
                          setPrompt(promptBeforeEnhancement);
                          setPromptBeforeEnhancement("");
                          setAnnouncement("已还原美化前的提示词。");
                        }}
                        disabled={isEnhancingPrompt || isSubmitting}
                      >
                        还原初稿
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      variant="outline"
                      className="h-9 rounded-lg border-violet-200 bg-violet-50 px-3 text-xs font-semibold text-violet-700 hover:bg-violet-100 hover:text-violet-800 dark:border-violet-400/30 dark:bg-violet-400/10 dark:text-violet-200 dark:hover:bg-violet-400/20"
                      onClick={() => void handleEnhancePrompt()}
                      disabled={
                        !prompt.trim() || isEnhancingPrompt || isSubmitting
                      }
                      aria-label="使用 AI 美化当前提示词"
                    >
                      {isEnhancingPrompt ? (
                        <LoaderCircle
                          className="size-3.5 animate-spin"
                          aria-hidden="true"
                        />
                      ) : (
                        <WandSparkles className="size-3.5" aria-hidden="true" />
                      )}
                      {isEnhancingPrompt ? "正在美化" : "一键美化"}
                    </Button>
                  </div>
                </div>
                <Textarea
                  ref={promptRef}
                  id="studio-prompt"
                  value={prompt}
                  onChange={(event) => {
                    setPrompt(event.target.value);
                    if (promptError) {
                      setPromptError("");
                    }
                  }}
                  onKeyDown={(event) => {
                    if (
                      (event.metaKey || event.ctrlKey) &&
                      event.key === "Enter"
                    ) {
                      event.preventDefault();
                      void handleSubmit();
                    }
                  }}
                  onPaste={handleReferencePaste}
                  placeholder={
                    hasReferenceImages
                      ? "例如：保留人物和构图，将背景改成雨夜霓虹街道，电影感光影"
                      : "例如：清晨的湖畔木屋，薄雾从水面升起，电影感自然光，细节丰富"
                  }
                  maxLength={2_000}
                  aria-describedby="studio-prompt-help studio-prompt-error"
                  aria-invalid={Boolean(promptError)}
                  className="min-h-44 resize-y rounded-none border-0 bg-transparent px-4 py-3 text-base leading-7 shadow-none focus-visible:ring-0 sm:min-h-48"
                />
                <div className="flex items-center justify-between gap-3 border-t border-stone-100 bg-stone-50/65 px-4 py-2.5 text-xs leading-5 dark:border-white/10 dark:bg-white/[0.025]">
                  <span
                    id="studio-prompt-help"
                    className="text-stone-500 dark:text-stone-400"
                  >
                    可选一键美化；会保留原意并补足画面细节。按 Ctrl / ⌘ + Enter
                    可直接提交。
                  </span>
                  <span className="shrink-0 tabular-nums text-stone-400">
                    {prompt.length}/2000
                  </span>
                </div>
                <details className="group border-t border-stone-100 bg-white dark:border-white/10 dark:bg-transparent">
                  <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-3 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-500">
                    <span className="flex min-w-0 items-center gap-2 px-1 text-violet-800 dark:text-violet-100">
                      <WandSparkles
                        className="size-3.5 shrink-0"
                        aria-hidden="true"
                      />
                      <span className="font-semibold">按自己的要求美化</span>
                      <span className="truncate font-normal text-violet-600/80 dark:text-violet-200/80">
                        {enhancementInstruction.trim()
                          ? "已填写美化要求"
                          : "可选"}
                      </span>
                    </span>
                    <ChevronDown
                      className="size-4 shrink-0 text-violet-500 transition-transform duration-200 group-open:rotate-180 motion-reduce:transition-none"
                      aria-hidden="true"
                    />
                  </summary>
                  <div className="space-y-2 border-t border-stone-100 bg-stone-50/55 p-3 dark:border-white/10 dark:bg-white/[0.02]">
                    <label
                      htmlFor="studio-enhancement-instruction"
                      className="text-xs font-semibold text-violet-900 dark:text-violet-100"
                    >
                      美化要求
                    </label>
                    <Textarea
                      id="studio-enhancement-instruction"
                      value={enhancementInstruction}
                      onChange={(event) =>
                        setEnhancementInstruction(event.target.value)
                      }
                      maxLength={500}
                      aria-describedby="studio-enhancement-instruction-help"
                      placeholder="例如：保留人物主体，改成电商海报风；画面干净、高级，突出中文留白。"
                      className="min-h-20 resize-y rounded-lg border-violet-100 bg-white/85 px-3 py-2 text-sm leading-6 shadow-none focus-visible:border-violet-500 focus-visible:ring-violet-500/30 dark:border-violet-400/20 dark:bg-stone-950/40"
                    />
                    <div className="flex items-center justify-between gap-3 text-xs leading-5 text-violet-700/80 dark:text-violet-200/80">
                      <span id="studio-enhancement-instruction-help">
                        AI 会在保留原提示词核心内容的前提下，按此要求美化。
                      </span>
                      <span className="shrink-0 tabular-nums">
                        {enhancementInstruction.length}/500
                      </span>
                    </div>
                  </div>
                </details>
                {promptError ? (
                  <p
                    id="studio-prompt-error"
                    role="alert"
                    className="border-t border-rose-100 bg-rose-50 px-4 py-2 text-sm leading-6 text-rose-600 dark:border-rose-400/20 dark:bg-rose-400/10 dark:text-rose-300"
                  >
                    {promptError}
                  </p>
                ) : null}
              </div>

              <details className="group overflow-hidden rounded-2xl border border-stone-200 bg-white dark:border-white/10 dark:bg-white/[0.025]">
                <summary className="flex min-h-16 cursor-pointer list-none items-center justify-between gap-3 px-3.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-500">
                  <span className="flex min-w-0 items-center gap-3">
                    <span
                      aria-hidden="true"
                      className="grid size-9 shrink-0 place-items-center rounded-xl bg-stone-100 text-stone-600 dark:bg-white/10 dark:text-stone-200"
                    >
                      <SlidersHorizontal className="size-4" />
                    </span>
                    <span className="min-w-0 text-left">
                      <span className="block font-semibold text-stone-800 dark:text-stone-100">
                        生成设置
                      </span>
                      <span className="mt-0.5 block text-xs text-stone-500 dark:text-stone-400">
                        核心参数与进阶工作流
                      </span>
                    </span>
                  </span>
                  <span className="flex min-w-0 shrink-0 items-center gap-1.5">
                    <span className="hidden max-w-28 truncate rounded-lg bg-violet-50 px-2 py-1 text-[11px] font-semibold text-violet-700 sm:inline dark:bg-violet-400/10 dark:text-violet-200">
                      {selectedModelLabel}
                    </span>
                    <span className="rounded-lg bg-stone-100 px-2 py-1 text-[11px] font-medium text-stone-600 dark:bg-white/10 dark:text-stone-300">
                      {selectedSizeLabel.split(" · ")[0]}
                    </span>
                    <span className="hidden rounded-lg bg-stone-100 px-2 py-1 text-[11px] font-medium text-stone-600 sm:inline dark:bg-white/10 dark:text-stone-300">
                      {selectedQualityLabel}质量
                    </span>
                    <ChevronDown
                      className="ml-1 size-4 text-stone-400 transition-transform duration-200 group-open:rotate-180 motion-reduce:transition-none"
                      aria-hidden="true"
                    />
                  </span>
                </summary>
                <div className="border-t border-stone-200/80 dark:border-white/10">
                  <div className="space-y-3 p-3.5">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wider text-stone-400 dark:text-stone-500">
                        核心参数
                      </p>
                      <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
                        日常生成通常只需调整这三项
                      </p>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-2">
                      <div className="space-y-2 xl:col-span-2">
                        <label
                          htmlFor="studio-model"
                          className="text-sm font-medium text-stone-700 dark:text-stone-200"
                        >
                          模型
                        </label>
                        <Select
                          value={model}
                          onValueChange={(value) =>
                            setModel(resolveUserWebImageModel(value, models))
                          }
                        >
                          <SelectTrigger
                            id="studio-model"
                            className="h-12 rounded-xl border-stone-200 bg-white shadow-none dark:border-white/10 dark:bg-white/5"
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {models.map((item) => (
                              <SelectItem key={item} value={item}>
                                {getImageModelDisplayName(item)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-2">
                        <label
                          htmlFor="studio-size"
                          className="text-sm font-medium text-stone-700 dark:text-stone-200"
                        >
                          画幅
                        </label>
                        <Select value={size} onValueChange={setSize}>
                          <SelectTrigger
                            id="studio-size"
                            className="h-12 rounded-xl border-stone-200 bg-white shadow-none dark:border-white/10 dark:bg-white/5"
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {sizeOptions.map((option) => (
                              <SelectItem
                                key={option.value}
                                value={option.value}
                              >
                                {option.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-2">
                        <label
                          htmlFor="studio-quality"
                          className="text-sm font-medium text-stone-700 dark:text-stone-200"
                        >
                          质量
                        </label>
                        <Select value={quality} onValueChange={setQuality}>
                          <SelectTrigger
                            id="studio-quality"
                            className="h-12 rounded-xl border-stone-200 bg-white shadow-none dark:border-white/10 dark:bg-white/5"
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {qualityOptions.map((option) => (
                              <SelectItem
                                key={option.value}
                                value={option.value}
                              >
                                {option.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  </div>
                  <div className="space-y-3 border-t border-stone-200/80 bg-stone-50/65 p-3.5 dark:border-white/10 dark:bg-white/[0.02]">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wider text-stone-400 dark:text-stone-500">
                        进阶控制
                      </p>
                      <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
                        用于批量创作与品牌一致性管理
                      </p>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="space-y-2">
                        <label
                          htmlFor="studio-recipe"
                          className="text-sm font-medium text-stone-700 dark:text-stone-200"
                        >
                          创作配方
                        </label>
                        <Select
                          value={recipeId || "none"}
                          onValueChange={(value) => {
                            const nextId = value === "none" ? "" : value;
                            setRecipeId(nextId);
                            const recipe = recipes.find(
                              (item) => item.id === nextId,
                            );
                            if (!recipe) return;
                            if (typeof recipe.settings.prompt === "string")
                              setPrompt(recipe.settings.prompt);
                            if (typeof recipe.settings.model === "string")
                              setModel(
                                resolveUserWebImageModel(
                                  recipe.settings.model,
                                  models,
                                ),
                              );
                            if (typeof recipe.settings.size === "string")
                              setSize(recipe.settings.size);
                            if (typeof recipe.settings.quality === "string")
                              setQuality(recipe.settings.quality);
                            setAnnouncement(`已应用「${recipe.name}」配方。`);
                          }}
                        >
                          <SelectTrigger
                            id="studio-recipe"
                            className="h-12 rounded-xl border-stone-200 bg-white shadow-none dark:border-white/10 dark:bg-white/5"
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="none">不使用配方</SelectItem>
                            {recipes.map((recipe) => (
                              <SelectItem key={recipe.id} value={recipe.id}>
                                {recipe.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-2">
                        <label
                          htmlFor="studio-profile"
                          className="text-sm font-medium text-stone-700 dark:text-stone-200"
                        >
                          一致性档案
                        </label>
                        <Select
                          value={profileId || "none"}
                          onValueChange={(value) =>
                            void selectConsistencyProfile(
                              value === "none" ? "" : value,
                            )
                          }
                        >
                          <SelectTrigger
                            id="studio-profile"
                            className="h-12 rounded-xl border-stone-200 bg-white shadow-none dark:border-white/10 dark:bg-white/5"
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="none">
                              不固定品牌 / 人物
                            </SelectItem>
                            {profiles.map((profile) => (
                              <SelectItem key={profile.id} value={profile.id}>
                                {profile.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-2">
                        <label
                          htmlFor="studio-profile-strength"
                          className="text-sm font-medium text-stone-700 dark:text-stone-200"
                        >
                          一致性强度
                        </label>
                        <Select
                          value={profileStrength}
                          disabled={!profileId}
                          onValueChange={(value) =>
                            setProfileStrength(value as ConsistencyStrength)
                          }
                        >
                          <SelectTrigger
                            id="studio-profile-strength"
                            className="h-12 rounded-xl border-stone-200 bg-white shadow-none disabled:opacity-50 dark:border-white/10 dark:bg-white/5"
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="strict">
                              严格 · 尽量不变化
                            </SelectItem>
                            <SelectItem value="balanced">
                              均衡 · 稳定创作
                            </SelectItem>
                            <SelectItem value="creative">
                              创意 · 允许变化
                            </SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-2">
                        <label
                          htmlFor="studio-priority"
                          className="text-sm font-medium text-stone-700 dark:text-stone-200"
                        >
                          队列优先级
                        </label>
                        <Select
                          value={String(priority)}
                          onValueChange={(value) => setPriority(Number(value))}
                        >
                          <SelectTrigger
                            id="studio-priority"
                            className="h-12 rounded-xl border-stone-200 bg-white shadow-none dark:border-white/10 dark:bg-white/5"
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="-5">较低</SelectItem>
                            <SelectItem value="0">普通</SelectItem>
                            <SelectItem value="5">较高</SelectItem>
                            <SelectItem value="10">紧急</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  </div>
                </div>
              </details>

              <details
                className="group overflow-hidden rounded-2xl border border-stone-200 bg-white dark:border-white/10 dark:bg-white/[0.025]"
                open={isReferencePanelOpen}
                onToggle={(event) =>
                  setIsReferencePanelOpen(event.currentTarget.open)
                }
              >
                <summary className="flex min-h-16 cursor-pointer list-none items-center justify-between gap-3 px-3.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-500">
                  <span className="flex min-w-0 items-center gap-3">
                    <span
                      aria-hidden="true"
                      className="grid size-8 shrink-0 place-items-center rounded-lg bg-violet-100 text-violet-700 dark:bg-violet-400/15 dark:text-violet-200"
                    >
                      <ImagePlus className="size-4" />
                    </span>
                    <span className="min-w-0 text-left">
                      <span className="block font-semibold text-stone-800 dark:text-stone-100">
                        参考图二创{" "}
                        <span className="font-normal text-stone-400">
                          （可选）
                        </span>
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-stone-500 dark:text-stone-400">
                        {hasReferenceImages
                          ? `已添加 ${referenceImages.length} 张，生成时会进入二创模式`
                          : "上传、拖入或直接粘贴图片"}
                      </span>
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span className="text-xs tabular-nums text-stone-400">
                      {referenceImages.length}/{MAX_REFERENCE_IMAGES}
                    </span>
                    <ChevronDown
                      className="size-4 text-stone-400 transition-transform duration-200 group-open:rotate-180 motion-reduce:transition-none"
                      aria-hidden="true"
                    />
                  </span>
                </summary>
                <div className="space-y-2 border-t border-stone-200/80 p-3 dark:border-white/10">
                  <input
                    ref={referenceInputRef}
                    id="studio-reference-input"
                    type="file"
                    accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
                    multiple
                    className="sr-only"
                    onChange={(event) => {
                      addReferenceFiles(Array.from(event.target.files || []));
                      event.target.value = "";
                    }}
                  />
                  <div
                    onDragEnter={handleReferenceDragOver}
                    onDragOver={handleReferenceDragOver}
                    onDragLeave={handleReferenceDragLeave}
                    onDrop={handleReferenceDrop}
                    onPaste={handleReferencePaste}
                    tabIndex={0}
                    aria-label="参考图上传区，可选择图片、拖入图片或粘贴截图"
                    className={cn(
                      "rounded-xl border border-dashed p-2.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2 motion-reduce:transition-none dark:focus-visible:ring-offset-stone-950",
                      isDraggingReference
                        ? "border-violet-500 bg-violet-50 dark:bg-violet-400/10"
                        : "border-stone-200 bg-white/70 dark:border-white/10 dark:bg-white/[0.03]",
                    )}
                  >
                    {referenceImages.length > 0 ? (
                      <div className="space-y-3">
                        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-5 xl:grid-cols-4">
                          {referenceImages.map((image, index) => (
                            <div
                              key={image.id}
                              className="group/reference relative aspect-square overflow-hidden rounded-xl border border-stone-200 bg-white dark:border-white/10 dark:bg-stone-900"
                            >
                              {/* Object URLs are local previews and cannot use the static image optimizer. */}
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img
                                src={image.previewUrl}
                                alt={`参考图 ${index + 1}：${image.file.name}`}
                                className="size-full object-cover"
                              />
                              <button
                                type="button"
                                onClick={() => removeReferenceImage(image.id)}
                                className="absolute top-1 right-1 inline-flex size-11 items-center justify-center rounded-full bg-black/65 text-white transition hover:bg-black/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-stone-900"
                                aria-label={`移除参考图 ${index + 1}`}
                              >
                                <X className="size-4" aria-hidden="true" />
                              </button>
                            </div>
                          ))}
                        </div>
                        {referenceImages.length < MAX_REFERENCE_IMAGES ? (
                          <div className="flex flex-col gap-2 sm:flex-row">
                            <button
                              type="button"
                              onClick={() => referenceInputRef.current?.click()}
                              className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl border border-stone-200 bg-white px-4 text-sm font-semibold text-stone-700 transition hover:border-violet-300 hover:bg-violet-50 hover:text-violet-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 dark:border-white/10 dark:bg-white/[0.04] dark:text-stone-200 dark:hover:bg-violet-400/10 dark:hover:text-violet-200"
                            >
                              <ImagePlus
                                className="size-4"
                                aria-hidden="true"
                              />
                              继续添加图片
                            </button>
                            <button
                              type="button"
                              onClick={() => void handlePasteScreenshot()}
                              disabled={isReadingClipboard}
                              className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl border border-violet-200 bg-violet-50 px-4 text-sm font-semibold text-violet-700 transition hover:border-violet-300 hover:bg-violet-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-violet-400/20 dark:bg-violet-400/10 dark:text-violet-200 dark:hover:bg-violet-400/15"
                            >
                              {isReadingClipboard ? (
                                <LoaderCircle
                                  className="size-4 animate-spin motion-reduce:animate-none"
                                  aria-hidden="true"
                                />
                              ) : (
                                <ClipboardPaste
                                  className="size-4"
                                  aria-hidden="true"
                                />
                              )}
                              {isReadingClipboard ? "正在读取" : "粘贴截图"}
                            </button>
                          </div>
                        ) : null}
                      </div>
                    ) : (
                      <div className="flex min-h-32 flex-col items-center justify-center gap-3 rounded-xl px-3 py-4 text-center text-stone-600 dark:text-stone-300">
                        <span
                          aria-hidden="true"
                          className="grid size-10 shrink-0 place-items-center rounded-xl bg-violet-100 text-violet-700 dark:bg-violet-400/15 dark:text-violet-200"
                        >
                          <ImagePlus className="size-5" />
                        </span>
                        <span>
                          <strong className="block text-sm text-stone-800 dark:text-stone-100">
                            上传图片或粘贴截图开始二创
                          </strong>
                          <span className="mt-1 block text-xs leading-5 text-stone-500 dark:text-stone-400">
                            支持选择、拖拽，也可以直接读取剪贴板中的截图
                          </span>
                        </span>
                        <div className="flex w-full max-w-md flex-col gap-2 sm:flex-row">
                          <button
                            type="button"
                            onClick={() => referenceInputRef.current?.click()}
                            className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl border border-stone-200 bg-white px-4 text-sm font-semibold text-stone-700 transition hover:border-violet-300 hover:bg-violet-50 hover:text-violet-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 dark:border-white/10 dark:bg-white/[0.04] dark:text-stone-200 dark:hover:bg-violet-400/10 dark:hover:text-violet-200"
                          >
                            <ImagePlus className="size-4" aria-hidden="true" />
                            选择图片
                          </button>
                          <button
                            type="button"
                            onClick={() => void handlePasteScreenshot()}
                            disabled={isReadingClipboard}
                            className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-violet-700 px-4 text-sm font-semibold text-white shadow-sm transition hover:bg-violet-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-violet-500 dark:hover:bg-violet-400 dark:focus-visible:ring-offset-stone-950"
                          >
                            {isReadingClipboard ? (
                              <LoaderCircle
                                className="size-4 animate-spin motion-reduce:animate-none"
                                aria-hidden="true"
                              />
                            ) : (
                              <ClipboardPaste
                                className="size-4"
                                aria-hidden="true"
                              />
                            )}
                            {isReadingClipboard ? "正在读取" : "粘贴截图"}
                          </button>
                        </div>
                        <span className="text-[11px] leading-5 text-stone-400 dark:text-stone-500">
                          也可先点击此区域，再按 Ctrl+V
                        </span>
                      </div>
                    )}
                  </div>
                  <p className="text-xs leading-5 text-stone-500 dark:text-stone-400">
                    支持 PNG、JPG、JPEG、WEBP，最多 {MAX_REFERENCE_IMAGES}{" "}
                    张，单张不超过 50 MB。
                  </p>
                  {referenceError ? (
                    <p
                      role="alert"
                      className="text-sm leading-6 text-rose-600 dark:text-rose-300"
                    >
                      {referenceError}
                    </p>
                  ) : null}
                </div>
              </details>

              <div className="-mx-5 -mb-5 border-t border-stone-200/80 bg-stone-50/70 px-5 py-4 sm:-mx-6 sm:-mb-6 sm:px-6 dark:border-white/10 dark:bg-white/[0.025]">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span className="inline-flex items-center gap-1.5 font-medium text-stone-600 dark:text-stone-300">
                    <span
                      className="size-1.5 rounded-full bg-emerald-500"
                      aria-hidden="true"
                    />
                    {hasReferenceImages ? "二创素材已就绪" : "文字生图已就绪"}
                  </span>
                  <span
                    className={cn(
                      "ml-auto rounded-full px-2.5 py-1 font-medium",
                      queueEstimate?.accepting === false
                        ? "bg-rose-50 text-rose-700 dark:bg-rose-400/10 dark:text-rose-200"
                        : "bg-white text-stone-500 shadow-sm dark:bg-white/[0.06] dark:text-stone-300",
                    )}
                  >
                    {queueEstimate
                      ? queueEstimate.accepting
                        ? `预计 ${formatEstimateRange(queueEstimate)} · 前方 ${Math.max(0, queueEstimate.queue_position - 1)} 个`
                        : "队列暂满，请稍后提交"
                      : "正在估算耗时"}
                  </span>
                  <span className="hidden text-stone-400 sm:inline">
                    Ctrl / ⌘ + Enter
                  </span>
                </div>
                <Button
                  type="button"
                  className="h-12 min-h-12 w-full rounded-xl bg-violet-700 text-base font-semibold text-white shadow-[0_14px_24px_-16px_rgba(109,40,217,0.9)] transition-[background-color,transform,box-shadow] hover:-translate-y-0.5 hover:bg-violet-800 hover:shadow-[0_18px_30px_-18px_rgba(109,40,217,0.95)] focus-visible:ring-violet-500 motion-reduce:transform-none motion-reduce:transition-none dark:bg-violet-500 dark:hover:bg-violet-400"
                  onClick={() => void handleSubmit()}
                  disabled={isSubmitting || queueEstimate?.accepting === false}
                >
                  {isSubmitting ? (
                    <LoaderCircle className="size-4 animate-spin" />
                  ) : hasReferenceImages ? (
                    <WandSparkles className="size-4" />
                  ) : (
                    <Sparkles className="size-4" />
                  )}
                  {queueEstimate?.accepting === false
                    ? "队列已满"
                    : isSubmitting
                      ? "正在提交"
                      : hasReferenceImages
                        ? "开始二创"
                        : "生成图片"}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        <section
          data-testid="studio-results-panel"
          aria-labelledby="studio-results-heading"
          aria-busy={isLoadingTasks || isRefreshing}
          className="min-w-0 rounded-2xl border border-stone-200/80 bg-white p-4 dark:border-white/10 dark:bg-stone-900 sm:p-6"
        >
          <div className="border-b border-stone-200/80 pb-4 dark:border-white/10">
            <div className="flex items-end justify-between gap-4">
              <div>
                <span className="text-xs font-semibold tracking-wide text-violet-700 dark:text-violet-200">
                  XG生图 · 创作记录
                </span>
                <h2
                  id="studio-results-heading"
                  className="mt-1 text-2xl font-semibold tracking-tight text-stone-950 dark:text-white"
                >
                  创作结果
                </h2>
                <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
                  当前任务与历史作品分区展示，操作时无需来回滚动。
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-11 shrink-0 rounded-xl border-stone-200 bg-white px-3 dark:border-white/10 dark:bg-white/5"
                onClick={() => void loadTasks()}
                disabled={isRefreshing}
              >
                <RefreshCw
                  className={cn("size-4", isRefreshing && "animate-spin")}
                />
                刷新
              </Button>
            </div>
            <div className="mt-4 flex flex-wrap gap-2 text-xs font-medium">
              <span className="rounded-full bg-emerald-50 px-3 py-1.5 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-200">
                已完成 {completedTaskCount}
              </span>
              <span className="rounded-full bg-stone-100 px-3 py-1.5 text-stone-600 dark:bg-white/10 dark:text-stone-300">
                画廊 {galleryTasks.length}
              </span>
              {activeTaskCount > 0 ? (
                <span className="rounded-full bg-violet-50 px-3 py-1.5 text-violet-700 dark:bg-violet-400/10 dark:text-violet-200">
                  生成中 {activeTaskCount}
                </span>
              ) : null}
              <span className="rounded-full bg-stone-100 px-3 py-1.5 text-stone-500 dark:bg-white/10 dark:text-stone-400">
                最近 {visibleTasks.length} 条
              </span>
            </div>
            <div
              role="tablist"
              aria-label="创作结果视图"
              className="mt-4 grid grid-cols-2 gap-1 rounded-xl bg-stone-100 p-1 dark:bg-white/[0.06]"
            >
              <button
                type="button"
                role="tab"
                id="studio-current-tab"
                aria-selected={resultView === "current"}
                aria-controls={
                  resultView === "current" ? "studio-current-panel" : undefined
                }
                onClick={() => setResultView("current")}
                className={cn(
                  "flex min-h-11 items-center justify-center gap-2 rounded-lg px-3 text-sm font-semibold transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 motion-reduce:transition-none",
                  resultView === "current"
                    ? "bg-white text-stone-950 shadow-sm dark:bg-stone-800 dark:text-white"
                    : "text-stone-500 hover:text-stone-800 dark:text-stone-400 dark:hover:text-stone-100",
                )}
              >
                <Clock3 className="size-4" aria-hidden="true" />
                当前创作
                {currentViewTasks.length > 0 ? (
                  <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[11px] tabular-nums text-violet-700 dark:bg-violet-400/15 dark:text-violet-200">
                    {currentViewTasks.length}
                  </span>
                ) : null}
              </button>
              <button
                type="button"
                role="tab"
                id="studio-gallery-tab"
                aria-selected={resultView === "gallery"}
                aria-controls={
                  resultView === "gallery" ? "studio-gallery-panel" : undefined
                }
                onClick={() => setResultView("gallery")}
                className={cn(
                  "flex min-h-11 items-center justify-center gap-2 rounded-lg px-3 text-sm font-semibold transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 motion-reduce:transition-none",
                  resultView === "gallery"
                    ? "bg-white text-stone-950 shadow-sm dark:bg-stone-800 dark:text-white"
                    : "text-stone-500 hover:text-stone-800 dark:text-stone-400 dark:hover:text-stone-100",
                )}
              >
                <ImageIcon className="size-4" aria-hidden="true" />
                作品画廊
                {galleryTasks.length > 0 ? (
                  <span className="rounded-full bg-stone-200 px-2 py-0.5 text-[11px] tabular-nums text-stone-600 dark:bg-white/10 dark:text-stone-300">
                    {galleryTasks.length}
                  </span>
                ) : null}
              </button>
            </div>
          </div>

          {taskLoadError ? (
            <div
              role="alert"
              className="mt-5 flex items-start gap-2 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm leading-6 text-rose-700 dark:border-rose-400/25 dark:bg-rose-400/10 dark:text-rose-200"
            >
              <CircleAlert className="mt-0.5 size-4 shrink-0" />
              <span>{taskLoadError}</span>
            </div>
          ) : null}

          {isLoadingTasks ? (
            <div className="mt-5 grid min-h-72 place-items-center rounded-2xl border border-white/80 bg-white/85 dark:border-white/10 dark:bg-stone-900/70">
              <div className="text-center text-sm text-stone-500 dark:text-stone-400">
                <LoaderCircle className="mx-auto mb-3 size-5 animate-spin" />
                正在读取你的任务
              </div>
            </div>
          ) : visibleTasks.length > 0 ? (
            <div className="mt-5">
              {resultView === "current" ? (
                <section
                  id="studio-current-panel"
                  role="tabpanel"
                  aria-labelledby="studio-current-tab"
                  className={cn(
                    "rounded-2xl border p-3 sm:p-4",
                    activeTaskCount > 0
                      ? "border-violet-200/80 bg-gradient-to-br from-violet-50/70 via-stone-50/80 to-fuchsia-50/50 dark:border-violet-400/20 dark:from-violet-950/25 dark:via-white/[0.03] dark:to-fuchsia-950/15"
                      : "border-stone-200/80 bg-stone-50/70 dark:border-white/10 dark:bg-white/[0.03]",
                  )}
                >
                  <div className="mb-3 flex items-start justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-semibold text-stone-800 dark:text-stone-100">
                        {activeTaskCount > 0 ? "实时生成" : "最近一次创作"}
                      </h3>
                      <p className="mt-1 text-xs leading-5 text-stone-500 dark:text-stone-400">
                        {activeTaskCount > 0
                          ? "状态与计时会自动更新，完成后可在作品画廊查看。"
                          : statusTasks.length > 0
                            ? "未完成记录集中显示，可重新生成或删除。"
                            : "查看最新结果，可直接下载、预览或继续二创。"}
                      </p>
                    </div>
                    <span
                      className={cn(
                        "shrink-0 rounded-full px-2.5 py-1 text-xs font-medium shadow-sm",
                        activeTaskCount > 0
                          ? "bg-violet-600 text-white dark:bg-violet-400 dark:text-violet-950"
                          : "bg-white text-stone-500 dark:bg-white/10 dark:text-stone-300",
                      )}
                    >
                      {activeTaskCount > 0
                        ? `${activeTaskCount} 个进行中`
                        : `${currentViewTasks.length} 条`}
                    </span>
                  </div>
                  <div
                    className={cn(
                      "mx-auto grid w-full max-w-4xl gap-3",
                      currentViewTasks.length > 1 && "sm:grid-cols-2",
                    )}
                  >
                    {currentViewTasks.map((task) => {
                      const hasImages = getTaskImages(task).length > 0;
                      return (
                        <StudioTaskCard
                          key={task.id}
                          task={task}
                          variant={hasImages ? "gallery" : "status"}
                          elapsedSeconds={getTaskElapsedSeconds(
                            task,
                            clockNowMs,
                            taskSnapshotAtMs,
                          )}
                          onRetry={hasImages ? undefined : handleRetry}
                          onCancel={hasImages ? undefined : handleCancel}
                          onRecreate={hasImages ? undefined : handleRecreate}
                          onDelete={hasImages ? undefined : openDeleteConfirm}
                          onRemix={hasImages ? handleRemix : undefined}
                          preparingRemixImageId={preparingRemixImageId}
                          isRetrying={retryingTaskIds.has(task.id)}
                          isCancelling={cancellingTaskIds.has(task.id)}
                          isDeleting={deletingTaskIds.has(task.id)}
                          isFeatured={currentViewTasks.length === 1}
                        />
                      );
                    })}
                  </div>
                </section>
              ) : galleryTasks.length > 0 ? (
                <section
                  id="studio-gallery-panel"
                  ref={gallerySectionRef}
                  role="tabpanel"
                  aria-labelledby="studio-gallery-tab"
                  className="scroll-mt-24"
                >
                  <div className="sticky top-3 z-20 mb-3 rounded-2xl border border-stone-200/80 bg-white/95 p-3 shadow-[0_12px_28px_-24px_rgba(41,37,36,0.5)] backdrop-blur dark:border-white/10 dark:bg-stone-950/90">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                      <div>
                        <h3 className="text-sm font-semibold text-stone-800 dark:text-stone-100">
                          最近作品
                        </h3>
                        <p className="mt-1 text-xs leading-5 text-stone-500 dark:text-stone-400">
                          点击图片预览，也可直接下载或加入参考图继续二创。
                        </p>
                      </div>
                      {pagedGallery.totalPages > 1 ? (
                        <nav
                          aria-label="最近作品分页"
                          className="flex items-center justify-between gap-3 sm:justify-end"
                        >
                          <p className="text-xs leading-5 text-stone-500 dark:text-stone-400">
                            第{" "}
                            <span className="font-semibold tabular-nums text-stone-700 dark:text-stone-200">
                              {pagedGallery.page}
                            </span>{" "}
                            / {pagedGallery.totalPages} 页，共{" "}
                            {pagedGallery.totalItems} 个任务
                          </p>
                          <div className="flex items-center gap-2">
                            <Button
                              type="button"
                              variant="outline"
                              size="icon"
                              className="size-11 rounded-xl border-stone-200 bg-white text-stone-700 transition-colors duration-200 hover:border-violet-200 hover:bg-violet-50 hover:text-violet-800 disabled:cursor-not-allowed disabled:opacity-45 motion-reduce:transition-none dark:border-white/10 dark:bg-white/[0.06] dark:text-stone-100 dark:hover:border-violet-400/30 dark:hover:bg-violet-400/10 dark:hover:text-violet-100"
                              onClick={() =>
                                changeGalleryPage(pagedGallery.page - 1)
                              }
                              disabled={pagedGallery.page <= 1}
                              aria-label="上一页最近作品"
                              title="上一页"
                            >
                              <ChevronLeft
                                className="size-4"
                                aria-hidden="true"
                              />
                            </Button>
                            <span className="grid h-11 min-w-20 place-items-center rounded-xl bg-stone-900 px-3 text-xs font-semibold tabular-nums text-white dark:bg-violet-500">
                              {pagedGallery.page} / {pagedGallery.totalPages}
                            </span>
                            <Button
                              type="button"
                              variant="outline"
                              size="icon"
                              className="size-11 rounded-xl border-stone-200 bg-white text-stone-700 transition-colors duration-200 hover:border-violet-200 hover:bg-violet-50 hover:text-violet-800 disabled:cursor-not-allowed disabled:opacity-45 motion-reduce:transition-none dark:border-white/10 dark:bg-white/[0.06] dark:text-stone-100 dark:hover:border-violet-400/30 dark:hover:bg-violet-400/10 dark:hover:text-violet-100"
                              onClick={() =>
                                changeGalleryPage(pagedGallery.page + 1)
                              }
                              disabled={
                                pagedGallery.page >= pagedGallery.totalPages
                              }
                              aria-label="下一页最近作品"
                              title="下一页"
                            >
                              <ChevronRight
                                className="size-4"
                                aria-hidden="true"
                              />
                            </Button>
                          </div>
                        </nav>
                      ) : (
                        <span className="shrink-0 text-xs text-stone-400 dark:text-stone-500">
                          {galleryTasks.length} 个任务
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,18rem),1fr))] gap-3">
                    {pagedGallery.items.map((task) => (
                      <StudioTaskCard
                        key={task.id}
                        task={task}
                        elapsedSeconds={getTaskElapsedSeconds(
                          task,
                          clockNowMs,
                          taskSnapshotAtMs,
                        )}
                        onRemix={handleRemix}
                        preparingRemixImageId={preparingRemixImageId}
                      />
                    ))}
                  </div>
                </section>
              ) : (
                <div
                  id="studio-gallery-panel"
                  role="tabpanel"
                  aria-labelledby="studio-gallery-tab"
                  className="grid min-h-72 place-items-center rounded-2xl border border-dashed border-stone-200 bg-white/75 px-6 text-center dark:border-white/10 dark:bg-stone-900/60"
                >
                  <div className="max-w-xs space-y-3">
                    <ImageIcon className="mx-auto size-6 text-stone-400" />
                    <p className="text-sm leading-6 text-stone-500 dark:text-stone-400">
                      暂无已完成作品，完成生成后会自动收录到这里。
                    </p>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div
              id={
                resultView === "gallery"
                  ? "studio-gallery-panel"
                  : "studio-current-panel"
              }
              role="tabpanel"
              aria-labelledby={
                resultView === "gallery"
                  ? "studio-gallery-tab"
                  : "studio-current-tab"
              }
              className="mt-5 grid min-h-72 place-items-center rounded-2xl border border-dashed border-stone-200 bg-white/75 px-6 text-center dark:border-white/10 dark:bg-stone-900/60"
            >
              <div className="max-w-xs space-y-3">
                <div className="mx-auto grid size-12 place-items-center rounded-2xl bg-violet-50 text-violet-700 dark:bg-violet-400/10 dark:text-violet-200">
                  <ImageIcon className="size-5" />
                </div>
                <h3 className="font-semibold text-stone-800 dark:text-white">
                  还没有创作记录
                </h3>
                <p className="text-sm leading-6 text-stone-500 dark:text-stone-400">
                  写下第一个画面描述，结果会自动出现在这里。
                </p>
              </div>
            </div>
          )}

          {tasks.length > MAX_RENDERED_TASKS ? (
            <p className="mt-4 text-center text-xs text-stone-500 dark:text-stone-400">
              为保持页面流畅，仅显示最近 {MAX_RENDERED_TASKS} 条任务。
            </p>
          ) : null}
        </section>
      </div>
    </div>
  );
}
