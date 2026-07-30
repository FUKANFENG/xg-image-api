"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Archive, CalendarDays, ChevronLeft, ChevronRight, Copy, Download, Eraser, HardDrive, ImageIcon, ImageOff, LoaderCircle, Maximize2, Plus, RefreshCw, Search, Tag, Trash2, X } from "lucide-react";
import { toast } from "sonner";

import { DateRangeFilter } from "@/components/date-range-filter";
import { ImageLightbox } from "@/components/image-lightbox";
import { RuntimeImage } from "@/components/runtime-image";
import { InspirationCandidates } from "@/app/image-manager/inspiration-candidates";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { compressAllImages, deleteImageTag, deleteManagedImages, deleteToTarget, downloadImages, downloadSingleImage, fetchImageStorage, fetchImageTags, fetchManagedImages, setImageTags, type ImageStorageStats, type ManagedImage } from "@/lib/api";
import { useAuthGuard } from "@/lib/use-auth-guard";

const LONG_PRESS_MS = 800;
const IMAGE_MANAGER_CHECKBOX_CLASS = "border-stone-300 bg-white/80 dark:border-white/35 dark:bg-white/5 data-[state=checked]:border-stone-950 dark:data-[state=checked]:border-white";

function formatSize(size: number) {
  return size > 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(2)} MB` : `${Math.ceil(size / 1024)} KB`;
}

function imageKey(item: ManagedImage) {
  return item.rel || item.url;
}

function ManagedImagePreview({ item }: { item: ManagedImage }) {
  const initialSource = item.thumbnail_url || item.url;
  const [source, setSource] = useState(initialSource);
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <span className="flex size-full flex-col items-center justify-center gap-2 bg-stone-100 px-3 text-center text-xs text-stone-500 dark:bg-white/5 dark:text-stone-400" role="img" aria-label={`${item.name} 暂时无法预览`}>
        <ImageOff className="size-6" aria-hidden="true" />
        暂时无法预览
      </span>
    );
  }

  return (
    <RuntimeImage
      src={source}
      alt={item.name}
      className="h-full w-full object-cover transition duration-200 group-hover:scale-[1.02] motion-reduce:transition-none"
      onError={() => {
        if (source !== item.url) {
          setSource(item.url);
          return;
        }
        setFailed(true);
      }}
    />
  );
}

function useLongPress(onLongPress: () => void, ms = LONG_PRESS_MS) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeRef = useRef(false);

  const start = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    activeRef.current = true;
    timerRef.current = setTimeout(() => {
      if (activeRef.current) {
        onLongPress();
      }
    }, ms);
  }, [onLongPress, ms]);

  const stop = useCallback(() => {
    activeRef.current = false;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  return {
    onMouseDown: start,
    onMouseUp: stop,
    onMouseLeave: stop,
    onTouchStart: start,
    onTouchEnd: stop,
  };
}

function ImageManagerContent() {
  const [items, setItems] = useState<ManagedImage[]>([]);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [appliedStartDate, setAppliedStartDate] = useState("");
  const [appliedEndDate, setAppliedEndDate] = useState("");
  const [lightboxIndex, setLightboxIndex] = useState(0);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [deleteStartDate, setDeleteStartDate] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<ManagedImage | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [allTags, setAllTags] = useState<string[]>([]);
  const [storage, setStorage] = useState<ImageStorageStats | null>(null);
  const [storageLoading, setStorageLoading] = useState(false);
  const [compressResult, setCompressResult] = useState<string>("");
  const [targetFreeMb, setTargetFreeMb] = useState(500);

  const loadStorage = useCallback(async () => {
    try {
      setStorageLoading(true);
      const data = await fetchImageStorage();
      setStorage(data);
    } catch { /* ignore */ }
    finally { setStorageLoading(false); }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadStorage(); }, 0);
    return () => window.clearTimeout(timer);
  }, [loadStorage]);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [tagEditTarget, setTagEditTarget] = useState<ManagedImage | null>(null);
  const [tagInput, setTagInput] = useState("");
  const [dialogVisible, setDialogVisible] = useState(false);
  const deleteTargetRef = useRef<ManagedImage | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [deleteMode, setDeleteMode] = useState<"selected" | "filtered" | "byDate" | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);
  const [lastQueryMs, setLastQueryMs] = useState<number | null>(null);

  const filteredItems = selectedTags.length > 0
    ? items.filter((item) => selectedTags.every((t) => (item.tags ?? []).includes(t)))
    : items;

  const lightboxImages = filteredItems.map((item) => ({
    id: item.name,
    src: item.url,
    sizeLabel: formatSize(item.size),
    dimensions: item.width && item.height ? `${item.width} x ${item.height}` : undefined,
  }));
  const pageSize = 12;
  const pageCount = Math.max(1, Math.ceil(filteredItems.length / pageSize));
  const safePage = Math.min(page, pageCount);
  const currentRows = filteredItems.slice((safePage - 1) * pageSize, safePage * pageSize);
  const selectedSet = useMemo(() => new Set(selectedPaths), [selectedPaths]);
  const selectedCount = deleteMode === "filtered" ? items.length : deleteMode === "byDate" ? 0 : selectedPaths.length;
  const currentPageSelected = currentRows.length > 0 && currentRows.every((item) => selectedSet.has(imageKey(item)));
  const allSelected = filteredItems.length > 0 && filteredItems.every((item) => selectedSet.has(imageKey(item)));

  const loadImages = useCallback(async () => {
    const startedAt = performance.now();
    setIsLoading(true);
    try {
      const [data, tagsData] = await Promise.all([
        fetchManagedImages({ start_date: appliedStartDate, end_date: appliedEndDate }),
        fetchImageTags(),
      ]);
      setItems(data.items);
      setAllTags(tagsData.tags);
      setSelectedPaths((current) => current.filter((path) => data.items.some((item) => imageKey(item) === path)));
      setPage(1);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "加载图片失败");
    } finally {
      setLastQueryMs(performance.now() - startedAt);
      setIsLoading(false);
    }
  }, [appliedEndDate, appliedStartDate]);

  const closeDialog = useCallback(() => {
    setDialogVisible(false);
    setTimeout(() => setDeleteTarget(null), 200);
  }, []);

  const openDeleteDialog = useCallback((item: ManagedImage) => {
    deleteTargetRef.current = item;
    setDeleteTarget(item);
    setDialogVisible(true);
  }, []);

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setIsDeleting(true);
    try {
      await deleteManagedImages({ paths: [deleteTarget.rel] });
      setItems((prev) => prev.filter((item) => item.rel !== deleteTarget.rel));
      setSelectedPaths((prev) => prev.filter((p) => p !== imageKey(deleteTarget)));
      toast.success("图片已删除");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除失败");
    } finally {
      setIsDeleting(false);
      closeDialog();
    }
  };

  const handleSetTags = async (item: ManagedImage, tags: string[]) => {
    try {
      const result = await setImageTags(item.rel, tags);
      setItems((prev) => prev.map((i) => i.rel === item.rel ? { ...i, tags: result.tags } : i));
      const tagsData = await fetchImageTags();
      setAllTags(tagsData.tags);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "设置标签失败");
    }
  };

  const handleAddTag = (item: ManagedImage) => {
    const tag = tagInput.trim();
    if (!tag) return;
    const current = item.tags ?? [];
    if (current.includes(tag)) {
      toast.error("标签已存在");
      return;
    }
    void handleSetTags(item, [...current, tag]);
    setTagInput("");
  };

  const handleRemoveTag = (item: ManagedImage, tag: string) => {
    void handleSetTags(item, (item.tags ?? []).filter((t) => t !== tag));
  };

  const toggleFilterTag = (tag: string) => {
    setSelectedTags((prev) => prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]);
    setPage(1);
  };

  const [pressingTag, setPressingTag] = useState<string | null>(null);
  const pressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [tagDeleteTarget, setTagDeleteTarget] = useState<string | null>(null);

  const handleDeleteTag = async (tag: string) => {
    try {
      const result = await deleteImageTag(tag);
      setAllTags((prev) => prev.filter((t) => t !== tag));
      setSelectedTags((prev) => prev.filter((t) => t !== tag));
      setItems((prev) => prev.map((item) => ({
        ...item,
        tags: (item.tags ?? []).filter((t) => t !== tag),
      })));
      toast.success(`标签"${tag}"已删除，影响 ${result.removed_from} 张图片`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除标签失败");
    }
  };

  const startTagPress = useCallback((tag: string) => {
    setPressingTag(tag);
    pressTimerRef.current = setTimeout(() => {
      setPressingTag(null);
      setTagDeleteTarget(tag);
    }, LONG_PRESS_MS);
  }, []);

  const stopTagPress = useCallback(() => {
    setPressingTag(null);
    if (pressTimerRef.current) {
      clearTimeout(pressTimerRef.current);
      pressTimerRef.current = null;
    }
  }, []);

  const clearFilters = () => {
    setStartDate("");
    setEndDate("");
    setSelectedTags([]);
    setPage(1);
    if (!appliedStartDate && !appliedEndDate) {
      void loadImages();
      return;
    }
    setAppliedStartDate("");
    setAppliedEndDate("");
  };

  const dateRangeDirty = startDate !== appliedStartDate || endDate !== appliedEndDate;

  const applyDateRange = () => {
    setPage(1);
    if (!dateRangeDirty) {
      void loadImages();
      return;
    }
    setAppliedStartDate(startDate);
    setAppliedEndDate(endDate);
  };

  const togglePaths = (paths: string[], checked: boolean) => {
    setSelectedPaths((current) => checked ? Array.from(new Set([...current, ...paths])) : current.filter((path) => !paths.includes(path)));
  };

  const confirmDelete = async () => {
    if (!deleteMode || selectedCount === 0) return;
    setIsDeleting(true);
    try {
      const data = await deleteManagedImages(deleteMode === "filtered" ? { start_date: appliedStartDate, end_date: appliedEndDate, all_matching: true } : { paths: selectedPaths });
      toast.success(`已删除 ${data.removed} 张图片`);
      setDeleteMode(null);
      setSelectedPaths([]);
      await loadImages();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除图片失败");
    } finally {
      setIsDeleting(false);
    }
  };

  const handleBatchDownload = async () => {
    const paths = deleteMode === "filtered" ? items.map((item) => item.rel) : selectedPaths;
    if (paths.length === 0) return;
    setIsDownloading(true);
    try {
      await downloadImages(paths);
      toast.success(`已下载 ${paths.length} 张图片`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "下载失败");
    } finally {
      setIsDownloading(false);
    }
  };

  const handleSingleDownload = async (item: ManagedImage) => {
    await downloadSingleImage(item.rel);
  };

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadImages(); }, 0);
    return () => window.clearTimeout(timer);
  }, [loadImages]);

  return (
    <section className="space-y-5">
      <header className="flex flex-col gap-3 border-b border-stone-200/80 pb-5 sm:flex-row sm:items-end sm:justify-between dark:border-white/10">
        <div className="flex items-start gap-3">
          <div className="grid size-11 shrink-0 place-items-center rounded-2xl bg-violet-100 text-violet-700 shadow-sm dark:bg-violet-400/15 dark:text-violet-200">
            <ImageIcon className="size-5" aria-hidden="true" />
          </div>
          <div>
            <div className="text-xs font-semibold tracking-[0.18em] text-stone-500 uppercase">Media Library</div>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight text-stone-950 dark:text-stone-50">图片管理</h1>
            <p className="mt-1 text-sm leading-6 text-stone-500 dark:text-stone-400">集中审阅、标记、下载和清理已生成图片。</p>
          </div>
        </div>
        <div className="flex items-center gap-2 text-sm text-stone-500 dark:text-stone-400">
          <span className="rounded-full bg-stone-100 px-3 py-1.5 font-medium tabular-nums dark:bg-white/10">{isLoading && items.length === 0 ? "正在查询" : `${filteredItems.length} 张图片`}</span>
          {selectedPaths.length > 0 ? <span className="rounded-full bg-violet-50 px-3 py-1.5 font-medium text-violet-700 tabular-nums dark:bg-violet-400/15 dark:text-violet-200">已选 {selectedPaths.length} 张</span> : null}
        </div>
      </header>

      <InspirationCandidates />

      <Card className="rounded-2xl border-white/80 bg-white/90 shadow-sm dark:border-white/10 dark:bg-white/5">
        <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-stone-800 dark:text-stone-100">浏览筛选</div>
            <p className="mt-1 text-xs leading-5 text-stone-500 dark:text-stone-400">按日期和标签缩小图片范围；日期变更后点击查询，不会重复请求。</p>
            <p className="mt-1 text-xs text-stone-400" aria-live="polite">
              {isLoading ? "正在读取图片索引…" : dateRangeDirty ? "日期范围已修改，点击查询后生效" : lastQueryMs !== null ? `上次查询 ${(lastQueryMs / 1000).toFixed(2)} 秒` : ""}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <DateRangeFilter startDate={startDate} endDate={endDate} onChange={(start, end) => { setStartDate(start); setEndDate(end); }} />
            <Button variant="outline" onClick={clearFilters} className="h-10 rounded-xl border-stone-200 bg-white px-4 text-stone-700 hover:bg-stone-50 dark:border-white/15 dark:bg-white/5 dark:text-stone-200">
              清除
            </Button>
            <Button onClick={applyDateRange} disabled={isLoading} className="h-10 rounded-xl bg-violet-700 px-4 text-white shadow-sm shadow-violet-700/15 hover:bg-violet-800 dark:bg-violet-500 dark:hover:bg-violet-400">
              {isLoading ? <LoaderCircle className="size-4 animate-spin" /> : <Search className="size-4" />}
              {isLoading ? "查询中" : dateRangeDirty ? "应用查询" : "重新查询"}
            </Button>
            <Button variant="outline" onClick={() => setDeleteMode("filtered")} disabled={isDeleting || items.length === 0 || dateRangeDirty || (!appliedStartDate && !appliedEndDate)} className="h-10 rounded-xl border-rose-200 bg-white px-4 text-rose-600 hover:bg-rose-50 dark:border-rose-400/30 dark:bg-white/5 dark:text-rose-300">
              <Trash2 className="size-4" />
              删除日期结果
            </Button>
          </div>
        </CardContent>
      </Card>

      {allTags.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-stone-500">
            <Tag className="mr-1 inline size-3.5" />
            标签筛选：
          </span>
          {allTags.map((tag) => {
            const isPressing = pressingTag === tag;
            return (
              <span
                key={tag}
                className="relative inline-flex items-center"
                onMouseDown={() => startTagPress(tag)}
                onMouseUp={stopTagPress}
                onMouseLeave={stopTagPress}
                onTouchStart={() => startTagPress(tag)}
                onTouchEnd={stopTagPress}
              >
                <button
                  type="button"
                  onClick={() => toggleFilterTag(tag)}
                >
                  <Badge
                    variant={selectedTags.includes(tag) ? "default" : "outline"}
                    className={`cursor-pointer rounded-md transition-all hover:opacity-80 ${isPressing ? "ring-2 ring-red-400 ring-offset-1" : ""}`}
                  >
                    {tag}
                  </Badge>
                </button>
                {isPressing ? (
                  <span className="pointer-events-none absolute inset-0 overflow-hidden rounded-md">
                    <span className="absolute inset-0 animate-[grow_800ms_linear_forwards] rounded-md bg-red-400/20" />
                  </span>
                ) : null}
              </span>
            );
          })}
          {selectedTags.length > 0 ? (
            <button type="button" onClick={() => setSelectedTags([])}>
              <Badge variant="secondary" className="cursor-pointer rounded-md">
                <X className="mr-0.5 size-3" />
                清除
              </Badge>
            </button>
          ) : null}
        </div>
      ) : null}

      <section className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <div className="text-sm font-semibold text-stone-800 dark:text-stone-100">存储概览</div>
            <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">查看磁盘余量，必要时执行压缩或清理。</p>
          </div>
          {compressResult ? <span className="text-xs font-medium text-emerald-700 dark:text-emerald-300">{compressResult}</span> : null}
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {storage ? (
          <>
            <div className="rounded-2xl border border-stone-200/80 bg-white/80 p-4 shadow-sm dark:border-white/10 dark:bg-white/5">
              <HardDrive className="mb-3 size-4 text-stone-400" aria-hidden="true" />
              <div className="text-xs font-medium text-stone-500">磁盘总量</div>
              <div className="mt-1 text-xl font-semibold text-stone-900 tabular-nums dark:text-stone-100">{storage.disk_total_mb >= 1024 ? `${(storage.disk_total_mb / 1024).toFixed(1)} GB` : `${storage.disk_total_mb} MB`}</div>
            </div>
            <div className="rounded-2xl border border-stone-200/80 bg-white/80 p-4 shadow-sm dark:border-white/10 dark:bg-white/5">
              <HardDrive className={`mb-3 size-4 ${storage.disk_free_mb < 200 ? "text-rose-500" : storage.disk_free_mb < 500 ? "text-amber-500" : "text-emerald-600"}`} aria-hidden="true" />
              <div className="text-xs font-medium text-stone-500">剩余空间</div>
              <div className={`mt-1 text-xl font-semibold tabular-nums ${storage.disk_free_mb < 200 ? "text-rose-600" : storage.disk_free_mb < 500 ? "text-amber-600" : "text-emerald-700 dark:text-emerald-300"}`}>{storage.disk_free_mb >= 1024 ? `${(storage.disk_free_mb / 1024).toFixed(1)} GB` : `${storage.disk_free_mb} MB`}</div>
            </div>
            <div className="rounded-2xl border border-stone-200/80 bg-white/80 p-4 shadow-sm dark:border-white/10 dark:bg-white/5">
              <ImageIcon className="mb-3 size-4 text-violet-600 dark:text-violet-300" aria-hidden="true" />
              <div className="text-xs font-medium text-stone-500">当前可用图片</div>
              <div className="mt-1 text-xl font-semibold text-stone-900 tabular-nums dark:text-stone-100">{isLoading ? "…" : items.length}</div>
              <div className="mt-1 text-[11px] text-stone-400">
                {!appliedStartDate && !appliedEndDate && !isLoading
                  ? `磁盘文件 ${storage.image_count}，异常文件不展示`
                  : "随当前日期查询更新"}
              </div>
            </div>
            <div className="rounded-2xl border border-stone-200/80 bg-white/80 p-4 shadow-sm dark:border-white/10 dark:bg-white/5">
              <Archive className="mb-3 size-4 text-stone-400" aria-hidden="true" />
              <div className="text-xs font-medium text-stone-500">图片占用</div>
              <div className="mt-1 text-xl font-semibold text-stone-900 tabular-nums dark:text-stone-100">{storage.image_size_mb >= 1024 ? `${(storage.image_size_mb / 1024).toFixed(1)} GB` : `${storage.image_size_mb} MB`}</div>
            </div>
            <div className="rounded-2xl border border-stone-200/80 bg-white/80 p-4 shadow-sm sm:col-span-2 xl:col-span-4 dark:border-white/10 dark:bg-white/5">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <div className="text-sm font-semibold text-stone-800 dark:text-stone-100">存储维护</div>
                  <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">删除操作不可恢复，请先确认筛选范围。</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" variant="outline" className="h-9 rounded-xl border-stone-200 bg-white text-xs dark:border-white/15 dark:bg-white/5" disabled={storageLoading} onClick={() => { void loadStorage(); }}>
                    <RefreshCw className={`size-3.5 ${storageLoading ? "animate-spin" : ""}`} />刷新信息
                  </Button>
                  <Button size="sm" variant="outline" className="h-9 rounded-xl border-stone-200 bg-white text-xs dark:border-white/15 dark:bg-white/5"
                    onClick={async () => {
                      try { const r = await compressAllImages(); setCompressResult(`已压缩 ${r.saved_mb} MB`); void loadStorage(); }
                      catch { setCompressResult("压缩失败，请稍后重试"); }
                    }}>
                    <Archive className="size-3.5" />压缩优化
                  </Button>
                  <Button size="sm" variant="outline" className="h-9 rounded-xl border-rose-200 bg-white text-xs text-rose-600 hover:bg-rose-50 dark:border-rose-400/30 dark:bg-white/5 dark:text-rose-300"
                    onClick={() => setDeleteMode("byDate")}>
                    <Trash2 className="size-3.5" />按日期删除
                  </Button>
                  <form onSubmit={async (e) => { e.preventDefault();
                    try {
                      const r = await deleteToTarget(targetFreeMb);
                      toast.success(`已删除 ${r.removed} 张图片，释放 ${r.freed_mb ?? 0} MB`);
                      void loadStorage();
                      void loadImages();
                    } catch { toast.error("清理失败"); }
                  }} className="flex items-center gap-2">
                    <Input className="h-9 w-20 rounded-xl text-center text-xs tabular-nums" type="number" min={50} value={targetFreeMb}
                      onChange={(e) => setTargetFreeMb(Number(e.target.value) || 500)} aria-label="目标剩余磁盘空间（MB）" />
                    <Button size="sm" variant="outline" className="h-9 rounded-xl border-amber-200 bg-white text-xs text-amber-700 hover:bg-amber-50 dark:border-amber-400/30 dark:bg-white/5 dark:text-amber-300" type="submit" title="删除较早图片，直到达到目标剩余空间">
                      <Eraser className="size-3.5" />清理到目标余量
                    </Button>
                  </form>
                </div>
              </div>
            </div>
          </>
        ) : (
          <div className="rounded-2xl border border-stone-200 bg-white/80 p-6 text-center text-sm text-stone-400 sm:col-span-2 xl:col-span-4">
            {storageLoading ? "加载存储信息..." : "存储信息加载失败"}
          </div>
        )}
        </div>
      </section>

      {/* Delete by date dialog */}
      <Dialog open={deleteMode === "byDate"} onOpenChange={() => setDeleteMode(null)}>
        <DialogContent className="sm:max-w-md rounded-2xl">
          <DialogHeader><DialogTitle>按日期删除图片</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <label className="text-sm text-stone-600 shrink-0">删除</label>
              <Input className="h-9 text-sm" type="date" value={deleteStartDate} onChange={(e) => setDeleteStartDate(e.target.value)} />
              <span className="text-sm text-stone-400">之前的图片</span>
            </div>
            <p className="text-xs text-stone-500">此操作不可撤销，将永久删除所有匹配日期的图片及其缩略图。</p>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteMode(null)}>取消</Button>
            <Button variant="destructive" disabled={!deleteStartDate || isDeleting}
              onClick={async () => {
                if (!deleteStartDate) return;
                try {
                  setIsDeleting(true);
                  const r = await deleteManagedImages({ end_date: deleteStartDate, all_matching: true });
                  toast.success(`已删除 ${r.removed} 张图片`);
                  setDeleteMode(null);
                  void loadStorage();
                  void loadImages();
                } catch { toast.error("删除失败"); }
                finally { setIsDeleting(false); }
              }}>
              {isDeleting ? <LoaderCircle className="size-4 animate-spin" /> : null}
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Card className="overflow-hidden rounded-2xl border-white/80 bg-white/90 shadow-sm dark:border-white/10 dark:bg-white/5">
        <CardContent className="p-0">
          <div className="flex flex-col gap-3 border-b border-stone-100 px-4 py-4 dark:border-white/10 sm:px-5 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-stone-600 dark:text-stone-300">
              <span className="inline-flex items-center gap-2 font-semibold text-stone-800 dark:text-stone-100"><ImageIcon className="size-4 text-violet-600 dark:text-violet-300" />作品画廊</span>
              <span className="tabular-nums" aria-live="polite">{isLoading && items.length === 0 ? "正在查询…" : `共 ${filteredItems.length} 张`}</span>
              {selectedTags.length > 0 ? <span className="text-stone-400">（筛选自 {items.length} 张）</span> : null}
              <label className="flex min-h-9 items-center gap-2">
                <Checkbox aria-label="选择本页全部图片" className={IMAGE_MANAGER_CHECKBOX_CLASS} checked={currentPageSelected} onCheckedChange={(checked) => togglePaths(currentRows.map(imageKey), Boolean(checked))} />
                本页全选
              </label>
              <label className="flex min-h-9 items-center gap-2">
                <Checkbox aria-label="选择筛选结果全部图片" className={IMAGE_MANAGER_CHECKBOX_CLASS} checked={allSelected} onCheckedChange={(checked) => togglePaths(filteredItems.map(imageKey), Boolean(checked))} />
                全选结果
              </label>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="ghost" className="h-9 rounded-xl px-3 text-stone-500 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-white/10" onClick={() => void loadImages()} disabled={isLoading}>
                <RefreshCw className={`size-4 ${isLoading ? "animate-spin" : ""}`} />
                刷新
              </Button>
              <button type="button" className="min-h-9 rounded-lg px-2 text-sm text-stone-500 transition hover:text-stone-900 disabled:text-stone-300 dark:text-stone-300 dark:hover:text-white" onClick={() => setSelectedPaths([])} disabled={selectedPaths.length === 0 || isDeleting}>
                取消选择
              </button>
              <Button variant="outline" className="h-9 rounded-xl border-stone-200 bg-white px-3 text-stone-600 hover:bg-stone-50 dark:border-white/15 dark:bg-white/5 dark:text-stone-200" onClick={() => void handleBatchDownload()} disabled={selectedPaths.length === 0 || isDownloading || isDeleting}>
                {isDownloading ? <LoaderCircle className="size-4 animate-spin" /> : <Download className="size-4" />}
                下载所选
              </Button>
              <Button variant="outline" className="h-9 rounded-xl border-rose-200 bg-white px-3 text-rose-600 hover:bg-rose-50 dark:border-rose-400/30 dark:bg-white/5 dark:text-rose-300" onClick={() => setDeleteMode("selected")} disabled={selectedPaths.length === 0 || isDeleting}>
                <Trash2 className="size-4" />
                删除所选
              </Button>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 p-3 sm:grid-cols-3 sm:p-4 xl:grid-cols-4 2xl:grid-cols-5">
            {isLoading && items.length === 0
              ? Array.from({ length: 10 }, (_, index) => (
                  <div key={`image-skeleton-${index}`} className="aspect-[4/5] animate-pulse rounded-2xl border border-stone-200/80 bg-stone-100 dark:border-white/10 dark:bg-white/5 motion-reduce:animate-none" aria-hidden="true" />
                ))
              : null}
            {currentRows.map((item) => {
              const imageIndex = filteredItems.findIndex((row) => row.url === item.url);
              return (
              <article key={item.rel} className="group rounded-2xl border border-stone-200/80 bg-white p-2.5 shadow-sm transition duration-200 hover:-translate-y-0.5 hover:border-stone-300 hover:shadow-md dark:border-white/10 dark:bg-white/5 dark:hover:border-white/20">
                <div className="relative">
                  <button
                    type="button"
                    className="relative block aspect-square w-full cursor-zoom-in overflow-hidden rounded-xl bg-stone-100 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2 dark:bg-white/10 dark:focus-visible:ring-offset-stone-950"
                    onClick={() => {
                      setLightboxIndex(imageIndex);
                      setLightboxOpen(true);
                    }}
                  >
                    <ManagedImagePreview key={item.thumbnail_url || item.url} item={item} />
                    <span className="absolute right-2 bottom-2 rounded-full bg-black/55 p-2 text-white opacity-100 transition sm:opacity-0 sm:group-hover:opacity-100">
                      <Maximize2 className="size-4" />
                    </span>
                  </button>
                  <button
                    type="button"
                    className="absolute top-2 right-2 z-10 inline-flex size-7 items-center justify-center rounded-full bg-black/50 text-white opacity-100 transition hover:bg-red-600 sm:opacity-0 sm:group-hover:opacity-100"
                    title="删除图片"
                    aria-label={`删除图片 ${item.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      openDeleteDialog(item);
                    }}
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
                <div className="mt-3 space-y-2 px-0.5 text-xs text-stone-500 dark:text-stone-400">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0 truncate font-medium text-stone-700 dark:text-stone-200">
                      <CalendarDays className="size-3.5" />
                      {item.created_at}
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8 rounded-lg text-stone-400 hover:bg-stone-100 hover:text-stone-700"
                        onClick={() => void handleSingleDownload(item)}
                        title="下载图片"
                        aria-label={`下载图片 ${item.name}`}
                      >
                        <Download className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8 rounded-lg text-stone-400 hover:bg-stone-100 hover:text-stone-700"
                        onClick={() => {
                          void navigator.clipboard.writeText(item.url);
                          toast.success("图片地址已复制");
                        }}
                        aria-label={`复制图片 ${item.name} 的地址`}
                      >
                        <Copy className="size-4" />
                      </Button>
                      <Checkbox aria-label={`选择图片 ${item.name}`} className={IMAGE_MANAGER_CHECKBOX_CLASS} checked={selectedSet.has(imageKey(item))} onCheckedChange={(checked) => togglePaths([imageKey(item)], Boolean(checked))} />
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span>{formatSize(item.size)}</span>
                    <span>{item.width && item.height ? `${item.width} x ${item.height}` : "-"}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-1">
                    {(item.tags ?? []).map((tag) => (
                      <Badge key={tag} variant="secondary" className="gap-0.5 rounded-md py-0 pr-0.5 text-[10px]">
                        {tag}
                        <button
                          type="button"
                          className="inline-flex size-3.5 items-center justify-center rounded-full hover:bg-stone-300"
                          onClick={() => handleRemoveTag(item, tag)}
                          aria-label={`移除标签 ${tag}`}
                        >
                          <X className="size-2.5" />
                        </button>
                      </Badge>
                    ))}
                    <Popover open={tagEditTarget?.rel === item.rel} onOpenChange={(open) => { setTagEditTarget(open ? item : null); setTagInput(""); }}>
                      <PopoverTrigger asChild>
                        <button
                          type="button"
                          className="inline-flex size-5 items-center justify-center rounded-full border border-dashed border-stone-300 text-stone-400 hover:border-stone-500 hover:text-stone-600"
                          title="添加标签"
                          aria-label="添加标签"
                        >
                          <Plus className="size-3" />
                        </button>
                      </PopoverTrigger>
                      <PopoverContent align="start" className="w-56 p-2">
                        <div className="space-y-2">
                          <div className="text-xs font-medium text-stone-500">添加标签</div>
                          <div className="flex gap-1">
                            <Input
                              value={tagInput}
                              onChange={(e) => setTagInput(e.target.value)}
                              placeholder="输入标签名"
                              className="h-8 text-xs"
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  e.preventDefault();
                                  handleAddTag(item);
                                }
                              }}
                            />
                            <Button
                              size="icon"
                              variant="outline"
                              className="size-8 shrink-0"
                              onClick={() => handleAddTag(item)}
                            >
                              <Plus className="size-3.5" />
                            </Button>
                          </div>
                          {allTags.filter((t) => !(item.tags ?? []).includes(t)).length > 0 ? (
                            <div className="flex flex-wrap gap-1 border-t border-stone-100 pt-2">
                              {allTags.filter((t) => !(item.tags ?? []).includes(t)).map((tag) => (
                                <button
                                  key={tag}
                                  type="button"
                                  onClick={() => {
                                    void handleSetTags(item, [...(item.tags ?? []), tag]);
                                    setTagEditTarget(null);
                                  }}
                                >
                                  <Badge variant="outline" className="cursor-pointer rounded-md text-[10px] hover:bg-stone-100">
                                    {tag}
                                  </Badge>
                                </button>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      </PopoverContent>
                    </Popover>
                  </div>
                </div>
              </article>
            )})}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-stone-100 px-4 py-3 text-sm text-stone-500 dark:border-white/10 dark:text-stone-400">
            <span className="tabular-nums">第 {safePage} / {pageCount} 页 · 共 {filteredItems.length} 张</span>
            <div className="flex items-center gap-2">
            <Button variant="outline" size="icon" className="size-9 rounded-xl border-stone-200 bg-white dark:border-white/15 dark:bg-white/5" disabled={safePage <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>
              <ChevronLeft className="size-4" />
            </Button>
            <Button variant="outline" size="icon" className="size-9 rounded-xl border-stone-200 bg-white dark:border-white/15 dark:bg-white/5" disabled={safePage >= pageCount} onClick={() => setPage((value) => Math.min(pageCount, value + 1))}>
              <ChevronRight className="size-4" />
            </Button>
            </div>
          </div>
          {!isLoading && filteredItems.length === 0 ? <div className="px-6 py-14 text-center text-sm text-stone-500">没有找到图片</div> : null}
        </CardContent>
      </Card>

      <Dialog open={dialogVisible} onOpenChange={(open) => { if (!open) closeDialog(); }}>
        <DialogContent className="max-w-sm overflow-hidden rounded-2xl">
          <DialogHeader>
            <DialogTitle className="pr-8">确认删除</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-stone-600">
            确定要删除这张图片吗？此操作不可恢复。
          </p>
          {deleteTarget ? (
            <div className="flex items-center gap-3 overflow-hidden rounded-xl border border-stone-200 bg-stone-50 p-3">
              <RuntimeImage
                src={deleteTarget.thumbnail_url || deleteTarget.url}
                alt=""
                className="size-16 shrink-0 rounded-lg object-cover"
                onError={(e) => { if (e.currentTarget.src !== deleteTarget.url) e.currentTarget.src = deleteTarget.url; }}
              />
              <div className="min-w-0 overflow-hidden text-xs text-stone-500">
                <div className="truncate font-medium text-stone-700">{deleteTarget.name}</div>
                <div className="truncate">{deleteTarget.created_at}</div>
                <div>{formatSize(deleteTarget.size)}</div>
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={closeDialog} className="rounded-xl">
              取消
            </Button>
            <Button variant="destructive" onClick={() => void handleDelete()} disabled={isDeleting} className="rounded-xl">
              {isDeleting ? <LoaderCircle className="mr-1 size-4 animate-spin" /> : <Trash2 className="mr-1 size-4" />}
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ImageLightbox
        images={lightboxImages}
        currentIndex={lightboxIndex}
        open={lightboxOpen}
        onOpenChange={setLightboxOpen}
        onIndexChange={setLightboxIndex}
      />
      <Dialog open={deleteMode === "selected" || deleteMode === "filtered"} onOpenChange={(open) => (!open ? setDeleteMode(null) : null)}>
        <DialogContent showCloseButton={false} className="rounded-2xl p-6">
          <DialogHeader className="gap-2">
            <DialogTitle>{deleteMode === "filtered" ? "删除匹配日期的图片" : "删除所选图片"}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-stone-600">
            确认删除 {selectedCount} 张图片吗？删除后无法恢复。
          </p>
          <DialogFooter>
            <Button variant="outline" className="rounded-xl" onClick={() => setDeleteMode(null)} disabled={isDeleting}>
              取消
            </Button>
            <Button className="rounded-xl bg-rose-600 text-white hover:bg-rose-700" onClick={() => void confirmDelete()} disabled={isDeleting || selectedCount === 0}>
              {isDeleting ? <LoaderCircle className="size-4 animate-spin" /> : null}
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={Boolean(tagDeleteTarget)} onOpenChange={(open) => { if (!open) setTagDeleteTarget(null); }}>
        <DialogContent className="max-w-sm rounded-2xl">
          <DialogHeader>
            <DialogTitle>删除标签</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-stone-600">
            确定要删除标签 <span className="font-semibold">「{tagDeleteTarget}」</span> 吗？将从所有图片中移除该标签。
          </p>
          <DialogFooter>
            <Button variant="outline" className="rounded-xl" onClick={() => setTagDeleteTarget(null)}>
              取消
            </Button>
            <Button
              variant="destructive"
              className="rounded-xl"
              onClick={() => {
                if (tagDeleteTarget) void handleDeleteTag(tagDeleteTarget);
                setTagDeleteTarget(null);
              }}
            >
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

export default function ImageManagerPage() {
  const { isCheckingAuth, session } = useAuthGuard(["admin"]);
  if (isCheckingAuth || !session || session.role !== "admin") {
    return <div className="flex min-h-[40vh] items-center justify-center"><LoaderCircle className="size-5 animate-spin text-stone-400" /></div>;
  }
  return <ImageManagerContent />;
}
