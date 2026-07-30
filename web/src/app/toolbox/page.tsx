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
  Contact,
  Download,
  Eraser,
  Expand,
  FileImage,
  Gauge,
  ImagePlus,
  LoaderCircle,
  Maximize2,
  Palette,
  ScanFace,
  Scissors,
  Sparkles,
  Upload,
  WandSparkles,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  fetchCreativeProjects,
  fetchImageTasks,
  runAiImageTool,
  runLocalImageTool,
  type CreativeProject,
  type ImageTask,
  type LocalImageToolResult,
} from "@/lib/api";
import { USER_DEFAULT_IMAGE_MODEL } from "@/lib/image-model-policy";
import { useAuthGuard } from "@/lib/use-auth-guard";
import { cn } from "@/lib/utils";

import { AiCreativeHub } from "./ai-creative-hub";

type ToolKey =
  | "cutout"
  | "remove_object"
  | "outpaint"
  | "id_photo"
  | "colorize"
  | "face_restore"
  | "resize"
  | "compress"
  | "convert";

const tools: Array<{
  key: ToolKey;
  name: string;
  description: string;
  kind: "ai" | "local";
  icon: typeof Scissors;
  needsInstruction?: boolean;
  placeholder?: string;
}> = [
  {
    key: "cutout",
    name: "智能抠图",
    description: "识别主体并生成透明背景",
    kind: "ai",
    icon: Scissors,
  },
  {
    key: "remove_object",
    name: "移除对象 / 水印",
    description: "自然补全被移除区域",
    kind: "ai",
    icon: Eraser,
    needsInstruction: true,
    placeholder: "例如：移除右下角水印，保持背景纹理自然",
  },
  {
    key: "outpaint",
    name: "智能扩图",
    description: "延续场景扩展画布",
    kind: "ai",
    icon: Expand,
    needsInstruction: true,
    placeholder: "例如：向左右扩展，补充完整城市夜景",
  },
  {
    key: "id_photo",
    name: "证件照换底",
    description: "保留人物，替换纯色背景",
    kind: "ai",
    icon: Contact,
    needsInstruction: true,
    placeholder: "例如：换成标准蓝色背景，人物不变",
  },
  {
    key: "colorize",
    name: "老照片上色",
    description: "自然恢复年代色彩",
    kind: "ai",
    icon: Palette,
  },
  {
    key: "face_restore",
    name: "人脸修复",
    description: "身份不变，恢复五官细节",
    kind: "ai",
    icon: ScanFace,
  },
  {
    key: "resize",
    name: "指定尺寸",
    description: "本地高质量缩放，不耗额度",
    kind: "local",
    icon: Maximize2,
  },
  {
    key: "compress",
    name: "图片压缩",
    description: "调整质量并减小文件体积",
    kind: "local",
    icon: Gauge,
  },
  {
    key: "convert",
    name: "格式转换",
    description: "PNG / JPEG / WEBP 互转",
    kind: "local",
    icon: FileImage,
  },
];

function formatBytes(value: number) {
  if (!value) return "0 B";
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(2)} MB`;
}

function taskImage(task: ImageTask | null) {
  const item = task?.data?.[0];
  if (item?.url) return item.url.startsWith("/") ? item.url : item.url;
  if (item?.b64_json) return `data:image/png;base64,${item.b64_json}`;
  return "";
}

export default function ToolboxPage() {
  const { isCheckingAuth, session } = useAuthGuard(["user", "admin"]);
  const inputRef = useRef<HTMLInputElement>(null);
  const [selectedTool, setSelectedTool] = useState<ToolKey>("cutout");
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [instruction, setInstruction] = useState("");
  const [width, setWidth] = useState(1024);
  const [height, setHeight] = useState(1024);
  const [quality, setQuality] = useState(82);
  const [outputFormat, setOutputFormat] = useState<"png" | "jpg" | "webp">(
    "png",
  );
  const [projectId, setProjectId] = useState("");
  const [projects, setProjects] = useState<CreativeProject[]>([]);
  const [task, setTask] = useState<ImageTask | null>(null);
  const [localResult, setLocalResult] = useState<LocalImageToolResult | null>(
    null,
  );
  const [isDragging, setIsDragging] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState("");

  const tool = useMemo(
    () => tools.find((item) => item.key === selectedTool) || tools[0],
    [selectedTool],
  );
  const SelectedToolIcon = tool.icon;
  const resultUrl = localResult?.url || taskImage(task);
  const isTaskActive = task?.status === "queued" || task?.status === "running";

  useEffect(() => {
    if (!session) return;
    void fetchCreativeProjects()
      .then((result) => setProjects(result.items))
      .catch(() => setProjects([]));
  }, [session]);

  useEffect(
    () => () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    },
    [previewUrl],
  );

  useEffect(() => {
    if (!task || !isTaskActive) return;
    const timer = window.setInterval(() => {
      void fetchImageTasks([task.id])
        .then((result) => {
          const next = result.items[0];
          if (next) setTask(next);
        })
        .catch(() => undefined);
    }, 1800);
    return () => window.clearInterval(timer);
  }, [isTaskActive, task]);

  const selectFile = useCallback((nextFile: File) => {
    if (!nextFile.type.startsWith("image/")) {
      setError("请选择 PNG、JPG 或 WEBP 图片");
      return;
    }
    if (!nextFile.size || nextFile.size > 50 * 1024 * 1024) {
      setError("图片为空或超过 50 MB");
      return;
    }
    setFile(nextFile);
    setPreviewUrl((current) => {
      if (current) URL.revokeObjectURL(current);
      return URL.createObjectURL(nextFile);
    });
    setTask(null);
    setLocalResult(null);
    setError("");
  }, []);

  const handlePaste = (event: ClipboardEvent<HTMLDivElement>) => {
    const pasted = Array.from(event.clipboardData.files || []).find((item) =>
      item.type.startsWith("image/"),
    );
    if (pasted) {
      event.preventDefault();
      selectFile(pasted);
    }
  };

  const submit = async () => {
    if (!file) {
      setError("请先上传或粘贴一张图片");
      return;
    }
    if (tool.needsInstruction && !instruction.trim()) {
      setError("请填写需要移除、扩展或替换的具体要求");
      return;
    }
    setIsSubmitting(true);
    setError("");
    setTask(null);
    setLocalResult(null);
    try {
      if (tool.kind === "ai") {
        const created = await runAiImageTool({
          file,
          operation: tool.key,
          instruction: instruction.trim(),
          model: USER_DEFAULT_IMAGE_MODEL,
          size: `${width}x${height}`,
          project_id: projectId,
        });
        setTask(created);
        toast.success(`${tool.name}已加入队列`);
      } else {
        const result = await runLocalImageTool({
          file,
          operation: tool.key as "resize" | "compress" | "convert",
          width: tool.key === "resize" ? width : undefined,
          height: tool.key === "resize" ? height : undefined,
          quality,
          output_format: outputFormat,
          project_id: projectId,
        });
        setLocalResult(result);
        toast.success(`${tool.name}完成`);
      }
    } catch (submitError) {
      setError(
        submitError instanceof Error ? submitError.message : `${tool.name}失败`,
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const pasteFromClipboard = async () => {
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const type = item.types.find((candidate) =>
          candidate.startsWith("image/"),
        );
        if (!type) continue;
        const blob = await item.getType(type);
        selectFile(
          new File(
            [blob],
            `截图-${Date.now()}.${type.includes("jpeg") ? "jpg" : type.split("/")[1]}`,
            { type },
          ),
        );
        return;
      }
      setError("剪贴板里没有图片");
    } catch (clipboardError) {
      setError(
        clipboardError instanceof Error
          ? clipboardError.message
          : "剪贴板读取失败，请使用 Ctrl+V",
      );
    }
  };

  if (isCheckingAuth || !session)
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <LoaderCircle className="size-6 animate-spin text-violet-600" />
      </div>
    );

  return (
    <main
      className="min-h-[calc(100dvh-4rem)] bg-stone-50/70 px-4 py-6 sm:px-6 lg:px-8 dark:bg-stone-950"
      onPaste={handlePaste}
    >
      <div className="mx-auto max-w-7xl space-y-6">
        <header className="rounded-3xl border border-stone-200/80 bg-white p-6 shadow-sm dark:border-white/10 dark:bg-stone-900">
          <div className="inline-flex items-center gap-2 rounded-full bg-violet-50 px-3 py-1.5 text-sm font-medium text-violet-700 dark:bg-violet-400/10 dark:text-violet-200">
            <WandSparkles className="size-4" />
            图片工具箱
          </div>
          <h1 className="mt-3 text-2xl font-bold tracking-tight text-stone-950 sm:text-3xl dark:text-white">
            从修图到交付，一站完成
          </h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-stone-600 sm:text-base dark:text-stone-300">
            AI
            工具沿用生图额度并进入版本链；尺寸、压缩和格式转换在本机完成，不消耗额度。
          </p>
        </header>

        <AiCreativeHub />

        <section
          className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5"
          aria-label="图片工具选择"
        >
          {tools.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.key}
                type="button"
                aria-pressed={selectedTool === item.key}
                onClick={() => {
                  setSelectedTool(item.key);
                  setTask(null);
                  setLocalResult(null);
                  setError("");
                }}
                className={cn(
                  "group min-h-28 rounded-2xl border p-4 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500",
                  selectedTool === item.key
                    ? "border-violet-300 bg-violet-50 shadow-sm dark:border-violet-400/40 dark:bg-violet-400/10"
                    : "border-stone-200 bg-white hover:border-stone-300 hover:shadow-sm dark:border-white/10 dark:bg-stone-900 dark:hover:border-white/20",
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <span
                    className={cn(
                      "grid size-10 place-items-center rounded-xl",
                      selectedTool === item.key
                        ? "bg-violet-700 text-white"
                        : "bg-stone-100 text-stone-600 dark:bg-white/10 dark:text-stone-300",
                    )}
                  >
                    <Icon className="size-5" />
                  </span>
                  <span className="rounded-full bg-stone-100 px-2 py-1 text-[11px] text-stone-500 dark:bg-white/10 dark:text-stone-300">
                    {item.kind === "ai" ? "AI" : "本地"}
                  </span>
                </div>
                <h2 className="mt-3 text-sm font-semibold text-stone-900 dark:text-white">
                  {item.name}
                </h2>
                <p className="mt-1 text-xs leading-5 text-stone-500">
                  {item.description}
                </p>
              </button>
            );
          })}
        </section>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(360px,.9fr)]">
          <section className="rounded-3xl border border-stone-200/80 bg-white p-5 shadow-sm sm:p-6 dark:border-white/10 dark:bg-stone-900">
            <div className="flex items-start gap-3">
              <span className="grid size-11 place-items-center rounded-2xl bg-violet-100 text-violet-700 dark:bg-violet-400/10 dark:text-violet-200">
                <SelectedToolIcon className="size-5" />
              </span>
              <div>
                <h2 className="font-bold text-stone-950 dark:text-white">
                  {tool.name}
                </h2>
                <p className="mt-1 text-sm text-stone-500">
                  {tool.description}
                </p>
              </div>
            </div>

            <input
              ref={inputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="sr-only"
              onChange={(event) => {
                const next = event.target.files?.[0];
                if (next) selectFile(next);
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
                const next = event.dataTransfer.files?.[0];
                if (next) selectFile(next);
              }}
              className={cn(
                "mt-5 overflow-hidden rounded-2xl border-2 border-dashed transition",
                isDragging
                  ? "border-violet-500 bg-violet-50 dark:bg-violet-400/10"
                  : "border-stone-200 bg-stone-50 dark:border-white/10 dark:bg-stone-950",
              )}
            >
              {previewUrl ? (
                <div className="relative aspect-[4/3] bg-[linear-gradient(45deg,#eee_25%,transparent_25%),linear-gradient(-45deg,#eee_25%,transparent_25%),linear-gradient(45deg,transparent_75%,#eee_75%),linear-gradient(-45deg,transparent_75%,#eee_75%)] bg-[length:20px_20px] bg-[position:0_0,0_10px,10px_-10px,-10px_0px] dark:bg-none">
                  <Image
                    fill
                    sizes="(min-width: 1024px) 50vw, 100vw"
                    src={previewUrl}
                    alt="待处理图片预览"
                    className="object-contain"
                    unoptimized
                  />
                </div>
              ) : (
                <div className="flex aspect-[4/3] flex-col items-center justify-center p-6 text-center">
                  <span className="grid size-14 place-items-center rounded-2xl bg-violet-100 text-violet-700 dark:bg-violet-400/10 dark:text-violet-200">
                    <ImagePlus className="size-7" />
                  </span>
                  <p className="mt-4 font-semibold text-stone-800 dark:text-stone-100">
                    拖入图片，或直接 Ctrl+V 粘贴
                  </p>
                  <p className="mt-1 text-sm text-stone-500">
                    PNG / JPG / WEBP，最大 50 MB
                  </p>
                </div>
              )}
              <div className="flex flex-wrap justify-center gap-2 border-t border-stone-200 p-3 dark:border-white/10">
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11 rounded-xl"
                  onClick={() => inputRef.current?.click()}
                >
                  <Upload className="size-4" />
                  {file ? "更换图片" : "选择图片"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11 rounded-xl"
                  onClick={() => void pasteFromClipboard()}
                >
                  <ImagePlus className="size-4" />
                  粘贴截图
                </Button>
              </div>
            </div>

            <div className="mt-5 space-y-4">
              {tool.needsInstruction ? (
                <label className="block space-y-2">
                  <span className="text-sm font-medium text-stone-700 dark:text-stone-200">
                    处理要求
                  </span>
                  <textarea
                    value={instruction}
                    onChange={(event) => setInstruction(event.target.value)}
                    rows={3}
                    className="w-full resize-y rounded-2xl border border-stone-200 bg-stone-50 px-4 py-3 text-base leading-6 outline-none focus:border-violet-500 focus:ring-4 focus:ring-violet-500/10 dark:border-white/10 dark:bg-stone-950"
                    placeholder={tool.placeholder}
                  />
                </label>
              ) : null}
              {tool.key === "resize" || tool.key === "outpaint" ? (
                <div className="grid grid-cols-2 gap-3">
                  <label className="space-y-2 text-sm font-medium">
                    <span>目标宽度</span>
                    <input
                      type="number"
                      min={1}
                      max={8192}
                      value={width}
                      onChange={(event) =>
                        setWidth(Number(event.target.value) || 1)
                      }
                      className="h-11 w-full rounded-xl border border-stone-200 bg-white px-3 text-base tabular-nums outline-none focus:border-violet-500 focus:ring-4 focus:ring-violet-500/10 dark:border-white/10 dark:bg-stone-950"
                    />
                  </label>
                  <label className="space-y-2 text-sm font-medium">
                    <span>目标高度</span>
                    <input
                      type="number"
                      min={1}
                      max={8192}
                      value={height}
                      onChange={(event) =>
                        setHeight(Number(event.target.value) || 1)
                      }
                      className="h-11 w-full rounded-xl border border-stone-200 bg-white px-3 text-base tabular-nums outline-none focus:border-violet-500 focus:ring-4 focus:ring-violet-500/10 dark:border-white/10 dark:bg-stone-950"
                    />
                  </label>
                </div>
              ) : null}
              {tool.key === "compress" ? (
                <label className="block space-y-2">
                  <span className="flex justify-between text-sm font-medium">
                    <span>输出质量</span>
                    <span className="tabular-nums text-violet-700 dark:text-violet-200">
                      {quality}
                    </span>
                  </span>
                  <input
                    aria-label="输出质量"
                    type="range"
                    min={20}
                    max={100}
                    value={quality}
                    onChange={(event) => setQuality(Number(event.target.value))}
                    className="w-full accent-violet-700"
                  />
                </label>
              ) : null}
              {tool.kind === "local" ? (
                <label className="block space-y-2 text-sm font-medium">
                  <span>输出格式</span>
                  <select
                    value={outputFormat}
                    onChange={(event) =>
                      setOutputFormat(
                        event.target.value as "png" | "jpg" | "webp",
                      )
                    }
                    className="h-11 w-full rounded-xl border border-stone-200 bg-white px-3 outline-none focus:border-violet-500 focus:ring-4 focus:ring-violet-500/10 dark:border-white/10 dark:bg-stone-950"
                  >
                    <option value="png">PNG</option>
                    <option value="jpg">JPEG</option>
                    <option value="webp">WEBP</option>
                  </select>
                </label>
              ) : null}
              <label className="block space-y-2 text-sm font-medium">
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
              {error ? (
                <p
                  className="rounded-xl bg-rose-50 px-3 py-2 text-sm leading-6 text-rose-700 dark:bg-rose-400/10 dark:text-rose-200"
                  role="alert"
                >
                  {error}
                </p>
              ) : null}
              <Button
                type="button"
                disabled={!file || isSubmitting || isTaskActive}
                onClick={() => void submit()}
                className="min-h-12 w-full rounded-2xl bg-violet-700 text-base font-semibold text-white shadow-lg shadow-violet-700/20 hover:bg-violet-800"
              >
                {isSubmitting || isTaskActive ? (
                  <LoaderCircle className="size-5 animate-spin" />
                ) : tool.kind === "ai" ? (
                  <Sparkles className="size-5" />
                ) : (
                  <Gauge className="size-5" />
                )}
                {isTaskActive ? "正在处理…" : `开始${tool.name}`}
              </Button>
            </div>
          </section>

          <section className="rounded-3xl border border-stone-200/80 bg-white p-5 shadow-sm sm:p-6 dark:border-white/10 dark:bg-stone-900">
            <div>
              <h2 className="font-bold text-stone-950 dark:text-white">
                处理结果
              </h2>
              <p className="mt-1 text-sm text-stone-500">
                完成后可预览、下载，并在项目中继续编辑。
              </p>
            </div>
            <div className="relative mt-5 aspect-[4/3] overflow-hidden rounded-2xl border border-stone-200 bg-stone-100 dark:border-white/10 dark:bg-stone-950">
              {resultUrl ? (
                <Image
                  fill
                  sizes="(min-width: 1024px) 50vw, 100vw"
                  src={resultUrl}
                  alt={`${tool.name}结果`}
                  className="object-contain"
                  unoptimized
                />
              ) : (
                <div className="flex aspect-[4/3] flex-col items-center justify-center text-center">
                  <WandSparkles
                    className={cn(
                      "size-10 text-stone-300",
                      isTaskActive && "animate-pulse text-violet-500",
                    )}
                  />
                  <p className="mt-3 text-sm text-stone-500">
                    {isTaskActive
                      ? task?.progress || "AI 正在生成新版本"
                      : "结果将在这里显示"}
                  </p>
                </div>
              )}
            </div>
            {localResult ? (
              <div className="mt-4 grid grid-cols-2 gap-3">
                <div className="rounded-xl bg-stone-100 p-3 dark:bg-white/5">
                  <p className="text-xs text-stone-500">尺寸</p>
                  <p className="mt-1 font-semibold tabular-nums">
                    {localResult.width} × {localResult.height}
                  </p>
                </div>
                <div className="rounded-xl bg-stone-100 p-3 dark:bg-white/5">
                  <p className="text-xs text-stone-500">文件体积</p>
                  <p className="mt-1 font-semibold tabular-nums">
                    {formatBytes(localResult.output_bytes)}
                  </p>
                  <p className="text-xs text-stone-500">
                    原始 {formatBytes(localResult.original_bytes)}
                  </p>
                </div>
              </div>
            ) : null}
            {task?.status === "error" ? (
              <p
                className="mt-4 rounded-xl bg-rose-50 p-3 text-sm text-rose-700 dark:bg-rose-400/10 dark:text-rose-200"
                role="alert"
              >
                {task.error || "AI 处理失败，请重试"}
              </p>
            ) : null}
            {resultUrl ? (
              <a
                href={resultUrl}
                download
                className="mt-4 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-stone-200 text-sm font-semibold text-stone-700 transition hover:bg-stone-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 dark:border-white/10 dark:text-stone-200 dark:hover:bg-white/5"
              >
                <Download className="size-4" />
                下载处理结果
              </a>
            ) : null}
          </section>
        </div>
      </div>
    </main>
  );
}
