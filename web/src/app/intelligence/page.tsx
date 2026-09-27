"use client";

import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Bell,
  BellRing,
  Blocks,
  Box,
  Check,
  Download,
  FileArchive,
  FolderKanban,
  GitBranch,
  ImageDown,
  Images,
  LayoutDashboard,
  LoaderCircle,
  Mail,
  Maximize2,
  MousePointer2,
  Palette,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings2,
  Sparkles,
  Trash2,
  Upload,
  Webhook,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  addCreativeBoardItem,
  createCreativeBoard,
  createCreativeBranch,
  createCreativeDerivatives,
  deleteCreativeBoardItem,
  downloadProjectDelivery,
  fetchCreativeAsset,
  fetchAdminCreativeProjectBudget,
  fetchCreativeAssets,
  fetchCreativeBoard,
  fetchCreativeBoardDraft,
  fetchCreativeBoards,
  fetchCreativeBudgetProjects,
  fetchCreativeDerivatives,
  fetchCreativeNotificationSettings,
  fetchCreativeNotifications,
  fetchCreativeProjectBudget,
  fetchCreativeProjects,
  fetchCreativeQuality,
  fetchCreativeVersionTree,
  indexCreativeHistory,
  markCreativeNotificationsRead,
  queueCreativeQualityRanking,
  rankCreativeAssets,
  scoreCreativeQuality,
  semanticSearchCreativeAssets,
  testCreativeNotification,
  updateCreativeBoardItem,
  updateCreativeNotificationSettings,
  updateCreativeProjectBudget,
  uploadCreativeBoardItem,
  type CreativeAsset,
  type CreativeBoard,
  type CreativeBoardItem,
  type CreativeDerivative,
  type CreativeNotification,
  type CreativeNotificationSettings,
  type CreativeProject,
  type CreativeProjectBudget,
  type CreativeQualityReview,
  type CreativeVersionTree,
  type SemanticCreativeAsset,
} from "@/lib/api";
import { saveStudioPromptDraft } from "@/lib/creative-drafts";
import { useAuthGuard } from "@/lib/use-auth-guard";
import { cn } from "@/lib/utils";

type IntelligenceTab = "assets" | "board" | "notifications" | "delivery";

type RankedAsset = {
  asset_id: string;
  name: string;
  version_id: string;
  image_path: string;
  image_url: string;
  quality: CreativeQualityReview | null;
  overall: number;
};

type BudgetProject = {
  id: string;
  owner_id: string;
  name: string;
  description: string;
  asset_count: number;
  updated_at: string;
};

type DragSession = {
  item: CreativeBoardItem;
  node: HTMLElement;
  mode: "move" | "resize";
  startX: number;
  startY: number;
  nextX: number;
  nextY: number;
  nextWidth: number;
  nextHeight: number;
};

const derivativeOptions: Array<{
  value: CreativeDerivative["preset"];
  label: string;
  size: string;
}> = [
  { value: "xiaohongshu", label: "小红书", size: "1080 × 1440" },
  { value: "ecommerce", label: "电商主图", size: "1200 × 1200" },
  { value: "wechat", label: "公众号封面", size: "900 × 383" },
  { value: "poster", label: "竖版海报", size: "1080 × 1920" },
];

const qualityLabels: Array<
  [keyof NonNullable<CreativeQualityReview["scores"]>, string]
> = [
  ["overall", "综合"],
  ["text", "文字"],
  ["anatomy", "手部人体"],
  ["face", "面部"],
  ["brand", "Logo"],
  ["composition", "构图"],
];

const notificationEvents = [
  ["task.success", "生成成功"],
  ["task.failed", "生成失败"],
  ["batch.completed", "批次完成"],
  ["budget.warning", "预算预警"],
  ["storage.missing", "存储缺失"],
] as const;

function assetImage(
  asset?:
    | CreativeAsset
    | SemanticCreativeAsset
    | RankedAsset
    | CreativeDerivative
    | null,
) {
  if (!asset) return "";
  const value = !("asset_id" in asset)
    ? asset.current_image_url ||
      (asset.current_image_path ? `/images/${asset.current_image_path}` : "")
    : asset.image_url ||
      (asset.image_path ? `/images/${asset.image_path}` : "");
  if (!value) return "";
  return /^(https?:|data:|blob:)/.test(value)
    ? value
    : value.startsWith("/")
      ? value
      : `/${value}`;
}

function formatDuration(value?: number) {
  if (!value) return "暂无";
  return value < 1000 ? `${value} ms` : `${(value / 1000).toFixed(1)} 秒`;
}

function statusText(status?: CreativeQualityReview["status"]) {
  if (status === "ready") return "质检完成";
  if (status === "running" || status === "pending") return "正在质检";
  if (status === "retryable_failed") return "质检失败，可重试";
  return "尚未质检";
}

function Surface({
  className,
  children,
}: React.PropsWithChildren<{ className?: string }>) {
  return (
    <section
      className={cn(
        "min-w-0 rounded-xl border border-stone-200/80 bg-white shadow-[0_10px_34px_rgba(41,37,36,0.05)] sm:rounded-2xl dark:border-white/10 dark:bg-stone-950 dark:shadow-none",
        className,
      )}
    >
      {children}
    </section>
  );
}

export default function IntelligencePage() {
  const router = useRouter();
  const { isCheckingAuth, session } = useAuthGuard(["user", "admin"]);
  const [tab, setTab] = useState<IntelligenceTab>("assets");
  const [isLoading, setIsLoading] = useState(true);
  const [assets, setAssets] = useState<CreativeAsset[]>([]);
  const [projects, setProjects] = useState<CreativeProject[]>([]);
  const [selectedAsset, setSelectedAsset] = useState<CreativeAsset | null>(
    null,
  );
  const [quality, setQuality] = useState<CreativeQualityReview | null>(null);
  const [derivatives, setDerivatives] = useState<CreativeDerivative[]>([]);
  const [versionTree, setVersionTree] = useState<CreativeVersionTree | null>(
    null,
  );
  const [semanticQuery, setSemanticQuery] = useState("");
  const [semanticResults, setSemanticResults] = useState<
    SemanticCreativeAsset[]
  >([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isIndexing, setIsIndexing] = useState(false);
  const [isScoring, setIsScoring] = useState(false);
  const [rankedAssets, setRankedAssets] = useState<RankedAsset[]>([]);
  const [isRanking, setIsRanking] = useState(false);
  const [selectedPresets, setSelectedPresets] = useState<
    CreativeDerivative["preset"][]
  >(["xiaohongshu", "ecommerce", "wechat", "poster"]);
  const [derivativeMode, setDerivativeMode] =
    useState<CreativeDerivative["mode"]>("contain");
  const [isDeriving, setIsDeriving] = useState(false);
  const [branchName, setBranchName] = useState("");
  const [isCreatingBranch, setIsCreatingBranch] = useState(false);

  const [boards, setBoards] = useState<CreativeBoard[]>([]);
  const [board, setBoard] = useState<CreativeBoard | null>(null);
  const [newBoardName, setNewBoardName] = useState("");
  const [newBoardText, setNewBoardText] = useState("");
  const [boardColor, setBoardColor] = useState("#7c3aed");
  const [isSavingBoard, setIsSavingBoard] = useState(false);
  const boardInputRef = useRef<HTMLInputElement>(null);
  const boardCanvasRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragSession | null>(null);

  const [notifications, setNotifications] = useState<CreativeNotification[]>(
    [],
  );
  const [notificationSettings, setNotificationSettings] =
    useState<CreativeNotificationSettings | null>(null);
  const [isSavingNotifications, setIsSavingNotifications] = useState(false);

  const [budgetProjects, setBudgetProjects] = useState<BudgetProject[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [budget, setBudget] = useState<CreativeProjectBudget | null>(null);
  const [budgetLimit, setBudgetLimit] = useState(100);
  const [budgetType, setBudgetType] = useState<
    "project" | "department" | "client"
  >("project");
  const [budgetLabel, setBudgetLabel] = useState("");
  const [budgetWarning, setBudgetWarning] = useState(80);
  const [budgetUnitCost, setBudgetUnitCost] = useState(0);
  const [isSavingBudget, setIsSavingBudget] = useState(false);
  const rankPollRef = useRef<number | null>(null);

  const loadAssetDetails = useCallback(async (assetId: string) => {
    const [asset, qualityResult, derivativeResult, tree] = await Promise.all([
      fetchCreativeAsset(assetId),
      fetchCreativeQuality(assetId),
      fetchCreativeDerivatives(assetId),
      fetchCreativeVersionTree(assetId),
    ]);
    setSelectedAsset(asset);
    setQuality(qualityResult);
    setDerivatives(derivativeResult.items);
    setVersionTree(tree);
  }, []);

  const loadNotifications = useCallback(async () => {
    const result = await fetchCreativeNotifications(50);
    setNotifications(result.items);
    if (typeof window === "undefined" || !("Notification" in window)) return;
    if (Notification.permission !== "granted") return;
    const newestUnread = result.items.find((item) => !item.read);
    if (!newestUnread) return;
    const lastShown = window.localStorage.getItem(
      "xg:last-browser-notification",
    );
    if (lastShown === newestUnread.id) return;
    new Notification(newestUnread.title, { body: newestUnread.message });
    window.localStorage.setItem(
      "xg:last-browser-notification",
      newestUnread.id,
    );
  }, []);

  const refreshRank = useCallback(async () => {
    if (!assets.length) return [];
    const result = await rankCreativeAssets(assets.map((item) => item.id));
    setRankedAssets(result.items);
    return result.items;
  }, [assets]);

  useEffect(() => {
    if (!session) return;
    let active = true;
    const load = async () => {
      setIsLoading(true);
      try {
        const [
          assetPage,
          projectResult,
          boardResult,
          settingsResult,
          notificationResult,
        ] = await Promise.all([
          fetchCreativeAssets({ limit: 200 }),
          fetchCreativeProjects(),
          fetchCreativeBoards(),
          fetchCreativeNotificationSettings(),
          fetchCreativeNotifications(50),
        ]);
        if (!active) return;
        setAssets(assetPage.items);
        setProjects(projectResult.items);
        setBoards(boardResult.items);
        setNotificationSettings(settingsResult);
        setNotifications(notificationResult.items);
        const queryAsset =
          new URLSearchParams(window.location.search).get("asset") || "";
        const initialAsset =
          assetPage.items.find((item) => item.id === queryAsset) ||
          assetPage.items[0];
        if (initialAsset) await loadAssetDetails(initialAsset.id);
        const queryProject =
          new URLSearchParams(window.location.search).get("project") || "";
        setSelectedProjectId(
          projectResult.items.some((item) => item.id === queryProject)
            ? queryProject
            : projectResult.items[0]?.id || "",
        );
        if (boardResult.items[0]) {
          setBoard(await fetchCreativeBoard(boardResult.items[0].id));
        }
        if (session.role === "admin") {
          const adminProjects = await fetchCreativeBudgetProjects();
          if (active) {
            setBudgetProjects(adminProjects.items);
            if (!queryProject && !projectResult.items.length) {
              setSelectedProjectId(adminProjects.items[0]?.id || "");
            }
          }
        }
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "智能资产工作台加载失败",
        );
      } finally {
        if (active) setIsLoading(false);
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [loadAssetDetails, session]);

  useEffect(() => {
    if (!session) return;
    const timer = window.setInterval(() => void loadNotifications(), 30_000);
    return () => window.clearInterval(timer);
  }, [loadNotifications, session]);

  useEffect(() => {
    return () => {
      if (rankPollRef.current) window.clearInterval(rankPollRef.current);
    };
  }, []);

  useEffect(() => {
    if (!selectedProjectId || !session) {
      return;
    }
    const requestBudget =
      session.role === "admin"
        ? fetchAdminCreativeProjectBudget(selectedProjectId)
        : fetchCreativeProjectBudget(selectedProjectId);
    void requestBudget
      .then((result) => {
        setBudget(result);
        if (result.configured === false) return;
        setBudgetLimit(result.credit_limit || 0);
        setBudgetType(result.budget_type || "project");
        setBudgetLabel(result.label || "");
        setBudgetWarning(result.warning_percent || 80);
        setBudgetUnitCost(result.unit_cost || 0);
      })
      .catch((error) =>
        toast.error(error instanceof Error ? error.message : "预算读取失败"),
      );
  }, [selectedProjectId, session]);

  const visibleAssets = useMemo(() => {
    if (semanticResults.length) return semanticResults;
    return assets;
  }, [assets, semanticResults]);

  const selectedProject = useMemo(
    () =>
      projects.find((item) => item.id === selectedProjectId) ||
      budgetProjects.find((item) => item.id === selectedProjectId),
    [budgetProjects, projects, selectedProjectId],
  );

  const handleSemanticSearch = async () => {
    const query = semanticQuery.trim();
    if (!query) {
      setSemanticResults([]);
      return;
    }
    setIsSearching(true);
    try {
      const result = await semanticSearchCreativeAssets(query, { limit: 80 });
      setSemanticResults(result.items);
      if (!result.items.length)
        toast.info("没有找到相近作品，可先补建历史索引");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "语义搜索失败");
    } finally {
      setIsSearching(false);
    }
  };

  const handleIndexHistory = async () => {
    setIsIndexing(true);
    try {
      const result = await indexCreativeHistory(1000);
      toast.success(
        `索引完成 ${result.indexed.length} 张，失败 ${result.failed.length} 张`,
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "历史索引失败");
    } finally {
      setIsIndexing(false);
    }
  };

  const handleScoreSelected = async () => {
    if (!selectedAsset) return;
    setIsScoring(true);
    try {
      const result = await scoreCreativeQuality(selectedAsset.id);
      setQuality(result);
      toast[result.status === "ready" ? "success" : "error"](
        result.status === "ready"
          ? "图片质检完成"
          : result.error || "图片质检失败",
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "图片质检失败");
    } finally {
      setIsScoring(false);
    }
  };

  const handleAutoPick = async () => {
    if (!assets.length) return;
    setIsRanking(true);
    try {
      const result = await queueCreativeQualityRanking(
        assets.map((item) => item.id),
      );
      toast.success(
        `已排队 ${result.queued.length} 张，已有结果 ${result.skipped.length} 张，不可分析 ${result.failed.length} 项`,
      );
      await refreshRank();
      if (rankPollRef.current) window.clearInterval(rankPollRef.current);
      let attempts = 0;
      rankPollRef.current = window.setInterval(() => {
        attempts += 1;
        void refreshRank().then((items) => {
          const pending = items.some(
            (item) =>
              item.quality?.status === "pending" ||
              item.quality?.status === "running",
          );
          if (!pending || attempts >= 24) {
            if (rankPollRef.current) window.clearInterval(rankPollRef.current);
            rankPollRef.current = null;
            setIsRanking(false);
          }
        });
      }, 5_000);
      if (!result.queued.length) setIsRanking(false);
    } catch (error) {
      setIsRanking(false);
      toast.error(error instanceof Error ? error.message : "自动挑图启动失败");
    }
  };

  const handleDerive = async () => {
    if (!selectedAsset || !selectedPresets.length) return;
    setIsDeriving(true);
    try {
      const result = await createCreativeDerivatives(selectedAsset.id, {
        presets: selectedPresets,
        mode: derivativeMode,
      });
      setDerivatives(result.items);
      toast.success(`已生成 ${result.items.length} 个平台尺寸`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "多尺寸衍生失败");
    } finally {
      setIsDeriving(false);
    }
  };

  const handleCreateBranch = async () => {
    if (!selectedAsset || !branchName.trim()) return;
    setIsCreatingBranch(true);
    try {
      await createCreativeBranch(selectedAsset.id, {
        name: branchName.trim(),
        root_version_id: selectedAsset.current_version_id || "",
      });
      setVersionTree(await fetchCreativeVersionTree(selectedAsset.id));
      setBranchName("");
      toast.success("版本分支已创建");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "版本分支创建失败");
    } finally {
      setIsCreatingBranch(false);
    }
  };

  const continueBranch = (branchId: string, versionId: string) => {
    if (!selectedAsset || !versionTree) return;
    const version = versionTree.nodes.find((item) => item.id === versionId);
    saveStudioPromptDraft({
      source: "intelligence",
      prompt:
        version?.prompt || "基于当前画面继续创作，保持主体和视觉风格一致。",
      assetId: selectedAsset.id,
      versionId,
      branchId,
      referenceUrl: assetImage({
        asset_id: selectedAsset.id,
        name: selectedAsset.name,
        version_id: versionId,
        image_path: version?.image_path || "",
        image_url: version?.image_url || "",
        quality: null,
        overall: -1,
      }),
    });
    router.push("/studio");
  };

  const createBoard = async () => {
    if (!newBoardName.trim()) return;
    setIsSavingBoard(true);
    try {
      const created = await createCreativeBoard({
        name: newBoardName.trim(),
        project_id: selectedProjectId,
      });
      setBoards((current) => [created, ...current]);
      setBoard(created);
      setNewBoardName("");
      toast.success("灵感画板已创建");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "画板创建失败");
    } finally {
      setIsSavingBoard(false);
    }
  };

  const replaceBoardItem = (item: CreativeBoardItem) => {
    setBoard((current) =>
      current
        ? {
            ...current,
            items: (current.items || []).map((existing) =>
              existing.id === item.id ? item : existing,
            ),
          }
        : current,
    );
  };

  const addBoardText = async () => {
    if (!board || !newBoardText.trim()) return;
    try {
      const item = await addCreativeBoardItem(board.id, {
        item_type: "text",
        content: newBoardText.trim(),
        image_path: "",
        image_url: "",
        x: 60,
        y: 60,
        width: 260,
        height: 150,
        z_index: (board.items?.length || 0) + 1,
        metadata: {},
      });
      setBoard({ ...board, items: [...(board.items || []), item] });
      setNewBoardText("");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "文字卡片添加失败");
    }
  };

  const addBoardColor = async () => {
    if (!board) return;
    try {
      const item = await addCreativeBoardItem(board.id, {
        item_type: "color",
        content: boardColor,
        image_path: "",
        image_url: "",
        x: 100,
        y: 100,
        width: 180,
        height: 120,
        z_index: (board.items?.length || 0) + 1,
        metadata: {},
      });
      setBoard({ ...board, items: [...(board.items || []), item] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "色板添加失败");
    }
  };

  const uploadBoardImage = async (file?: File) => {
    if (!board || !file) return;
    try {
      const item = await uploadCreativeBoardItem(board.id, file, {
        x: 140,
        y: 80,
      });
      setBoard({ ...board, items: [...(board.items || []), item] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "参考图上传失败");
    } finally {
      if (boardInputRef.current) boardInputRef.current.value = "";
    }
  };

  const removeBoardItem = async (itemId: string) => {
    if (!board) return;
    try {
      await deleteCreativeBoardItem(board.id, itemId);
      setBoard({
        ...board,
        items: (board.items || []).filter((item) => item.id !== itemId),
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "卡片删除失败");
    }
  };

  const beginBoardInteraction = (
    event: React.PointerEvent<HTMLButtonElement>,
    item: CreativeBoardItem,
    mode: DragSession["mode"],
  ) => {
    const node = boardCanvasRef.current?.querySelector<HTMLElement>(
      `[data-board-card="${item.id}"]`,
    );
    if (!node) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      item,
      node,
      mode,
      startX: event.clientX,
      startY: event.clientY,
      nextX: item.x,
      nextY: item.y,
      nextWidth: item.width,
      nextHeight: item.height,
    };
  };

  const moveBoardInteraction = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    if (drag.mode === "move") {
      drag.nextX = Math.max(0, drag.item.x + deltaX);
      drag.nextY = Math.max(0, drag.item.y + deltaY);
      drag.node.style.transform = `translate(${drag.nextX - drag.item.x}px, ${drag.nextY - drag.item.y}px)`;
    } else {
      drag.nextWidth = Math.max(100, Math.min(680, drag.item.width + deltaX));
      drag.nextHeight = Math.max(80, Math.min(480, drag.item.height + deltaY));
      drag.node.style.width = `${drag.nextWidth}px`;
      drag.node.style.height = `${drag.nextHeight}px`;
    }
  };

  const finishBoardInteraction = async () => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag || !board) return;
    drag.node.style.transform = "";
    try {
      const updated = await updateCreativeBoardItem(board.id, drag.item.id, {
        x: drag.nextX,
        y: drag.nextY,
        width: drag.nextWidth,
        height: drag.nextHeight,
      });
      replaceBoardItem(updated);
    } catch (error) {
      drag.node.style.width = `${drag.item.width}px`;
      drag.node.style.height = `${drag.item.height}px`;
      toast.error(error instanceof Error ? error.message : "画板位置保存失败");
    }
  };

  const sendBoardToStudio = async () => {
    if (!board) return;
    try {
      const draft = await fetchCreativeBoardDraft(board.id);
      if (!draft.prompt.trim()) {
        toast.info("请先在画板加入文字或色板说明");
        return;
      }
      saveStudioPromptDraft({
        source: "board",
        prompt: draft.prompt,
        referenceUrls: draft.references
          .map((item) => item.url || `/images/${item.path}`)
          .slice(0, 4),
      });
      router.push("/studio");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "画板内容带入失败");
    }
  };

  const requestBrowserNotifications = async () => {
    if (!("Notification" in window)) {
      toast.error("当前浏览器不支持系统通知");
      return;
    }
    const permission = await Notification.requestPermission();
    toast[permission === "granted" ? "success" : "info"](
      permission === "granted" ? "浏览器通知已启用" : "浏览器通知未授权",
    );
  };

  const saveNotificationSettings = async () => {
    if (!notificationSettings) return;
    setIsSavingNotifications(true);
    try {
      const updated =
        await updateCreativeNotificationSettings(notificationSettings);
      setNotificationSettings(updated);
      toast.success("通知设置已保存");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "通知设置保存失败");
    } finally {
      setIsSavingNotifications(false);
    }
  };

  const saveBudget = async () => {
    if (!selectedProjectId || session?.role !== "admin") return;
    const target = budgetProjects.find((item) => item.id === selectedProjectId);
    const ownerId = target?.owner_id || session.subjectId;
    setIsSavingBudget(true);
    try {
      const updated = await updateCreativeProjectBudget(selectedProjectId, {
        owner_id: ownerId,
        credit_limit: budgetLimit,
        budget_type: budgetType,
        label: budgetLabel,
        warning_percent: budgetWarning,
        unit_cost: budgetUnitCost,
        enabled: true,
      });
      setBudget(updated);
      toast.success("项目预算已更新");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "项目预算更新失败");
    } finally {
      setIsSavingBudget(false);
    }
  };

  if (isCheckingAuth || !session || isLoading) {
    return (
      <main className="mx-auto w-full max-w-[1440px] px-4 py-8 sm:px-6">
        <div className="h-28 animate-pulse rounded-2xl bg-stone-200/70 dark:bg-white/10" />
        <div className="mt-5 grid gap-5 lg:grid-cols-[1.1fr_0.9fr]">
          <div className="h-[560px] animate-pulse rounded-2xl bg-stone-100 dark:bg-white/5" />
          <div className="h-[560px] animate-pulse rounded-2xl bg-stone-100 dark:bg-white/5" />
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-[100dvh] min-w-0 bg-stone-50/70 px-0 py-3 text-stone-950 sm:px-6 sm:py-8 dark:bg-stone-950 dark:text-stone-50">
      <div className="mx-auto w-full max-w-[1440px]">
        <header className="rounded-xl border border-stone-200/80 bg-white px-4 py-4 shadow-[0_10px_34px_rgba(41,37,36,0.05)] sm:rounded-2xl sm:px-7 sm:py-6 dark:border-white/10 dark:bg-stone-950 dark:shadow-none">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <div className="mb-3 inline-flex items-center gap-2 text-sm font-semibold text-violet-700 dark:text-violet-300">
                <Sparkles className="size-4" />
                智能资产工作台
              </div>
              <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
                从成片筛选到项目交付
              </h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-stone-600 dark:text-stone-300">
                统一管理质量检测、语义搜索、平台尺寸、版本分支、灵感画板、通知和项目预算。
              </p>
            </div>
            <div className="grid grid-cols-3 gap-2 text-center sm:flex sm:gap-3">
              {[
                [String(assets.length), "作品"],
                [
                  String(
                    rankedAssets.filter((item) => item.overall >= 0).length,
                  ),
                  "已质检",
                ],
                [
                  String(notifications.filter((item) => !item.read).length),
                  "未读通知",
                ],
              ].map(([value, label]) => (
                <div
                  key={label}
                  className="min-w-0 rounded-xl bg-stone-100 px-2 py-2 sm:min-w-24 sm:px-3 dark:bg-white/8"
                >
                  <div className="text-lg font-bold tabular-nums">{value}</div>
                  <div className="text-xs text-stone-500 dark:text-stone-400">
                    {label}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </header>

        <Tabs
          value={tab}
          onValueChange={(value) => setTab(value as IntelligenceTab)}
          className="mt-5"
        >
          <div className="min-w-0 max-w-full pb-1 sm:overflow-x-auto">
            <TabsList className="grid h-auto w-full min-w-0 grid-cols-2 gap-1 rounded-xl border border-stone-200 bg-white p-1 group-data-[orientation=horizontal]/tabs:h-auto sm:inline-flex sm:h-12 sm:w-auto sm:min-w-max sm:group-data-[orientation=horizontal]/tabs:h-12 dark:border-white/10 dark:bg-stone-900">
              <TabsTrigger
                value="assets"
                className="h-11 rounded-lg px-2 text-xs sm:h-10 sm:px-4 sm:text-sm data-[state=active]:bg-violet-700 data-[state=active]:text-white"
              >
                <Images /> 智能资产
              </TabsTrigger>
              <TabsTrigger
                value="board"
                className="h-11 rounded-lg px-2 text-xs sm:h-10 sm:px-4 sm:text-sm data-[state=active]:bg-violet-700 data-[state=active]:text-white"
              >
                <Palette /> 灵感画板
              </TabsTrigger>
              <TabsTrigger
                value="notifications"
                className="h-11 rounded-lg px-2 text-xs sm:h-10 sm:px-4 sm:text-sm data-[state=active]:bg-violet-700 data-[state=active]:text-white"
              >
                <Bell /> 完成通知
              </TabsTrigger>
              <TabsTrigger
                value="delivery"
                className="h-11 rounded-lg px-2 text-xs sm:h-10 sm:px-4 sm:text-sm data-[state=active]:bg-violet-700 data-[state=active]:text-white"
              >
                <FileArchive /> 预算交付
              </TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="assets" className="mt-3 space-y-5">
            <Surface className="p-4 sm:p-5">
              <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto_auto]">
                <label className="relative block">
                  <span className="sr-only">语义搜索历史作品</span>
                  <Search className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-stone-400" />
                  <input
                    value={semanticQuery}
                    onChange={(event) => setSemanticQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void handleSemanticSearch();
                    }}
                    placeholder="例如：雨夜城市蓝色海报"
                    className="h-11 w-full rounded-xl border border-stone-200 bg-stone-50 pl-11 pr-4 text-sm text-stone-900 outline-none transition placeholder:text-stone-500 focus:border-violet-500 focus:ring-2 focus:ring-violet-200 dark:border-white/10 dark:bg-white/5 dark:text-white dark:focus:ring-violet-500/30"
                  />
                </label>
                <Button
                  onClick={() => void handleSemanticSearch()}
                  disabled={isSearching}
                  className="h-11 rounded-xl bg-violet-700 px-5 text-white hover:bg-violet-800"
                >
                  {isSearching ? (
                    <LoaderCircle className="animate-spin" />
                  ) : (
                    <Search />
                  )}
                  搜索
                </Button>
                <Button
                  variant="outline"
                  onClick={() => void handleIndexHistory()}
                  disabled={isIndexing}
                  className="h-11 rounded-xl border-stone-200 bg-white px-5 dark:border-white/15 dark:bg-stone-900"
                >
                  {isIndexing ? (
                    <LoaderCircle className="animate-spin" />
                  ) : (
                    <RefreshCw />
                  )}
                  补建历史索引
                </Button>
              </div>
            </Surface>

            {rankedAssets.length ? (
              <Surface className="overflow-hidden">
                <div className="flex items-center justify-between gap-3 border-b border-stone-100 px-5 py-4 dark:border-white/10">
                  <div>
                    <h2 className="font-semibold">AI 推荐顺序</h2>
                    <p className="mt-1 text-xs text-stone-500">
                      综合文字、手部、面部、Logo 和构图结果排序
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void refreshRank()}
                    className="rounded-lg"
                  >
                    <RefreshCw /> 刷新
                  </Button>
                </div>
                <div className="flex gap-3 overflow-x-auto p-4">
                  {rankedAssets.slice(0, 12).map((item, index) => (
                    <button
                      type="button"
                      key={item.asset_id}
                      onClick={() => void loadAssetDetails(item.asset_id)}
                      className="group min-w-48 overflow-hidden rounded-xl border border-stone-200 bg-stone-50 text-left transition hover:border-violet-300 active:scale-[0.98] dark:border-white/10 dark:bg-white/5"
                    >
                      <div className="relative aspect-[4/3] overflow-hidden bg-stone-200 dark:bg-stone-800">
                        {assetImage(item) ? (
                          <Image
                            src={assetImage(item)}
                            alt={item.name}
                            fill
                            unoptimized
                            className="object-cover transition duration-300 group-hover:scale-[1.02]"
                          />
                        ) : null}
                      </div>
                      <div className="flex items-center justify-between gap-2 p-3">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-semibold">
                            {index + 1}. {item.name}
                          </div>
                          <div className="mt-0.5 text-xs text-stone-500">
                            {statusText(item.quality?.status)}
                          </div>
                        </div>
                        <span className="text-xl font-bold tabular-nums text-violet-700 dark:text-violet-300">
                          {item.overall >= 0 ? item.overall : "-"}
                        </span>
                      </div>
                    </button>
                  ))}
                </div>
              </Surface>
            ) : null}

            <div className="grid min-w-0 grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1.08fr)_minmax(420px,0.92fr)]">
              <Surface className="min-w-0 overflow-hidden">
                <div className="flex flex-col gap-3 border-b border-stone-100 px-5 py-4 sm:flex-row sm:items-center sm:justify-between dark:border-white/10">
                  <div>
                    <h2 className="font-semibold">作品库</h2>
                    <p className="mt-1 text-xs text-stone-500">
                      {semanticResults.length
                        ? `语义命中 ${semanticResults.length} 项`
                        : `共 ${assets.length} 项`}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    {semanticResults.length ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setSemanticResults([]);
                          setSemanticQuery("");
                        }}
                        className="rounded-lg"
                      >
                        清除搜索
                      </Button>
                    ) : null}
                    <Button
                      onClick={() => void handleAutoPick()}
                      disabled={isRanking || !assets.length}
                      size="sm"
                      className="rounded-lg bg-violet-700 text-white hover:bg-violet-800"
                    >
                      {isRanking ? (
                        <LoaderCircle className="animate-spin" />
                      ) : (
                        <Sparkles />
                      )}
                      批量质检排序
                    </Button>
                  </div>
                </div>
                <div className="grid max-h-[760px] min-w-0 grid-cols-2 gap-2 overflow-y-auto p-3 sm:grid-cols-3 sm:gap-3 sm:p-4">
                  {visibleAssets.map((item) => {
                    const id = "asset_id" in item ? item.asset_id : item.id;
                    return (
                      <button
                        type="button"
                        key={id}
                        onClick={() => void loadAssetDetails(id)}
                        className={cn(
                              "group min-w-0 overflow-hidden rounded-xl border bg-stone-50 text-left transition active:scale-[0.98] dark:bg-white/5",
                          selectedAsset?.id === id
                            ? "border-violet-500 ring-2 ring-violet-100 dark:ring-violet-500/20"
                            : "border-stone-200 hover:border-violet-300 dark:border-white/10",
                        )}
                      >
                        <div className="relative aspect-square overflow-hidden bg-stone-200 dark:bg-stone-800">
                          {assetImage(item) ? (
                            <Image
                              src={assetImage(item)}
                              alt={item.name}
                              fill
                              unoptimized
                              className="object-cover transition duration-300 group-hover:scale-[1.02]"
                            />
                          ) : (
                            <Images className="absolute inset-0 m-auto size-8 text-stone-400" />
                          )}
                        </div>
                        <div className="p-3">
                          <div className="line-clamp-1 text-sm font-semibold">
                            {item.name}
                          </div>
                          {"semantic_score" in item ? (
                            <div className="mt-1 text-xs font-medium text-violet-700 dark:text-violet-300">
                              相似度 {Math.round(item.semantic_score * 100)}%
                            </div>
                          ) : (
                            <div className="mt-1 text-xs text-stone-500">
                              V
                              {item.current_version_number ||
                                item.versions?.length ||
                                0}
                            </div>
                          )}
                        </div>
                      </button>
                    );
                  })}
                  {!visibleAssets.length ? (
                    <div className="col-span-full grid min-h-72 place-items-center rounded-xl border border-dashed border-stone-200 text-center dark:border-white/10">
                      <div>
                        <Images className="mx-auto size-8 text-stone-400" />
                        <p className="mt-3 text-sm font-medium">
                          暂无可分析作品
                        </p>
                        <p className="mt-1 text-xs text-stone-500">
                          先在创作台生成或归档图片
                        </p>
                      </div>
                    </div>
                  ) : null}
                </div>
              </Surface>

              <div className="space-y-5">
                <Surface className="overflow-hidden">
                  {selectedAsset ? (
                    <>
                      <div className="relative aspect-[16/9] overflow-hidden bg-stone-200 dark:bg-stone-800">
                        {assetImage(selectedAsset) ? (
                          <Image
                            src={assetImage(selectedAsset)}
                            alt={selectedAsset.name}
                            fill
                            unoptimized
                            className="object-contain"
                          />
                        ) : null}
                      </div>
                      <div className="p-5">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <h2 className="truncate text-lg font-semibold">
                              {selectedAsset.name}
                            </h2>
                            <p className="mt-1 text-xs text-stone-500">
                              {statusText(quality?.status)}
                            </p>
                          </div>
                          <Button
                            onClick={() => void handleScoreSelected()}
                            disabled={isScoring}
                            size="sm"
                            className="shrink-0 rounded-lg bg-violet-700 text-white hover:bg-violet-800"
                          >
                            {isScoring ? (
                              <LoaderCircle className="animate-spin" />
                            ) : (
                              <Sparkles />
                            )}
                            {quality?.status === "ready"
                              ? "重新质检"
                              : "AI 质检"}
                          </Button>
                        </div>
                        <div className="mt-4 grid grid-cols-3 gap-2">
                          {qualityLabels.map(([key, label]) => (
                            <div
                              key={key}
                              className="rounded-xl bg-stone-100 px-3 py-2.5 dark:bg-white/7"
                            >
                              <div className="text-lg font-bold tabular-nums">
                                {quality?.scores?.[key] ?? "-"}
                              </div>
                              <div className="text-[11px] text-stone-500">
                                {label}
                              </div>
                            </div>
                          ))}
                        </div>
                        {quality?.issues?.length ? (
                          <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900 dark:border-rose-400/20 dark:bg-rose-400/10 dark:text-rose-100">
                            <div className="font-semibold">需处理</div>
                            <div className="mt-1 leading-6">
                              {quality.issues.join("；")}
                            </div>
                          </div>
                        ) : null}
                        {quality?.recommendation ? (
                          <p className="mt-3 text-sm leading-6 text-stone-600 dark:text-stone-300">
                            建议：{quality.recommendation}
                          </p>
                        ) : null}
                        {quality?.error ? (
                          <p className="mt-3 text-sm text-rose-700 dark:text-rose-300">
                            {quality.error}
                          </p>
                        ) : null}
                      </div>
                    </>
                  ) : (
                    <div className="grid min-h-96 place-items-center text-sm text-stone-500">
                      选择一张作品查看详情
                    </div>
                  )}
                </Surface>

                <Surface className="p-5">
                  <div className="flex items-center gap-2">
                    <ImageDown className="size-5 text-violet-700 dark:text-violet-300" />
                    <h2 className="font-semibold">一键多尺寸</h2>
                  </div>
                  <div className="mt-4 grid grid-cols-2 gap-2">
                    {derivativeOptions.map((option) => {
                      const active = selectedPresets.includes(option.value);
                      return (
                        <button
                          type="button"
                          key={option.value}
                          onClick={() =>
                            setSelectedPresets((current) =>
                              active
                                ? current.filter(
                                    (item) => item !== option.value,
                                  )
                                : [...current, option.value],
                            )
                          }
                          className={cn(
                            "rounded-xl border p-3 text-left transition active:scale-[0.98]",
                            active
                              ? "border-violet-500 bg-violet-50 dark:bg-violet-400/10"
                              : "border-stone-200 bg-white dark:border-white/10 dark:bg-white/5",
                          )}
                        >
                          <div className="flex items-center justify-between gap-2 text-sm font-semibold">
                            {option.label}
                            {active ? (
                              <Check className="size-4 text-violet-700 dark:text-violet-300" />
                            ) : null}
                          </div>
                          <div className="mt-1 text-xs text-stone-500">
                            {option.size}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2 rounded-xl bg-stone-100 p-1 dark:bg-white/7">
                    {(["contain", "cover"] as const).map((mode) => (
                      <button
                        type="button"
                        key={mode}
                        onClick={() => setDerivativeMode(mode)}
                        className={cn(
                          "h-9 rounded-lg text-sm font-medium transition",
                          derivativeMode === mode
                            ? "bg-white text-violet-700 shadow-sm dark:bg-stone-800 dark:text-violet-300"
                            : "text-stone-500",
                        )}
                      >
                        {mode === "contain" ? "完整保留" : "铺满裁切"}
                      </button>
                    ))}
                  </div>
                  <Button
                    onClick={() => void handleDerive()}
                    disabled={
                      !selectedAsset || !selectedPresets.length || isDeriving
                    }
                    className="mt-3 h-11 w-full rounded-xl bg-violet-700 text-white hover:bg-violet-800"
                  >
                    {isDeriving ? (
                      <LoaderCircle className="animate-spin" />
                    ) : (
                      <Maximize2 />
                    )}
                    生成平台尺寸
                  </Button>
                  {derivatives.length ? (
                    <div className="mt-4 grid grid-cols-2 gap-2">
                      {derivatives.map((item) => (
                        <a
                          key={item.id}
                          href={assetImage(item)}
                          download
                          className="group overflow-hidden rounded-xl border border-stone-200 dark:border-white/10"
                        >
                          <div className="relative aspect-[4/3] bg-stone-100 dark:bg-stone-800">
                            <Image
                              src={assetImage(item)}
                              alt={item.label}
                              fill
                              unoptimized
                              className="object-cover"
                            />
                          </div>
                          <div className="flex items-center justify-between gap-2 p-2 text-xs font-medium">
                            <span className="truncate">{item.label}</span>
                            <Download className="size-3.5 text-violet-700 dark:text-violet-300" />
                          </div>
                        </a>
                      ))}
                    </div>
                  ) : null}
                </Surface>

                <Surface className="p-5">
                  <div className="flex items-center gap-2">
                    <GitBranch className="size-5 text-violet-700 dark:text-violet-300" />
                    <h2 className="font-semibold">版本分支树</h2>
                  </div>
                  <div className="mt-3 flex gap-2">
                    <input
                      value={branchName}
                      onChange={(event) => setBranchName(event.target.value)}
                      placeholder="例如：暖色商业版"
                      className="h-10 min-w-0 flex-1 rounded-xl border border-stone-200 bg-stone-50 px-3 text-sm outline-none focus:border-violet-500 dark:border-white/10 dark:bg-white/5"
                    />
                    <Button
                      onClick={() => void handleCreateBranch()}
                      disabled={
                        !branchName.trim() || !selectedAsset || isCreatingBranch
                      }
                      size="sm"
                      className="h-10 rounded-xl bg-violet-700 text-white hover:bg-violet-800"
                    >
                      {isCreatingBranch ? (
                        <LoaderCircle className="animate-spin" />
                      ) : (
                        <Plus />
                      )}
                      新分支
                    </Button>
                  </div>
                  <div className="mt-4 space-y-2">
                    {versionTree?.branches.map((branch) => (
                      <div
                        key={branch.id}
                        className="rounded-xl border border-stone-200 p-3 dark:border-white/10"
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <div className="truncate text-sm font-semibold">
                              {branch.name}
                            </div>
                            <div className="mt-1 text-xs text-stone-500">
                              {
                                versionTree.nodes.filter(
                                  (item) => item.branch_id === branch.id,
                                ).length
                              }{" "}
                              个分支版本
                            </div>
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() =>
                              continueBranch(branch.id, branch.head_version_id)
                            }
                            className="shrink-0 rounded-lg"
                          >
                            <Send /> 继续创作
                          </Button>
                        </div>
                      </div>
                    ))}
                    {!versionTree?.branches.length ? (
                      <p className="rounded-xl bg-stone-100 p-3 text-sm text-stone-500 dark:bg-white/7">
                        当前只有主线，可从当前版本创建第一个方向。
                      </p>
                    ) : null}
                  </div>
                </Surface>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="board" className="mt-3">
            <div className="grid min-w-0 grid-cols-1 gap-5 xl:grid-cols-[280px_minmax(0,1fr)]">
              <Surface className="p-4">
                <h2 className="font-semibold">灵感画板</h2>
                <div className="mt-3 flex gap-2">
                  <input
                    value={newBoardName}
                    onChange={(event) => setNewBoardName(event.target.value)}
                    placeholder="新画板名称"
                    className="h-10 min-w-0 flex-1 rounded-xl border border-stone-200 bg-stone-50 px-3 text-sm outline-none focus:border-violet-500 dark:border-white/10 dark:bg-white/5"
                  />
                  <Button
                    size="icon"
                    onClick={() => void createBoard()}
                    disabled={!newBoardName.trim() || isSavingBoard}
                    className="size-10 rounded-xl bg-violet-700 text-white hover:bg-violet-800"
                  >
                    {isSavingBoard ? (
                      <LoaderCircle className="animate-spin" />
                    ) : (
                      <Plus />
                    )}
                  </Button>
                </div>
                <div className="mt-4 space-y-2">
                  {boards.map((item) => (
                    <button
                      type="button"
                      key={item.id}
                      onClick={() =>
                        void fetchCreativeBoard(item.id).then(setBoard)
                      }
                      className={cn(
                        "w-full rounded-xl border p-3 text-left transition active:scale-[0.98]",
                        board?.id === item.id
                          ? "border-violet-500 bg-violet-50 dark:bg-violet-400/10"
                          : "border-stone-200 hover:border-violet-300 dark:border-white/10",
                      )}
                    >
                      <div className="truncate text-sm font-semibold">
                        {item.name}
                      </div>
                      <div className="mt-1 text-xs text-stone-500">
                        {item.item_count || 0} 个素材
                      </div>
                    </button>
                  ))}
                  {!boards.length ? (
                    <p className="rounded-xl bg-stone-100 p-3 text-sm text-stone-500 dark:bg-white/7">
                      创建画板后即可组合图片、文字和色板。
                    </p>
                  ) : null}
                </div>
              </Surface>

              <Surface className="min-w-0 overflow-hidden">
                <div className="border-b border-stone-100 p-4 dark:border-white/10">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                    <div>
                      <h2 className="font-semibold">
                        {board?.name || "选择或创建画板"}
                      </h2>
                      <p className="mt-1 text-xs text-stone-500">
                        拖动卡片调整位置，右下角拖动可改变尺寸
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <input
                        ref={boardInputRef}
                        type="file"
                        accept="image/png,image/jpeg,image/webp"
                        className="hidden"
                        onChange={(event) =>
                          void uploadBoardImage(event.target.files?.[0])
                        }
                      />
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!board}
                        onClick={() => boardInputRef.current?.click()}
                        className="rounded-lg"
                      >
                        <Upload /> 上传参考图
                      </Button>
                      <div className="flex items-center gap-1 rounded-lg border border-stone-200 p-1 dark:border-white/10">
                        <input
                          type="color"
                          value={boardColor}
                          onChange={(event) =>
                            setBoardColor(event.target.value)
                          }
                          aria-label="选择色板颜色"
                          className="size-7 cursor-pointer rounded border-0 bg-transparent p-0"
                        />
                        <button
                          type="button"
                          disabled={!board}
                          onClick={() => void addBoardColor()}
                          className="h-7 rounded-md px-2 text-xs font-medium text-stone-600 transition hover:bg-stone-100 disabled:opacity-40 dark:text-stone-300 dark:hover:bg-white/10"
                        >
                          加色板
                        </button>
                      </div>
                      <Button
                        size="sm"
                        disabled={!board}
                        onClick={() => void sendBoardToStudio()}
                        className="rounded-lg bg-violet-700 text-white hover:bg-violet-800"
                      >
                        <Send /> 带入创作台
                      </Button>
                    </div>
                  </div>
                  <div className="mt-3 flex gap-2">
                    <input
                      value={newBoardText}
                      onChange={(event) => setNewBoardText(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") void addBoardText();
                      }}
                      placeholder="输入画面关键词、文案或创作要求"
                      disabled={!board}
                      className="h-10 min-w-0 flex-1 rounded-xl border border-stone-200 bg-stone-50 px-3 text-sm outline-none focus:border-violet-500 disabled:opacity-50 dark:border-white/10 dark:bg-white/5"
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!board || !newBoardText.trim()}
                      onClick={() => void addBoardText()}
                      className="h-10 rounded-xl"
                    >
                      <Plus /> 文字卡
                    </Button>
                  </div>
                </div>
                <div
                  ref={boardCanvasRef}
                  onPointerMove={moveBoardInteraction}
                  onPointerUp={() => void finishBoardInteraction()}
                  onPointerCancel={() => void finishBoardInteraction()}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.preventDefault();
                    void uploadBoardImage(event.dataTransfer.files?.[0]);
                  }}
                  className="relative min-h-[620px] touch-none overflow-auto bg-[linear-gradient(rgba(120,113,108,0.08)_1px,transparent_1px),linear-gradient(90deg,rgba(120,113,108,0.08)_1px,transparent_1px)] bg-[size:28px_28px] dark:bg-[linear-gradient(rgba(255,255,255,0.05)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.05)_1px,transparent_1px)] dark:bg-[size:28px_28px]"
                >
                  {(board?.items || []).map((item) => (
                    <article
                      key={item.id}
                      data-board-card={item.id}
                      style={{
                        left: item.x,
                        top: item.y,
                        width: item.width,
                        height: item.height,
                        zIndex: item.z_index,
                      }}
                      className="absolute overflow-hidden rounded-xl border border-stone-200 bg-white shadow-[0_12px_30px_rgba(41,37,36,0.12)] dark:border-white/15 dark:bg-stone-900"
                    >
                      <button
                        type="button"
                        onPointerDown={(event) =>
                          beginBoardInteraction(event, item, "move")
                        }
                        className="absolute left-2 top-2 z-10 grid size-8 cursor-grab place-items-center rounded-lg bg-white/90 text-stone-700 shadow-sm backdrop-blur active:cursor-grabbing dark:bg-stone-900/90 dark:text-stone-200"
                        aria-label="拖动画板卡片"
                      >
                        <MousePointer2 className="size-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => void removeBoardItem(item.id)}
                        className="absolute right-2 top-2 z-10 grid size-8 place-items-center rounded-lg bg-white/90 text-stone-500 shadow-sm backdrop-blur hover:text-rose-600 dark:bg-stone-900/90"
                        aria-label="删除画板卡片"
                      >
                        <Trash2 className="size-4" />
                      </button>
                      {item.item_type === "image" ||
                      item.item_type === "reference" ? (
                        <div className="relative size-full bg-stone-100 dark:bg-stone-800">
                          <Image
                            src={assetImage({
                              asset_id: "",
                              version_id: "",
                              name: "",
                              image_path: item.image_path,
                              image_url: item.image_url,
                              quality: null,
                              overall: -1,
                            })}
                            alt="画板参考图"
                            fill
                            unoptimized
                            className="object-cover"
                          />
                        </div>
                      ) : item.item_type === "color" ? (
                        <div
                          className="flex size-full items-end p-4"
                          style={{ backgroundColor: item.content }}
                        >
                          <span className="rounded-lg bg-white/90 px-2 py-1 text-xs font-semibold text-stone-900 shadow-sm">
                            {item.content}
                          </span>
                        </div>
                      ) : (
                        <div className="flex size-full items-center p-5 pt-12 text-sm font-medium leading-6 text-stone-800 dark:text-stone-100">
                          {item.content}
                        </div>
                      )}
                      <button
                        type="button"
                        onPointerDown={(event) =>
                          beginBoardInteraction(event, item, "resize")
                        }
                        className="absolute bottom-1 right-1 z-10 grid size-8 cursor-nwse-resize place-items-center rounded-lg bg-white/90 text-stone-500 shadow-sm dark:bg-stone-900/90"
                        aria-label="调整画板卡片尺寸"
                      >
                        <Maximize2 className="size-4" />
                      </button>
                    </article>
                  ))}
                  {board && !board.items?.length ? (
                    <div className="absolute inset-0 grid place-items-center text-center text-stone-500">
                      <div>
                        <Palette className="mx-auto size-10" />
                        <p className="mt-3 text-sm font-medium">
                          拖入图片，或从上方添加文字和色板
                        </p>
                      </div>
                    </div>
                  ) : null}
                </div>
              </Surface>
            </div>
          </TabsContent>

          <TabsContent value="notifications" className="mt-3">
            <div className="grid min-w-0 grid-cols-1 gap-5 xl:grid-cols-[minmax(0,0.95fr)_minmax(420px,1.05fr)]">
              <Surface className="p-5">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h2 className="font-semibold">通知渠道</h2>
                    <p className="mt-1 text-xs text-stone-500">
                      站内通知默认开启，其他渠道按需配置
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void requestBrowserNotifications()}
                    className="rounded-lg"
                  >
                    <BellRing /> 浏览器授权
                  </Button>
                </div>
                {notificationSettings ? (
                  <div className="mt-5 space-y-4">
                    {[
                      [
                        "in_app",
                        "站内通知",
                        "工作台保存完整通知记录",
                        LayoutDashboard,
                      ],
                      [
                        "browser",
                        "浏览器通知",
                        "页面在后台时显示系统提醒",
                        BellRing,
                      ],
                      ["email", "邮件通知", "通过管理员配置的 SMTP 发送", Mail],
                      [
                        "webhook",
                        "Webhook",
                        "向业务系统发送标准 JSON",
                        Webhook,
                      ],
                      ["wecom", "企业微信", "发送到企业微信群机器人", Blocks],
                    ].map(([key, title, description, Icon]) => (
                      <label
                        key={String(key)}
                        className="flex cursor-pointer items-center justify-between gap-4 rounded-xl border border-stone-200 p-3 dark:border-white/10"
                      >
                        <span className="flex min-w-0 items-center gap-3">
                          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-violet-50 text-violet-700 dark:bg-violet-400/10 dark:text-violet-300">
                            <Icon className="size-4" />
                          </span>
                          <span className="min-w-0">
                            <span className="block text-sm font-semibold">
                              {String(title)}
                            </span>
                            <span className="mt-0.5 block text-xs text-stone-500">
                              {String(description)}
                            </span>
                          </span>
                        </span>
                        <input
                          type="checkbox"
                          checked={Boolean(
                            notificationSettings[
                              key as keyof CreativeNotificationSettings
                            ],
                          )}
                          onChange={(event) =>
                            setNotificationSettings({
                              ...notificationSettings,
                              [String(key)]: event.target.checked,
                            })
                          }
                          className="size-4 accent-violet-700"
                        />
                      </label>
                    ))}
                    <label className="block">
                      <span className="mb-2 block text-sm font-medium">
                        接收邮箱
                      </span>
                      <input
                        value={notificationSettings.email_to}
                        onChange={(event) =>
                          setNotificationSettings({
                            ...notificationSettings,
                            email_to: event.target.value,
                          })
                        }
                        placeholder="name@example.com"
                        className="h-10 w-full rounded-xl border border-stone-200 bg-stone-50 px-3 text-sm outline-none focus:border-violet-500 dark:border-white/10 dark:bg-white/5"
                      />
                    </label>
                    <label className="block">
                      <span className="mb-2 block text-sm font-medium">
                        Webhook 地址
                      </span>
                      <input
                        value={notificationSettings.webhook_url}
                        onChange={(event) =>
                          setNotificationSettings({
                            ...notificationSettings,
                            webhook_url: event.target.value,
                          })
                        }
                        placeholder="https://example.com/webhook"
                        className="h-10 w-full rounded-xl border border-stone-200 bg-stone-50 px-3 text-sm outline-none focus:border-violet-500 dark:border-white/10 dark:bg-white/5"
                      />
                    </label>
                    <label className="block">
                      <span className="mb-2 block text-sm font-medium">
                        企业微信机器人地址
                      </span>
                      <input
                        value={notificationSettings.wecom_url}
                        onChange={(event) =>
                          setNotificationSettings({
                            ...notificationSettings,
                            wecom_url: event.target.value,
                          })
                        }
                        placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?..."
                        className="h-10 w-full rounded-xl border border-stone-200 bg-stone-50 px-3 text-sm outline-none focus:border-violet-500 dark:border-white/10 dark:bg-white/5"
                      />
                    </label>
                    <div>
                      <div className="mb-2 text-sm font-medium">通知事件</div>
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        {notificationEvents.map(([event, label]) => {
                          const active =
                            notificationSettings.events.includes(event);
                          return (
                            <label
                              key={event}
                              className="flex cursor-pointer items-center gap-2 rounded-lg bg-stone-100 px-3 py-2 text-sm dark:bg-white/7"
                            >
                              <input
                                type="checkbox"
                                checked={active}
                                onChange={() =>
                                  setNotificationSettings({
                                    ...notificationSettings,
                                    events: active
                                      ? notificationSettings.events.filter(
                                          (item) => item !== event,
                                        )
                                      : [...notificationSettings.events, event],
                                  })
                                }
                                className="size-4 accent-violet-700"
                              />
                              {label}
                            </label>
                          );
                        })}
                      </div>
                    </div>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      <Button
                        variant="outline"
                        onClick={() =>
                          void testCreativeNotification()
                            .then(() => {
                              toast.success("测试通知已创建");
                              void loadNotifications();
                            })
                            .catch((error) =>
                              toast.error(
                                error instanceof Error
                                  ? error.message
                                  : "测试失败",
                              ),
                            )
                        }
                        className="rounded-xl"
                      >
                        <Send /> 发送测试
                      </Button>
                      <Button
                        onClick={() => void saveNotificationSettings()}
                        disabled={isSavingNotifications}
                        className="rounded-xl bg-violet-700 text-white hover:bg-violet-800"
                      >
                        {isSavingNotifications ? (
                          <LoaderCircle className="animate-spin" />
                        ) : (
                          <Settings2 />
                        )}
                        保存设置
                      </Button>
                    </div>
                  </div>
                ) : null}
              </Surface>

              <Surface className="overflow-hidden">
                <div className="flex items-center justify-between gap-3 border-b border-stone-100 px-5 py-4 dark:border-white/10">
                  <div>
                    <h2 className="font-semibold">通知记录</h2>
                    <p className="mt-1 text-xs text-stone-500">
                      生成结果、预算和存储预警集中显示
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      void markCreativeNotificationsRead().then(() =>
                        loadNotifications(),
                      )
                    }
                    className="rounded-lg"
                  >
                    全部已读
                  </Button>
                </div>
                <div className="max-h-[760px] overflow-y-auto p-3">
                  {notifications.map((item) => (
                    <button
                      type="button"
                      key={item.id}
                      onClick={() =>
                        void markCreativeNotificationsRead(item.id).then(() =>
                          loadNotifications(),
                        )
                      }
                      className={cn(
                        "mb-2 w-full rounded-xl p-4 text-left transition active:scale-[0.99]",
                        item.read
                          ? "bg-stone-50 text-stone-600 dark:bg-white/5 dark:text-stone-300"
                          : "border border-violet-200 bg-violet-50 text-stone-900 dark:border-violet-400/20 dark:bg-violet-400/10 dark:text-white",
                      )}
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <div className="text-sm font-semibold">
                            {item.title}
                          </div>
                          <p className="mt-1 text-sm leading-6">
                            {item.message}
                          </p>
                        </div>
                        {!item.read ? (
                          <span className="shrink-0 rounded-md bg-violet-700 px-2 py-1 text-[10px] font-semibold text-white">
                            未读
                          </span>
                        ) : null}
                      </div>
                      <div className="mt-2 text-xs text-stone-500">
                        {new Date(item.created_at).toLocaleString("zh-CN")}
                      </div>
                    </button>
                  ))}
                  {!notifications.length ? (
                    <div className="grid min-h-80 place-items-center text-center text-stone-500">
                      <div>
                        <Bell className="mx-auto size-9" />
                        <p className="mt-3 text-sm">暂无通知</p>
                      </div>
                    </div>
                  ) : null}
                </div>
              </Surface>
            </div>
          </TabsContent>

          <TabsContent value="delivery" className="mt-3">
            <div className="grid min-w-0 grid-cols-1 gap-5 xl:grid-cols-[minmax(0,0.9fr)_minmax(460px,1.1fr)]">
              <Surface className="p-5">
                <div className="flex items-center gap-2">
                  <FolderKanban className="size-5 text-violet-700 dark:text-violet-300" />
                  <h2 className="font-semibold">项目选择</h2>
                </div>
                <label className="mt-4 block">
                  <span className="mb-2 block text-sm font-medium">项目</span>
                  <select
                    value={selectedProjectId}
                    onChange={(event) => {
                      setBudget(null);
                      setSelectedProjectId(event.target.value);
                    }}
                    className="h-11 w-full rounded-xl border border-stone-200 bg-stone-50 px-3 text-sm outline-none focus:border-violet-500 dark:border-white/10 dark:bg-stone-900"
                  >
                    <option value="">选择项目</option>
                    {(session.role === "admin" && budgetProjects.length
                      ? budgetProjects
                      : projects
                    ).map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                        {"owner_id" in item
                          ? ` (${item.owner_id.slice(0, 8)})`
                          : ""}
                      </option>
                    ))}
                  </select>
                </label>
                {selectedProject ? (
                  <div className="mt-4 rounded-xl bg-stone-100 p-4 dark:bg-white/7">
                    <div className="font-semibold">{selectedProject.name}</div>
                    <p className="mt-1 text-sm leading-6 text-stone-600 dark:text-stone-300">
                      {selectedProject.description || "该项目尚未填写说明。"}
                    </p>
                  </div>
                ) : null}
                <Button
                  disabled={!selectedProjectId}
                  onClick={() =>
                    void downloadProjectDelivery(
                      selectedProjectId,
                      selectedProject?.name || "xg-project-delivery",
                    )
                  }
                  className="mt-4 h-11 w-full rounded-xl bg-violet-700 text-white hover:bg-violet-800"
                >
                  <FileArchive /> 下载智能交付包
                </Button>
                <p className="mt-3 text-xs leading-5 text-stone-500">
                  交付包包含原图、版本、平台尺寸、提示词、质量报告和分支说明。缺失文件会写入清单。
                </p>
              </Surface>

              <Surface className="p-5">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h2 className="font-semibold">项目额度与效果</h2>
                    <p className="mt-1 text-xs text-stone-500">
                      任务提交时预留，成功消费，失败和取消自动退款
                    </p>
                  </div>
                  {budget?.warning ? (
                    <span className="rounded-lg bg-rose-100 px-3 py-1.5 text-xs font-semibold text-rose-700 dark:bg-rose-400/10 dark:text-rose-300">
                      预算预警
                    </span>
                  ) : null}
                </div>
                <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {[
                    [budget?.credit_limit ?? "-", "总预算"],
                    [budget?.used_credits ?? "-", "已使用"],
                    [budget?.remaining_credits ?? "-", "可用额度"],
                    [
                      budget?.success_rate == null
                        ? "-"
                        : `${Math.round(budget.success_rate * 100)}%`,
                      "成功率",
                    ],
                  ].map(([value, label]) => (
                    <div
                      key={label}
                      className="rounded-xl bg-stone-100 p-3 dark:bg-white/7"
                    >
                      <div className="text-xl font-bold tabular-nums">
                        {value}
                      </div>
                      <div className="mt-1 text-xs text-stone-500">{label}</div>
                    </div>
                  ))}
                </div>
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  <div className="rounded-xl border border-stone-200 p-3 text-sm dark:border-white/10">
                    平均耗时：
                    <span className="font-semibold">
                      {formatDuration(budget?.average_duration_ms)}
                    </span>
                  </div>
                  <div className="rounded-xl border border-stone-200 p-3 text-sm dark:border-white/10">
                    预计成本：
                    <span className="font-semibold">
                      ¥{(budget?.estimated_cost || 0).toFixed(2)}
                    </span>
                  </div>
                </div>
                {session.role === "admin" ? (
                  <div className="mt-5 grid gap-4 sm:grid-cols-2">
                    <label>
                      <span className="mb-2 block text-sm font-medium">
                        额度上限
                      </span>
                      <input
                        type="number"
                        min={0}
                        value={budgetLimit}
                        onChange={(event) =>
                          setBudgetLimit(Number(event.target.value))
                        }
                        className="h-10 w-full rounded-xl border border-stone-200 bg-stone-50 px-3 text-sm outline-none focus:border-violet-500 dark:border-white/10 dark:bg-white/5"
                      />
                    </label>
                    <label>
                      <span className="mb-2 block text-sm font-medium">
                        预算类型
                      </span>
                      <select
                        value={budgetType}
                        onChange={(event) =>
                          setBudgetType(event.target.value as typeof budgetType)
                        }
                        className="h-10 w-full rounded-xl border border-stone-200 bg-stone-50 px-3 text-sm outline-none focus:border-violet-500 dark:border-white/10 dark:bg-stone-900"
                      >
                        <option value="project">项目</option>
                        <option value="department">部门</option>
                        <option value="client">客户</option>
                      </select>
                    </label>
                    <label>
                      <span className="mb-2 block text-sm font-medium">
                        部门或客户名称
                      </span>
                      <input
                        value={budgetLabel}
                        onChange={(event) => setBudgetLabel(event.target.value)}
                        placeholder="可选"
                        className="h-10 w-full rounded-xl border border-stone-200 bg-stone-50 px-3 text-sm outline-none focus:border-violet-500 dark:border-white/10 dark:bg-white/5"
                      />
                    </label>
                    <label>
                      <span className="mb-2 block text-sm font-medium">
                        预警比例
                      </span>
                      <input
                        type="number"
                        min={1}
                        max={100}
                        value={budgetWarning}
                        onChange={(event) =>
                          setBudgetWarning(Number(event.target.value))
                        }
                        className="h-10 w-full rounded-xl border border-stone-200 bg-stone-50 px-3 text-sm outline-none focus:border-violet-500 dark:border-white/10 dark:bg-white/5"
                      />
                    </label>
                    <label>
                      <span className="mb-2 block text-sm font-medium">
                        单张成本（元）
                      </span>
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        value={budgetUnitCost}
                        onChange={(event) =>
                          setBudgetUnitCost(Number(event.target.value))
                        }
                        className="h-10 w-full rounded-xl border border-stone-200 bg-stone-50 px-3 text-sm outline-none focus:border-violet-500 dark:border-white/10 dark:bg-white/5"
                      />
                    </label>
                    <Button
                      disabled={!selectedProjectId || isSavingBudget}
                      onClick={() => void saveBudget()}
                      className="h-11 rounded-xl bg-violet-700 text-white hover:bg-violet-800 sm:col-span-2"
                    >
                      {isSavingBudget ? (
                        <LoaderCircle className="animate-spin" />
                      ) : (
                        <Settings2 />
                      )}
                      保存项目预算
                    </Button>
                  </div>
                ) : budget?.configured === false ? (
                  <p className="mt-5 rounded-xl bg-stone-100 p-4 text-sm text-stone-500 dark:bg-white/7">
                    该项目尚未配置独立预算，当前只受用户总额度限制。
                  </p>
                ) : null}
              </Surface>
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </main>
  );
}
