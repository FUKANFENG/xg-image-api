"use client";

import Image from "next/image";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Archive,
  ArrowRight,
  Check,
  Clipboard,
  Brush,
  Download,
  FileSearch,
  Folder,
  FolderOpen,
  Heart,
  ImageIcon,
  Layers3,
  LoaderCircle,
  Plus,
  RefreshCw,
  Search,
  Send,
  Share2,
  SlidersHorizontal,
  Sparkles,
  ShieldCheck,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ConversationEditor } from "@/app/projects/conversation-editor";
import {
  activateCreativeVersion,
  bulkArchiveCreativeAssets,
  createCreativeProject,
  createAssetShare,
  deleteCreativeAsset,
  deleteCreativeProject,
  deleteCreativeVersion,
  detectDuplicateCreativeAssets,
  downloadAssetDelivery,
  fetchCreativeAsset,
  fetchCreativeAssets,
  fetchCreativeProjects,
  fetchImageIntegrity,
  repairImageIntegrity,
  searchCreativeAssets,
  submitAssetReview,
  updateCreativeAsset,
  updateCreativeProject,
  type CreativeAsset,
  type CreativeProject,
  type CreativeVersion,
  type ImageIntegrityReport,
} from "@/lib/api";
import { INSPIRATION_DRAFT_STORAGE_KEY } from "@/lib/inspiration-templates";
import { useAuthGuard } from "@/lib/use-auth-guard";
import { cn } from "@/lib/utils";

const operationLabels: Record<string, string> = {
  original: "原图",
  generate: "文生图",
  edit: "图片二创",
  restore: "高清修复",
  archive: "手动归档",
  cutout: "智能抠图",
  remove_object: "对象移除",
  outpaint: "智能扩图",
  id_photo: "证件照换底",
  colorize: "老照片上色",
  face_restore: "人脸修复",
};

function imageUrl(value?: string) {
  if (!value) return "";
  if (/^(https?:|data:|blob:)/.test(value)) return value;
  return value.startsWith("/") ? value : `/${value}`;
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

function VersionComparison({
  versions,
}: {
  versions: [CreativeVersion, CreativeVersion];
}) {
  const [position, setPosition] = useState(50);
  const [left, right] = versions;
  const leftSrc = imageUrl(
    left.image_url || (left.image_path ? `/images/${left.image_path}` : ""),
  );
  const rightSrc = imageUrl(
    right.image_url || (right.image_path ? `/images/${right.image_path}` : ""),
  );
  if (!leftSrc || !rightSrc) return null;
  return (
    <section className="overflow-hidden rounded-2xl border border-violet-200 bg-white p-4 dark:border-violet-400/30 dark:bg-stone-950">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold text-stone-900 dark:text-white">
            版本滑动对比
          </h3>
          <p className="mt-1 text-xs text-stone-500">
            V{left.version_number} 与 V{right.version_number}
            ，拖动滑杆检查细节。
          </p>
        </div>
        <span className="rounded-full bg-violet-50 px-2.5 py-1 text-xs font-medium text-violet-700 dark:bg-violet-400/10 dark:text-violet-200">
          {position}%
        </span>
      </div>
      <div className="relative aspect-[4/3] overflow-hidden rounded-xl bg-stone-100 dark:bg-white/5">
        <Image
          fill
          src={rightSrc}
          alt={`版本 ${right.version_number}`}
          className="object-contain"
          unoptimized
        />
        <Image
          fill
          src={leftSrc}
          alt={`版本 ${left.version_number}`}
          className="object-contain"
          style={{ clipPath: `inset(0 ${100 - position}% 0 0)` }}
          unoptimized
        />
        <span
          aria-hidden="true"
          className="absolute inset-y-0 w-0.5 bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.25)]"
          style={{ left: `${position}%` }}
        />
        <span className="absolute left-3 top-3 rounded-full bg-black/65 px-2.5 py-1 text-xs font-medium text-white">
          V{left.version_number}
        </span>
        <span className="absolute right-3 top-3 rounded-full bg-black/65 px-2.5 py-1 text-xs font-medium text-white">
          V{right.version_number}
        </span>
      </div>
      <input
        type="range"
        min="0"
        max="100"
        value={position}
        onChange={(event) => setPosition(Number(event.target.value))}
        className="mt-4 h-11 w-full cursor-ew-resize accent-violet-600"
        aria-label="调整版本对比位置"
      />
    </section>
  );
}

function VersionTimeline({
  asset,
  onActivate,
  onContinue,
  onDelete,
  compareVersionIds,
  onToggleCompare,
}: {
  asset: CreativeAsset;
  onActivate: (version: CreativeVersion) => void;
  onContinue: (version: CreativeVersion) => void;
  onDelete: (version: CreativeVersion) => void;
  compareVersionIds: string[];
  onToggleCompare: (version: CreativeVersion) => void;
}) {
  const versions = asset.versions || [];
  return (
    <div className="space-y-3">
      {versions.map((version, index) => {
        const isCurrent = version.id === asset.current_version_id;
        const src = imageUrl(
          version.image_url ||
            (version.image_path ? `/images/${version.image_path}` : ""),
        );
        return (
          <article
            key={version.id}
            className={cn(
              "relative grid gap-4 rounded-2xl border p-4 sm:grid-cols-[112px_minmax(0,1fr)]",
              isCurrent
                ? "border-violet-300 bg-violet-50/70 dark:border-violet-400/40 dark:bg-violet-400/10"
                : "border-stone-200 bg-white dark:border-white/10 dark:bg-stone-950",
            )}
          >
            {index < versions.length - 1 ? (
              <span
                aria-hidden="true"
                className="absolute bottom-[-14px] left-[67px] h-4 w-px bg-stone-200 dark:bg-white/15"
              />
            ) : null}
            <div className="relative aspect-square overflow-hidden rounded-xl bg-stone-100 dark:bg-white/5">
              {src ? (
                <Image
                  fill
                  sizes="96px"
                  src={src}
                  alt={`版本 ${version.version_number}`}
                  className="object-cover"
                  unoptimized
                />
              ) : (
                <div className="grid h-full place-items-center">
                  <ImageIcon className="size-7 text-stone-300" />
                </div>
              )}
            </div>
            <div className="min-w-0 space-y-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold text-stone-900 dark:text-white">
                      V{version.version_number}
                    </span>
                    <span className="rounded-full bg-stone-100 px-2 py-1 text-xs text-stone-600 dark:bg-white/10 dark:text-stone-300">
                      {operationLabels[version.operation] || version.operation}
                    </span>
                    {isCurrent ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-violet-600 px-2 py-1 text-xs font-medium text-white">
                        <Check className="size-3" />
                        当前版本
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1 text-xs text-stone-500">
                    {formatDate(version.created_at)}
                  </p>
                </div>
              </div>
              <p
                className="line-clamp-2 text-sm leading-6 text-stone-600 dark:text-stone-300"
                title={version.prompt}
              >
                {version.prompt || "未记录提示词"}
              </p>
              <div className="flex flex-wrap gap-2">
                {!isCurrent ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="min-h-10 rounded-xl"
                    onClick={() => onActivate(version)}
                  >
                    <Undo2 className="size-4" />
                    设为当前
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="min-h-10 rounded-xl"
                  onClick={() => {
                    void navigator.clipboard.writeText(
                      `${version.prompt}\n${JSON.stringify(version.params, null, 2)}`,
                    );
                    toast.success("版本参数已复制");
                  }}
                >
                  <Clipboard className="size-4" />
                  复制参数
                </Button>
                {src ? (
                  <>
                    <Button
                      type="button"
                      variant={
                        compareVersionIds.includes(version.id)
                          ? "default"
                          : "outline"
                      }
                      size="sm"
                      className={cn(
                        "min-h-10 rounded-xl",
                        compareVersionIds.includes(version.id) &&
                          "bg-violet-700 text-white hover:bg-violet-800",
                      )}
                      onClick={() => onToggleCompare(version)}
                    >
                      <Layers3 className="size-4" />
                      {compareVersionIds.includes(version.id)
                        ? "已选对比"
                        : "加入对比"}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="min-h-10 rounded-xl"
                      asChild
                    >
                      <a
                        href={`/canvas/?asset=${encodeURIComponent(asset.id)}&version=${encodeURIComponent(version.id)}`}
                      >
                        <Layers3 className="size-4" />
                        画布局部编辑
                      </a>
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      className="min-h-10 rounded-xl bg-violet-700 text-white hover:bg-violet-800"
                      onClick={() => onContinue(version)}
                    >
                      从此版本继续
                      <ArrowRight className="size-4" />
                    </Button>
                  </>
                ) : null}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="min-h-10 rounded-xl text-rose-600"
                  onClick={() => onDelete(version)}
                >
                  <Trash2 className="size-4" />
                  移入回收站
                </Button>
              </div>
            </div>
          </article>
        );
      })}
      {!versions.length ? (
        <div className="rounded-2xl border border-dashed border-stone-200 py-10 text-center text-sm text-stone-500 dark:border-white/10">
          这个资产还没有图片版本
        </div>
      ) : null}
    </div>
  );
}

export default function ProjectsPage() {
  const router = useRouter();
  const { isCheckingAuth, session } = useAuthGuard(["user", "admin"]);
  const [projects, setProjects] = useState<CreativeProject[]>([]);
  const [assets, setAssets] = useState<CreativeAsset[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState("all");
  const [selectedAsset, setSelectedAsset] = useState<CreativeAsset | null>(
    null,
  );
  const [query, setQuery] = useState("");
  const [assetType, setAssetType] = useState("");
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [advancedSearch, setAdvancedSearch] = useState(false);
  const [personFilter, setPersonFilter] = useState("");
  const [styleFilter, setStyleFilter] = useState("");
  const [colorFilter, setColorFilter] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isCreatingProject, setIsCreatingProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectDescription, setNewProjectDescription] = useState("");
  const [error, setError] = useState("");
  const [integrity, setIntegrity] = useState<ImageIntegrityReport | null>(null);
  const [isScanningIntegrity, setIsScanningIntegrity] = useState(false);
  const [isRepairingIntegrity, setIsRepairingIntegrity] = useState(false);
  const [isDetectingDuplicates, setIsDetectingDuplicates] = useState(false);
  const [selectedAssetIds, setSelectedAssetIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [bulkProjectId, setBulkProjectId] = useState("");
  const [isBulkArchiving, setIsBulkArchiving] = useState(false);
  const [compareVersionIds, setCompareVersionIds] = useState<string[]>([]);

  const loadProjects = useCallback(async () => {
    const result = await fetchCreativeProjects();
    setProjects(result.items);
  }, []);

  const applyLoadedAssets = useCallback((items: CreativeAsset[]) => {
    setAssets(items);
    const available = new Set(items.map((asset) => asset.id));
    setSelectedAssetIds(
      (current) => new Set([...current].filter((id) => available.has(id))),
    );
  }, []);

  const loadIntegrity = useCallback(
    async (force = false) => {
      setIsScanningIntegrity(true);
      try {
        setIntegrity(
          await fetchImageIntegrity(force, session?.role === "admin"),
        );
      } finally {
        setIsScanningIntegrity(false);
      }
    },
    [session?.role],
  );

  const loadAssets = useCallback(async () => {
    const useSmartSearch = Boolean(
      query.trim() ||
      personFilter.trim() ||
      styleFilter.trim() ||
      colorFilter.trim() ||
      dateFrom ||
      dateTo,
    );
    if (useSmartSearch) {
      const result = await searchCreativeAssets({
        query: query.trim() || undefined,
        person: personFilter.trim() || undefined,
        style: styleFilter.trim() || undefined,
        color: colorFilter.trim() || undefined,
        date_from: dateFrom || undefined,
        date_to: dateTo || undefined,
      });
      applyLoadedAssets(
        result.items.filter((asset) => {
          if (assetType && asset.asset_type !== assetType) return false;
          if (favoritesOnly && !asset.favorite) return false;
          if (selectedProjectId === "unfiled" && asset.project_id) return false;
          if (
            selectedProjectId !== "all" &&
            selectedProjectId !== "unfiled" &&
            asset.project_id !== selectedProjectId
          )
            return false;
          return true;
        }),
      );
      return;
    }
    const filters: Parameters<typeof fetchCreativeAssets>[0] = {
      query: query.trim() || undefined,
      asset_type: assetType || undefined,
      favorite: favoritesOnly ? true : undefined,
    };
    if (selectedProjectId === "unfiled") filters.project_id = "";
    else if (selectedProjectId !== "all")
      filters.project_id = selectedProjectId;
    const result = await fetchCreativeAssets(filters);
    applyLoadedAssets(result.items);
  }, [
    applyLoadedAssets,
    assetType,
    colorFilter,
    dateFrom,
    dateTo,
    favoritesOnly,
    personFilter,
    query,
    selectedProjectId,
    styleFilter,
  ]);

  useEffect(() => {
    if (!session) return;
    let active = true;
    const timer = window.setTimeout(() => {
      setIsLoading(true);
      void Promise.all([loadProjects(), loadAssets(), loadIntegrity()])
        .catch(
          (loadError) =>
            active &&
            setError(
              loadError instanceof Error ? loadError.message : "项目加载失败",
            ),
        )
        .finally(() => active && setIsLoading(false));
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [loadAssets, loadIntegrity, loadProjects, session]);

  const totalAssets = useMemo(
    () => projects.reduce((sum, project) => sum + project.asset_count, 0),
    [projects],
  );
  const selectedCompareVersions = useMemo(() => {
    if (!selectedAsset || compareVersionIds.length !== 2) return null;
    const versions = selectedAsset.versions || [];
    const selected = compareVersionIds
      .map((id) => versions.find((version) => version.id === id))
      .filter((version): version is CreativeVersion => Boolean(version));
    return selected.length === 2
      ? ([selected[0], selected[1]] as [CreativeVersion, CreativeVersion])
      : null;
  }, [compareVersionIds, selectedAsset]);
  const integrityActionable = integrity
    ? integrity.summary.recoverable +
      (integrity.summary.backup_mode === "local"
        ? 0
        : integrity.summary.local_only)
    : 0;

  const createProject = async () => {
    if (!newProjectName.trim()) {
      setError("请填写项目名称");
      return;
    }
    try {
      const created = await createCreativeProject({
        name: newProjectName.trim(),
        description: newProjectDescription.trim(),
      });
      setNewProjectName("");
      setNewProjectDescription("");
      setIsCreatingProject(false);
      await loadProjects();
      setSelectedProjectId(created.id);
      toast.success("项目已创建");
    } catch (createError) {
      setError(
        createError instanceof Error ? createError.message : "创建项目失败",
      );
    }
  };

  const openAsset = async (assetId: string) => {
    try {
      const asset = await fetchCreativeAsset(assetId);
      setSelectedAsset(asset);
      const imageVersions = (asset.versions || []).filter(
        (version) => version.image_url || version.image_path,
      );
      setCompareVersionIds(
        imageVersions.length >= 2
          ? [imageVersions[0].id, imageVersions.at(-1)!.id]
          : [],
      );
    } catch (openError) {
      setError(
        openError instanceof Error ? openError.message : "作品详情加载失败",
      );
    }
  };

  const toggleAssetSelection = (assetId: string) => {
    setSelectedAssetIds((current) => {
      const next = new Set(current);
      if (next.has(assetId)) next.delete(assetId);
      else next.add(assetId);
      return next;
    });
  };

  const repairIntegrity = async () => {
    setIsRepairingIntegrity(true);
    try {
      const result = await repairImageIntegrity(session?.role === "admin");
      setIntegrity(result);
      await loadAssets();
      toast.success(
        `体检修复完成：恢复 ${result.restored.length} 张，备份 ${result.backed_up.length} 张`,
      );
      if (result.failed.length) {
        toast.warning(`${result.failed.length} 张仍需人工处理`);
      }
    } catch (repairError) {
      setError(
        repairError instanceof Error ? repairError.message : "图片修复失败",
      );
    } finally {
      setIsRepairingIntegrity(false);
    }
  };

  const detectDuplicates = async () => {
    setIsDetectingDuplicates(true);
    try {
      const result = await detectDuplicateCreativeAssets();
      await loadAssets();
      toast.success(
        `已扫描 ${result.summary.scanned} 项，发现 ${result.summary.duplicates} 组相似图片`,
      );
    } catch (detectError) {
      setError(
        detectError instanceof Error ? detectError.message : "重复图片检测失败",
      );
    } finally {
      setIsDetectingDuplicates(false);
    }
  };

  const bulkArchive = async () => {
    if (!selectedAssetIds.size) return;
    setIsBulkArchiving(true);
    try {
      const result = await bulkArchiveCreativeAssets(
        [...selectedAssetIds],
        bulkProjectId || null,
      );
      setSelectedAssetIds(new Set());
      await Promise.all([loadAssets(), loadProjects()]);
      toast.success(`已归档 ${result.updated} 项作品`);
    } catch (bulkError) {
      setError(bulkError instanceof Error ? bulkError.message : "批量归档失败");
    } finally {
      setIsBulkArchiving(false);
    }
  };

  const toggleVersionComparison = (version: CreativeVersion) => {
    setCompareVersionIds((current) => {
      if (current.includes(version.id)) {
        return current.filter((id) => id !== version.id);
      }
      return [...current.slice(-1), version.id];
    });
  };

  const mutateAsset = async (
    asset: CreativeAsset,
    updates: Parameters<typeof updateCreativeAsset>[1],
  ) => {
    try {
      const updated = await updateCreativeAsset(asset.id, updates);
      setSelectedAsset((current) =>
        current?.id === asset.id ? { ...current, ...updated } : current,
      );
      await Promise.all([loadAssets(), loadProjects()]);
    } catch (updateError) {
      setError(
        updateError instanceof Error ? updateError.message : "作品更新失败",
      );
    }
  };

  const activateVersion = async (version: CreativeVersion) => {
    if (!selectedAsset) return;
    try {
      const updated = await activateCreativeVersion(
        selectedAsset.id,
        version.id,
      );
      setSelectedAsset(updated);
      await loadAssets();
      toast.success(`已回到 V${version.version_number}`);
    } catch (activateError) {
      setError(
        activateError instanceof Error ? activateError.message : "版本回退失败",
      );
    }
  };

  const trashVersion = async (version: CreativeVersion) => {
    if (
      !selectedAsset ||
      !window.confirm(
        `将 V${version.version_number} 移入回收站？30 天内可恢复。`,
      )
    )
      return;
    try {
      await deleteCreativeVersion(selectedAsset.id, version.id);
      setSelectedAsset(await fetchCreativeAsset(selectedAsset.id));
      await loadAssets();
      toast.success("版本已移入回收站");
    } catch (trashError) {
      setError(
        trashError instanceof Error ? trashError.message : "版本删除失败",
      );
    }
  };

  const continueFromVersion = (version: CreativeVersion) => {
    if (!selectedAsset) return;
    const params = version.params || {};
    window.sessionStorage.setItem(
      INSPIRATION_DRAFT_STORAGE_KEY,
      JSON.stringify({
        title: `${selectedAsset.name} · V${version.version_number}`,
        prompt:
          version.prompt ||
          "保持主体、人物和构图不变，按照我的下一条要求继续修改。",
        size: typeof params.size === "string" ? params.size : "1024x1024",
        quality: typeof params.quality === "string" ? params.quality : "auto",
        reference_url: imageUrl(
          version.image_url || `/images/${version.image_path}`,
        ),
        asset_id: selectedAsset.id,
        parent_version_id: version.id,
      }),
    );
    router.push("/studio");
  };

  const handleConversationAssetUpdated = useCallback(
    (nextAsset: CreativeAsset) => {
      setSelectedAsset(nextAsset);
      setAssets((current) =>
        current.map((item) =>
          item.id === nextAsset.id ? { ...item, ...nextAsset } : item,
        ),
      );
    },
    [],
  );

  if (isCheckingAuth || !session)
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <LoaderCircle className="size-6 animate-spin text-violet-600" />
      </div>
    );

  return (
    <main className="min-h-[calc(100dvh-4rem)] bg-stone-50/70 px-4 py-6 sm:px-6 lg:px-8 dark:bg-stone-950">
      <div className="mx-auto max-w-7xl space-y-6">
        <header className="flex flex-col gap-4 rounded-3xl border border-stone-200/80 bg-white p-6 shadow-sm md:flex-row md:items-end md:justify-between dark:border-white/10 dark:bg-stone-900">
          <div>
            <div className="mb-3 inline-flex items-center gap-2 rounded-full bg-violet-50 px-3 py-1.5 text-sm font-medium text-violet-700 dark:bg-violet-400/10 dark:text-violet-200">
              <FolderOpen className="size-4" />
              创作资产库
            </div>
            <h1 className="text-2xl font-bold tracking-tight text-stone-950 sm:text-3xl dark:text-white">
              项目、作品与完整版本链
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-stone-600 sm:text-base dark:text-stone-300">
              生图、二创和修复结果自动沉淀为作品。文件夹只管理关系，移动或删除归档不会删除底层图片。
            </p>
          </div>
          <Button
            type="button"
            onClick={() => setIsCreatingProject(true)}
            className="min-h-11 rounded-xl bg-violet-700 text-white hover:bg-violet-800"
          >
            <Plus className="size-4" />
            新建项目
          </Button>
        </header>

        {isCreatingProject ? (
          <section className="rounded-3xl border border-violet-200 bg-violet-50/60 p-5 dark:border-violet-400/30 dark:bg-violet-400/10">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold text-stone-900 dark:text-white">
                创建新项目
              </h2>
              <button
                type="button"
                aria-label="关闭"
                onClick={() => setIsCreatingProject(false)}
                className="grid size-11 place-items-center rounded-xl hover:bg-white/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 dark:hover:bg-white/10"
              >
                <X className="size-4" />
              </button>
            </div>
            <div className="mt-4 grid gap-3 md:grid-cols-[1fr_1.5fr_auto]">
              <label className="space-y-2 text-sm font-medium">
                <span>项目名称</span>
                <input
                  value={newProjectName}
                  onChange={(event) => setNewProjectName(event.target.value)}
                  className="h-11 w-full rounded-xl border border-stone-200 bg-white px-3 text-base outline-none focus:border-violet-500 focus:ring-4 focus:ring-violet-500/10 dark:border-white/10 dark:bg-stone-950"
                  placeholder="例如：新品发布海报"
                />
              </label>
              <label className="space-y-2 text-sm font-medium">
                <span>项目说明</span>
                <input
                  value={newProjectDescription}
                  onChange={(event) =>
                    setNewProjectDescription(event.target.value)
                  }
                  className="h-11 w-full rounded-xl border border-stone-200 bg-white px-3 text-base outline-none focus:border-violet-500 focus:ring-4 focus:ring-violet-500/10 dark:border-white/10 dark:bg-stone-950"
                  placeholder="用途、客户或交付目标"
                />
              </label>
              <Button
                type="button"
                onClick={() => void createProject()}
                className="min-h-11 self-end rounded-xl bg-violet-700 text-white"
              >
                创建
              </Button>
            </div>
          </section>
        ) : null}

        {error ? (
          <div
            className="rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:bg-rose-400/10 dark:text-rose-200"
            role="alert"
          >
            {error}
          </div>
        ) : null}

        <section className="flex flex-col gap-4 rounded-3xl border border-stone-200/80 bg-white p-4 shadow-sm md:flex-row md:items-center md:justify-between dark:border-white/10 dark:bg-stone-900">
          <div className="flex min-w-0 items-start gap-3">
            <span
              className={cn(
                "grid size-11 shrink-0 place-items-center rounded-2xl",
                integrity?.summary.missing
                  ? "bg-rose-50 text-rose-600 dark:bg-rose-400/10 dark:text-rose-200"
                  : "bg-emerald-50 text-emerald-600 dark:bg-emerald-400/10 dark:text-emerald-200",
              )}
            >
              {isScanningIntegrity ? (
                <LoaderCircle className="size-5 animate-spin" />
              ) : (
                <ShieldCheck className="size-5" />
              )}
            </span>
            <div className="min-w-0">
              <h2 className="font-semibold text-stone-900 dark:text-white">
                {session.role === "admin" ? "全站图片存储体检" : "图片存储体检"}
              </h2>
              <p className="mt-1 text-sm leading-6 text-stone-500 dark:text-stone-400">
                {integrity
                  ? `共 ${integrity.summary.unique_images} 张 · 缺失 ${integrity.summary.missing} 张 · 可恢复 ${integrity.summary.recoverable} 张${integrity.summary.backup_mode === "local" ? " · 当前仅本地存储" : ` · 待备份 ${integrity.summary.local_only} 张`}`
                  : "正在检查历史作品与底层图片是否一致。"}
              </p>
              {integrity?.summary.missing ? (
                <p className="mt-1 text-xs font-medium text-rose-600 dark:text-rose-300">
                  {integrity.summary.missing}{" "}
                  张在本机和远端均不存在，需要人工补回原图。
                </p>
              ) : integrity?.summary.recoverable ? (
                <p className="mt-1 text-xs font-medium text-amber-600 dark:text-amber-300">
                  {integrity.summary.recoverable}{" "}
                  张仅保存在远端，可一键恢复本地副本。
                </p>
              ) : null}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              className="min-h-11 rounded-xl"
              disabled={isScanningIntegrity}
              onClick={() => void loadIntegrity(true)}
            >
              <RefreshCw
                className={cn("size-4", isScanningIntegrity && "animate-spin")}
              />
              重新体检
            </Button>
            <Button
              type="button"
              variant="outline"
              className="min-h-11 rounded-xl"
              disabled={isDetectingDuplicates}
              onClick={() => void detectDuplicates()}
            >
              {isDetectingDuplicates ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : (
                <Layers3 className="size-4" />
              )}
              检测重复图
            </Button>
            {integrityActionable > 0 ? (
              <Button
                type="button"
                className="min-h-11 rounded-xl bg-violet-700 text-white hover:bg-violet-800"
                disabled={isRepairingIntegrity}
                onClick={() => void repairIntegrity()}
              >
                {isRepairingIntegrity ? (
                  <LoaderCircle className="size-4 animate-spin" />
                ) : (
                  <ShieldCheck className="size-4" />
                )}
                一键修复 {integrityActionable} 张
              </Button>
            ) : null}
          </div>
        </section>

        <div className="grid gap-6 lg:grid-cols-[260px_minmax(0,1fr)]">
          <aside className="rounded-3xl border border-stone-200/80 bg-white p-4 shadow-sm dark:border-white/10 dark:bg-stone-900">
            <div className="px-2 pb-3">
              <h2 className="font-semibold text-stone-900 dark:text-white">
                项目文件夹
              </h2>
              <p className="mt-1 text-xs text-stone-500">
                {projects.length} 个项目 ·{" "}
                {Math.max(totalAssets, assets.length)} 项资产
              </p>
            </div>
            <nav className="space-y-1" aria-label="项目筛选">
              {[
                {
                  id: "all",
                  name: "全部作品",
                  count: Math.max(totalAssets, assets.length),
                  icon: Layers3,
                },
                {
                  id: "unfiled",
                  name: "未归档",
                  count: undefined,
                  icon: Archive,
                },
              ].map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setSelectedProjectId(item.id)}
                    className={cn(
                      "flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500",
                      selectedProjectId === item.id
                        ? "bg-violet-50 text-violet-800 dark:bg-violet-400/10 dark:text-violet-100"
                        : "text-stone-600 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-white/5",
                    )}
                  >
                    <Icon className="size-4" />
                    <span className="flex-1">{item.name}</span>
                    {item.count !== undefined ? (
                      <span className="text-xs tabular-nums text-stone-400">
                        {item.count}
                      </span>
                    ) : null}
                  </button>
                );
              })}
              <div className="my-3 h-px bg-stone-200 dark:bg-white/10" />
              {projects.map((project) => (
                <div key={project.id} className="group flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setSelectedProjectId(project.id)}
                    className={cn(
                      "flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-xl px-3 text-left text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500",
                      selectedProjectId === project.id
                        ? "bg-violet-50 text-violet-800 dark:bg-violet-400/10 dark:text-violet-100"
                        : "text-stone-600 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-white/5",
                    )}
                  >
                    <Folder className="size-4 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">
                      {project.name}
                    </span>
                    <span className="text-xs tabular-nums text-stone-400">
                      {project.asset_count}
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-label={
                      project.favorite
                        ? `取消收藏 ${project.name}`
                        : `收藏 ${project.name}`
                    }
                    onClick={() =>
                      void updateCreativeProject(project.id, {
                        favorite: !project.favorite,
                      }).then(loadProjects)
                    }
                    className="grid size-11 shrink-0 place-items-center rounded-xl text-stone-400 opacity-70 transition hover:bg-stone-100 hover:text-rose-500 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 group-hover:opacity-100 dark:hover:bg-white/5"
                  >
                    <Heart
                      className={cn(
                        "size-4",
                        project.favorite && "fill-current text-rose-500",
                      )}
                    />
                  </button>
                </div>
              ))}
            </nav>
          </aside>

          <section className="min-w-0 space-y-4">
            <div className="grid gap-3 rounded-3xl border border-stone-200/80 bg-white p-4 shadow-sm sm:grid-cols-[minmax(0,1fr)_auto_auto_auto] dark:border-white/10 dark:bg-stone-900">
              <label className="relative">
                <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-stone-400" />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  className="h-11 w-full rounded-xl border border-stone-200 bg-stone-50 pl-10 pr-3 text-base outline-none focus:border-violet-500 focus:ring-4 focus:ring-violet-500/10 dark:border-white/10 dark:bg-stone-950"
                  placeholder="搜索作品名称"
                />
              </label>
              <select
                aria-label="资产类型"
                value={assetType}
                onChange={(event) => setAssetType(event.target.value)}
                className="h-11 rounded-xl border border-stone-200 bg-white px-3 text-sm outline-none focus:border-violet-500 focus:ring-4 focus:ring-violet-500/10 dark:border-white/10 dark:bg-stone-950"
              >
                <option value="">全部类型</option>
                <option value="image">图片</option>
                <option value="prompt">提示词</option>
                <option value="ppt">PPT</option>
                <option value="psd">PSD</option>
              </select>
              <button
                type="button"
                aria-pressed={favoritesOnly}
                onClick={() => setFavoritesOnly((value) => !value)}
                className={cn(
                  "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border px-4 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500",
                  favoritesOnly
                    ? "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-400/30 dark:bg-rose-400/10 dark:text-rose-200"
                    : "border-stone-200 text-stone-600 hover:bg-stone-50 dark:border-white/10 dark:text-stone-300 dark:hover:bg-white/5",
                )}
              >
                <Heart
                  className={cn("size-4", favoritesOnly && "fill-current")}
                />
                收藏
              </button>
              <button
                type="button"
                aria-expanded={advancedSearch}
                onClick={() => setAdvancedSearch((value) => !value)}
                className={cn(
                  "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border px-4 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500",
                  advancedSearch
                    ? "border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-400/30 dark:bg-violet-400/10 dark:text-violet-200"
                    : "border-stone-200 text-stone-600 hover:bg-stone-50 dark:border-white/10 dark:text-stone-300 dark:hover:bg-white/5",
                )}
              >
                <SlidersHorizontal className="size-4" />
                智能筛选
              </button>
              {advancedSearch ? (
                <div className="grid gap-3 border-t border-stone-100 pt-3 sm:col-span-4 sm:grid-cols-5 dark:border-white/10">
                  <label className="text-xs font-medium text-stone-500">
                    人物 / 产品
                    <input
                      value={personFilter}
                      onChange={(event) => setPersonFilter(event.target.value)}
                      placeholder="人物、产品名称"
                      className="mt-1 min-h-11 w-full rounded-xl border border-stone-200 bg-stone-50 px-3 text-base outline-none focus:border-violet-500 dark:border-white/10 dark:bg-stone-950"
                    />
                  </label>
                  <label className="text-xs font-medium text-stone-500">
                    风格
                    <input
                      value={styleFilter}
                      onChange={(event) => setStyleFilter(event.target.value)}
                      placeholder="电影感、插画、极简"
                      className="mt-1 min-h-11 w-full rounded-xl border border-stone-200 bg-stone-50 px-3 text-base outline-none focus:border-violet-500 dark:border-white/10 dark:bg-stone-950"
                    />
                  </label>
                  <label className="text-xs font-medium text-stone-500">
                    颜色
                    <input
                      value={colorFilter}
                      onChange={(event) => setColorFilter(event.target.value)}
                      placeholder="#7c3aed 或 蓝色"
                      className="mt-1 min-h-11 w-full rounded-xl border border-stone-200 bg-stone-50 px-3 text-base outline-none focus:border-violet-500 dark:border-white/10 dark:bg-stone-950"
                    />
                  </label>
                  <label className="text-xs font-medium text-stone-500">
                    开始日期
                    <input
                      type="date"
                      value={dateFrom}
                      onChange={(event) => setDateFrom(event.target.value)}
                      className="mt-1 min-h-11 w-full rounded-xl border border-stone-200 bg-stone-50 px-3 text-base outline-none focus:border-violet-500 dark:border-white/10 dark:bg-stone-950"
                    />
                  </label>
                  <label className="text-xs font-medium text-stone-500">
                    结束日期
                    <input
                      type="date"
                      value={dateTo}
                      onChange={(event) => setDateTo(event.target.value)}
                      className="mt-1 min-h-11 w-full rounded-xl border border-stone-200 bg-stone-50 px-3 text-base outline-none focus:border-violet-500 dark:border-white/10 dark:bg-stone-950"
                    />
                  </label>
                </div>
              ) : null}
            </div>

            {selectedAssetIds.size > 0 ? (
              <div className="sticky top-20 z-20 flex flex-col gap-3 rounded-2xl border border-violet-200 bg-white/95 p-3 shadow-lg backdrop-blur sm:flex-row sm:items-center dark:border-violet-400/30 dark:bg-stone-900/95">
                <span className="shrink-0 text-sm font-semibold text-violet-800 dark:text-violet-100">
                  已选择 {selectedAssetIds.size} 项
                </span>
                <select
                  aria-label="批量归档目标项目"
                  value={bulkProjectId}
                  onChange={(event) => setBulkProjectId(event.target.value)}
                  className="h-11 min-w-0 flex-1 rounded-xl border border-stone-200 bg-white px-3 text-sm outline-none focus:border-violet-500 dark:border-white/10 dark:bg-stone-950"
                >
                  <option value="">移动到未归档</option>
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      移动到 {project.name}
                    </option>
                  ))}
                </select>
                <Button
                  type="button"
                  className="min-h-11 rounded-xl bg-violet-700 text-white hover:bg-violet-800"
                  disabled={isBulkArchiving}
                  onClick={() => void bulkArchive()}
                >
                  {isBulkArchiving ? (
                    <LoaderCircle className="size-4 animate-spin" />
                  ) : (
                    <Archive className="size-4" />
                  )}
                  批量归档
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  className="min-h-11 rounded-xl"
                  onClick={() => setSelectedAssetIds(new Set())}
                >
                  取消选择
                </Button>
              </div>
            ) : assets.length > 0 ? (
              <div className="flex justify-end">
                <Button
                  type="button"
                  variant="ghost"
                  className="min-h-11 rounded-xl text-stone-600 dark:text-stone-300"
                  onClick={() =>
                    setSelectedAssetIds(
                      new Set(assets.map((asset) => asset.id)),
                    )
                  }
                >
                  <Check className="size-4" />
                  全选当前作品
                </Button>
              </div>
            ) : null}

            {isLoading ? (
              <div className="flex min-h-72 items-center justify-center rounded-3xl border border-stone-200 bg-white dark:border-white/10 dark:bg-stone-900">
                <LoaderCircle className="size-6 animate-spin text-violet-600" />
              </div>
            ) : assets.length ? (
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {assets.map((asset) => (
                  <article
                    key={asset.id}
                    className={cn(
                      "group relative overflow-hidden rounded-3xl border bg-white shadow-sm transition hover:-translate-y-0.5 hover:shadow-md motion-reduce:hover:translate-y-0 dark:bg-stone-900",
                      selectedAssetIds.has(asset.id)
                        ? "border-violet-400 ring-2 ring-violet-500/20 dark:border-violet-400"
                        : "border-stone-200/80 dark:border-white/10",
                    )}
                  >
                    <button
                      type="button"
                      aria-pressed={selectedAssetIds.has(asset.id)}
                      aria-label={`${selectedAssetIds.has(asset.id) ? "取消选择" : "选择"} ${asset.name}`}
                      onClick={() => toggleAssetSelection(asset.id)}
                      className={cn(
                        "absolute left-3 top-3 z-20 grid size-11 place-items-center rounded-full border shadow-sm backdrop-blur transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500",
                        selectedAssetIds.has(asset.id)
                          ? "border-violet-500 bg-violet-600 text-white"
                          : "border-white/70 bg-black/45 text-white hover:bg-black/65",
                      )}
                    >
                      {selectedAssetIds.has(asset.id) ? (
                        <Check className="size-4" />
                      ) : (
                        <span
                          aria-hidden="true"
                          className="size-3 rounded-full border-2 border-current"
                        />
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => void openAsset(asset.id)}
                      className="block w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-500"
                    >
                      <div className="relative aspect-[4/3] overflow-hidden bg-stone-100 dark:bg-white/5">
                        {asset.metadata.duplicate_of ? (
                          <span className="absolute right-3 top-3 z-10 rounded-full bg-amber-500 px-2.5 py-1 text-xs font-semibold text-white shadow-sm">
                            相似图
                            {typeof asset.metadata.duplicate_similarity ===
                            "number"
                              ? ` ${asset.metadata.duplicate_similarity}%`
                              : ""}
                          </span>
                        ) : null}
                        {asset.current_image_url ? (
                          <Image
                            fill
                            sizes="(min-width: 1280px) 25vw, (min-width: 768px) 50vw, 100vw"
                            src={imageUrl(asset.current_image_url)}
                            alt={asset.name}
                            className="object-cover transition duration-300 group-hover:scale-[1.02] motion-reduce:transition-none"
                            unoptimized
                          />
                        ) : (
                          <div className="grid h-full place-items-center">
                            <Folder className="size-10 text-stone-300" />
                          </div>
                        )}
                      </div>
                      <div className="p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <h3
                              className="truncate font-semibold text-stone-900 dark:text-white"
                              title={asset.name}
                            >
                              {asset.name}
                            </h3>
                            <p className="mt-1 text-xs text-stone-500">
                              {asset.asset_type.toUpperCase()} ·{" "}
                              {asset.current_version_number || 0} 个版本
                            </p>
                          </div>
                          {asset.favorite ? (
                            <Heart className="size-4 shrink-0 fill-current text-rose-500" />
                          ) : null}
                        </div>
                        {asset.tags.length ? (
                          <div className="mt-3 flex flex-wrap gap-1.5">
                            {asset.tags.slice(0, 3).map((tag) => (
                              <span
                                key={tag}
                                className="rounded-full bg-stone-100 px-2 py-1 text-xs text-stone-600 dark:bg-white/10 dark:text-stone-300"
                              >
                                {tag}
                              </span>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    </button>
                    <div className="flex items-center gap-2 border-t border-stone-100 px-3 py-2 dark:border-white/10">
                      {asset.asset_type === "image" ? (
                        <>
                          <button
                            type="button"
                            title="反推提示词"
                            aria-label={`反推 ${asset.name} 的提示词`}
                            onClick={() =>
                              router.push(
                                `/toolbox/?reverse_asset=${encodeURIComponent(asset.id)}#reverse-prompt`,
                              )
                            }
                            className="grid size-10 place-items-center rounded-xl text-violet-600 transition hover:bg-violet-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 dark:hover:bg-violet-400/10"
                          >
                            <FileSearch className="size-4" />
                          </button>
                          <button
                            type="button"
                            title="局部重绘 / 扩图"
                            aria-label={`在画布编辑 ${asset.name}`}
                            onClick={() =>
                              router.push(
                                `/canvas/?asset=${encodeURIComponent(asset.id)}${asset.current_version_id ? `&version=${encodeURIComponent(asset.current_version_id)}` : ""}`,
                              )
                            }
                            className="grid size-10 place-items-center rounded-xl text-violet-600 transition hover:bg-violet-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 dark:hover:bg-violet-400/10"
                          >
                            <Brush className="size-4" />
                          </button>
                          <button
                            type="button"
                            title="智能质检、尺寸与版本分支"
                            aria-label={`打开 ${asset.name} 的智能资产工具`}
                            onClick={() =>
                              router.push(
                                `/intelligence/?asset=${encodeURIComponent(asset.id)}`,
                              )
                            }
                            className="grid size-10 place-items-center rounded-xl text-violet-600 transition hover:bg-violet-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 dark:hover:bg-violet-400/10"
                          >
                            <Sparkles className="size-4" />
                          </button>
                        </>
                      ) : null}
                      <button
                        type="button"
                        onClick={() =>
                          void mutateAsset(asset, { favorite: !asset.favorite })
                        }
                        className="grid size-10 place-items-center rounded-xl text-stone-400 transition hover:bg-rose-50 hover:text-rose-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 dark:hover:bg-rose-400/10"
                      >
                        <Heart
                          className={cn(
                            "size-4",
                            asset.favorite && "fill-current text-rose-500",
                          )}
                        />
                      </button>
                      <select
                        aria-label={`移动 ${asset.name} 到项目`}
                        value={asset.project_id || ""}
                        onChange={(event) =>
                          void mutateAsset(asset, {
                            project_id: event.target.value || null,
                          })
                        }
                        className="h-10 min-w-0 flex-1 rounded-xl border border-stone-200 bg-white px-2 text-xs outline-none focus:border-violet-500 dark:border-white/10 dark:bg-stone-950"
                      >
                        <option value="">未归档</option>
                        {projects.map((project) => (
                          <option key={project.id} value={project.id}>
                            {project.name}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        aria-label={`删除 ${asset.name} 的归档记录`}
                        onClick={() => {
                          if (
                            window.confirm(
                              "只删除项目归档与版本关系，底层图片仍会保留。继续吗？",
                            )
                          )
                            void deleteCreativeAsset(asset.id).then(() =>
                              Promise.all([loadAssets(), loadProjects()]),
                            );
                        }}
                        className="grid size-10 place-items-center rounded-xl text-stone-400 transition hover:bg-rose-50 hover:text-rose-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 dark:hover:bg-rose-400/10"
                      >
                        <Trash2 className="size-4" />
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="rounded-3xl border border-dashed border-stone-200 bg-white py-16 text-center dark:border-white/10 dark:bg-stone-900">
                <FolderOpen className="mx-auto size-10 text-stone-300" />
                <h2 className="mt-4 font-semibold text-stone-800 dark:text-stone-100">
                  当前范围没有作品
                </h2>
                <p className="mt-2 text-sm text-stone-500">
                  新生成、二创和修复结果会自动出现在“未归档”中。
                </p>
              </div>
            )}

            {selectedProjectId !== "all" && selectedProjectId !== "unfiled" ? (
              <div className="flex justify-end">
                <Button
                  type="button"
                  variant="ghost"
                  className="min-h-11 rounded-xl text-rose-600"
                  onClick={() => {
                    if (
                      window.confirm(
                        "删除项目后，里面的作品会移到“未归档”，底层图片不受影响。",
                      )
                    )
                      void deleteCreativeProject(selectedProjectId).then(
                        async () => {
                          setSelectedProjectId("all");
                          await Promise.all([loadProjects(), loadAssets()]);
                        },
                      );
                  }}
                >
                  <Trash2 className="size-4" />
                  删除当前项目
                </Button>
              </div>
            ) : null}
          </section>
        </div>

        {selectedAsset ? (
          <div
            className="fixed inset-0 z-[100] flex items-end justify-end bg-black/50 p-0 sm:p-4"
            role="presentation"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setSelectedAsset(null);
            }}
          >
            <section
              role="dialog"
              aria-modal="true"
              aria-labelledby="asset-detail-title"
              className="max-h-[96dvh] w-full overflow-y-auto rounded-t-3xl bg-stone-50 shadow-2xl sm:max-w-3xl sm:rounded-3xl dark:bg-stone-900"
            >
              <div className="sticky top-0 z-10 flex items-center justify-between border-b border-stone-200 bg-white/95 px-5 py-4 backdrop-blur dark:border-white/10 dark:bg-stone-900/95">
                <div className="min-w-0">
                  <p className="text-xs font-medium text-violet-600 dark:text-violet-300">
                    作品详情
                  </p>
                  <h2
                    id="asset-detail-title"
                    className="truncate text-lg font-bold text-stone-950 dark:text-white"
                  >
                    {selectedAsset.name}
                  </h2>
                </div>
                <button
                  type="button"
                  aria-label="关闭作品详情"
                  onClick={() => setSelectedAsset(null)}
                  className="grid size-11 place-items-center rounded-xl text-stone-500 transition hover:bg-stone-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 dark:hover:bg-white/10"
                >
                  <X className="size-5" />
                </button>
              </div>
              <div className="space-y-5 p-5">
                <div className="flex flex-wrap gap-2 rounded-2xl border border-stone-200 bg-white p-3 dark:border-white/10 dark:bg-stone-950/40">
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11 rounded-xl"
                    disabled={!selectedAsset.current_version_id}
                    onClick={async () => {
                      if (!selectedAsset.current_version_id) return;
                      const share = await createAssetShare(
                        selectedAsset.id,
                        selectedAsset.current_version_id,
                      );
                      await navigator.clipboard.writeText(
                        `${window.location.origin}/share/?token=${encodeURIComponent(share.token)}`,
                      );
                      toast.success("只读分享链接已复制");
                    }}
                  >
                    <Share2 className="size-4" />
                    分享
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11 rounded-xl"
                    disabled={!selectedAsset.current_version_id}
                    onClick={async () => {
                      if (!selectedAsset.current_version_id) return;
                      await submitAssetReview(
                        selectedAsset.id,
                        selectedAsset.current_version_id,
                      );
                      toast.success("已提交管理员审核");
                    }}
                  >
                    <Send className="size-4" />
                    提交审核
                  </Button>
                  {(
                    [
                      ["original", "原图"],
                      ["current", "当前"],
                      ["all", "全部版本"],
                      ["delivery", "交付包"],
                    ] as const
                  ).map(([mode, label]) => (
                    <Button
                      key={mode}
                      type="button"
                      variant="outline"
                      className="min-h-11 rounded-xl"
                      onClick={() =>
                        void downloadAssetDelivery(
                          selectedAsset.id,
                          mode,
                          `${selectedAsset.name}-${label}`,
                        )
                      }
                    >
                      <Download className="size-4" />
                      {label}
                    </Button>
                  ))}
                </div>
                <ConversationEditor
                  asset={selectedAsset}
                  onAssetUpdated={handleConversationAssetUpdated}
                />
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h3 className="font-semibold text-stone-900 dark:text-white">
                      版本时间线
                    </h3>
                    <p className="mt-1 text-sm text-stone-500">
                      回退只切换当前指针，所有历史版本都会保留。
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11 rounded-xl"
                    onClick={() =>
                      void mutateAsset(selectedAsset, {
                        favorite: !selectedAsset.favorite,
                      })
                    }
                  >
                    <Heart
                      className={cn(
                        "size-4",
                        selectedAsset.favorite && "fill-current text-rose-500",
                      )}
                    />
                    {selectedAsset.favorite ? "已收藏" : "收藏作品"}
                  </Button>
                </div>
                {selectedCompareVersions ? (
                  <VersionComparison
                    key={selectedCompareVersions
                      .map((version) => version.id)
                      .join(":")}
                    versions={selectedCompareVersions}
                  />
                ) : (selectedAsset.versions || []).filter(
                    (version) => version.image_url || version.image_path,
                  ).length >= 2 ? (
                  <p className="rounded-2xl border border-dashed border-stone-200 px-4 py-3 text-sm text-stone-500 dark:border-white/10">
                    在下方选择两个版本，即可滑动对比细节。
                  </p>
                ) : null}
                <VersionTimeline
                  asset={selectedAsset}
                  onActivate={(version) => void activateVersion(version)}
                  onContinue={continueFromVersion}
                  onDelete={(version) => void trashVersion(version)}
                  compareVersionIds={compareVersionIds}
                  onToggleCompare={toggleVersionComparison}
                />
              </div>
            </section>
          </div>
        ) : null}
      </div>
    </main>
  );
}
