"use client";

import Link from "next/link";
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
  ArrowRight,
  Check,
  ChevronLeft,
  ChevronRight,
  ClipboardPaste,
  Clock3,
  Download,
  Eye,
  FileText,
  History,
  ImagePlus,
  LoaderCircle,
  PackageSearch,
  RefreshCw,
  ScanLine,
  ShieldCheck,
  Sparkles,
  Upload,
  UserRound,
  WandSparkles,
  Waves,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { ImageComparisonSlider } from "@/components/image-comparison-slider";
import { ImageLightbox } from "@/components/image-lightbox";
import { Button } from "@/components/ui/button";
import {
  createImageEditTask,
  fetchImageTasks,
  type ImageTask,
} from "@/lib/api";
import { validateReferenceImages } from "@/lib/image-references";
import { USER_DEFAULT_IMAGE_MODEL } from "@/lib/image-model-policy";
import {
  buildRestorePrompt,
  isRestoreTask,
  parseRestorePrompt,
  RESTORE_MODES,
  RESTORE_STRENGTHS,
  type RestoreMode,
  type RestoreStrength,
} from "@/lib/image-restore";
import { getImageTaskErrorPresentation } from "@/lib/image-task-presentation";
import { useAuthGuard } from "@/lib/use-auth-guard";
import { cn } from "@/lib/utils";

const RESTORE_MODEL = USER_DEFAULT_IMAGE_MODEL;
const RESTORE_TASK_STORAGE_KEY = "xg-image-restore-current-task";
const HISTORY_PAGE_SIZE = 6;

type RestoreImage = {
  id: string;
  src: string;
};

const RESTORE_MODE_ICONS = {
  general: ScanLine,
  portrait: UserRound,
  old_photo: History,
  product: PackageSearch,
  text: FileText,
  denoise: Waves,
} satisfies Record<RestoreMode, typeof ScanLine>;

function formatTaskDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "时间未知";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function sortRestoreTasks(tasks: ImageTask[]) {
  return [...tasks].sort(
    (left, right) =>
      new Date(right.created_at).getTime() -
      new Date(left.created_at).getTime(),
  );
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

function getTaskImages(task: ImageTask | null): RestoreImage[] {
  if (!task) {
    return [];
  }
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

function outputSizeForDimensions(width: number, height: number) {
  if (width > height * 1.15) {
    return "1536x1024";
  }
  if (height > width * 1.15) {
    return "1024x1536";
  }
  return "1024x1024";
}

async function detectOutputSize(file: File) {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(file);
    try {
      return outputSizeForDimensions(bitmap.width, bitmap.height);
    } finally {
      bitmap.close();
    }
  }

  const source = URL.createObjectURL(file);
  try {
    const dimensions = await new Promise<{ width: number; height: number }>(
      (resolve, reject) => {
        const image = new Image();
        image.onload = () =>
          resolve({ width: image.naturalWidth, height: image.naturalHeight });
        image.onerror = () => reject(new Error("读取图片尺寸失败"));
        image.src = source;
      },
    );
    return outputSizeForDimensions(dimensions.width, dimensions.height);
  } finally {
    URL.revokeObjectURL(source);
  }
}

function formatElapsedTime(seconds: number) {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  const remainingSeconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
}

function taskElapsedSeconds(task: ImageTask | null, now: number) {
  if (!task) {
    return 0;
  }
  if (task.status !== "queued" && task.status !== "running") {
    if (typeof task.duration_ms === "number") {
      return task.duration_ms / 1_000;
    }
    return Number(task.elapsed_secs || 0);
  }
  const createdAt = new Date(
    String(task.created_at || "").replace(" ", "T"),
  ).getTime();
  return Number.isNaN(createdAt)
    ? Number(task.elapsed_secs || 0)
    : Math.max(0, (now - createdAt) / 1_000);
}

function triggerDownload(source: string, fileName: string) {
  const link = document.createElement("a");
  link.href = source;
  link.download = fileName;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

async function downloadRestoreImage(image: RestoreImage, taskId: string) {
  let objectUrl = "";
  try {
    const response = await fetch(image.src);
    if (!response.ok) {
      throw new Error(`download failed: ${response.status}`);
    }
    objectUrl = URL.createObjectURL(await response.blob());
    triggerDownload(objectUrl, `xg-hd-restore-${taskId}.png`);
  } catch {
    triggerDownload(image.src, `xg-hd-restore-${taskId}.png`);
  } finally {
    if (objectUrl) {
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
    }
  }
}

async function readClipboardImageFile() {
  if (!navigator.clipboard?.read) {
    throw new Error(
      "当前浏览器不支持一键读取剪贴板，请点击上传区后按 Ctrl+V。",
    );
  }

  const clipboardItems = await navigator.clipboard.read();
  for (const item of clipboardItems) {
    const imageType = item.types.find((type) => type.startsWith("image/"));
    if (!imageType) {
      continue;
    }
    const blob = await item.getType(imageType);
    const extension =
      imageType === "image/jpeg"
        ? "jpg"
        : imageType === "image/webp"
          ? "webp"
          : "png";
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    return new File([blob], `粘贴图片-${timestamp}.${extension}`, {
      type: imageType,
      lastModified: Date.now(),
    });
  }

  throw new Error("剪贴板里没有图片，请先截图或复制一张图片后再试。");
}

export default function RestorePage() {
  const { isCheckingAuth, session } = useAuthGuard(["user"]);
  const inputRef = useRef<HTMLInputElement>(null);
  const previewUrlRef = useRef("");
  const fileSelectionVersionRef = useRef(0);
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [outputSize, setOutputSize] = useState("1024x1024");
  const [isReadingDimensions, setIsReadingDimensions] = useState(false);
  const [isReadingClipboard, setIsReadingClipboard] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [task, setTask] = useState<ImageTask | null>(null);
  const [error, setError] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [remainingQuota, setRemainingQuota] = useState<number | null>(null);
  const [restoreMode, setRestoreMode] = useState<RestoreMode>("general");
  const [restoreStrength, setRestoreStrength] =
    useState<RestoreStrength>("standard");
  const [historyTasks, setHistoryTasks] = useState<ImageTask[]>([]);
  const [historyPage, setHistoryPage] = useState(1);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [historyError, setHistoryError] = useState("");

  const taskPending = task?.status === "queued" || task?.status === "running";
  const resultImages = useMemo(() => getTaskImages(task), [task]);
  const resultImage = resultImages[0] || null;
  const currentRestoreMetadata = parseRestorePrompt(task?.prompt);
  const elapsedLabel = formatElapsedTime(taskElapsedSeconds(task, now));
  const displayedQuota =
    remainingQuota ??
    (typeof session?.imageQuota === "number" ? session.imageQuota : null);
  const historyPageCount = Math.max(
    1,
    Math.ceil(historyTasks.length / HISTORY_PAGE_SIZE),
  );
  const safeHistoryPage = Math.min(historyPage, historyPageCount);
  const visibleHistoryTasks = historyTasks.slice(
    (safeHistoryPage - 1) * HISTORY_PAGE_SIZE,
    safeHistoryPage * HISTORY_PAGE_SIZE,
  );

  const upsertHistoryTask = useCallback((nextTask: ImageTask) => {
    if (!isRestoreTask(nextTask)) {
      return;
    }
    setHistoryTasks((current) =>
      sortRestoreTasks([
        nextTask,
        ...current.filter((item) => item.id !== nextTask.id),
      ]),
    );
  }, []);

  const refreshHistory = useCallback(async () => {
    setIsLoadingHistory(true);
    setHistoryError("");
    try {
      const data = await fetchImageTasks([]);
      setHistoryTasks(sortRestoreTasks(data.items.filter(isRestoreTask)));
    } catch (loadError) {
      setHistoryError(
        loadError instanceof Error ? loadError.message : "修复记录读取失败",
      );
    } finally {
      setIsLoadingHistory(false);
    }
  }, []);

  const rememberTask = useCallback((nextTask: ImageTask | null) => {
    setTask(nextTask);
    if (typeof window === "undefined") {
      return;
    }
    if (nextTask) {
      window.sessionStorage.setItem(RESTORE_TASK_STORAGE_KEY, nextTask.id);
    } else {
      window.sessionStorage.removeItem(RESTORE_TASK_STORAGE_KEY);
    }
  }, []);

  const openHistoryTask = useCallback(
    (historyTask: ImageTask) => {
      if (taskPending) {
        return;
      }
      fileSelectionVersionRef.current += 1;
      if (previewUrlRef.current) {
        URL.revokeObjectURL(previewUrlRef.current);
        previewUrlRef.current = "";
      }
      setFile(null);
      setPreviewUrl("");
      setError("");
      setIsPreviewOpen(false);
      const metadata = parseRestorePrompt(historyTask.prompt);
      setRestoreMode(metadata.mode);
      setRestoreStrength(metadata.strength);
      rememberTask(historyTask);
      window.requestAnimationFrame(() => {
        document
          .getElementById("restore-result")
          ?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    },
    [rememberTask, taskPending],
  );

  const selectFile = useCallback(
    async (nextFile: File) => {
      if (taskPending) {
        const message = "当前图片正在修复，请等待完成后再更换原图。";
        setError(message);
        setAnnouncement(message);
        return;
      }

      const validation = validateReferenceImages([nextFile], 0);
      if (validation.accepted.length === 0) {
        const message = validation.errors.join(" ") || "请选择支持的图片文件。";
        setError(message);
        setAnnouncement(message);
        return;
      }

      const acceptedFile = validation.accepted[0];
      fileSelectionVersionRef.current += 1;
      const selectionVersion = fileSelectionVersionRef.current;
      if (previewUrlRef.current) {
        URL.revokeObjectURL(previewUrlRef.current);
      }
      const nextPreviewUrl = URL.createObjectURL(acceptedFile);
      previewUrlRef.current = nextPreviewUrl;
      setFile(acceptedFile);
      setPreviewUrl(nextPreviewUrl);
      rememberTask(null);
      setError("");
      setIsReadingDimensions(true);
      setAnnouncement("原图已添加，正在识别图片比例。无需填写提示词。 ");
      try {
        const detectedSize = await detectOutputSize(acceptedFile);
        if (selectionVersion === fileSelectionVersionRef.current) {
          setOutputSize(detectedSize);
          setAnnouncement(`原图已就绪，将按 ${detectedSize} 进行高清修复。`);
        }
      } catch {
        if (selectionVersion === fileSelectionVersionRef.current) {
          setOutputSize("1024x1024");
          setAnnouncement("图片比例读取失败，将使用方形高清尺寸进行修复。 ");
        }
      } finally {
        if (selectionVersion === fileSelectionVersionRef.current) {
          setIsReadingDimensions(false);
        }
      }
    },
    [rememberTask, taskPending],
  );

  const clearFile = () => {
    if (taskPending) {
      return;
    }
    fileSelectionVersionRef.current += 1;
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = "";
    }
    setFile(null);
    setPreviewUrl("");
    setIsReadingDimensions(false);
    setOutputSize("1024x1024");
    setError("");
    rememberTask(null);
    if (inputRef.current) {
      inputRef.current.value = "";
    }
  };

  const handlePaste = (event: ClipboardEvent<HTMLDivElement>) => {
    const pastedFile = Array.from(event.clipboardData.files || []).find(
      (item) => item.type.startsWith("image/"),
    );
    if (!pastedFile) {
      return;
    }
    event.preventDefault();
    void selectFile(pastedFile);
  };

  const handlePasteButton = async () => {
    if (taskPending || isReadingClipboard) {
      return;
    }
    setIsReadingClipboard(true);
    setError("");
    try {
      await selectFile(await readClipboardImageFile());
    } catch (pasteError) {
      const message =
        pasteError instanceof DOMException &&
        pasteError.name === "NotAllowedError"
          ? "浏览器未允许读取剪贴板，请点击上传区后按 Ctrl+V。"
          : pasteError instanceof Error
            ? pasteError.message
            : "读取剪贴板图片失败，请点击上传区后按 Ctrl+V。";
      setError(message);
      setAnnouncement(message);
    } finally {
      setIsReadingClipboard(false);
    }
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
    const droppedFile = Array.from(event.dataTransfer.files || []).find(
      (item) => item.type.startsWith("image/"),
    );
    if (droppedFile) {
      void selectFile(droppedFile);
    }
  };

  const handleSubmit = async () => {
    if (!file) {
      const message = "请先上传一张需要高清修复的图片。";
      setError(message);
      setAnnouncement(message);
      inputRef.current?.focus();
      return;
    }
    if (isReadingDimensions || isSubmitting || taskPending) {
      return;
    }

    setIsSubmitting(true);
    setError("");
    try {
      const createdTask = await createImageEditTask(
        createClientTaskId(),
        file,
        buildRestorePrompt(restoreMode, restoreStrength),
        RESTORE_MODEL,
        outputSize,
        "high",
      );
      rememberTask(createdTask);
      upsertHistoryTask(createdTask);
      setHistoryPage(1);
      setNow(Date.now());
      if (typeof createdTask.remaining_image_quota === "number") {
        setRemainingQuota(createdTask.remaining_image_quota);
      }
      setAnnouncement("高清修复任务已提交，完成后结果会自动显示。 ");
      toast.success("高清修复已开始");
    } catch (submitError) {
      const message =
        submitError instanceof Error ? submitError.message : "提交高清修复失败";
      setError(message);
      setAnnouncement(message);
      toast.error(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  useEffect(() => {
    previewUrlRef.current = previewUrl;
  }, [previewUrl]);

  useEffect(
    () => () => {
      if (previewUrlRef.current) {
        URL.revokeObjectURL(previewUrlRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (!session) {
      return;
    }
    const historyTimer = window.setTimeout(() => void refreshHistory(), 0);
    const storedTaskId = window.sessionStorage.getItem(
      RESTORE_TASK_STORAGE_KEY,
    );
    if (!storedTaskId) {
      return () => window.clearTimeout(historyTimer);
    }
    let active = true;
    void fetchImageTasks([storedTaskId])
      .then((data) => {
        if (!active) {
          return;
        }
        const storedTask = data.items.find((item) => item.id === storedTaskId);
        if (storedTask) {
          setTask(storedTask);
          upsertHistoryTask(storedTask);
          if (typeof storedTask.remaining_image_quota === "number") {
            setRemainingQuota(storedTask.remaining_image_quota);
          }
        } else {
          window.sessionStorage.removeItem(RESTORE_TASK_STORAGE_KEY);
        }
      })
      .catch(() => {
        // The normal polling path or a manual retry can recover a transient read failure.
      });
    return () => {
      active = false;
      window.clearTimeout(historyTimer);
    };
  }, [refreshHistory, session, upsertHistoryTask]);

  useEffect(() => {
    const taskId = task?.id;
    if (!taskPending || !taskId) {
      return;
    }
    let active = true;
    let timer = 0;
    const poll = async () => {
      let shouldContinue = true;
      try {
        const data = await fetchImageTasks([taskId]);
        const updatedTask = data.items.find((item) => item.id === taskId);
        if (!active || !updatedTask) {
          return;
        }
        setTask(updatedTask);
        upsertHistoryTask(updatedTask);
        if (typeof updatedTask.remaining_image_quota === "number") {
          setRemainingQuota(updatedTask.remaining_image_quota);
        }
        if (updatedTask.status === "success") {
          shouldContinue = false;
          setAnnouncement("高清修复已完成，可以预览或下载图片。 ");
          toast.success("高清修复完成");
        } else if (updatedTask.status === "error") {
          shouldContinue = false;
          setAnnouncement("高清修复未完成，请按页面提示重新尝试。 ");
        }
      } catch {
        // Keep the current task visible; the next polling tick retries automatically.
      } finally {
        if (active && shouldContinue) {
          timer = window.setTimeout(() => void poll(), 2_500);
        }
      }
    };
    timer = window.setTimeout(() => void poll(), 2_500);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [task?.id, taskPending, upsertHistoryTask]);

  useEffect(() => {
    if (!taskPending) {
      return;
    }
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [taskPending]);

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

  const taskError =
    task?.status === "error"
      ? getImageTaskErrorPresentation(task.error_code, task.error)
      : null;

  return (
    <div className="mx-auto w-full max-w-6xl pb-10 sm:pb-14">
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>

      <section className="relative overflow-hidden rounded-[28px] border border-white/80 bg-white/90 px-5 py-6 shadow-[0_24px_70px_-46px_rgba(109,40,217,0.45)] dark:border-white/10 dark:bg-stone-900/80 sm:px-8 sm:py-8">
        <div className="pointer-events-none absolute -top-24 right-[-5rem] size-64 rounded-full bg-violet-200/45 blur-3xl dark:bg-violet-500/10" />
        <div className="relative flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-2xl">
            <span className="inline-flex items-center gap-2 rounded-full bg-violet-50 px-3 py-1.5 text-xs font-semibold text-violet-700 dark:bg-violet-400/10 dark:text-violet-200">
              <ScanLine className="size-3.5" aria-hidden="true" />
              XG 高清修复
            </span>
            <h1 className="mt-4 text-3xl font-semibold tracking-[-0.04em] text-stone-950 dark:text-white sm:text-4xl">
              上传原图，一键恢复清晰细节
            </h1>
            <p className="mt-3 max-w-xl text-sm leading-7 text-stone-600 dark:text-stone-300 sm:text-base">
              无需填写提示词。系统会自动识别图片比例，清理模糊、噪点和压缩痕迹，同时尽量保持原人物与构图。
            </p>
          </div>
          <div className="flex flex-wrap gap-2 text-xs font-medium text-stone-600 dark:text-stone-300">
            <span className="inline-flex min-h-9 items-center gap-1.5 rounded-full border border-stone-200 bg-white px-3 dark:border-white/10 dark:bg-white/[0.04]">
              <ShieldCheck
                className="size-3.5 text-violet-600"
                aria-hidden="true"
              />
              保持原图结构
            </span>
            <span className="inline-flex min-h-9 items-center gap-1.5 rounded-full border border-stone-200 bg-white px-3 dark:border-white/10 dark:bg-white/[0.04]">
              <Sparkles
                className="size-3.5 text-violet-600"
                aria-hidden="true"
              />
              自动高清增强
            </span>
          </div>
        </div>
      </section>

      <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <section className="rounded-[24px] border border-stone-200/80 bg-white p-4 shadow-[0_18px_50px_-40px_rgba(41,37,36,0.5)] dark:border-white/10 dark:bg-stone-900 sm:p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs font-semibold tracking-[0.12em] text-violet-700 dark:text-violet-200">
                第一步
              </p>
              <h2 className="mt-1 text-xl font-semibold text-stone-950 dark:text-white">
                上传需要修复的原图
              </h2>
            </div>
            {displayedQuota !== null ? (
              <span className="rounded-full bg-stone-100 px-3 py-1.5 text-xs font-medium text-stone-600 dark:bg-white/10 dark:text-stone-300">
                剩余 {displayedQuota} 张
              </span>
            ) : null}
          </div>

          <input
            ref={inputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
            className="sr-only"
            onChange={(event) => {
              const selectedFile = event.target.files?.[0];
              if (selectedFile) {
                void selectFile(selectedFile);
              }
              event.target.value = "";
            }}
          />

          <div
            tabIndex={0}
            onPaste={handlePaste}
            onDragEnter={(event) => {
              event.preventDefault();
              setIsDragging(true);
            }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node)) {
                setIsDragging(false);
              }
            }}
            onDrop={handleDrop}
            aria-label="高清修复图片上传区"
            className={cn(
              "mt-5 overflow-hidden rounded-2xl border border-dashed p-3 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2 motion-reduce:transition-none dark:focus-visible:ring-offset-stone-900",
              isDragging
                ? "border-violet-500 bg-violet-50 dark:bg-violet-400/10"
                : "border-stone-300 bg-stone-50/70 dark:border-white/15 dark:bg-white/[0.03]",
            )}
          >
            {previewUrl ? (
              <div className="space-y-3">
                <div className="relative flex min-h-72 items-center justify-center overflow-hidden rounded-xl bg-[linear-gradient(45deg,#f5f5f4_25%,transparent_25%),linear-gradient(-45deg,#f5f5f4_25%,transparent_25%),linear-gradient(45deg,transparent_75%,#f5f5f4_75%),linear-gradient(-45deg,transparent_75%,#f5f5f4_75%)] bg-[length:20px_20px] bg-[position:0_0,0_10px,10px_-10px,-10px_0px] dark:bg-stone-950">
                  {/* Local object URLs cannot use the static image optimizer. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={previewUrl}
                    alt={`待修复原图：${file?.name || "已上传图片"}`}
                    className="max-h-[28rem] w-full object-contain"
                  />
                  <button
                    type="button"
                    onClick={clearFile}
                    disabled={taskPending}
                    className="absolute top-2 right-2 inline-flex size-11 items-center justify-center rounded-full bg-black/65 text-white transition hover:bg-black/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 disabled:cursor-not-allowed disabled:opacity-50"
                    aria-label="移除原图"
                  >
                    <X className="size-4" aria-hidden="true" />
                  </button>
                </div>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-stone-800 dark:text-stone-100">
                      {file?.name}
                    </p>
                    <p className="mt-0.5 text-xs text-stone-500 dark:text-stone-400">
                      {isReadingDimensions
                        ? "正在识别图片比例"
                        : `自动输出尺寸 ${outputSize}`}
                    </p>
                  </div>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Button
                      type="button"
                      variant="outline"
                      className="h-11 rounded-xl"
                      onClick={() => inputRef.current?.click()}
                      disabled={taskPending}
                    >
                      <Upload className="size-4" aria-hidden="true" />
                      更换图片
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      className="h-11 rounded-xl border-violet-200 bg-violet-50 text-violet-700 hover:bg-violet-100 hover:text-violet-800 dark:border-violet-400/20 dark:bg-violet-400/10 dark:text-violet-200 dark:hover:bg-violet-400/15"
                      onClick={() => void handlePasteButton()}
                      disabled={taskPending || isReadingClipboard}
                    >
                      {isReadingClipboard ? (
                        <LoaderCircle
                          className="size-4 animate-spin motion-reduce:animate-none"
                          aria-hidden="true"
                        />
                      ) : (
                        <ClipboardPaste className="size-4" aria-hidden="true" />
                      )}
                      {isReadingClipboard ? "正在读取" : "粘贴替换"}
                    </Button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex min-h-80 w-full flex-col items-center justify-center rounded-xl px-5 text-center">
                <span className="grid size-14 place-items-center rounded-2xl bg-violet-100 text-violet-700 dark:bg-violet-400/15 dark:text-violet-200">
                  <ImagePlus className="size-6" aria-hidden="true" />
                </span>
                <strong className="mt-4 text-base text-stone-900 dark:text-white">
                  选择一张需要修复的图片
                </strong>
                <span className="mt-2 text-sm leading-6 text-stone-500 dark:text-stone-400">
                  选择文件、拖拽到这里，或直接粘贴剪贴板图片
                </span>
                <div className="mt-4 flex w-full max-w-sm flex-col gap-2 sm:flex-row">
                  <Button
                    type="button"
                    variant="outline"
                    className="h-11 flex-1 rounded-xl bg-white text-violet-700 shadow-sm dark:bg-white/10 dark:text-violet-200"
                    onClick={() => inputRef.current?.click()}
                  >
                    <Upload className="size-4" aria-hidden="true" />
                    上传原图
                  </Button>
                  <Button
                    type="button"
                    className="h-11 flex-1 rounded-xl bg-violet-700 text-white shadow-sm hover:bg-violet-800 dark:bg-violet-500 dark:hover:bg-violet-400"
                    onClick={() => void handlePasteButton()}
                    disabled={isReadingClipboard}
                  >
                    {isReadingClipboard ? (
                      <LoaderCircle
                        className="size-4 animate-spin motion-reduce:animate-none"
                        aria-hidden="true"
                      />
                    ) : (
                      <ClipboardPaste className="size-4" aria-hidden="true" />
                    )}
                    {isReadingClipboard ? "正在读取" : "粘贴图片"}
                  </Button>
                </div>
                <span className="mt-3 text-xs text-stone-400 dark:text-stone-500">
                  也可以先点击此区域，再按 Ctrl+V
                </span>
              </div>
            )}
          </div>

          <p className="mt-3 text-xs leading-5 text-stone-500 dark:text-stone-400">
            支持 PNG、JPG、JPEG、WEBP，单张不超过 50 MB。高清修复会消耗 1
            张生图额度。
          </p>

          <fieldset className="mt-5" disabled={Boolean(taskPending)}>
            <div className="flex items-end justify-between gap-3">
              <div>
                <legend className="text-sm font-semibold text-stone-900 dark:text-white">
                  选择修复模式
                </legend>
                <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
                  系统自动执行，无需填写提示词
                </p>
              </div>
              <span className="text-xs font-medium text-violet-700 dark:text-violet-200">
                {
                  RESTORE_MODES.find((item) => item.value === restoreMode)
                    ?.label
                }
              </span>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
              {RESTORE_MODES.map((modeOption) => {
                const ModeIcon = RESTORE_MODE_ICONS[modeOption.value];
                const selected = restoreMode === modeOption.value;
                return (
                  <button
                    key={modeOption.value}
                    type="button"
                    aria-pressed={selected}
                    data-restore-mode={modeOption.value}
                    onClick={() => setRestoreMode(modeOption.value)}
                    className={cn(
                      "min-h-[76px] cursor-pointer rounded-xl border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:transition-none",
                      selected
                        ? "border-violet-500 bg-violet-50 text-violet-800 shadow-sm dark:border-violet-400 dark:bg-violet-400/10 dark:text-violet-100"
                        : "border-stone-200 bg-white text-stone-700 hover:border-violet-300 hover:bg-violet-50/60 dark:border-white/10 dark:bg-white/[0.03] dark:text-stone-200 dark:hover:border-violet-400/40 dark:hover:bg-violet-400/[0.07]",
                    )}
                  >
                    <span className="flex items-center gap-2 text-sm font-semibold">
                      <ModeIcon className="size-4" aria-hidden="true" />
                      {modeOption.label}
                    </span>
                    <span className="mt-1 block text-xs leading-5 opacity-70">
                      {modeOption.description}
                    </span>
                  </button>
                );
              })}
            </div>
          </fieldset>

          <fieldset className="mt-4" disabled={Boolean(taskPending)}>
            <legend className="text-sm font-semibold text-stone-900 dark:text-white">
              修复强度
            </legend>
            <div className="mt-2 grid grid-cols-3 rounded-xl bg-stone-100 p-1 dark:bg-white/[0.06]">
              {RESTORE_STRENGTHS.map((strengthOption) => {
                const selected = restoreStrength === strengthOption.value;
                return (
                  <button
                    key={strengthOption.value}
                    type="button"
                    aria-pressed={selected}
                    data-restore-strength={strengthOption.value}
                    onClick={() => setRestoreStrength(strengthOption.value)}
                    className={cn(
                      "min-h-11 cursor-pointer rounded-lg px-2 py-1.5 text-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:transition-none",
                      selected
                        ? "bg-white text-violet-700 shadow-sm dark:bg-violet-500 dark:text-white"
                        : "text-stone-500 hover:text-stone-900 dark:text-stone-400 dark:hover:text-white",
                    )}
                  >
                    <span className="block text-sm font-semibold">
                      {strengthOption.label}
                    </span>
                    <span className="hidden text-[11px] opacity-70 sm:block">
                      {strengthOption.description}
                    </span>
                  </button>
                );
              })}
            </div>
          </fieldset>

          {error ? (
            <p
              role="alert"
              className="mt-3 rounded-xl bg-rose-50 px-3 py-2.5 text-sm leading-6 text-rose-700 dark:bg-rose-400/10 dark:text-rose-200"
            >
              {error}
            </p>
          ) : null}

          <Button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={
              !file ||
              isReadingDimensions ||
              isSubmitting ||
              Boolean(taskPending)
            }
            className="mt-4 h-12 w-full rounded-xl bg-violet-700 text-base font-semibold text-white shadow-[0_14px_28px_-16px_rgba(109,40,217,0.8)] hover:bg-violet-800 focus-visible:ring-violet-500 dark:bg-violet-500 dark:hover:bg-violet-400"
          >
            {isSubmitting || taskPending ? (
              <LoaderCircle
                className="size-4 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : (
              <WandSparkles className="size-4" aria-hidden="true" />
            )}
            {isSubmitting
              ? "正在提交"
              : taskPending
                ? `正在高清修复 · ${elapsedLabel}`
                : task?.status === "error"
                  ? `重新执行${RESTORE_MODES.find((item) => item.value === restoreMode)?.label || "高清修复"}`
                  : `开始${RESTORE_MODES.find((item) => item.value === restoreMode)?.label || "高清修复"}`}
          </Button>
        </section>

        <section
          id="restore-result"
          className="scroll-mt-24 rounded-[24px] border border-stone-200/80 bg-white p-4 shadow-[0_18px_50px_-40px_rgba(41,37,36,0.5)] dark:border-white/10 dark:bg-stone-900 sm:p-5"
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs font-semibold tracking-[0.12em] text-violet-700 dark:text-violet-200">
                第二步
              </p>
              <h2 className="mt-1 text-xl font-semibold text-stone-950 dark:text-white">
                查看高清结果
              </h2>
            </div>
            {task ? (
              <span
                className={cn(
                  "inline-flex min-h-8 items-center gap-1.5 rounded-full px-3 text-xs font-semibold",
                  task.status === "success"
                    ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-200"
                    : task.status === "error"
                      ? "bg-rose-50 text-rose-700 dark:bg-rose-400/10 dark:text-rose-200"
                      : "bg-violet-50 text-violet-700 dark:bg-violet-400/10 dark:text-violet-200",
                )}
              >
                {task.status === "success" ? (
                  <Check className="size-3.5" aria-hidden="true" />
                ) : task.status === "error" ? (
                  <X className="size-3.5" aria-hidden="true" />
                ) : (
                  <LoaderCircle
                    className="size-3.5 animate-spin motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                )}
                {task.status === "success"
                  ? "修复完成"
                  : task.status === "error"
                    ? "需要重试"
                    : "修复中"}
              </span>
            ) : null}
          </div>

          <div className="mt-5 min-h-[30rem] overflow-hidden rounded-2xl border border-stone-200 bg-stone-50/70 dark:border-white/10 dark:bg-white/[0.03]">
            {resultImage && task?.status === "success" ? (
              <div className="flex min-h-[30rem] flex-col">
                {previewUrl ? (
                  <ImageComparisonSlider
                    originalSrc={previewUrl}
                    restoredSrc={resultImage.src}
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => setIsPreviewOpen(true)}
                    className="group relative flex min-h-[25rem] flex-1 cursor-zoom-in items-center justify-center overflow-hidden bg-stone-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-500 dark:bg-stone-950"
                    aria-label="预览高清修复结果"
                  >
                    {/* Dynamic task URLs cannot use the static image optimizer. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={resultImage.src}
                      alt="高清修复结果"
                      className="max-h-[34rem] w-full object-contain"
                    />
                    <span className="absolute bottom-3 left-3 inline-flex min-h-9 items-center gap-1.5 rounded-full bg-black/65 px-3 text-xs font-medium text-white">
                      <Eye className="size-4" aria-hidden="true" />
                      点击预览
                    </span>
                  </button>
                )}
                <div className="border-t border-stone-200 bg-white p-3 dark:border-white/10 dark:bg-stone-900">
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-stone-600 dark:text-stone-300">
                    <span className="inline-flex items-center gap-2">
                      <Clock3
                        className="size-4 text-violet-600"
                        aria-hidden="true"
                      />
                      修复耗时 {elapsedLabel}
                    </span>
                    <span className="rounded-full bg-violet-50 px-2.5 py-1 text-xs font-semibold text-violet-700 dark:bg-violet-400/10 dark:text-violet-200">
                      {currentRestoreMetadata.modeLabel} ·{" "}
                      {currentRestoreMetadata.strengthLabel}
                    </span>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      className="h-11 rounded-xl"
                      onClick={() => setIsPreviewOpen(true)}
                    >
                      <Eye className="size-4" aria-hidden="true" />
                      全屏预览
                    </Button>
                    <Button
                      type="button"
                      className="h-11 rounded-xl bg-violet-700 text-white hover:bg-violet-800 dark:bg-violet-500 dark:hover:bg-violet-400"
                      onClick={() =>
                        void downloadRestoreImage(resultImage, task.id)
                      }
                    >
                      <Download className="size-4" aria-hidden="true" />
                      下载高清图
                    </Button>
                  </div>
                </div>
              </div>
            ) : taskPending ? (
              <div className="relative flex min-h-[30rem] flex-col items-center justify-center overflow-hidden px-6 text-center">
                <span className="absolute size-56 rounded-full bg-violet-200/55 blur-3xl motion-safe:animate-pulse motion-reduce:animate-none dark:bg-violet-500/15" />
                <span className="relative grid size-16 place-items-center rounded-2xl bg-white text-violet-700 shadow-[0_18px_40px_-24px_rgba(109,40,217,0.8)] dark:bg-stone-900 dark:text-violet-200">
                  <ScanLine
                    className="size-7 motion-safe:animate-pulse motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                </span>
                <h3 className="relative mt-5 text-lg font-semibold text-stone-900 dark:text-white">
                  正在恢复图片细节
                </h3>
                <p className="relative mt-2 max-w-sm text-sm leading-6 text-stone-500 dark:text-stone-400">
                  正在清理模糊和噪点，并重建边缘与自然纹理。任务完成后会自动显示结果。
                </p>
                <span className="relative mt-4 inline-flex items-center gap-2 rounded-full bg-white px-3 py-1.5 text-xs font-medium text-stone-600 shadow-sm dark:bg-white/10 dark:text-stone-300">
                  <Clock3 className="size-3.5" aria-hidden="true" />
                  已用时 {elapsedLabel}
                </span>
              </div>
            ) : taskError ? (
              <div className="flex min-h-[30rem] flex-col items-center justify-center px-6 text-center">
                <span className="grid size-14 place-items-center rounded-2xl bg-rose-50 text-rose-600 dark:bg-rose-400/10 dark:text-rose-200">
                  <X className="size-6" aria-hidden="true" />
                </span>
                <h3 className="mt-4 text-lg font-semibold text-stone-900 dark:text-white">
                  {taskError.title}
                </h3>
                <p className="mt-2 max-w-sm text-sm leading-6 text-stone-500 dark:text-stone-400">
                  {taskError.detail} {taskError.action}
                </p>
                {file ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="mt-5 h-11 rounded-xl"
                    onClick={() => void handleSubmit()}
                  >
                    重新尝试
                  </Button>
                ) : null}
              </div>
            ) : (
              <div className="flex min-h-[30rem] flex-col items-center justify-center px-6 text-center">
                <span className="grid size-14 place-items-center rounded-2xl bg-stone-100 text-stone-400 dark:bg-white/10 dark:text-stone-500">
                  <ScanLine className="size-6" aria-hidden="true" />
                </span>
                <h3 className="mt-4 text-base font-semibold text-stone-800 dark:text-stone-100">
                  高清结果将在这里显示
                </h3>
                <p className="mt-2 max-w-sm text-sm leading-6 text-stone-500 dark:text-stone-400">
                  上传原图后直接开始修复，不需要选择模型、尺寸或编写提示词。
                </p>
              </div>
            )}
          </div>

          <Link
            href="/studio"
            className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-xl px-2 text-sm font-medium text-stone-500 transition hover:text-violet-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 dark:text-stone-400 dark:hover:text-violet-200"
          >
            需要自由二创？返回个人工作台
            <ArrowRight className="size-4" aria-hidden="true" />
          </Link>
        </section>
      </div>

      <section className="mt-5 rounded-[24px] border border-stone-200/80 bg-white p-4 shadow-[0_18px_50px_-40px_rgba(41,37,36,0.5)] dark:border-white/10 dark:bg-stone-900 sm:p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-xs font-semibold tracking-[0.12em] text-violet-700 dark:text-violet-200">
              修复记录
            </p>
            <h2 className="mt-1 text-xl font-semibold text-stone-950 dark:text-white">
              我的高清修复历史
            </h2>
            <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
              仅展示高清修复任务，与提示词生图和二创记录分开。
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-stone-500 dark:text-stone-400">
              共 {historyTasks.length} 条
            </span>
            <Button
              type="button"
              variant="outline"
              className="h-11 rounded-xl"
              onClick={() => void refreshHistory()}
              disabled={isLoadingHistory}
            >
              <RefreshCw
                className={cn(
                  "size-4",
                  isLoadingHistory && "animate-spin motion-reduce:animate-none",
                )}
                aria-hidden="true"
              />
              刷新记录
            </Button>
          </div>
        </div>

        {historyError ? (
          <p
            role="alert"
            className="mt-4 rounded-xl bg-rose-50 px-3 py-2.5 text-sm text-rose-700 dark:bg-rose-400/10 dark:text-rose-200"
          >
            {historyError}
          </p>
        ) : null}

        {isLoadingHistory && historyTasks.length === 0 ? (
          <div className="mt-4 flex min-h-48 items-center justify-center gap-2 rounded-2xl border border-stone-200 bg-stone-50 text-sm text-stone-500 dark:border-white/10 dark:bg-white/[0.03] dark:text-stone-400">
            <LoaderCircle
              className="size-5 animate-spin text-violet-600 motion-reduce:animate-none"
              aria-hidden="true"
            />
            正在读取修复记录
          </div>
        ) : visibleHistoryTasks.length > 0 ? (
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {visibleHistoryTasks.map((historyTask) => {
              const historyImage = getTaskImages(historyTask)[0] || null;
              const metadata = parseRestorePrompt(historyTask.prompt);
              const HistoryModeIcon = RESTORE_MODE_ICONS[metadata.mode];
              const statusLabel =
                historyTask.status === "success"
                  ? "已完成"
                  : historyTask.status === "error"
                    ? "需重试"
                    : "处理中";
              return (
                <article
                  key={historyTask.id}
                  className="overflow-hidden rounded-2xl border border-stone-200 bg-stone-50/70 dark:border-white/10 dark:bg-white/[0.03]"
                >
                  <div className="relative flex aspect-[4/3] items-center justify-center overflow-hidden bg-stone-100 dark:bg-stone-950">
                    {historyImage ? (
                      // Dynamic task URLs cannot use the static image optimizer.
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={historyImage.src}
                        alt={`${metadata.modeLabel}结果`}
                        className="size-full object-cover"
                      />
                    ) : (
                      <span className="grid size-12 place-items-center rounded-2xl bg-white text-stone-400 shadow-sm dark:bg-stone-900 dark:text-stone-500">
                        {historyTask.status === "queued" ||
                        historyTask.status === "running" ? (
                          <LoaderCircle
                            className="size-5 animate-spin motion-reduce:animate-none"
                            aria-hidden="true"
                          />
                        ) : (
                          <ScanLine className="size-5" aria-hidden="true" />
                        )}
                      </span>
                    )}
                    <span
                      className={cn(
                        "absolute top-2 right-2 rounded-full px-2.5 py-1 text-[11px] font-semibold backdrop-blur-sm",
                        historyTask.status === "success"
                          ? "bg-emerald-600/90 text-white"
                          : historyTask.status === "error"
                            ? "bg-rose-600/90 text-white"
                            : "bg-violet-700/90 text-white",
                      )}
                    >
                      {statusLabel}
                    </span>
                  </div>
                  <div className="p-3">
                    <div className="flex items-center justify-between gap-3">
                      <span className="inline-flex min-w-0 items-center gap-2 text-sm font-semibold text-stone-900 dark:text-white">
                        <HistoryModeIcon
                          className="size-4 shrink-0 text-violet-600 dark:text-violet-300"
                          aria-hidden="true"
                        />
                        {metadata.modeLabel}
                      </span>
                      <span className="shrink-0 rounded-full bg-stone-100 px-2 py-1 text-[11px] font-medium text-stone-500 dark:bg-white/10 dark:text-stone-400">
                        {metadata.strengthLabel}
                      </span>
                    </div>
                    <div className="mt-2 flex items-center justify-between gap-3 text-xs text-stone-500 dark:text-stone-400">
                      <span>{formatTaskDate(historyTask.created_at)}</span>
                      <span>{historyTask.size || "自动尺寸"}</span>
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        className="h-11 rounded-xl"
                        onClick={() => openHistoryTask(historyTask)}
                        disabled={Boolean(taskPending)}
                      >
                        <Eye className="size-4" aria-hidden="true" />
                        查看结果
                      </Button>
                      <Button
                        type="button"
                        className="h-11 rounded-xl bg-violet-700 text-white hover:bg-violet-800 disabled:bg-stone-300 dark:bg-violet-500 dark:hover:bg-violet-400 dark:disabled:bg-stone-700"
                        disabled={
                          !historyImage || historyTask.status !== "success"
                        }
                        onClick={() =>
                          historyImage
                            ? void downloadRestoreImage(
                                historyImage,
                                historyTask.id,
                              )
                            : undefined
                        }
                      >
                        <Download className="size-4" aria-hidden="true" />
                        下载
                      </Button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="mt-4 flex min-h-48 flex-col items-center justify-center rounded-2xl border border-dashed border-stone-300 bg-stone-50/70 px-5 text-center dark:border-white/15 dark:bg-white/[0.03]">
            <History
              className="size-6 text-stone-400 dark:text-stone-500"
              aria-hidden="true"
            />
            <p className="mt-3 text-sm font-semibold text-stone-800 dark:text-stone-100">
              还没有高清修复记录
            </p>
            <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
              完成第一张图片后会自动保存在这里。
            </p>
          </div>
        )}

        {historyTasks.length > HISTORY_PAGE_SIZE ? (
          <nav
            className="mt-4 flex items-center justify-center gap-3"
            aria-label="高清修复历史分页"
          >
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="size-11 rounded-xl"
              aria-label="上一页"
              disabled={safeHistoryPage <= 1}
              onClick={() => setHistoryPage(safeHistoryPage - 1)}
            >
              <ChevronLeft className="size-4" aria-hidden="true" />
            </Button>
            <span className="min-w-20 text-center text-sm font-medium text-stone-600 dark:text-stone-300">
              {safeHistoryPage} / {historyPageCount}
            </span>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="size-11 rounded-xl"
              aria-label="下一页"
              disabled={safeHistoryPage >= historyPageCount}
              onClick={() => setHistoryPage(safeHistoryPage + 1)}
            >
              <ChevronRight className="size-4" aria-hidden="true" />
            </Button>
          </nav>
        ) : null}
      </section>

      {resultImage && task ? (
        <ImageLightbox
          images={[{ ...resultImage, sizeLabel: task.size }]}
          currentIndex={0}
          open={isPreviewOpen}
          onOpenChange={setIsPreviewOpen}
          onIndexChange={() => undefined}
        />
      ) : null}
    </div>
  );
}
