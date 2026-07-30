"use client";

import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleGauge,
  Clock3,
  ImageIcon,
  ListRestart,
  LoaderCircle,
  RefreshCw,
  Search,
  ServerCog,
  SlidersHorizontal,
  Sparkles,
  Workflow,
  X,
} from "lucide-react";
import Link from "next/link";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { ApiTaskCard } from "@/app/api-tasks/api-task-card";
import { ApiTaskDetail } from "@/app/api-tasks/api-task-detail";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  fetchAdminImageTaskOverview,
  type ImageTask,
  type ImageTaskOverviewSummary,
} from "@/lib/api";
import { useAuthGuard } from "@/lib/use-auth-guard";

const PAGE_SIZE = 30;

const EMPTY_SUMMARY: ImageTaskOverviewSummary = {
  total: 0,
  queued: 0,
  paused: 0,
  running: 0,
  success: 0,
  error: 0,
  api: 0,
  queue: 0,
};

type Filters = {
  status: string;
  source: string;
  mode: string;
  query: string;
};

export default function ApiTasksPage() {
  const { isCheckingAuth, session } = useAuthGuard(["admin"]);
  const [items, setItems] = useState<ImageTask[]>([]);
  const [summary, setSummary] =
    useState<ImageTaskOverviewSummary>(EMPTY_SUMMARY);
  const [filters, setFilters] = useState<Filters>({
    status: "",
    source: "",
    mode: "",
    query: "",
  });
  const [queryDraft, setQueryDraft] = useState("");
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
  const [selectedTask, setSelectedTask] = useState<ImageTask | null>(null);

  const load = useCallback(
    async (quiet = false) => {
      if (!session) return;
      if (quiet) setRefreshing(true);
      else setLoading(true);
      try {
        const response = await fetchAdminImageTaskOverview({
          limit: PAGE_SIZE,
          offset,
          status: filters.status,
          source: filters.source,
          mode: filters.mode,
          query: filters.query,
        });
        setItems(response.items);
        setSummary(response.summary);
        setTotal(response.pagination.total);
        setHasMore(response.pagination.has_more);
        setLastUpdatedAt(new Date());
        setSelectedTask((current) => {
          if (!current) return null;
          return (
            response.items.find((item) => item.id === current.id) || current
          );
        });
      } catch (error) {
        if (!quiet) {
          toast.error(
            error instanceof Error ? error.message : "生图任务加载失败",
          );
        }
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [filters, offset, session],
  );

  useEffect(() => {
    if (!session) return;
    const initialTimer = window.setTimeout(() => void load(), 0);
    const pollTimer = window.setInterval(() => void load(true), 3000);
    return () => {
      window.clearTimeout(initialTimer);
      window.clearInterval(pollTimer);
    };
  }, [load, session]);

  const updateFilter = (key: keyof Omit<Filters, "query">, value: string) => {
    setOffset(0);
    setFilters((current) => ({
      ...current,
      [key]: value === "all" ? "" : value,
    }));
  };

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    const next = queryDraft.trim();
    setOffset(0);
    if (next === filters.query) {
      void load();
      return;
    }
    setFilters((current) => ({ ...current, query: next }));
  };

  const resetFilters = () => {
    setQueryDraft("");
    setOffset(0);
    setFilters({ status: "", source: "", mode: "", query: "" });
  };

  if (isCheckingAuth || !session || session.role !== "admin") {
    return (
      <main className="grid min-h-[70vh] place-items-center bg-stone-50 dark:bg-stone-950">
        <LoaderCircle className="size-6 animate-spin text-stone-400" />
      </main>
    );
  }

  const activeCount = summary.running + summary.queued + summary.paused;
  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const filtersActive = Object.values(filters).some(Boolean);
  const summaryCards = [
    {
      label: "全部任务",
      value: summary.total,
      helper: `${summary.api} 次 API · ${summary.queue} 个队列`,
      icon: CircleGauge,
      tone: "bg-stone-100 text-stone-700 dark:bg-white/10 dark:text-stone-200",
    },
    {
      label: "执行中",
      value: activeCount,
      helper: `${summary.running} 生成 · ${summary.queued + summary.paused} 等待`,
      icon: Activity,
      tone: "bg-sky-50 text-sky-700 dark:bg-sky-400/10 dark:text-sky-300",
    },
    {
      label: "已完成",
      value: summary.success,
      helper:
        summary.total > 0
          ? `${Math.round((summary.success / summary.total) * 100)}% 完成率`
          : "暂无任务",
      icon: CheckCircle2,
      tone:
        "bg-emerald-50 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300",
    },
    {
      label: "失败",
      value: summary.error,
      helper: summary.error ? "可按失败状态筛选" : "运行正常",
      icon: AlertTriangle,
      tone:
        "bg-rose-50 text-rose-700 dark:bg-rose-400/10 dark:text-rose-300",
    },
  ];

  return (
    <main className="min-h-screen bg-stone-50 px-3 py-5 text-stone-950 sm:px-6 lg:px-8 dark:bg-stone-950 dark:text-white">
      <div className="mx-auto max-w-[1500px] space-y-5">
        <header className="overflow-hidden rounded-3xl border border-stone-200 bg-white shadow-sm dark:border-white/10 dark:bg-stone-900">
          <div className="grid gap-6 px-5 py-6 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end lg:px-7">
            <div>
              <div className="flex items-center gap-2 text-xs font-bold tracking-[0.16em] text-stone-500 uppercase">
                <Sparkles className="size-3.5" />
                Image activity
              </div>
              <h1 className="mt-2 text-2xl font-black tracking-tight sm:text-3xl">
                API 生图任务
              </h1>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-stone-500 dark:text-stone-400">
                统一查看同步 API 与异步队列产生的图片任务、提示词、实际输出及调用状态。
                页面每 3 秒自动更新。
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                className="h-10 rounded-xl border-stone-200 bg-white dark:border-white/10 dark:bg-stone-900"
                asChild
              >
                <Link href="/queue">
                  <ListRestart className="size-4" />
                  队列控制
                </Link>
              </Button>
              <Button
                variant="outline"
                className="h-10 rounded-xl border-stone-200 bg-white dark:border-white/10 dark:bg-stone-900"
                asChild
              >
                <Link href="/image-manager">
                  <ImageIcon className="size-4" />
                  图片管理
                </Link>
              </Button>
              <Button
                type="button"
                className="h-10 rounded-xl bg-stone-950 px-4 text-white hover:bg-stone-800 dark:bg-white dark:text-stone-950 dark:hover:bg-stone-200"
                onClick={() => void load(true)}
                disabled={refreshing}
              >
                <RefreshCw
                  className={`size-4 ${refreshing ? "animate-spin" : ""}`}
                />
                刷新
              </Button>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-stone-100 bg-stone-50/70 px-5 py-3 text-xs text-stone-500 lg:px-7 dark:border-white/10 dark:bg-white/[0.025] dark:text-stone-400">
            <span className="inline-flex items-center gap-1.5">
              <span className="relative flex size-2">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-50" />
                <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
              </span>
              自动刷新已开启
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Clock3 className="size-3.5" />
              最近更新：
              {lastUpdatedAt
                ? lastUpdatedAt.toLocaleTimeString("zh-CN", {
                    hour12: false,
                  })
                : "等待首次同步"}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <ServerCog className="size-3.5" />
              记录默认保留 15 天
            </span>
          </div>
        </header>

        <section
          className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
          aria-label="任务统计"
        >
          {summaryCards.map(({ label, value, helper, icon: Icon, tone }) => (
            <article
              key={label}
              className="rounded-2xl border border-stone-200 bg-white p-4 dark:border-white/10 dark:bg-stone-900"
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-xs font-medium text-stone-500">{label}</p>
                  <p className="mt-1 text-2xl font-black tracking-tight">
                    {value}
                  </p>
                  <p className="mt-1 text-xs text-stone-400">{helper}</p>
                </div>
                <span
                  className={`grid size-10 shrink-0 place-items-center rounded-xl ${tone}`}
                >
                  <Icon className="size-5" />
                </span>
              </div>
            </article>
          ))}
        </section>

        <section className="rounded-3xl border border-stone-200 bg-white p-4 shadow-sm sm:p-5 dark:border-white/10 dark:bg-stone-900">
          <div className="mb-4 flex items-center gap-2">
            <SlidersHorizontal className="size-4 text-stone-400" />
            <h2 className="text-sm font-bold">筛选任务</h2>
            {filtersActive ? (
              <button
                type="button"
                onClick={resetFilters}
                className="ml-auto inline-flex min-h-9 items-center gap-1 rounded-lg px-2 text-xs font-semibold text-stone-500 hover:bg-stone-100 hover:text-stone-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-stone-900 dark:hover:bg-white/10 dark:hover:text-white"
              >
                <X className="size-3.5" />
                清除筛选
              </button>
            ) : null}
          </div>
          <form
            onSubmit={submitSearch}
            className="grid gap-3 md:grid-cols-2 xl:grid-cols-[minmax(280px,1fr)_180px_180px_180px_auto]"
          >
            <label className="relative block">
              <span className="sr-only">搜索提示词、任务 ID 或调用方</span>
              <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-stone-400" />
              <Input
                id="api-task-query"
                name="query"
                value={queryDraft}
                onChange={(event) => setQueryDraft(event.target.value)}
                placeholder="搜索提示词、任务 ID、模型或调用方"
                className="h-11 rounded-xl border-stone-200 bg-stone-50 pl-10 dark:border-white/10 dark:bg-white/5"
              />
            </label>
            <Select
              name="status"
              value={filters.status || "all"}
              onValueChange={(value) => updateFilter("status", value)}
            >
              <SelectTrigger
                className="h-11 rounded-xl border-stone-200 shadow-none dark:border-white/10"
                aria-label="任务状态"
              >
                <SelectValue placeholder="全部状态" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部状态</SelectItem>
                <SelectItem value="running">生成中</SelectItem>
                <SelectItem value="queued">等待中</SelectItem>
                <SelectItem value="paused">已暂停</SelectItem>
                <SelectItem value="success">已完成</SelectItem>
                <SelectItem value="error">失败</SelectItem>
              </SelectContent>
            </Select>
            <Select
              name="source"
              value={filters.source || "all"}
              onValueChange={(value) => updateFilter("source", value)}
            >
              <SelectTrigger
                className="h-11 rounded-xl border-stone-200 shadow-none dark:border-white/10"
                aria-label="任务来源"
              >
                <SelectValue placeholder="全部来源" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部来源</SelectItem>
                <SelectItem value="api">同步 API</SelectItem>
                <SelectItem value="queue">异步队列</SelectItem>
              </SelectContent>
            </Select>
            <Select
              name="mode"
              value={filters.mode || "all"}
              onValueChange={(value) => updateFilter("mode", value)}
            >
              <SelectTrigger
                className="h-11 rounded-xl border-stone-200 shadow-none dark:border-white/10"
                aria-label="生图模式"
              >
                <SelectValue placeholder="全部模式" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部模式</SelectItem>
                <SelectItem value="generate">文生图</SelectItem>
                <SelectItem value="edit">图片编辑</SelectItem>
              </SelectContent>
            </Select>
            <Button
              type="submit"
              className="h-11 rounded-xl bg-stone-950 px-5 text-white hover:bg-stone-800 dark:bg-white dark:text-stone-950"
            >
              <Search className="size-4" />
              查询
            </Button>
          </form>
        </section>

        <section aria-labelledby="task-list-heading">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3 px-1">
            <div>
              <h2 id="task-list-heading" className="text-sm font-bold">
                任务记录
              </h2>
              <p className="mt-1 text-xs text-stone-400">
                当前筛选共 {total} 条，第 {page} / {pageCount} 页
              </p>
            </div>
            {refreshing ? (
              <span className="inline-flex items-center gap-1.5 text-xs text-stone-400">
                <RefreshCw className="size-3.5 animate-spin" />
                正在同步
              </span>
            ) : null}
          </div>

          {loading ? (
            <div className="grid min-h-80 place-items-center rounded-3xl border border-stone-200 bg-white dark:border-white/10 dark:bg-stone-900">
              <div className="text-center">
                <LoaderCircle className="mx-auto size-7 animate-spin text-stone-400" />
                <p className="mt-3 text-sm text-stone-500">
                  正在读取生图任务
                </p>
              </div>
            </div>
          ) : items.length ? (
            <div className="space-y-3">
              {items.map((task) => (
                <ApiTaskCard
                  key={`${task.owner_id || "owner"}-${task.id}`}
                  task={task}
                  onSelect={setSelectedTask}
                />
              ))}
            </div>
          ) : (
            <div className="grid min-h-80 place-items-center rounded-3xl border border-dashed border-stone-300 bg-white text-center dark:border-white/15 dark:bg-stone-900">
              <div className="max-w-sm px-6">
                <Workflow className="mx-auto size-10 text-stone-300 dark:text-stone-600" />
                <h3 className="mt-4 font-bold">
                  {filtersActive ? "没有符合条件的任务" : "暂时没有生图任务"}
                </h3>
                <p className="mt-2 text-sm leading-6 text-stone-500">
                  {filtersActive
                    ? "调整或清除筛选条件后再试。"
                    : "外部服务调用生图 API 后，任务会自动出现在这里。"}
                </p>
                {filtersActive ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="mt-4 h-10 rounded-xl"
                    onClick={resetFilters}
                  >
                    清除筛选
                  </Button>
                ) : null}
              </div>
            </div>
          )}

          {total > 0 ? (
            <nav
              className="mt-4 flex items-center justify-between gap-3 rounded-2xl border border-stone-200 bg-white p-3 dark:border-white/10 dark:bg-stone-900"
              aria-label="任务分页"
            >
              <p className="text-xs text-stone-500">
                显示 {offset + 1}–{Math.min(offset + items.length, total)} /{" "}
                {total}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  className="h-9 rounded-lg"
                  disabled={offset === 0 || loading}
                  onClick={() =>
                    setOffset((current) => Math.max(0, current - PAGE_SIZE))
                  }
                >
                  <ChevronLeft className="size-4" />
                  上一页
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="h-9 rounded-lg"
                  disabled={!hasMore || loading}
                  onClick={() => setOffset((current) => current + PAGE_SIZE)}
                >
                  下一页
                  <ChevronRight className="size-4" />
                </Button>
              </div>
            </nav>
          ) : null}
        </section>
      </div>

      <ApiTaskDetail
        task={selectedTask}
        open={Boolean(selectedTask)}
        onOpenChange={(open) => {
          if (!open) setSelectedTask(null);
        }}
      />
    </main>
  );
}
