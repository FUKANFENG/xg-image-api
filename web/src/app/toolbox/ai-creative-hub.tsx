"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  Brush,
  Check,
  Clipboard,
  Copy,
  Expand,
  FileSearch,
  FolderClock,
  LoaderCircle,
  Sparkles,
  Upload,
  UsersRound,
  WandSparkles,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
} from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  fetchCreativeAssets,
  reverseImagePrompt,
  type CreativeAsset,
  type ReversePromptResult,
} from "@/lib/api";
import { saveStudioPromptDraft } from "@/lib/creative-drafts";
import { cn } from "@/lib/utils";

type Source =
  | { kind: "upload"; file: File; url: string }
  | { kind: "asset"; asset: CreativeAsset; url: string };

const detailOptions = [
  { value: "concise", label: "简洁" },
  { value: "standard", label: "标准" },
  { value: "professional", label: "专业" },
] as const;

function assetImage(asset: CreativeAsset) {
  return (
    asset.current_image_url ||
    (asset.current_image_path ? `/images/${asset.current_image_path}` : "")
  );
}

export function AiCreativeHub() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [source, setSource] = useState<Source | null>(null);
  const [assets, setAssets] = useState<CreativeAsset[]>([]);
  const [showAssets, setShowAssets] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [detail, setDetail] =
    useState<(typeof detailOptions)[number]["value"]>("standard");
  const [purpose, setPurpose] = useState("");
  const [result, setResult] = useState<ReversePromptResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void fetchCreativeAssets({ asset_type: "image", limit: 12 })
      .then(({ items }) => {
        const recent = items.slice(0, 12);
        setAssets(recent);
        const requestedId = new URLSearchParams(window.location.search).get(
          "reverse_asset",
        );
        const requested = items.find((item) => item.id === requestedId);
        const url = requested ? assetImage(requested) : "";
        if (requested && url) {
          setSource({ kind: "asset", asset: requested, url });
          setShowAssets(true);
        }
      })
      .catch(() => setAssets([]));
  }, []);

  useEffect(
    () => () => {
      if (source?.kind === "upload") URL.revokeObjectURL(source.url);
    },
    [source],
  );

  const selectedAsset = source?.kind === "asset" ? source.asset : null;
  const canvasHref = selectedAsset
    ? `/canvas/?asset=${encodeURIComponent(selectedAsset.id)}${
        selectedAsset.current_version_id
          ? `&version=${encodeURIComponent(selectedAsset.current_version_id)}`
          : ""
      }`
    : "#reverse-prompt";

  const selectFile = useCallback((file: File) => {
    if (!file.type.startsWith("image/")) {
      toast.error("请选择 PNG、JPG 或 WEBP 图片");
      return;
    }
    if (!file.size || file.size > 50 * 1024 * 1024) {
      toast.error("图片为空或超过 50 MB");
      return;
    }
    setSource((current) => {
      if (current?.kind === "upload") URL.revokeObjectURL(current.url);
      return { kind: "upload", file, url: URL.createObjectURL(file) };
    });
    setResult(null);
  }, []);

  const handlePaste = (event: ClipboardEvent<HTMLElement>) => {
    const file = Array.from(event.clipboardData.items)
      .find((item) => item.type.startsWith("image/"))
      ?.getAsFile();
    if (!file) return;
    event.preventDefault();
    event.stopPropagation();
    selectFile(file);
    toast.success("已粘贴截图");
  };

  const runReverse = async () => {
    if (!source) {
      toast.error("请先上传、粘贴或选择一张作品");
      return;
    }
    setLoading(true);
    setResult(null);
    try {
      const next = await reverseImagePrompt({
        ...(source.kind === "upload"
          ? { file: source.file }
          : {
              asset_id: source.asset.id,
              version_id: source.asset.current_version_id || undefined,
            }),
        detail,
        purpose: purpose.trim(),
      });
      setResult(next);
      toast.success("提示词分析完成");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "提示词分析失败");
    } finally {
      setLoading(false);
    }
  };

  const copyPrompt = async () => {
    if (!result?.prompt) return;
    await navigator.clipboard.writeText(result.prompt);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
    toast.success("提示词已复制");
  };

  const fillStudio = () => {
    if (!result?.prompt) return;
    saveStudioPromptDraft({
      prompt: result.prompt,
      source: "reverse-prompt",
      assetId: selectedAsset?.id,
      versionId: selectedAsset?.current_version_id || undefined,
    });
    router.push("/studio");
  };

  const factRows = useMemo(
    () =>
      result
        ? [
            ["主体", result.subject],
            ["构图", result.composition],
            ["光线", result.lighting],
            ["风格", result.style],
          ].filter((item) => item[1])
        : [],
    [result],
  );

  return (
    <section
      id="reverse-prompt"
      onPaste={handlePaste}
      className="overflow-hidden rounded-3xl border border-violet-200/80 bg-white shadow-sm dark:border-violet-400/20 dark:bg-stone-900"
    >
      <div className="border-b border-stone-200 bg-[radial-gradient(circle_at_top_right,_rgba(139,92,246,0.2),_transparent_42%),linear-gradient(135deg,#faf5ff,#fff)] p-5 sm:p-7 dark:border-white/10 dark:bg-[radial-gradient(circle_at_top_right,_rgba(139,92,246,0.22),_transparent_42%),linear-gradient(135deg,#18151f,#1c1917)]">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full bg-violet-700 px-3 py-1.5 text-xs font-semibold text-white">
              <Sparkles className="size-3.5" /> AI 创作中心
            </div>
            <h2 className="mt-3 text-xl font-bold tracking-tight text-stone-950 sm:text-2xl dark:text-white">
              从看懂图片，到可控地继续创作
            </h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-stone-600 dark:text-stone-300">
              反推提示词、局部重绘、智能扩图和一致性档案已汇总到这里。
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <a
              href="#reverse-workspace"
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-white px-4 text-sm font-semibold text-stone-800 shadow-sm ring-1 ring-stone-200 transition hover:ring-violet-300 dark:bg-stone-900 dark:text-white dark:ring-white/10"
            >
              <FileSearch className="size-4 text-violet-600" /> 反推提示词
            </a>
            <Link
              href={canvasHref}
              onClick={(event) => {
                if (!selectedAsset) {
                  event.preventDefault();
                  setShowAssets(true);
                  toast.info("先从下方历史作品中选择一张图片");
                }
              }}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-white px-4 text-sm font-semibold text-stone-800 shadow-sm ring-1 ring-stone-200 transition hover:ring-violet-300 dark:bg-stone-900 dark:text-white dark:ring-white/10"
            >
              <Brush className="size-4 text-violet-600" /> 重绘/扩图
            </Link>
            <Link
              href="/presets/?tab=profiles"
              className="col-span-2 inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-white px-4 text-sm font-semibold text-stone-800 shadow-sm ring-1 ring-stone-200 transition hover:ring-violet-300 sm:col-span-1 dark:bg-stone-900 dark:text-white dark:ring-white/10"
            >
              <UsersRound className="size-4 text-violet-600" /> 一致性档案
            </Link>
          </div>
        </div>
      </div>

      <div
        id="reverse-workspace"
        className="grid gap-0 lg:grid-cols-[minmax(320px,.85fr)_minmax(0,1.15fr)]"
      >
        <div className="border-b border-stone-200 p-5 sm:p-6 lg:border-r lg:border-b-0 dark:border-white/10">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="font-bold text-stone-950 dark:text-white">
                1. 选择图片
              </h3>
              <p className="mt-1 text-xs text-stone-500">
                上传、Ctrl+V 粘贴或从作品中选择
              </p>
            </div>
            <button
              type="button"
              onClick={() => setShowAssets((value) => !value)}
              className="inline-flex min-h-11 items-center gap-2 rounded-xl px-3 text-sm font-medium text-violet-700 transition hover:bg-violet-50 dark:text-violet-200 dark:hover:bg-violet-400/10"
            >
              <FolderClock className="size-4" /> 历史作品
            </button>
          </div>

          <input
            ref={inputRef}
            className="sr-only"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) selectFile(file);
              event.target.value = "";
            }}
          />
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            onDragEnter={(event: DragEvent<HTMLButtonElement>) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              const file = event.dataTransfer.files?.[0];
              if (file) selectFile(file);
            }}
            className={cn(
              "relative mt-4 flex min-h-64 w-full overflow-hidden rounded-2xl border border-dashed transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500",
              dragging
                ? "border-violet-500 bg-violet-50"
                : "border-stone-300 bg-stone-50 hover:border-violet-400 dark:border-white/15 dark:bg-stone-950",
            )}
          >
            {source ? (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={source.url}
                  alt="待分析图片预览"
                  className="absolute inset-0 size-full object-contain"
                />
                <span className="absolute right-3 bottom-3 rounded-full bg-black/70 px-3 py-1.5 text-xs font-medium text-white backdrop-blur">
                  点击更换
                </span>
              </>
            ) : (
              <span className="m-auto flex flex-col items-center px-6 text-center">
                <span className="grid size-12 place-items-center rounded-2xl bg-violet-100 text-violet-700 dark:bg-violet-400/10 dark:text-violet-200">
                  <Upload className="size-5" />
                </span>
                <strong className="mt-3 text-sm text-stone-900 dark:text-white">
                  上传图片或拖到这里
                </strong>
                <span className="mt-1 inline-flex items-center gap-1 text-xs text-stone-500">
                  <Clipboard className="size-3.5" /> 也可直接粘贴截图
                </span>
              </span>
            )}
          </button>

          {showAssets ? (
            <div className="mt-4">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs font-semibold text-stone-700 dark:text-stone-200">
                  最近作品
                </span>
                <Link href="/projects" className="text-xs text-violet-700">
                  查看全部
                </Link>
              </div>
              {assets.length ? (
                <div className="grid grid-cols-4 gap-2">
                  {assets.map((asset) => {
                    const url = assetImage(asset);
                    if (!url) return null;
                    return (
                      <button
                        key={asset.id}
                        type="button"
                        title={asset.name}
                        onClick={() => {
                          setSource({ kind: "asset", asset, url });
                          setResult(null);
                        }}
                        className={cn(
                          "relative aspect-square overflow-hidden rounded-xl border bg-stone-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500",
                          selectedAsset?.id === asset.id
                            ? "border-violet-500 ring-2 ring-violet-200"
                            : "border-stone-200 dark:border-white/10",
                        )}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={url}
                          alt={asset.name}
                          className="size-full object-cover"
                        />
                      </button>
                    );
                  })}
                </div>
              ) : (
                <p className="rounded-xl bg-stone-50 px-3 py-4 text-center text-xs text-stone-500 dark:bg-stone-950">
                  暂无可选图片作品
                </p>
              )}
            </div>
          ) : null}
        </div>

        <div className="p-5 sm:p-6">
          <h3 className="font-bold text-stone-950 dark:text-white">
            2. AI 视觉分析
          </h3>
          <div className="mt-4 grid gap-3 sm:grid-cols-[150px_minmax(0,1fr)]">
            <label className="grid gap-1.5 text-xs font-medium text-stone-700 dark:text-stone-200">
              分析深度
              <select
                value={detail}
                onChange={(event) =>
                  setDetail(event.target.value as typeof detail)
                }
                className="min-h-11 rounded-xl border border-stone-200 bg-white px-3 text-sm outline-none focus:border-violet-500 dark:border-white/10 dark:bg-stone-950"
              >
                {detailOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1.5 text-xs font-medium text-stone-700 dark:text-stone-200">
              你的用途（可选）
              <input
                value={purpose}
                onChange={(event) => setPurpose(event.target.value)}
                placeholder="例如：用于商品海报，保留版式和镜头语言"
                className="min-h-11 rounded-xl border border-stone-200 bg-white px-3 text-sm outline-none placeholder:text-stone-400 focus:border-violet-500 dark:border-white/10 dark:bg-stone-950"
              />
            </label>
          </div>
          <Button
            type="button"
            onClick={() => void runReverse()}
            disabled={!source || loading}
            className="mt-4 min-h-12 w-full rounded-xl bg-violet-700 font-semibold hover:bg-violet-800"
          >
            {loading ? (
              <LoaderCircle className="mr-2 size-4 animate-spin" />
            ) : (
              <WandSparkles className="mr-2 size-4" />
            )}
            {loading ? "正在通过账号池分析图片…" : "一键反推提示词"}
          </Button>

          {result ? (
            <div className="mt-5 space-y-4" aria-live="polite">
              <div className="rounded-2xl border border-violet-200 bg-violet-50/70 p-4 dark:border-violet-400/20 dark:bg-violet-400/5">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs font-semibold text-violet-700 dark:text-violet-200">
                    可直接生图的完整提示词
                  </span>
                  <span className="text-[11px] text-stone-500">
                    {(result.elapsed_ms / 1000).toFixed(1)} 秒
                  </span>
                </div>
                <p className="mt-2 max-h-52 overflow-y-auto whitespace-pre-wrap text-sm leading-6 text-stone-800 dark:text-stone-100">
                  {result.prompt}
                </p>
                <div className="mt-4 grid grid-cols-2 gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11 rounded-xl"
                    onClick={() => void copyPrompt()}
                  >
                    {copied ? (
                      <Check className="mr-2 size-4" />
                    ) : (
                      <Copy className="mr-2 size-4" />
                    )}
                    {copied ? "已复制" : "复制提示词"}
                  </Button>
                  <Button
                    type="button"
                    className="min-h-11 rounded-xl bg-violet-700 hover:bg-violet-800"
                    onClick={fillStudio}
                  >
                    填入工作台 <ArrowRight className="ml-2 size-4" />
                  </Button>
                </div>
              </div>

              {factRows.length ? (
                <dl className="grid gap-2 sm:grid-cols-2">
                  {factRows.map(([label, value]) => (
                    <div
                      key={label}
                      className="rounded-xl border border-stone-200 px-3 py-2.5 dark:border-white/10"
                    >
                      <dt className="text-[11px] font-semibold text-stone-500">
                        {label}
                      </dt>
                      <dd className="mt-1 line-clamp-2 text-xs leading-5 text-stone-800 dark:text-stone-200">
                        {value}
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : null}
            </div>
          ) : (
            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              <Link
                href={canvasHref}
                onClick={(event) => {
                  if (!selectedAsset) {
                    event.preventDefault();
                    setShowAssets(true);
                    toast.info("选择历史作品后即可进入画布");
                  }
                }}
                className="group rounded-2xl border border-stone-200 p-4 transition hover:border-violet-300 hover:bg-violet-50/40 dark:border-white/10 dark:hover:bg-violet-400/5"
              >
                <span className="grid size-9 place-items-center rounded-xl bg-stone-100 text-stone-700 group-hover:bg-violet-100 group-hover:text-violet-700 dark:bg-white/10 dark:text-white">
                  <Expand className="size-4" />
                </span>
                <strong className="mt-3 block text-sm text-stone-900 dark:text-white">
                  局部重绘与扩图
                </strong>
                <span className="mt-1 block text-xs leading-5 text-stone-500">
                  进入统一画布，涂抹、擦除、扩展并保存版本。
                </span>
              </Link>
              <Link
                href="/presets/?tab=profiles"
                className="group rounded-2xl border border-stone-200 p-4 transition hover:border-violet-300 hover:bg-violet-50/40 dark:border-white/10 dark:hover:bg-violet-400/5"
              >
                <span className="grid size-9 place-items-center rounded-xl bg-stone-100 text-stone-700 group-hover:bg-violet-100 group-hover:text-violet-700 dark:bg-white/10 dark:text-white">
                  <UsersRound className="size-4" />
                </span>
                <strong className="mt-3 block text-sm text-stone-900 dark:text-white">
                  角色与风格一致性
                </strong>
                <span className="mt-1 block text-xs leading-5 text-stone-500">
                  管理人物、商品、品牌、画风档案和控制强度。
                </span>
              </Link>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
