"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ComponentProps } from "react";
import {
  Activity,
  Ban,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleOff,
  Clock3,
  Copy,
  Database,
  Download,
  Link2,
  LoaderCircle,
  LogIn,
  Pencil,
  RefreshCw,
  Search,
  ShieldAlert,
  Trash2,
  UsersRound,
  Zap,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  deleteAccounts,
  fetchAccounts,
  fetchModels,
  fetchRefreshProgress,
  fetchReLoginProgress,
  reLoginAccounts,
  refreshAccounts,
  testProxy,
  updateAccount,
  type Account,
  type AccountRefreshResponse,
  type AccountStatus,
  type Model,
  type RefreshProgressResponse,
} from "@/lib/api";
import { useAuthGuard } from "@/lib/use-auth-guard";
import { cn } from "@/lib/utils";

import { AccountImportDialog } from "./components/account-import-dialog";

const accountStatusOptions: { label: string; value: AccountStatus | "all" }[] =
  [
    { label: "全部状态", value: "all" },
    { label: "正常", value: "正常" },
    { label: "限流", value: "限流" },
    { label: "异常", value: "异常" },
    { label: "禁用", value: "禁用" },
  ];

const statusMeta: Record<
  AccountStatus,
  {
    icon: typeof CheckCircle2;
    badge: ComponentProps<typeof Badge>["variant"];
  }
> = {
  正常: { icon: CheckCircle2, badge: "success" },
  限流: { icon: CircleAlert, badge: "warning" },
  异常: { icon: CircleOff, badge: "danger" },
  禁用: { icon: Ban, badge: "secondary" },
};

const statusOverviewMeta: Record<
  AccountStatus,
  {
    description: string;
    iconClass: string;
    surfaceClass: string;
    textClass: string;
    trackClass: string;
  }
> = {
  正常: {
    description: "可参与任务调度",
    iconClass:
      "bg-emerald-100 text-emerald-700 dark:bg-emerald-400/15 dark:text-emerald-300",
    surfaceClass:
      "border-emerald-100 bg-emerald-50/65 hover:border-emerald-200 dark:border-emerald-400/15 dark:bg-emerald-400/8",
    textClass: "text-emerald-700 dark:text-emerald-300",
    trackClass: "bg-emerald-500",
  },
  限流: {
    description: "等待额度窗口恢复",
    iconClass:
      "bg-amber-100 text-amber-700 dark:bg-amber-400/15 dark:text-amber-300",
    surfaceClass:
      "border-amber-100 bg-amber-50/70 hover:border-amber-200 dark:border-amber-400/15 dark:bg-amber-400/8",
    textClass: "text-amber-700 dark:text-amber-300",
    trackClass: "bg-amber-500",
  },
  异常: {
    description: "建议执行恢复或移除",
    iconClass:
      "bg-rose-100 text-rose-700 dark:bg-rose-400/15 dark:text-rose-300",
    surfaceClass:
      "border-rose-100 bg-rose-50/70 hover:border-rose-200 dark:border-rose-400/15 dark:bg-rose-400/8",
    textClass: "text-rose-700 dark:text-rose-300",
    trackClass: "bg-rose-500",
  },
  禁用: {
    description: "已从调度中排除",
    iconClass:
      "bg-stone-200 text-stone-600 dark:bg-white/10 dark:text-stone-300",
    surfaceClass:
      "border-stone-200 bg-stone-50/75 hover:border-stone-300 dark:border-white/10 dark:bg-white/5",
    textClass: "text-stone-600 dark:text-stone-300",
    trackClass: "bg-stone-500",
  },
};

type AccountSummary = {
  total: number;
  active: number;
  limited: number;
  abnormal: number;
  disabled: number;
  quota: string;
  inflight: number;
  success: number;
  fail: number;
  successRate: number;
};

type LiveAccountSummary = Pick<
  AccountSummary,
  "total" | "active" | "limited" | "abnormal" | "disabled" | "quota"
>;

function formatCompact(value: number) {
  if (value >= 1000) {
    return `${(value / 1000).toFixed(1)}k`;
  }
  return String(value);
}

function formatQuota(account: Account) {
  return String(Math.max(0, account.quota));
}

function formatRestoreAt(value?: string | null) {
  if (!value) {
    return { absolute: "—", relative: "" };
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return { absolute: value, relative: "" };
  }

  const diffMs = Math.max(0, date.getTime() - Date.now());
  const totalHours = Math.ceil(diffMs / (1000 * 60 * 60));
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  const relative = diffMs > 0 ? `剩余 ${days}d ${hours}h` : "已到恢复时间";

  const pad = (num: number) => String(num).padStart(2, "0");
  const absolute = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;

  return { absolute, relative };
}

function formatQuotaSummary(accounts: Account[]) {
  const availableAccounts = accounts.filter(
    (account) => account.status === "正常",
  );
  return formatCompact(
    availableAccounts.reduce(
      (sum, account) => sum + Math.max(0, account.quota),
      0,
    ),
  );
}

function formatDateTime(value?: string | Date | null, fallback = "—") {
  if (!value) {
    return fallback;
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function formatShortDateTime(value?: string | null) {
  if (!value) {
    return "—";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value).slice(0, 16);
  }

  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function formatPercent(value: number) {
  return `${Math.max(0, Math.min(100, Math.round(value)))}%`;
}

function formatTaskSuccessRate(success: number, fail: number) {
  return success + fail > 0
    ? formatPercent(calculatePercentage(success, success + fail))
    : "—";
}

function calculatePercentage(numerator: number, denominator: number) {
  if (denominator <= 0) {
    return 0;
  }
  return (numerator / denominator) * 100;
}

function maskToken(token?: string) {
  if (!token) return "—";
  if (token.length <= 18) return token;
  return `${token.slice(0, 16)}...${token.slice(-8)}`;
}

function downloadTokens(accounts: Account[]) {
  const content = `${accounts.map((account) => account.access_token).join("\n")}\n`;
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `accounts-${Date.now()}.txt`;
  link.click();
  URL.revokeObjectURL(url);
}

function displayAccountType(account: Account) {
  return account.type || "Free";
}

function displayAccountSource(account: Account) {
  const source = String(account.source_type || "")
    .trim()
    .toLowerCase();
  if (!source) {
    return "web";
  }
  if (source === "web") {
    return "web";
  }
  return source;
}

function AccountsPageContent() {
  const didLoadRef = useRef(false);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [availableModels, setAvailableModels] = useState<Model[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<AccountStatus | "all">(
    "all",
  );
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState("10");
  const [editingAccount, setEditingAccount] = useState<Account | null>(null);
  const [editStatus, setEditStatus] = useState<AccountStatus>("正常");
  const [editProxy, setEditProxy] = useState("");
  const [isTestingProxy, setIsTestingProxy] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingModels, setIsLoadingModels] = useState(true);
  const [accountLoadError, setAccountLoadError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshingTokens, setRefreshingTokens] = useState<Set<string>>(
    new Set(),
  );
  const [isDeleting, setIsDeleting] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [isRelogining, setIsRelogining] = useState(false);
  const [isModelListExpanded, setIsModelListExpanded] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);
  const [progress, setProgress] = useState<{
    visible: boolean;
    current: number;
    total: number;
    message: string;
    email: string;
  }>({
    visible: false,
    current: 0,
    total: 0,
    message: "",
    email: "",
  });
  const [refreshSummary, setRefreshSummary] =
    useState<LiveAccountSummary | null>(null);

  const loadAccounts = async (silent = false) => {
    if (!silent) {
      setIsLoading(true);
    }
    try {
      const data = await fetchAccounts();
      setAccounts(data.items);
      setSelectedIds((prev) =>
        prev.filter((id) =>
          data.items.some((item) => item.access_token === id),
        ),
      );
      setLastSyncedAt(new Date());
      setAccountLoadError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "加载账户失败";
      setAccountLoadError(message);
      toast.error(message);
    } finally {
      if (!silent) {
        setIsLoading(false);
      }
    }
  };

  const loadModels = async () => {
    setIsLoadingModels(true);
    try {
      const data = await fetchModels();
      setAvailableModels(Array.isArray(data.data) ? data.data : []);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "加载模型列表失败";
      toast.error(message);
    } finally {
      setIsLoadingModels(false);
    }
  };

  useEffect(() => {
    if (didLoadRef.current) {
      return;
    }
    didLoadRef.current = true;
    void loadAccounts();
    void loadModels();
  }, []);

  const filteredAccounts = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return accounts.filter((account) => {
      const searchMatched =
        normalizedQuery.length === 0 ||
        [
          account.email ?? "",
          account.access_token,
          displayAccountType(account),
          displayAccountSource(account),
        ].some((value) => value.toLowerCase().includes(normalizedQuery));
      const typeMatched =
        typeFilter === "all" || displayAccountType(account) === typeFilter;
      const statusMatched =
        statusFilter === "all" || account.status === statusFilter;
      return searchMatched && typeMatched && statusMatched;
    });
  }, [accounts, query, statusFilter, typeFilter]);

  const pageCount = Math.max(
    1,
    Math.ceil(filteredAccounts.length / Number(pageSize)),
  );
  const safePage = Math.min(page, pageCount);
  const startIndex = (safePage - 1) * Number(pageSize);
  const currentRows = filteredAccounts.slice(
    startIndex,
    startIndex + Number(pageSize),
  );
  const allCurrentSelected =
    currentRows.length > 0 &&
    currentRows.every((row) => selectedIds.includes(row.access_token));

  const summary = useMemo<AccountSummary>(() => {
    const total = accounts.length;
    const active = accounts.filter((item) => item.status === "正常").length;
    const limited = accounts.filter((item) => item.status === "限流").length;
    const abnormal = accounts.filter((item) => item.status === "异常").length;
    const disabled = accounts.filter((item) => item.status === "禁用").length;
    const quota = formatQuotaSummary(accounts);
    const inflight = accounts.reduce(
      (sum, item) => sum + Math.max(0, item.image_inflight ?? 0),
      0,
    );
    const success = accounts.reduce(
      (sum, item) => sum + Math.max(0, item.success),
      0,
    );
    const fail = accounts.reduce(
      (sum, item) => sum + Math.max(0, item.fail),
      0,
    );

    return {
      total,
      active,
      limited,
      abnormal,
      disabled,
      quota,
      inflight,
      success,
      fail,
      successRate: calculatePercentage(success, success + fail),
    };
  }, [accounts]);

  const displayedSummary = refreshSummary ?? summary;
  const visibleModels = isModelListExpanded
    ? availableModels
    : availableModels.slice(0, 4);

  const accountTypeOptions = useMemo(
    () => [
      { label: "全部类型", value: "all" },
      ...Array.from(new Set(accounts.map(displayAccountType))).map((type) => ({
        label: type,
        value: type,
      })),
    ],
    [accounts],
  );

  const selectedTokens = useMemo(() => {
    const selectedSet = new Set(selectedIds);
    return accounts
      .filter((item) => selectedSet.has(item.access_token))
      .map((item) => item.access_token);
  }, [accounts, selectedIds]);

  const abnormalTokens = useMemo(() => {
    return accounts
      .filter((item) => item.status === "异常")
      .map((item) => item.access_token);
  }, [accounts]);

  const paginationItems = useMemo(() => {
    const items: (number | "...")[] = [];
    const start = Math.max(1, safePage - 1);
    const end = Math.min(pageCount, safePage + 1);

    if (start > 1) items.push(1);
    if (start > 2) items.push("...");
    for (let current = start; current <= end; current += 1) items.push(current);
    if (end < pageCount - 1) items.push("...");
    if (end < pageCount) items.push(pageCount);

    return items;
  }, [pageCount, safePage]);

  const handleDeleteTokens = async (tokens: string[]) => {
    if (tokens.length === 0) {
      toast.error("请先选择要删除的账户");
      return;
    }

    setIsDeleting(true);
    try {
      const data = await deleteAccounts(tokens);
      setAccounts(data.items);
      setSelectedIds((prev) =>
        prev.filter((id) =>
          data.items.some((item) => item.access_token === id),
        ),
      );
      setLastSyncedAt(new Date());
      toast.success(`删除 ${data.removed ?? 0} 个账户`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "删除账户失败";
      toast.error(message);
    } finally {
      setIsDeleting(false);
    }
  };

  const handleRefreshAccounts = async (accessTokens: string[]) => {
    if (accessTokens.length === 0) {
      toast.error("没有需要刷新的账户");
      return;
    }

    if (accessTokens.length === 1) {
      setRefreshingTokens((prev) => new Set([...prev, accessTokens[0]]));
      try {
        const { progress_id } = await refreshAccounts(accessTokens);
        // 单账号：轮询等待完成
        await pollRefreshProgress(progress_id, (progress) => {
          if (progress.done && progress.result) {
            setAccounts(progress.result.items);
            setSelectedIds((prev) =>
              prev.filter((id) =>
                progress.result!.items.some((item) => item.access_token === id),
              ),
            );
            setLastSyncedAt(new Date());
          }
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "刷新账户失败";
        toast.error(message);
      } finally {
        setRefreshingTokens((prev) => {
          const next = new Set(prev);
          next.delete(accessTokens[0]);
          return next;
        });
      }
      return;
    }

    setIsRefreshing(true);

    // 计算非选中账号的基数（统计卡片联动用）
    const selectedTokenSet = new Set(accessTokens);
    const baseAccountsList = accounts.filter(
      (a) => !selectedTokenSet.has(a.access_token),
    );
    const baseActive = baseAccountsList.filter(
      (a) => a.status === "正常",
    ).length;
    const baseLimited = baseAccountsList.filter(
      (a) => a.status === "限流",
    ).length;
    const baseAbnormal = baseAccountsList.filter(
      (a) => a.status === "异常",
    ).length;
    const baseDisabled = baseAccountsList.filter(
      (a) => a.status === "禁用",
    ).length;
    const baseNormalAccounts = baseAccountsList.filter(
      (a) => a.status === "正常",
    );
    const baseQuotaNum = baseNormalAccounts.reduce(
      (s, a) => s + Math.max(0, a.quota),
      0,
    );

    // 显示进度条（只显示当前任务，不含分类统计）
    const total = accessTokens.length;
    setProgress({
      visible: true,
      current: 0,
      total,
      message: "正在刷新账号信息...",
      email: "",
    });

    try {
      const { progress_id } = await refreshAccounts(accessTokens);

      // 轮询进度到完成
      const data = await new Promise<AccountRefreshResponse>(
        (resolve, reject) => {
          const pollTimer = setInterval(async () => {
            try {
              const p = await fetchRefreshProgress(progress_id);
              if (p.done) {
                clearInterval(pollTimer);
                if (p.error) {
                  reject(new Error(p.error));
                  return;
                }
                if (!p.result) {
                  reject(new Error("刷新结果为空"));
                  return;
                }
                // 更新最终进度显示
                setProgress((prev) => ({
                  ...prev,
                  current: prev.total,
                  message: "刷新完成",
                }));
                // 清除联动统计
                setRefreshSummary(null);
                resolve(p.result);
              } else {
                // 实时更新进度
                setProgress((prev) => ({
                  ...prev,
                  current: p.processed,
                }));
                // 实时更新统计卡片：基数 + 已刷新的累加结果
                const runningActive =
                  baseActive + (p.status_counts?.["正常"] ?? 0);
                const runningLimited =
                  baseLimited + (p.status_counts?.["限流"] ?? 0);
                const runningAbnormal =
                  baseAbnormal + (p.status_counts?.["异常"] ?? 0);
                const runningDisabled =
                  baseDisabled + (p.status_counts?.["禁用"] ?? 0);
                setRefreshSummary({
                  total: accounts.length,
                  active: runningActive,
                  limited: runningLimited,
                  abnormal: runningAbnormal,
                  disabled: runningDisabled,
                  quota: formatCompact(baseQuotaNum + (p.total_quota ?? 0)),
                });
              }
            } catch (err) {
              clearInterval(pollTimer);
              reject(err);
            }
          }, 300);
        },
      );

      // 刷新完成，更新数据
      setAccounts(data.items);
      setSelectedIds((prev) =>
        prev.filter((id) =>
          data.items.some((item) => item.access_token === id),
        ),
      );
      setLastSyncedAt(new Date());

      const relogined = data.relogined ?? 0;

      // 显示重新登录进度
      if (relogined > 0) {
        setProgress({
          visible: true,
          current: 0,
          total: relogined,
          message: `正在尝试对 ${relogined} 个账号进行移除异常状态`,
          email: "",
        });
        // 模拟重新登录进度
        let reCount = 0;
        await new Promise<void>((resolve) => {
          const timer = setInterval(() => {
            reCount += 1;
            if (reCount >= relogined) {
              clearInterval(timer);
              setProgress({
                visible: true,
                current: relogined,
                total: relogined,
                message: "移除异常状态完成",
                email: "",
              });
              setTimeout(
                () =>
                  setProgress({
                    visible: false,
                    current: 0,
                    total: 0,
                    message: "",
                    email: "",
                  }),
                800,
              );
              resolve();
            } else {
              setProgress((prev) => ({ ...prev, current: reCount }));
            }
          }, 150);
          setTimeout(resolve, 2000);
        });
      } else {
        setProgress({
          visible: true,
          current: total,
          total,
          message: "刷新完成",
          email: "",
        });
        setTimeout(
          () =>
            setProgress({
              visible: false,
              current: 0,
              total: 0,
              message: "",
              email: "",
            }),
          800,
        );
      }

      if ((data.errors ?? []).length > 0) {
        const firstError = data.errors?.[0]?.error;
        toast.error(
          `刷新成功 ${data.refreshed} 个，失败 ${(data.errors ?? []).length} 个${firstError ? `，首个错误：${firstError}` : ""}`,
        );
      } else {
        toast.success(
          `刷新成功 ${data.refreshed} 个账户${relogined > 0 ? `，已触发 ${relogined} 个账号重新登录` : ""}`,
        );
      }
    } catch (error) {
      setProgress({
        visible: false,
        current: 0,
        total: 0,
        message: "",
        email: "",
      });
      setRefreshSummary(null);
      const message = error instanceof Error ? error.message : "刷新账户失败";
      toast.error(message);
    } finally {
      setIsRefreshing(false);
    }
  };

  const pollRefreshProgress = async (
    progressId: string,
    onUpdate: (p: RefreshProgressResponse) => void,
  ): Promise<void> => {
    return new Promise<void>((resolve, reject) => {
      const timer = setInterval(async () => {
        try {
          const p = await fetchRefreshProgress(progressId);
          if (p.done) {
            clearInterval(timer);
            if (p.error) {
              reject(new Error(p.error));
            } else {
              onUpdate(p);
              resolve();
            }
          }
        } catch (err) {
          clearInterval(timer);
          reject(err);
        }
      }, 500);
    });
  };

  const handleReLogin = async (accessTokens: string[]) => {
    if (accessTokens.length === 0) {
      toast.error("请先选择要恢复的账户");
      return;
    }

    // 只处理异常账号，过滤非异常账号
    const abnormalTokens = accessTokens.filter((token) => {
      const account = accounts.find((a) => a.access_token === token);
      return account?.status === "异常";
    });

    if (abnormalTokens.length === 0) {
      toast.error("选中账号中没有异常账号");
      return;
    }

    if (abnormalTokens.length < accessTokens.length) {
      toast.info(
        `已过滤 ${accessTokens.length - abnormalTokens.length} 个非异常账号`,
      );
    }

    setIsRelogining(true);

    // 计算非选中账号的基数（统计卡片联动用）
    const selectedTokenSet = new Set(abnormalTokens);
    const baseAccountsList = accounts.filter(
      (a) => !selectedTokenSet.has(a.access_token),
    );
    const baseActive = baseAccountsList.filter(
      (a) => a.status === "正常",
    ).length;
    const baseLimited = baseAccountsList.filter(
      (a) => a.status === "限流",
    ).length;
    const baseAbnormal = baseAccountsList.filter(
      (a) => a.status === "异常",
    ).length;
    const baseDisabled = baseAccountsList.filter(
      (a) => a.status === "禁用",
    ).length;

    // 显示进度条（真实进度）
    const total = abnormalTokens.length;
    setProgress({
      visible: true,
      current: 0,
      total,
      message: "正在尝试恢复异常账号...",
      email: "",
    });

    try {
      const { progress_id } = await reLoginAccounts(abnormalTokens);

      // 轮询进度到完成
      await new Promise<void>((resolve, reject) => {
        const pollTimer = setInterval(async () => {
          try {
            const p = await fetchReLoginProgress(progress_id);
            if (p.done) {
              clearInterval(pollTimer);
              if (p.error) {
                reject(new Error(p.error));
                return;
              }
              setProgress((prev) => ({
                ...prev,
                current: prev.total,
                message: "恢复流程已完成",
              }));
              setRefreshSummary(null);
              resolve();
            } else {
              // 实时更新进度
              const results = p.results ?? [];
              // 找到最新一条有错误的结果
              const lastErrorResult = [...results]
                .reverse()
                .find((r) => r.error);
              const emailHint = lastErrorResult
                ? `失败: ${lastErrorResult.token} ${lastErrorResult.error ?? ""}`
                : `已处理 ${p.processed}/${p.total}`;
              setProgress((prev) => ({
                ...prev,
                current: p.processed,
                email: emailHint,
                message: "正在尝试恢复异常账号...",
              }));

              // 实时更新统计卡片：基数 + 已处理的恢复结果
              let runningActive = baseActive;
              let runningAbnormal = baseAbnormal;
              let runningDisabled = baseDisabled;
              for (const r of results) {
                if (r.status === "成功") {
                  runningActive += 1;
                  runningAbnormal -= 1;
                } else if (r.status === "禁用") {
                  runningDisabled += 1;
                  runningAbnormal -= 1;
                }
                // "异常"或"跳过"：保持异常状态不变
              }
              setRefreshSummary({
                total: accounts.length,
                active: runningActive,
                limited: baseLimited,
                abnormal: runningAbnormal,
                disabled: runningDisabled,
                quota: summary.quota,
              });
            }
          } catch (err) {
            clearInterval(pollTimer);
            reject(err);
          }
        }, 300);
      });

      // 等待后台线程完成，再拉取最新数据
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
      try {
        const freshData = await fetchAccounts();
        setAccounts(freshData.items);
        setSelectedIds((prev) =>
          prev.filter((id) =>
            freshData.items.some((item) => item.access_token === id),
          ),
        );
        setLastSyncedAt(new Date());
      } catch (error) {
        toast.warning(
          error instanceof Error
            ? `恢复完成，但列表同步失败：${error.message}`
            : "恢复完成，但列表暂未同步，请手动刷新",
        );
      }

      setProgress({
        visible: true,
        current: total,
        total,
        message: "恢复完成",
        email: "",
      });
      setTimeout(
        () =>
          setProgress({
            visible: false,
            current: 0,
            total: 0,
            message: "",
            email: "",
          }),
        800,
      );

      toast.success(`恢复流程已全部完成`);
    } catch (error) {
      setProgress({
        visible: false,
        current: 0,
        total: 0,
        message: "",
        email: "",
      });
      setRefreshSummary(null);
      const message = error instanceof Error ? error.message : "重新登录失败";
      toast.error(message);
    } finally {
      setIsRelogining(false);
    }
  };

  const openEditDialog = (account: Account) => {
    setEditingAccount(account);
    setEditStatus(account.status);
    setEditProxy(account.proxy ?? "");
  };

  const handleTestAccountProxy = async () => {
    const candidate = editProxy.trim();
    if (!candidate) {
      toast.error("请先填写代理地址");
      return;
    }
    setIsTestingProxy(true);
    try {
      const data = await testProxy(candidate);
      if (data.result.ok) {
        toast.success(
          `代理可用（${data.result.latency_ms} ms，HTTP ${data.result.status}）`,
        );
      } else {
        toast.error(`代理不可用：${data.result.error ?? "未知错误"}`);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "测试代理失败");
    } finally {
      setIsTestingProxy(false);
    }
  };

  const handleUpdateAccount = async () => {
    if (!editingAccount) {
      return;
    }

    setIsUpdating(true);
    try {
      const data = await updateAccount(editingAccount.access_token, {
        status: editStatus,
        proxy: editProxy.trim(),
      });
      setAccounts(data.items);
      setSelectedIds((prev) =>
        prev.filter((id) =>
          data.items.some((item) => item.access_token === id),
        ),
      );
      setLastSyncedAt(new Date());
      setEditingAccount(null);
      toast.success("账号信息已更新");
    } catch (error) {
      const message = error instanceof Error ? error.message : "更新账号失败";
      toast.error(message);
    } finally {
      setIsUpdating(false);
    }
  };

  const toggleSelectAll = (checked: boolean) => {
    if (checked) {
      setSelectedIds((prev) =>
        Array.from(
          new Set([...prev, ...currentRows.map((item) => item.access_token)]),
        ),
      );
      return;
    }
    setSelectedIds((prev) =>
      prev.filter((id) => !currentRows.some((row) => row.access_token === id)),
    );
  };

  const focusStatus = (status: AccountStatus | "all") => {
    setStatusFilter(status);
    setQuery("");
    setPage(1);
    window.requestAnimationFrame(() => {
      document
        .getElementById("account-list")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  };

  const clearFilters = () => {
    setQuery("");
    setTypeFilter("all");
    setStatusFilter("all");
    setPage(1);
  };

  return (
    <>
      <section className="flex flex-col gap-5 rounded-3xl border border-violet-100/80 bg-gradient-to-br from-white via-white to-violet-50/70 p-5 shadow-[0_18px_50px_-34px_rgba(91,33,182,0.45)] sm:p-6 xl:flex-row xl:items-start xl:justify-between dark:border-violet-400/15 dark:from-white/[0.055] dark:via-white/[0.025] dark:to-violet-400/[0.06]">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full border border-violet-200 bg-violet-100/80 px-2.5 py-1 text-[11px] font-semibold tracking-wide text-violet-800 dark:border-violet-400/20 dark:bg-violet-400/10 dark:text-violet-200">
              管理员 · 账号控制台
            </span>
          </div>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h1 className="text-2xl font-semibold tracking-tight text-stone-950 dark:text-white">
              号池管理
            </h1>
            <p className="text-sm text-stone-500 dark:text-stone-400">
              集中掌握账号健康、可用容量与任务运行状态
            </p>
          </div>
          <div
            aria-live="polite"
            className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-stone-500 dark:text-stone-400"
          >
            <span
              className={cn(
                "inline-flex items-center gap-1.5 font-medium",
                accountLoadError
                  ? "text-rose-700 dark:text-rose-300"
                  : "text-emerald-700 dark:text-emerald-300",
              )}
            >
              <span className="relative flex size-2" aria-hidden="true">
                {accountLoadError ? null : (
                  <span className="absolute inline-flex size-2 animate-ping rounded-full bg-emerald-400 opacity-65 motion-reduce:animate-none" />
                )}
                <span
                  className={cn(
                    "relative inline-flex size-2 rounded-full",
                    accountLoadError ? "bg-rose-500" : "bg-emerald-500",
                  )}
                />
              </span>
              {accountLoadError
                ? "账号数据同步失败"
                : isLoading
                  ? "正在同步账号数据"
                  : "账号服务已连接"}
            </span>
            <span>
              {accountLoadError
                ? "请点击“同步列表”重试"
                : `最近数据更新：${lastSyncedAt ? formatDateTime(lastSyncedAt) : "等待首次加载"}`}
            </span>
            {isRefreshing ? (
              <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-300">
                <LoaderCircle className="size-3 animate-spin" />
                全量刷新进行中
              </span>
            ) : null}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 xl:justify-end">
          <Button
            variant="outline"
            className="h-10 rounded-xl border-stone-200 bg-white/85 px-4 text-stone-700 hover:bg-white dark:border-white/10 dark:bg-white/5 dark:text-stone-200 dark:hover:bg-white/10"
            onClick={() => void loadAccounts()}
            disabled={isLoading || isRefreshing || isDeleting}
          >
            <RefreshCw
              className={cn("size-4", isLoading ? "animate-spin" : "")}
            />
            同步列表
          </Button>
          <Button
            className="h-10 rounded-xl bg-violet-700 px-4 text-white shadow-sm shadow-violet-700/15 hover:bg-violet-800 dark:bg-violet-500 dark:hover:bg-violet-400"
            onClick={() =>
              void handleRefreshAccounts(
                accounts.map((item) => item.access_token),
              )
            }
            disabled={
              isLoading || isRefreshing || isDeleting || accounts.length === 0
            }
          >
            <RefreshCw
              className={cn("size-4", isRefreshing ? "animate-spin" : "")}
            />
            全量刷新账号
          </Button>
          <AccountImportDialog
            disabled={isLoading || isRefreshing || isDeleting}
            onImported={(items) => {
              setAccounts(items);
              setSelectedIds([]);
              setLastSyncedAt(new Date());
              setPage(1);
            }}
          />
          <Button
            variant="outline"
            className="h-10 rounded-xl border-stone-200 bg-white/85 px-4 text-stone-700 hover:bg-white dark:border-white/10 dark:bg-white/5 dark:text-stone-200 dark:hover:bg-white/10"
            onClick={() => downloadTokens(accounts)}
            disabled={accounts.length === 0}
          >
            <Download className="size-4" />
            导出 Token
          </Button>
        </div>
      </section>

      {/* 进度条 */}
      {progress.visible && (
        <div className="overflow-hidden rounded-2xl border border-stone-200 bg-white/90 shadow-sm">
          <div className="px-4 py-3">
            <div className="flex items-center justify-between text-sm">
              <span className="text-stone-600">
                {progress.message}
                {progress.email && (
                  <span className="ml-1 font-medium text-stone-700">
                    {progress.email}
                  </span>
                )}
              </span>
              <span className="font-medium text-stone-700">
                {progress.current}/{progress.total}
              </span>
            </div>
            <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-stone-100">
              <div
                className="h-full rounded-full bg-gradient-to-r from-amber-400 to-orange-500 transition-all duration-300 ease-out"
                style={{
                  width: `${progress.total > 0 ? (progress.current / progress.total) * 100 : 0}%`,
                }}
              />
            </div>
          </div>
        </div>
      )}

      <Dialog
        open={Boolean(editingAccount)}
        onOpenChange={(open) => (!open ? setEditingAccount(null) : null)}
      >
        <DialogContent showCloseButton={false} className="rounded-2xl p-6">
          <DialogHeader className="gap-2">
            <DialogTitle>编辑账户</DialogTitle>
            <DialogDescription className="text-sm leading-6">
              手动修改账号状态和专属代理。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium text-stone-700">状态</label>
              <Select
                value={editStatus}
                onValueChange={(value) => setEditStatus(value as AccountStatus)}
              >
                <SelectTrigger className="h-11 rounded-xl border-stone-200 bg-white">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {accountStatusOptions
                    .filter((option) => option.value !== "all")
                    .map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-stone-700">
                账号代理
              </label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  value={editProxy}
                  onChange={(event) => setEditProxy(event.target.value)}
                  placeholder="留空走全局代理，例如 http://127.0.0.1:7890"
                  className="h-11 rounded-xl border-stone-200 bg-white"
                />
                <Button
                  variant="outline"
                  className="h-11 rounded-xl border-stone-200 bg-white px-4 text-stone-700 sm:w-24"
                  onClick={() => void handleTestAccountProxy()}
                  disabled={isTestingProxy}
                >
                  {isTestingProxy ? (
                    <LoaderCircle className="size-4 animate-spin" />
                  ) : (
                    <Link2 className="size-4" />
                  )}
                  测试
                </Button>
              </div>
            </div>
          </div>
          <DialogFooter className="pt-2">
            <Button
              variant="secondary"
              className="h-10 rounded-xl bg-stone-100 px-5 text-stone-700 hover:bg-stone-200"
              onClick={() => setEditingAccount(null)}
              disabled={isUpdating}
            >
              取消
            </Button>
            <Button
              className="h-10 rounded-xl bg-stone-950 px-5 text-white hover:bg-stone-800"
              onClick={() => void handleUpdateAccount()}
              disabled={isUpdating}
            >
              {isUpdating ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : null}
              保存修改
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <section aria-label="号池运行概览" className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Card className="rounded-2xl border-emerald-100 bg-white/95 shadow-sm dark:border-emerald-400/15">
            <CardContent className="p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-medium text-stone-500 dark:text-stone-400">
                    可调度账号
                  </p>
                  <p className="mt-2 font-mono text-2xl font-semibold tracking-tight text-stone-950 dark:text-white">
                    {displayedSummary.active}
                    <span className="ml-1 text-base font-medium text-stone-400">
                      / {displayedSummary.total}
                    </span>
                  </p>
                </div>
                <span className="grid size-9 place-items-center rounded-xl bg-emerald-100 text-emerald-700 dark:bg-emerald-400/15 dark:text-emerald-300">
                  <UsersRound className="size-4" />
                </span>
              </div>
              <div className="mt-3 flex items-center gap-2 text-xs text-stone-500 dark:text-stone-400">
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-stone-100 dark:bg-white/10">
                  <div
                    className="h-full rounded-full bg-emerald-500 transition-[width] duration-300 motion-reduce:transition-none"
                    style={{
                      width: `${calculatePercentage(displayedSummary.active, displayedSummary.total)}%`,
                    }}
                  />
                </div>
                <span className="font-medium text-emerald-700 dark:text-emerald-300">
                  {formatPercent(
                    calculatePercentage(
                      displayedSummary.active,
                      displayedSummary.total,
                    ),
                  )}
                </span>
              </div>
            </CardContent>
          </Card>

          <Card className="rounded-2xl border-blue-100 bg-white/95 shadow-sm dark:border-blue-400/15">
            <CardContent className="p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-medium text-stone-500 dark:text-stone-400">
                    可用生图额度
                  </p>
                  <p className="mt-2 font-mono text-2xl font-semibold tracking-tight text-blue-700 dark:text-blue-300">
                    {displayedSummary.quota}
                  </p>
                </div>
                <span className="grid size-9 place-items-center rounded-xl bg-blue-100 text-blue-700 dark:bg-blue-400/15 dark:text-blue-300">
                  <Zap className="size-4" />
                </span>
              </div>
              <p className="mt-3 text-xs text-stone-500 dark:text-stone-400">
                仅汇总状态正常账号的剩余额度
              </p>
            </CardContent>
          </Card>

          <Card
            className={cn(
              "rounded-2xl bg-white/95 shadow-sm dark:bg-white/[0.03]",
              displayedSummary.limited +
                displayedSummary.abnormal +
                displayedSummary.disabled >
                0
                ? "border-amber-200 dark:border-amber-400/20"
                : "border-stone-200 dark:border-white/10",
            )}
          >
            <CardContent className="p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-medium text-stone-500 dark:text-stone-400">
                    待处理风险账号
                  </p>
                  <p
                    className={cn(
                      "mt-2 font-mono text-2xl font-semibold tracking-tight",
                      displayedSummary.limited +
                        displayedSummary.abnormal +
                        displayedSummary.disabled >
                        0
                        ? "text-amber-700 dark:text-amber-300"
                        : "text-stone-950 dark:text-white",
                    )}
                  >
                    {formatCompact(
                      displayedSummary.limited +
                        displayedSummary.abnormal +
                        displayedSummary.disabled,
                    )}
                  </p>
                </div>
                <span
                  className={cn(
                    "grid size-9 place-items-center rounded-xl",
                    displayedSummary.limited +
                      displayedSummary.abnormal +
                      displayedSummary.disabled >
                      0
                      ? "bg-amber-100 text-amber-700 dark:bg-amber-400/15 dark:text-amber-300"
                      : "bg-stone-100 text-stone-500 dark:bg-white/10 dark:text-stone-300",
                  )}
                >
                  <ShieldAlert className="size-4" />
                </span>
              </div>
              <p className="mt-3 text-xs text-stone-500 dark:text-stone-400">
                限流 {displayedSummary.limited} · 异常{" "}
                {displayedSummary.abnormal} · 禁用 {displayedSummary.disabled}
              </p>
            </CardContent>
          </Card>

          <Card className="rounded-2xl border-violet-100 bg-white/95 shadow-sm dark:border-violet-400/15">
            <CardContent className="p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-medium text-stone-500 dark:text-stone-400">
                    任务运行表现
                  </p>
                  <p className="mt-2 font-mono text-2xl font-semibold tracking-tight text-violet-700 dark:text-violet-300">
                    {formatTaskSuccessRate(summary.success, summary.fail)}
                  </p>
                </div>
                <span className="grid size-9 place-items-center rounded-xl bg-violet-100 text-violet-700 dark:bg-violet-400/15 dark:text-violet-300">
                  <Activity className="size-4" />
                </span>
              </div>
              <p className="mt-3 text-xs text-stone-500 dark:text-stone-400">
                成功 {formatCompact(summary.success)} · 失败{" "}
                {formatCompact(summary.fail)} · 在途{" "}
                <span
                  className={
                    summary.inflight > 0
                      ? "font-semibold text-amber-700 dark:text-amber-300"
                      : "font-medium text-stone-700 dark:text-stone-200"
                  }
                >
                  {summary.inflight}
                </span>
              </p>
            </CardContent>
          </Card>
        </div>

        <div className="grid gap-3 xl:grid-cols-[minmax(0,1.6fr)_minmax(300px,0.9fr)]">
          <Card className="rounded-2xl border-white/80 bg-white/95 shadow-sm dark:border-white/10 dark:bg-white/[0.03]">
            <CardContent className="p-4 sm:p-5">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="text-sm font-semibold text-stone-900 dark:text-white">
                    账号状态分布
                  </h2>
                  <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
                    点击任一状态，直接筛选对应账号
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => focusStatus("all")}
                  className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-stone-500 transition hover:bg-stone-100 hover:text-stone-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 dark:text-stone-300 dark:hover:bg-white/10 dark:hover:text-white"
                >
                  查看全部
                </button>
              </div>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {(
                  [
                    { status: "正常", key: "active" },
                    { status: "限流", key: "limited" },
                    { status: "异常", key: "abnormal" },
                    { status: "禁用", key: "disabled" },
                  ] as const
                ).map(({ status, key }) => {
                  const meta = statusOverviewMeta[status];
                  const StatusIcon = statusMeta[status].icon;
                  const count = displayedSummary[key];
                  const percentage = calculatePercentage(
                    count,
                    displayedSummary.total,
                  );
                  return (
                    <button
                      key={status}
                      type="button"
                      aria-pressed={statusFilter === status}
                      onClick={() => focusStatus(status)}
                      className={cn(
                        "min-h-24 rounded-xl border p-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500",
                        meta.surfaceClass,
                        statusFilter === status
                          ? "ring-2 ring-violet-500 ring-offset-2 dark:ring-offset-stone-950"
                          : "",
                      )}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <span
                          className={cn(
                            "grid size-7 place-items-center rounded-lg",
                            meta.iconClass,
                          )}
                        >
                          <StatusIcon className="size-3.5" />
                        </span>
                        <span
                          className={cn(
                            "font-mono text-xl font-semibold",
                            meta.textClass,
                          )}
                        >
                          {count}
                        </span>
                      </div>
                      <p className="mt-2 text-xs font-semibold text-stone-700 dark:text-stone-200">
                        {status}
                      </p>
                      <p className="mt-0.5 text-[11px] text-stone-500 dark:text-stone-400">
                        {meta.description}
                      </p>
                      <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/85 dark:bg-white/10">
                        <div
                          className={cn(
                            "h-full rounded-full transition-[width] duration-300 motion-reduce:transition-none",
                            meta.trackClass,
                          )}
                          style={{ width: `${percentage}%` }}
                        />
                      </div>
                    </button>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          <Card className="rounded-2xl border-white/80 bg-white/95 shadow-sm dark:border-white/10 dark:bg-white/[0.03]">
            <CardContent className="p-4 sm:p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-sm font-semibold text-stone-900 dark:text-white">
                    模型与同步
                  </h2>
                  <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
                    当前可用能力与数据新鲜度
                  </p>
                </div>
                <span className="grid size-8 place-items-center rounded-xl bg-stone-100 text-stone-600 dark:bg-white/10 dark:text-stone-300">
                  <Database className="size-4" />
                </span>
              </div>
              <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
                <div>
                  <dt className="text-stone-500 dark:text-stone-400">
                    可用模型
                  </dt>
                  <dd className="mt-1 font-mono text-base font-semibold text-stone-900 dark:text-white">
                    {isLoadingModels ? "…" : availableModels.length}
                  </dd>
                </div>
                <div>
                  <dt className="text-stone-500 dark:text-stone-400">
                    数据更新时间
                  </dt>
                  <dd className="mt-1 font-medium text-stone-700 dark:text-stone-200">
                    {lastSyncedAt ? formatDateTime(lastSyncedAt) : "—"}
                  </dd>
                </div>
              </dl>
              <div className="mt-4 flex flex-wrap gap-1.5">
                {availableModels.length > 0 ? (
                  visibleModels.map((model) => (
                    <button
                      key={model.id}
                      type="button"
                      className="inline-flex cursor-pointer items-center rounded-lg border border-stone-200 bg-white px-2 py-1 text-[11px] font-medium text-stone-600 transition hover:border-violet-200 hover:bg-violet-50 hover:text-violet-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 dark:border-white/10 dark:bg-white/5 dark:text-stone-300 dark:hover:bg-violet-400/10 dark:hover:text-violet-200"
                      onClick={() => {
                        void navigator.clipboard.writeText(model.id);
                        toast.success("模型名已复制");
                      }}
                      title={`点击复制 ${model.id}`}
                    >
                      {model.id}
                    </button>
                  ))
                ) : (
                  <span className="text-xs text-stone-400">
                    {isLoadingModels
                      ? "正在读取模型列表…"
                      : "当前未返回可用模型"}
                  </span>
                )}
              </div>
              {availableModels.length > 4 ? (
                <button
                  type="button"
                  className="mt-3 rounded-lg px-2 py-1 text-xs font-medium text-violet-700 transition hover:bg-violet-50 hover:text-violet-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 dark:text-violet-300 dark:hover:bg-violet-400/10 dark:hover:text-violet-100"
                  onClick={() =>
                    setIsModelListExpanded((expanded) => !expanded)
                  }
                  aria-expanded={isModelListExpanded}
                >
                  {isModelListExpanded
                    ? "收起模型列表"
                    : `展开其余 ${availableModels.length - visibleModels.length} 个模型`}
                </button>
              ) : null}
            </CardContent>
          </Card>
        </div>
      </section>

      <section id="account-list" className="scroll-mt-4 space-y-4">
        <div className="flex flex-col gap-4 rounded-2xl border border-stone-200/70 bg-white/75 p-3 shadow-sm backdrop-blur sm:p-4 lg:flex-row lg:items-center lg:justify-between dark:border-white/10 dark:bg-white/[0.035]">
          <div className="flex flex-wrap items-center gap-2.5">
            <div>
              <h2 className="text-lg font-semibold tracking-tight text-stone-950 dark:text-white">
                账号明细
              </h2>
              <p className="mt-0.5 text-xs text-stone-500 dark:text-stone-400">
                当前显示 {filteredAccounts.length} / {summary.total} 个账号
              </p>
            </div>
            <Badge
              variant="secondary"
              className="rounded-lg bg-stone-200 px-2 py-0.5 text-stone-700 dark:bg-white/10 dark:text-stone-200"
            >
              {filteredAccounts.length}
            </Badge>
          </div>

          <div className="grid gap-2 sm:grid-cols-2 lg:flex lg:items-center">
            <div className="relative sm:col-span-2 lg:min-w-[300px]">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-stone-400" />
              <Input
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setPage(1);
                }}
                aria-label="搜索账号"
                placeholder="搜索邮箱、Token、类型或来源"
                className="h-10 rounded-xl border-stone-200 bg-white/85 pl-10 dark:border-white/10 dark:bg-white/5"
              />
            </div>
            <Select
              value={typeFilter}
              onValueChange={(value) => {
                setTypeFilter(value);
                setPage(1);
              }}
            >
              <SelectTrigger
                aria-label="按账号类型筛选"
                className="h-10 w-full rounded-xl border-stone-200 bg-white/85 dark:border-white/10 dark:bg-white/5 lg:w-[150px]"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {accountTypeOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={statusFilter}
              onValueChange={(value) => {
                setStatusFilter(value as AccountStatus | "all");
                setPage(1);
              }}
            >
              <SelectTrigger
                aria-label="按账号状态筛选"
                className="h-10 w-full rounded-xl border-stone-200 bg-white/85 dark:border-white/10 dark:bg-white/5 lg:w-[150px]"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {accountStatusOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {query || typeFilter !== "all" || statusFilter !== "all" ? (
              <Button
                variant="ghost"
                className="h-10 rounded-xl px-3 text-stone-500 hover:bg-stone-100 hover:text-stone-900 dark:text-stone-300 dark:hover:bg-white/10 dark:hover:text-white"
                onClick={clearFilters}
              >
                清除筛选
              </Button>
            ) : null}
          </div>
        </div>

        {isLoading && accounts.length === 0 ? (
          <Card className="rounded-2xl border-white/80 bg-white/90 shadow-sm">
            <CardContent className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
              <div className="rounded-xl bg-stone-100 p-3 text-stone-500">
                <LoaderCircle className="size-5 animate-spin" />
              </div>
              <div className="space-y-1">
                <p className="text-sm font-medium text-stone-700">
                  正在加载账户
                </p>
                <p className="text-sm text-stone-500">
                  从后端同步账号列表和状态。
                </p>
              </div>
            </CardContent>
          </Card>
        ) : null}

        <Card
          className={cn(
            "overflow-hidden rounded-2xl border-white/80 bg-white/90 shadow-sm",
            isLoading && accounts.length === 0 ? "hidden" : "",
          )}
        >
          <CardContent className="space-y-0 p-0">
            <div className="flex min-h-14 flex-col gap-3 border-b border-stone-100 bg-stone-50/55 px-4 py-3 lg:flex-row lg:items-center lg:justify-between dark:border-white/10 dark:bg-white/[0.025]">
              <div className="flex flex-wrap items-center gap-2 text-sm text-stone-500">
                <Button
                  variant="ghost"
                  className="h-8 rounded-lg px-3 text-stone-500 hover:bg-stone-100"
                  onClick={() => void handleRefreshAccounts(selectedTokens)}
                  disabled={selectedTokens.length === 0 || isRefreshing}
                >
                  {isRefreshing ? (
                    <LoaderCircle className="size-4 animate-spin" />
                  ) : (
                    <RefreshCw className="size-4" />
                  )}
                  刷新所选
                </Button>
                <Button
                  variant="ghost"
                  className="h-8 rounded-lg px-3 text-amber-600 hover:bg-amber-50 hover:text-amber-700"
                  onClick={() => void handleReLogin(selectedTokens)}
                  disabled={selectedTokens.length === 0 || isRelogining}
                  title="尝试密码登录恢复账号"
                >
                  {isRelogining ? (
                    <LoaderCircle className="size-4 animate-spin" />
                  ) : (
                    <LogIn className="size-4" />
                  )}
                  恢复所选
                </Button>
                <Button
                  variant="ghost"
                  className="h-8 rounded-lg px-3 text-rose-500 hover:bg-rose-50 hover:text-rose-600"
                  onClick={() => void handleDeleteTokens(abnormalTokens)}
                  disabled={abnormalTokens.length === 0 || isDeleting}
                >
                  {isDeleting ? (
                    <LoaderCircle className="size-4 animate-spin" />
                  ) : (
                    <Trash2 className="size-4" />
                  )}
                  清理异常账号{abnormalTokens.length > 0 ? ` (${abnormalTokens.length})` : ""}
                </Button>
                <Button
                  variant="ghost"
                  className="h-8 rounded-lg px-3 text-rose-500 hover:bg-rose-50 hover:text-rose-600"
                  onClick={() => void handleDeleteTokens(selectedTokens)}
                  disabled={selectedTokens.length === 0 || isDeleting}
                >
                  {isDeleting ? (
                    <LoaderCircle className="size-4 animate-spin" />
                  ) : (
                    <Trash2 className="size-4" />
                  )}
                  删除所选
                </Button>
                {selectedIds.length > 0 ? (
                  <span className="rounded-lg bg-violet-100 px-2.5 py-1 text-xs font-semibold text-violet-700 dark:bg-violet-400/12 dark:text-violet-200">
                    已选择 {selectedIds.length} 项
                  </span>
                ) : null}
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full min-w-[960px] text-left">
                <thead className="sticky top-0 z-10 border-b border-stone-100 bg-stone-50/95 text-[11px] font-medium tracking-[0.14em] text-stone-500 uppercase backdrop-blur dark:border-white/10 dark:bg-stone-950/90 dark:text-stone-400">
                  <tr>
                    <th className="w-12 px-4 py-3.5">
                      <Checkbox
                        aria-label="选择当前页全部账号"
                        checked={allCurrentSelected}
                        onCheckedChange={(checked) =>
                          toggleSelectAll(Boolean(checked))
                        }
                      />
                    </th>
                    <th className="min-w-72 px-4 py-3.5">账号</th>
                    <th className="w-36 px-4 py-3.5">状态 / 额度</th>
                    <th className="min-w-44 px-4 py-3.5">调度与调用</th>
                    <th className="min-w-44 px-4 py-3.5">关键时间</th>
                    <th className="w-36 px-4 py-3.5 text-right">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {currentRows.map((account) => {
                    const status = statusMeta[account.status];
                    const StatusIcon = status.icon;
                    const restore = formatRestoreAt(account.restore_at);
                    const inflight = Math.max(0, account.image_inflight ?? 0);
                    const isSelected = selectedIds.includes(
                      account.access_token,
                    );

                    return (
                      <tr
                        key={account.access_token}
                        className={cn(
                          "border-b border-stone-100/80 text-sm text-stone-600 transition-colors hover:bg-violet-50/45 dark:border-white/8 dark:text-stone-300 dark:hover:bg-violet-400/8",
                          isSelected
                            ? "bg-violet-50/70 dark:bg-violet-400/10"
                            : "",
                        )}
                      >
                        <td className="px-4 py-3.5 align-top">
                          <Checkbox
                            aria-label={`选择 ${account.email ?? "账号"}`}
                            checked={isSelected}
                            onCheckedChange={(checked) => {
                              setSelectedIds((prev) =>
                                checked
                                  ? Array.from(
                                      new Set([...prev, account.access_token]),
                                    )
                                  : prev.filter(
                                      (item) => item !== account.access_token,
                                    ),
                              );
                            }}
                          />
                        </td>
                        <td className="px-4 py-3.5 align-top">
                          <div className="flex min-w-0 items-start justify-between gap-3">
                            <div className="min-w-0">
                              <p
                                className="truncate font-medium text-stone-800 dark:text-stone-100"
                                title={account.email ?? undefined}
                              >
                                {account.email ?? "未绑定邮箱"}
                              </p>
                              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                                <code className="rounded bg-stone-100 px-1.5 py-0.5 text-[11px] text-stone-500 dark:bg-white/10 dark:text-stone-300">
                                  {maskToken(account.access_token)}
                                </code>
                                <Badge
                                  variant="secondary"
                                  className="rounded-md bg-stone-100 text-[10px] text-stone-600 dark:bg-white/10 dark:text-stone-300"
                                >
                                  {displayAccountType(account)}
                                </Badge>
                                <Badge
                                  variant="outline"
                                  className="rounded-md border-stone-200 text-[10px] text-stone-500 dark:border-white/15 dark:text-stone-300"
                                >
                                  {displayAccountSource(account)}
                                </Badge>
                              </div>
                            </div>
                            <button
                              type="button"
                              aria-label={`复制 ${account.email ?? "账号"} 的 Token`}
                              className="grid size-8 shrink-0 place-items-center rounded-lg text-stone-400 transition hover:bg-stone-100 hover:text-stone-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 dark:hover:bg-white/10 dark:hover:text-white"
                              onClick={() => {
                                void navigator.clipboard.writeText(
                                  account.access_token,
                                );
                                toast.success("Token 已复制");
                              }}
                            >
                              <Copy className="size-4" />
                            </button>
                          </div>
                        </td>
                        <td className="px-4 py-3.5 align-top">
                          <Badge
                            variant={status.badge}
                            className="inline-flex items-center gap-1 rounded-md px-2 py-1"
                          >
                            <StatusIcon className="size-3.5" />
                            {account.status}
                          </Badge>
                          <div className="mt-2">
                            <span className="font-mono text-base font-semibold text-blue-700 dark:text-blue-300">
                              {formatQuota(account)}
                            </span>
                            <span className="ml-1 text-[11px] text-stone-400">
                              额度
                            </span>
                          </div>
                        </td>
                        <td className="px-4 py-3.5 align-top">
                          <div className="space-y-1.5 text-xs">
                            <div className="flex items-center justify-between gap-3">
                              <span className="text-stone-500 dark:text-stone-400">
                                在途任务
                              </span>
                              <span
                                className={cn(
                                  "font-mono font-semibold",
                                  inflight > 0
                                    ? "text-amber-700 dark:text-amber-300"
                                    : "text-stone-700 dark:text-stone-200",
                                )}
                                title={
                                  inflight > 0
                                    ? "当前正在生成的图片数"
                                    : "当前无在途生图任务"
                                }
                              >
                                {inflight}
                              </span>
                            </div>
                            <div className="flex items-center justify-between gap-3">
                              <span className="text-stone-500 dark:text-stone-400">
                                成功 / 失败
                              </span>
                              <span className="font-mono text-stone-700 dark:text-stone-200">
                                {account.success} / {account.fail}
                              </span>
                            </div>
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-stone-500 dark:text-stone-400">
                                成功率
                              </span>
                              <span
                                className={cn(
                                  "font-mono font-medium",
                                  account.fail > 0
                                    ? "text-stone-700 dark:text-stone-200"
                                    : "text-emerald-700 dark:text-emerald-300",
                                )}
                              >
                                {formatTaskSuccessRate(
                                  account.success,
                                  account.fail,
                                )}
                              </span>
                            </div>
                            <div className="h-1.5 overflow-hidden rounded-full bg-stone-100 dark:bg-white/10" aria-hidden="true">
                              <div
                                className={cn(
                                  "h-full rounded-full transition-[width] duration-300 motion-reduce:transition-none",
                                  account.fail > 0 ? "bg-amber-500" : "bg-emerald-500",
                                )}
                                style={{ width: `${calculatePercentage(account.success, account.success + account.fail)}%` }}
                              />
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3.5 align-top">
                          <div className="space-y-1.5 text-xs text-stone-500 dark:text-stone-400">
                            <div className="flex items-center gap-1.5">
                              <Clock3 className="size-3.5 shrink-0 text-stone-400" />
                              <span>
                                创建 {formatShortDateTime(account.created_at)}
                              </span>
                            </div>
                            <div>
                              最近使用{" "}
                              {formatShortDateTime(account.last_used_at)}
                            </div>
                            {restore.relative ? (
                              <div className="font-medium text-amber-700 dark:text-amber-300">
                                恢复 {restore.relative}
                              </div>
                            ) : null}
                          </div>
                        </td>
                        <td className="px-4 py-3.5 align-top">
                          <div className="flex items-center justify-end gap-1 text-stone-400">
                            <button
                              type="button"
                              aria-label={`编辑 ${account.email ?? "账号"}`}
                              title="编辑账号"
                              className="grid size-10 place-items-center rounded-xl transition hover:bg-stone-100 hover:text-stone-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 dark:hover:bg-white/10 dark:hover:text-white"
                              onClick={() => openEditDialog(account)}
                              disabled={isUpdating}
                            >
                              <Pencil className="size-4" />
                            </button>
                            <button
                              type="button"
                              aria-label={`刷新 ${account.email ?? "账号"}`}
                              title="刷新账号信息与额度"
                              className="grid size-10 place-items-center rounded-xl transition hover:bg-stone-100 hover:text-stone-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 dark:hover:bg-white/10 dark:hover:text-white"
                              onClick={() =>
                                void handleRefreshAccounts([
                                  account.access_token,
                                ])
                              }
                              disabled={
                                isRefreshing ||
                                refreshingTokens.has(account.access_token)
                              }
                            >
                              <RefreshCw
                                className={cn(
                                  "size-4",
                                  isRefreshing ||
                                    refreshingTokens.has(account.access_token)
                                    ? "animate-spin"
                                    : "",
                                )}
                              />
                            </button>
                            <button
                              type="button"
                              aria-label={`删除 ${account.email ?? "账号"}`}
                              title="删除账号"
                              className="grid size-10 place-items-center rounded-xl transition hover:bg-rose-50 hover:text-rose-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500 dark:hover:bg-rose-400/10"
                              onClick={() =>
                                void handleDeleteTokens([account.access_token])
                              }
                              disabled={isDeleting}
                            >
                              <Trash2 className="size-4" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              {!isLoading && currentRows.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
                  <div className="rounded-xl bg-stone-100 p-3 text-stone-500">
                    <Search className="size-5" />
                  </div>
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-stone-700">
                      没有匹配的账户
                    </p>
                    <p className="text-sm text-stone-500">
                      调整筛选条件或搜索关键字后重试。
                    </p>
                  </div>
                </div>
              ) : null}
            </div>

            <div className="border-t border-stone-100 px-4 py-4">
              <div className="flex items-center justify-center gap-3 overflow-x-auto whitespace-nowrap">
                <div className="shrink-0 text-sm text-stone-500">
                  显示第 {filteredAccounts.length === 0 ? 0 : startIndex + 1} -{" "}
                  {Math.min(
                    startIndex + Number(pageSize),
                    filteredAccounts.length,
                  )}{" "}
                  条，共 {filteredAccounts.length} 条
                </div>

                <span className="shrink-0 text-sm leading-none text-stone-500">
                  {safePage} / {pageCount} 页
                </span>
                <Select
                  value={pageSize}
                  onValueChange={(value) => {
                    setPageSize(value);
                    setPage(1);
                  }}
                >
                  <SelectTrigger className="h-10 w-[108px] shrink-0 rounded-lg border-stone-200 bg-white text-sm leading-none">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="10">10 / 页</SelectItem>
                    <SelectItem value="20">20 / 页</SelectItem>
                    <SelectItem value="50">50 / 页</SelectItem>
                    <SelectItem value="100">100 / 页</SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  variant="outline"
                  size="icon"
                  className="size-10 shrink-0 rounded-lg border-stone-200 bg-white"
                  disabled={safePage <= 1}
                  onClick={() => setPage((prev) => Math.max(1, prev - 1))}
                >
                  <ChevronLeft className="size-4" />
                </Button>
                {paginationItems.map((item, index) =>
                  item === "..." ? (
                    <span
                      key={`ellipsis-${index}`}
                      className="px-1 text-sm text-stone-400"
                    >
                      ...
                    </span>
                  ) : (
                    <Button
                      key={item}
                      variant={item === safePage ? "default" : "outline"}
                      className={cn(
                        "h-10 min-w-10 shrink-0 rounded-lg px-3",
                        item === safePage
                          ? "bg-stone-950 text-white hover:bg-stone-800"
                          : "border-stone-200 bg-white text-stone-700",
                      )}
                      onClick={() => setPage(item)}
                    >
                      {item}
                    </Button>
                  ),
                )}
                <Button
                  variant="outline"
                  size="icon"
                  className="size-10 shrink-0 rounded-lg border-stone-200 bg-white"
                  disabled={safePage >= pageCount}
                  onClick={() =>
                    setPage((prev) => Math.min(pageCount, prev + 1))
                  }
                >
                  <ChevronRight className="size-4" />
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </section>
    </>
  );
}

export default function AccountsPage() {
  const { isCheckingAuth, session } = useAuthGuard(["admin"]);

  if (isCheckingAuth || !session || session.role !== "admin") {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <LoaderCircle className="size-5 animate-spin text-stone-400" />
      </div>
    );
  }

  return <AccountsPageContent />;
}
