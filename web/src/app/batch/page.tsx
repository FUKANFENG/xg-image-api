"use client";

import Image from "next/image";
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
  Archive,
  CheckCircle2,
  Clock3,
  Download,
  Files,
  ImagePlus,
  Layers3,
  LoaderCircle,
  PackageOpen,
  RefreshCw,
  Sparkles,
  Upload,
  WandSparkles,
  X,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  createGenerationBatch,
  createRestorationBatch,
  downloadCreativeBatch,
  fetchCreativeBatch,
  fetchCreativeBatches,
  fetchConsistencyProfiles,
  fetchCreativeProjects,
  fetchCreativeRecipes,
  retryCreativeBatchItem,
  type CreativeBatch,
  type CreativeBatchItem,
  type ConsistencyProfile,
  type CreativeProject,
  type CreativeRecipe,
  type ImageModel,
} from "@/lib/api";
import { USER_DEFAULT_IMAGE_MODEL } from "@/lib/image-model-policy";
import { RESTORE_MODES, RESTORE_STRENGTHS } from "@/lib/image-restore";
import { useAuthGuard } from "@/lib/use-auth-guard";
import { cn } from "@/lib/utils";

const MAX_BATCH_FILES = 30;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

const statusMeta = {
  queued: {
    label: "排队中",
    className:
      "bg-amber-50 text-amber-700 dark:bg-amber-400/10 dark:text-amber-200",
    icon: Clock3,
  },
  paused: {
    label: "已暂停",
    className: "bg-sky-50 text-sky-700 dark:bg-sky-400/10 dark:text-sky-200",
    icon: Clock3,
  },
  running: {
    label: "处理中",
    className:
      "bg-violet-50 text-violet-700 dark:bg-violet-400/10 dark:text-violet-200",
    icon: LoaderCircle,
  },
  success: {
    label: "已完成",
    className:
      "bg-emerald-50 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-200",
    icon: CheckCircle2,
  },
  error: {
    label: "失败",
    className:
      "bg-rose-50 text-rose-700 dark:bg-rose-400/10 dark:text-rose-200",
    icon: XCircle,
  },
} as const;

function normalizeImageUrl(value: string) {
  if (!value) return "";
  if (
    value.startsWith("data:") ||
    value.startsWith("blob:") ||
    value.startsWith("http://") ||
    value.startsWith("https://")
  ) {
    return value;
  }
  return value.startsWith("/") ? value : `/${value}`;
}

function getTaskImage(item: CreativeBatchItem) {
  const first = item.task.data?.[0];
  if (first?.url) return normalizeImageUrl(first.url);
  if (first?.b64_json) return `data:image/png;base64,${first.b64_json}`;
  return "";
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function validateFiles(source: File[], existing: File[]) {
  const accepted: File[] = [];
  const known = new Set(
    existing.map((file) => `${file.name}:${file.size}:${file.lastModified}`),
  );
  let error = "";
  for (const file of source) {
    if (!IMAGE_TYPES.has(file.type)) {
      error ||= `${file.name} 不是支持的 PNG、JPG 或 WEBP 图片`;
      continue;
    }
    if (file.size <= 0 || file.size > MAX_FILE_BYTES) {
      error ||= `${file.name} 为空或超过 50 MB`;
      continue;
    }
    const key = `${file.name}:${file.size}:${file.lastModified}`;
    if (known.has(key)) continue;
    known.add(key);
    accepted.push(file);
    if (existing.length + accepted.length >= MAX_BATCH_FILES) break;
  }
  if (existing.length + source.length > MAX_BATCH_FILES) {
    error ||= `单个批次最多上传 ${MAX_BATCH_FILES} 张图片`;
  }
  return { accepted, error };
}

function BatchStatusCard({
  item,
  retrying,
  onRetry,
}: {
  item: CreativeBatchItem;
  retrying: boolean;
  onRetry: () => void;
}) {
  const status = item.task.status || "error";
  const meta = statusMeta[status] || statusMeta.error;
  const StatusIcon = meta.icon;
  const image = getTaskImage(item);
  const description =
    item.source_name || item.prompt || `任务 ${item.task_id.slice(-8)}`;
  return (
    <article className="overflow-hidden rounded-2xl border border-stone-200/80 bg-white shadow-sm dark:border-white/10 dark:bg-stone-950">
      <div className="relative aspect-[4/3] overflow-hidden bg-stone-100 dark:bg-white/5">
        {image ? (
          <Image
            fill
            sizes="(min-width: 1280px) 25vw, (min-width: 768px) 50vw, 100vw"
            className="object-cover"
            src={image}
            alt={`${description} 的处理结果`}
            unoptimized
          />
        ) : (
          <div className="flex h-full items-center justify-center">
            {status === "queued" ||
            status === "paused" ||
            status === "running" ? (
              <div className="relative grid size-16 place-items-center rounded-2xl bg-violet-100 text-violet-700 dark:bg-violet-400/10 dark:text-violet-200">
                <Sparkles className="size-7 motion-safe:animate-pulse" />
                <span className="absolute -inset-2 rounded-3xl border border-violet-200/70 motion-safe:animate-ping dark:border-violet-400/20" />
              </div>
            ) : (
              <XCircle className="size-9 text-stone-300 dark:text-stone-600" />
            )}
          </div>
        )}
      </div>
      <div className="space-y-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <p
            className="line-clamp-2 min-w-0 text-sm font-medium leading-6 text-stone-800 dark:text-stone-100"
            title={description}
          >
            {description}
          </p>
          <span
            className={cn(
              "inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium",
              meta.className,
            )}
          >
            <StatusIcon
              className={cn("size-3.5", status === "running" && "animate-spin")}
            />
            {meta.label}
          </span>
        </div>
        {item.task.error || item.submit_error ? (
          <div className="space-y-2">
            <p
              className="rounded-xl bg-rose-50 px-3 py-2 text-xs leading-5 text-rose-700 dark:bg-rose-400/10 dark:text-rose-200"
              role="alert"
            >
              {item.task.error || item.submit_error}
            </p>
            <button
              type="button"
              disabled={retrying}
              onClick={onRetry}
              className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-violet-200 text-sm font-semibold text-violet-700 transition hover:bg-violet-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-violet-400/30 dark:text-violet-200 dark:hover:bg-violet-400/10"
            >
              <RefreshCw className={cn("size-4", retrying && "animate-spin")} />
              {retrying ? "正在重试…" : "重新处理"}
            </button>
          </div>
        ) : (
          <div className="flex items-center justify-between text-xs text-stone-500 dark:text-stone-400">
            <span>{item.task.size || "自动尺寸"}</span>
            <span className="tabular-nums">
              {typeof item.task.duration_ms === "number"
                ? `${(item.task.duration_ms / 1000).toFixed(1)} 秒`
                : item.task.progress || "等待结果"}
            </span>
          </div>
        )}
      </div>
    </article>
  );
}

export default function BatchPage() {
  const { isCheckingAuth, session } = useAuthGuard(["user", "admin"]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<"generate" | "restore">("generate");
  const [promptMode, setPromptMode] = useState<"repeat" | "lines">("repeat");
  const [prompt, setPrompt] = useState("");
  const [count, setCount] = useState(4);
  const [files, setFiles] = useState<File[]>([]);
  const [fileError, setFileError] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [isReadingClipboard, setIsReadingClipboard] = useState(false);
  const [model, setModel] = useState<ImageModel>(USER_DEFAULT_IMAGE_MODEL);
  const [size, setSize] = useState("1024x1024");
  const [quality, setQuality] = useState("auto");
  const [restoreMode, setRestoreMode] = useState("general");
  const [restoreStrength, setRestoreStrength] = useState("standard");
  const [projectId, setProjectId] = useState("");
  const [recipeId, setRecipeId] = useState("");
  const [profileId, setProfileId] = useState("");
  const [priority, setPriority] = useState(0);
  const [projects, setProjects] = useState<CreativeProject[]>([]);
  const [recipes, setRecipes] = useState<CreativeRecipe[]>([]);
  const [profiles, setProfiles] = useState<ConsistencyProfile[]>([]);
  const [batches, setBatches] = useState<CreativeBatch[]>([]);
  const [currentBatch, setCurrentBatch] = useState<CreativeBatch | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isLoadingBatches, setIsLoadingBatches] = useState(false);
  const [retryingItemId, setRetryingItemId] = useState("");
  const [error, setError] = useState("");

  const addFiles = useCallback((incoming: File[]) => {
    setFiles((current) => {
      const validated = validateFiles(incoming, current);
      setFileError(validated.error);
      return [...current, ...validated.accepted];
    });
  }, []);

  const loadBatches = useCallback(async () => {
    setIsLoadingBatches(true);
    try {
      const result = await fetchCreativeBatches();
      setBatches(result.items);
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : "批次记录加载失败",
      );
    } finally {
      setIsLoadingBatches(false);
    }
  }, []);

  useEffect(() => {
    if (!session) return;
    const timer = window.setTimeout(() => {
      void Promise.all([
        loadBatches(),
        fetchCreativeProjects()
          .then((result) => setProjects(result.items))
          .catch(() => setProjects([])),
        fetchCreativeRecipes()
          .then((result) => setRecipes(result.items))
          .catch(() => setRecipes([])),
        fetchConsistencyProfiles()
          .then((result) => setProfiles(result.items))
          .catch(() => setProfiles([])),
      ]);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadBatches, session]);

  useEffect(() => {
    if (!currentBatch || currentBatch.completed) return;
    const timer = window.setInterval(() => {
      void fetchCreativeBatch(currentBatch.id)
        .then((next) => {
          setCurrentBatch(next);
          if (next.completed) void loadBatches();
        })
        .catch((pollError) =>
          setError(
            pollError instanceof Error ? pollError.message : "批次状态刷新失败",
          ),
        );
    }, 1800);
    return () => window.clearInterval(timer);
  }, [currentBatch, loadBatches]);

  const linePrompts = useMemo(
    () =>
      prompt
        .split(/\r?\n/)
        .map((item) => item.trim())
        .filter(Boolean),
    [prompt],
  );
  const pendingCount =
    mode === "generate"
      ? promptMode === "lines"
        ? linePrompts.length
        : count
      : files.length;
  const batchCounts = currentBatch?.counts;
  const progressPercent = batchCounts?.total
    ? Math.round(
        ((batchCounts.success + batchCounts.error + batchCounts.cancelled) /
          batchCounts.total) *
          100,
      )
    : 0;

  const handlePaste = (event: ClipboardEvent<HTMLDivElement>) => {
    const pasted = Array.from(event.clipboardData.files || []).filter((file) =>
      file.type.startsWith("image/"),
    );
    if (pasted.length) {
      event.preventDefault();
      addFiles(pasted);
    }
  };

  const handlePasteButton = async () => {
    setIsReadingClipboard(true);
    try {
      const items = await navigator.clipboard.read();
      const pasted: File[] = [];
      for (const item of items) {
        const type = item.types.find((candidate) =>
          candidate.startsWith("image/"),
        );
        if (!type) continue;
        const blob = await item.getType(type);
        pasted.push(
          new File(
            [blob],
            `截图-${Date.now()}-${pasted.length + 1}.${type.includes("jpeg") ? "jpg" : type.split("/")[1]}`,
            { type },
          ),
        );
      }
      if (!pasted.length) throw new Error("剪贴板里没有图片");
      addFiles(pasted);
    } catch (pasteError) {
      setFileError(
        pasteError instanceof Error
          ? pasteError.message
          : "读取剪贴板失败，请使用 Ctrl+V",
      );
    } finally {
      setIsReadingClipboard(false);
    }
  };

  const submit = async () => {
    setError("");
    if (mode === "generate" && !prompt.trim()) {
      setError("请先填写提示词");
      return;
    }
    if (mode === "generate" && promptMode === "lines" && !linePrompts.length) {
      setError("请每行填写一个提示词");
      return;
    }
    if (mode === "restore" && !files.length) {
      setFileError("请至少上传一张图片");
      return;
    }
    setIsSubmitting(true);
    try {
      const created =
        mode === "generate"
          ? await createGenerationBatch({
              prompt: promptMode === "repeat" ? prompt.trim() : undefined,
              prompts: promptMode === "lines" ? linePrompts : undefined,
              count: promptMode === "repeat" ? count : undefined,
              model,
              size,
              quality,
              project_id: projectId,
              recipe_id: recipeId,
              profile_id: profileId,
              priority,
            })
          : await createRestorationBatch({
              files,
              mode: restoreMode,
              strength: restoreStrength,
              model,
              size,
              quality,
              project_id: projectId,
            });
      setCurrentBatch(created);
      toast.success(`已提交 ${created.counts?.total || pendingCount} 个任务`);
      void loadBatches();
    } catch (submitError) {
      setError(
        submitError instanceof Error ? submitError.message : "批量任务提交失败",
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const openBatch = async (batchId: string) => {
    setError("");
    try {
      setCurrentBatch(await fetchCreativeBatch(batchId));
    } catch (openError) {
      setError(
        openError instanceof Error ? openError.message : "批次详情加载失败",
      );
    }
  };

  const retryItem = async (itemId: string) => {
    if (!currentBatch) return;
    setRetryingItemId(itemId);
    setError("");
    try {
      const next = await retryCreativeBatchItem(currentBatch.id, itemId);
      setCurrentBatch(next);
      toast.success("失败项已重新加入队列");
    } catch (retryError) {
      setError(
        retryError instanceof Error ? retryError.message : "重新处理失败",
      );
    } finally {
      setRetryingItemId("");
    }
  };

  if (isCheckingAuth || !session) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <LoaderCircle className="size-6 animate-spin text-violet-600" />
      </div>
    );
  }

  return (
    <main className="min-h-[calc(100dvh-4rem)] bg-stone-50/70 px-4 py-6 sm:px-6 lg:px-8 dark:bg-stone-950">
      <div className="mx-auto max-w-7xl space-y-6">
        <header className="flex flex-col gap-4 rounded-3xl border border-stone-200/80 bg-white p-6 shadow-sm sm:flex-row sm:items-end sm:justify-between dark:border-white/10 dark:bg-stone-900">
          <div className="max-w-2xl">
            <div className="mb-3 inline-flex items-center gap-2 rounded-full bg-violet-50 px-3 py-1.5 text-sm font-medium text-violet-700 dark:bg-violet-400/10 dark:text-violet-200">
              <Layers3 className="size-4" /> 批量工作流
            </div>
            <h1 className="text-2xl font-bold tracking-tight text-stone-950 sm:text-3xl dark:text-white">
              一次提交，自动排队完成
            </h1>
            <p className="mt-2 text-sm leading-6 text-stone-600 sm:text-base dark:text-stone-300">
              批量生成与高清修复共用稳定任务队列，每张图独立计费、独立重试，完成后可整包下载。
            </p>
          </div>
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="rounded-2xl bg-stone-100 px-4 py-3 dark:bg-white/5">
              <div className="text-lg font-bold tabular-nums">
                {batches.length}
              </div>
              <div className="text-xs text-stone-500">近期批次</div>
            </div>
            <div className="rounded-2xl bg-violet-50 px-4 py-3 dark:bg-violet-400/10">
              <div className="text-lg font-bold tabular-nums text-violet-700 dark:text-violet-200">
                {batchCounts?.running || 0}
              </div>
              <div className="text-xs text-stone-500">处理中</div>
            </div>
            <div className="rounded-2xl bg-emerald-50 px-4 py-3 dark:bg-emerald-400/10">
              <div className="text-lg font-bold tabular-nums text-emerald-700 dark:text-emerald-200">
                {batchCounts?.success || 0}
              </div>
              <div className="text-xs text-stone-500">已完成</div>
            </div>
          </div>
        </header>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.55fr)_minmax(280px,.65fr)]">
          <section className="rounded-3xl border border-stone-200/80 bg-white p-5 shadow-sm sm:p-6 dark:border-white/10 dark:bg-stone-900">
            <div
              className="grid grid-cols-2 rounded-2xl bg-stone-100 p-1 dark:bg-white/5"
              role="tablist"
              aria-label="批量任务类型"
            >
              <button
                type="button"
                role="tab"
                aria-selected={mode === "generate"}
                onClick={() => setMode("generate")}
                className={cn(
                  "min-h-11 rounded-xl px-4 text-sm font-semibold transition",
                  mode === "generate"
                    ? "bg-white text-violet-700 shadow-sm dark:bg-stone-800 dark:text-violet-200"
                    : "text-stone-500 hover:text-stone-900 dark:text-stone-400 dark:hover:text-white",
                )}
              >
                <Sparkles className="mr-2 inline size-4" />
                批量生成
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === "restore"}
                onClick={() => setMode("restore")}
                className={cn(
                  "min-h-11 rounded-xl px-4 text-sm font-semibold transition",
                  mode === "restore"
                    ? "bg-white text-violet-700 shadow-sm dark:bg-stone-800 dark:text-violet-200"
                    : "text-stone-500 hover:text-stone-900 dark:text-stone-400 dark:hover:text-white",
                )}
              >
                <WandSparkles className="mr-2 inline size-4" />
                批量修复
              </button>
            </div>

            <div className="mt-6 space-y-6">
              {mode === "generate" ? (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <label
                      htmlFor="batch-prompt"
                      className="text-sm font-semibold text-stone-800 dark:text-stone-100"
                    >
                      提示词
                    </label>
                    <div className="flex rounded-xl bg-stone-100 p-1 text-xs dark:bg-white/5">
                      <button
                        type="button"
                        onClick={() => setPromptMode("repeat")}
                        className={cn(
                          "min-h-9 rounded-lg px-3 font-medium transition",
                          promptMode === "repeat"
                            ? "bg-white text-stone-950 shadow-sm dark:bg-stone-800 dark:text-white"
                            : "text-stone-500",
                        )}
                      >
                        同一提示词
                      </button>
                      <button
                        type="button"
                        onClick={() => setPromptMode("lines")}
                        className={cn(
                          "min-h-9 rounded-lg px-3 font-medium transition",
                          promptMode === "lines"
                            ? "bg-white text-stone-950 shadow-sm dark:bg-stone-800 dark:text-white"
                            : "text-stone-500",
                        )}
                      >
                        每行一个
                      </button>
                    </div>
                  </div>
                  <textarea
                    id="batch-prompt"
                    value={prompt}
                    onChange={(event) => setPrompt(event.target.value)}
                    rows={7}
                    className="w-full resize-y rounded-2xl border border-stone-200 bg-stone-50 px-4 py-3 text-base leading-7 text-stone-950 outline-none transition placeholder:text-stone-400 focus:border-violet-500 focus:ring-4 focus:ring-violet-500/10 dark:border-white/10 dark:bg-stone-950 dark:text-white"
                    placeholder={
                      promptMode === "repeat"
                        ? "描述你想批量生成的画面…"
                        : "每行填写一个提示词，系统会分别创建任务…"
                    }
                  />
                  {promptMode === "repeat" ? (
                    <div className="flex items-center justify-between rounded-2xl border border-stone-200 px-4 py-3 dark:border-white/10">
                      <div>
                        <div className="text-sm font-medium text-stone-800 dark:text-stone-100">
                          生成数量
                        </div>
                        <div className="text-xs text-stone-500">
                          每张图独立占用 1 张额度
                        </div>
                      </div>
                      <input
                        aria-label="生成数量"
                        type="number"
                        min={1}
                        max={50}
                        value={count}
                        onChange={(event) =>
                          setCount(
                            Math.max(
                              1,
                              Math.min(50, Number(event.target.value) || 1),
                            ),
                          )
                        }
                        className="h-11 w-24 rounded-xl border border-stone-200 bg-white px-3 text-center text-base font-semibold tabular-nums outline-none focus:border-violet-500 focus:ring-4 focus:ring-violet-500/10 dark:border-white/10 dark:bg-stone-950"
                      />
                    </div>
                  ) : (
                    <p className="text-xs text-stone-500">
                      已识别 {linePrompts.length} 条有效提示词，最多 50 条。
                    </p>
                  )}
                </div>
              ) : (
                <div className="space-y-3" onPaste={handlePaste}>
                  <div className="flex items-center justify-between">
                    <label className="text-sm font-semibold text-stone-800 dark:text-stone-100">
                      上传待修复图片
                    </label>
                    <span className="text-xs tabular-nums text-stone-500">
                      {files.length}/{MAX_BATCH_FILES}
                    </span>
                  </div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    multiple
                    className="sr-only"
                    onChange={(event) => {
                      addFiles(Array.from(event.target.files || []));
                      event.target.value = "";
                    }}
                  />
                  <div
                    onDragEnter={(event) => {
                      event.preventDefault();
                      setIsDragging(true);
                    }}
                    onDragOver={(event) => event.preventDefault()}
                    onDragLeave={() => setIsDragging(false)}
                    onDrop={(event: DragEvent<HTMLDivElement>) => {
                      event.preventDefault();
                      setIsDragging(false);
                      addFiles(Array.from(event.dataTransfer.files));
                    }}
                    className={cn(
                      "rounded-2xl border-2 border-dashed p-6 text-center transition",
                      isDragging
                        ? "border-violet-500 bg-violet-50 dark:bg-violet-400/10"
                        : "border-stone-200 bg-stone-50 dark:border-white/10 dark:bg-stone-950",
                    )}
                  >
                    <div className="mx-auto grid size-12 place-items-center rounded-2xl bg-violet-100 text-violet-700 dark:bg-violet-400/10 dark:text-violet-200">
                      <ImagePlus className="size-6" />
                    </div>
                    <p className="mt-3 text-sm font-semibold text-stone-800 dark:text-stone-100">
                      拖入多张图片，或直接粘贴截图
                    </p>
                    <p className="mt-1 text-xs text-stone-500">
                      PNG / JPG / WEBP，单张不超过 50 MB
                    </p>
                    <div className="mt-4 flex flex-wrap justify-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        className="min-h-11 rounded-xl"
                        onClick={() => fileInputRef.current?.click()}
                      >
                        <Upload className="size-4" />
                        选择图片
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        className="min-h-11 rounded-xl"
                        disabled={isReadingClipboard}
                        onClick={() => void handlePasteButton()}
                      >
                        {isReadingClipboard ? (
                          <LoaderCircle className="size-4 animate-spin" />
                        ) : (
                          <Files className="size-4" />
                        )}
                        粘贴截图
                      </Button>
                    </div>
                  </div>
                  {files.length ? (
                    <div className="grid gap-2 sm:grid-cols-2">
                      {files.map((file, index) => (
                        <div
                          key={`${file.name}-${file.lastModified}-${index}`}
                          className="flex items-center gap-3 rounded-xl border border-stone-200 px-3 py-2 dark:border-white/10"
                        >
                          <ImagePlus className="size-4 shrink-0 text-violet-600" />
                          <span
                            className="min-w-0 flex-1 truncate text-sm"
                            title={file.name}
                          >
                            {file.name}
                          </span>
                          <button
                            type="button"
                            aria-label={`移除 ${file.name}`}
                            onClick={() =>
                              setFiles((current) =>
                                current.filter(
                                  (_, fileIndex) => fileIndex !== index,
                                ),
                              )
                            }
                            className="grid size-10 shrink-0 place-items-center rounded-xl text-stone-400 transition hover:bg-rose-50 hover:text-rose-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 dark:hover:bg-rose-400/10"
                          >
                            <X className="size-4" />
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {fileError ? (
                    <p
                      className="text-sm text-rose-600 dark:text-rose-300"
                      role="alert"
                    >
                      {fileError}
                    </p>
                  ) : null}
                </div>
              )}

              <fieldset className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <legend className="sr-only">统一生成设置</legend>
                <label className="space-y-2 text-sm font-medium text-stone-700 dark:text-stone-200">
                  <span>模型</span>
                  <select
                    value={model}
                    onChange={(event) =>
                      setModel(event.target.value as ImageModel)
                    }
                    className="h-11 w-full rounded-xl border border-stone-200 bg-white px-3 outline-none focus:border-violet-500 focus:ring-4 focus:ring-violet-500/10 dark:border-white/10 dark:bg-stone-950"
                  >
                    <option value="gpt-image-2">GPT Image 2</option>
                    <option value="codex-gpt-image-2">Codex Image 2</option>
                  </select>
                </label>
                <label className="space-y-2 text-sm font-medium text-stone-700 dark:text-stone-200">
                  <span>尺寸</span>
                  <select
                    value={size}
                    onChange={(event) => setSize(event.target.value)}
                    className="h-11 w-full rounded-xl border border-stone-200 bg-white px-3 outline-none focus:border-violet-500 focus:ring-4 focus:ring-violet-500/10 dark:border-white/10 dark:bg-stone-950"
                  >
                    <option value="1024x1024">1:1 方图</option>
                    <option value="1536x1024">3:2 横图</option>
                    <option value="1024x1536">2:3 竖图</option>
                  </select>
                </label>
                <label className="space-y-2 text-sm font-medium text-stone-700 dark:text-stone-200">
                  <span>质量</span>
                  <select
                    value={quality}
                    onChange={(event) => setQuality(event.target.value)}
                    className="h-11 w-full rounded-xl border border-stone-200 bg-white px-3 outline-none focus:border-violet-500 focus:ring-4 focus:ring-violet-500/10 dark:border-white/10 dark:bg-stone-950"
                  >
                    <option value="auto">自动</option>
                    <option value="high">高质量</option>
                    <option value="medium">均衡</option>
                  </select>
                </label>
                <label className="space-y-2 text-sm font-medium text-stone-700 dark:text-stone-200">
                  <span>归档项目</span>
                  <select
                    value={projectId}
                    onChange={(event) => setProjectId(event.target.value)}
                    className="h-11 w-full rounded-xl border border-stone-200 bg-white px-3 outline-none focus:border-violet-500 focus:ring-4 focus:ring-violet-500/10 dark:border-white/10 dark:bg-stone-950"
                  >
                    <option value="">未归档</option>
                    {projects.map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.name}
                      </option>
                    ))}
                  </select>
                </label>
                {mode === "generate" ? (
                  <>
                    <label className="space-y-2 text-sm font-medium text-stone-700 dark:text-stone-200">
                      <span>创作配方</span>
                      <select
                        value={recipeId}
                        onChange={(event) => {
                          const nextId = event.target.value;
                          setRecipeId(nextId);
                          const recipe = recipes.find(
                            (item) => item.id === nextId,
                          );
                          if (!recipe) return;
                          if (typeof recipe.settings.prompt === "string")
                            setPrompt(recipe.settings.prompt);
                          if (typeof recipe.settings.model === "string")
                            setModel(recipe.settings.model);
                          if (typeof recipe.settings.size === "string")
                            setSize(recipe.settings.size);
                          if (typeof recipe.settings.quality === "string")
                            setQuality(recipe.settings.quality);
                        }}
                        className="h-11 w-full rounded-xl border border-stone-200 bg-white px-3 outline-none focus:border-violet-500 focus:ring-4 focus:ring-violet-500/10 dark:border-white/10 dark:bg-stone-950"
                      >
                        <option value="">不使用配方</option>
                        {recipes.map((recipe) => (
                          <option key={recipe.id} value={recipe.id}>
                            {recipe.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="space-y-2 text-sm font-medium text-stone-700 dark:text-stone-200">
                      <span>一致性档案</span>
                      <select
                        value={profileId}
                        onChange={(event) => setProfileId(event.target.value)}
                        className="h-11 w-full rounded-xl border border-stone-200 bg-white px-3 outline-none focus:border-violet-500 focus:ring-4 focus:ring-violet-500/10 dark:border-white/10 dark:bg-stone-950"
                      >
                        <option value="">不固定品牌 / 人物</option>
                        {profiles.map((profile) => (
                          <option key={profile.id} value={profile.id}>
                            {profile.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="space-y-2 text-sm font-medium text-stone-700 dark:text-stone-200">
                      <span>队列优先级</span>
                      <select
                        value={priority}
                        onChange={(event) =>
                          setPriority(Number(event.target.value))
                        }
                        className="h-11 w-full rounded-xl border border-stone-200 bg-white px-3 outline-none focus:border-violet-500 focus:ring-4 focus:ring-violet-500/10 dark:border-white/10 dark:bg-stone-950"
                      >
                        <option value={-5}>较低</option>
                        <option value={0}>普通</option>
                        <option value={5}>较高</option>
                        <option value={10}>紧急</option>
                      </select>
                    </label>
                  </>
                ) : null}
              </fieldset>

              {mode === "restore" ? (
                <fieldset className="grid gap-4 sm:grid-cols-2">
                  <legend className="sr-only">修复设置</legend>
                  <label className="space-y-2 text-sm font-medium text-stone-700 dark:text-stone-200">
                    <span>修复模式</span>
                    <select
                      value={restoreMode}
                      onChange={(event) => setRestoreMode(event.target.value)}
                      className="h-11 w-full rounded-xl border border-stone-200 bg-white px-3 outline-none focus:border-violet-500 focus:ring-4 focus:ring-violet-500/10 dark:border-white/10 dark:bg-stone-950"
                    >
                      {RESTORE_MODES.map((item) => (
                        <option key={item.value} value={item.value}>
                          {item.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="space-y-2 text-sm font-medium text-stone-700 dark:text-stone-200">
                    <span>修复强度</span>
                    <select
                      value={restoreStrength}
                      onChange={(event) =>
                        setRestoreStrength(event.target.value)
                      }
                      className="h-11 w-full rounded-xl border border-stone-200 bg-white px-3 outline-none focus:border-violet-500 focus:ring-4 focus:ring-violet-500/10 dark:border-white/10 dark:bg-stone-950"
                    >
                      {RESTORE_STRENGTHS.map((item) => (
                        <option key={item.value} value={item.value}>
                          {item.label} · {item.description}
                        </option>
                      ))}
                    </select>
                  </label>
                </fieldset>
              ) : null}

              {error ? (
                <div
                  className="rounded-2xl bg-rose-50 px-4 py-3 text-sm leading-6 text-rose-700 dark:bg-rose-400/10 dark:text-rose-200"
                  role="alert"
                >
                  {error}
                </div>
              ) : null}
              <div className="flex flex-col gap-3 border-t border-stone-200 pt-5 sm:flex-row sm:items-center sm:justify-between dark:border-white/10">
                <div className="text-sm text-stone-500">
                  本次将创建{" "}
                  <strong className="text-stone-900 dark:text-white">
                    {pendingCount}
                  </strong>{" "}
                  个独立任务
                </div>
                <Button
                  type="button"
                  disabled={isSubmitting || pendingCount < 1}
                  onClick={() => void submit()}
                  className="min-h-12 rounded-2xl bg-violet-700 px-7 text-base font-semibold text-white shadow-lg shadow-violet-700/20 hover:bg-violet-800 sm:min-w-48"
                >
                  {isSubmitting ? (
                    <LoaderCircle className="size-5 animate-spin" />
                  ) : mode === "generate" ? (
                    <Sparkles className="size-5" />
                  ) : (
                    <WandSparkles className="size-5" />
                  )}
                  {isSubmitting
                    ? "正在提交…"
                    : mode === "generate"
                      ? "开始批量生成"
                      : "开始批量修复"}
                </Button>
              </div>
            </div>
          </section>

          <aside className="rounded-3xl border border-stone-200/80 bg-white p-5 shadow-sm dark:border-white/10 dark:bg-stone-900">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="font-semibold text-stone-950 dark:text-white">
                  近期批次
                </h2>
                <p className="mt-1 text-xs text-stone-500">
                  点开即可继续查看进度
                </p>
              </div>
              <button
                type="button"
                aria-label="刷新批次"
                onClick={() => void loadBatches()}
                className="grid size-11 place-items-center rounded-xl text-stone-500 transition hover:bg-stone-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 dark:hover:bg-white/10"
              >
                <RefreshCw
                  className={cn("size-4", isLoadingBatches && "animate-spin")}
                />
              </button>
            </div>
            <div className="mt-4 space-y-2">
              {batches.map((batch) => (
                <button
                  key={batch.id}
                  type="button"
                  onClick={() => void openBatch(batch.id)}
                  className={cn(
                    "w-full rounded-2xl border p-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500",
                    currentBatch?.id === batch.id
                      ? "border-violet-300 bg-violet-50 dark:border-violet-400/40 dark:bg-violet-400/10"
                      : "border-stone-200 hover:border-stone-300 hover:bg-stone-50 dark:border-white/10 dark:hover:bg-white/5",
                  )}
                >
                  <div className="flex items-center gap-3">
                    <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-stone-100 text-stone-600 dark:bg-white/10 dark:text-stone-200">
                      {batch.mode === "generate" ? (
                        <Sparkles className="size-4" />
                      ) : (
                        <WandSparkles className="size-4" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-stone-800 dark:text-stone-100">
                        {batch.name}
                      </span>
                      <span className="mt-1 block text-xs text-stone-500">
                        {batch.item_count || 0} 项 ·{" "}
                        {formatDate(batch.created_at)}
                      </span>
                    </span>
                  </div>
                </button>
              ))}
              {!batches.length && !isLoadingBatches ? (
                <div className="py-10 text-center">
                  <PackageOpen className="mx-auto size-8 text-stone-300" />
                  <p className="mt-3 text-sm text-stone-500">
                    提交后，批次会保存在这里
                  </p>
                </div>
              ) : null}
            </div>
          </aside>
        </div>

        {currentBatch ? (
          <section
            className="rounded-3xl border border-stone-200/80 bg-white p-5 shadow-sm sm:p-6 dark:border-white/10 dark:bg-stone-900"
            aria-live="polite"
          >
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <Archive className="size-5 text-violet-600" />
                  <h2 className="text-lg font-bold text-stone-950 dark:text-white">
                    {currentBatch.name}
                  </h2>
                </div>
                <p className="mt-1 text-sm text-stone-500">
                  成功 {batchCounts?.success || 0} · 处理中{" "}
                  {(batchCounts?.running || 0) + (batchCounts?.queued || 0)} ·
                  失败{" "}
                  {(batchCounts?.error || 0) + (batchCounts?.cancelled || 0)}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                disabled={!batchCounts?.success}
                onClick={() =>
                  void downloadCreativeBatch(currentBatch.id, currentBatch.name)
                }
                className="min-h-11 rounded-xl"
              >
                <Download className="size-4" />
                下载成功结果 ZIP
              </Button>
            </div>
            <div className="mt-5 h-2 overflow-hidden rounded-full bg-stone-100 dark:bg-white/10">
              <div
                className="h-full rounded-full bg-violet-600 transition-[width] duration-300 motion-reduce:transition-none"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
            <div className="mt-2 flex items-center justify-between text-xs text-stone-500">
              <span>完成进度</span>
              <span className="tabular-nums">{progressPercent}%</span>
            </div>
            <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {currentBatch.items?.map((item) => (
                <BatchStatusCard
                  key={item.id}
                  item={item}
                  retrying={retryingItemId === item.id}
                  onRetry={() => void retryItem(item.id)}
                />
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </main>
  );
}
