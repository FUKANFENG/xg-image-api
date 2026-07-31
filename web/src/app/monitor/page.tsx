"use client";

import {
  Activity,
  AlertTriangle,
  BarChart3,
  Clock3,
  Cloud,
  Database,
  ExternalLink,
  Gauge,
  LoaderCircle,
  RefreshCw,
  Server,
  ShieldCheck,
  TrendingUp,
  Users,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  fetchImageRuntimeMetrics,
  fetchImageStorageReadiness,
  testImageStorageConnection,
  type ImageRuntimeMetrics,
  type ImageStorageReadiness,
} from "@/lib/api";
import { useAuthGuard } from "@/lib/use-auth-guard";
import { cn } from "@/lib/utils";

const circuitLabels: Record<string, string> = {
  closed: "正常",
  open: "冷却中",
  half_open: "探测中",
};

const imageStorageModeLabels: Record<
  ImageStorageReadiness["image_protection"]["mode"],
  string
> = {
  local: "仅本机",
  webdav: "仅 WebDAV",
  both: "本机 + WebDAV",
};

const imageProtectionStatusLabels: Record<
  ImageStorageReadiness["image_protection"]["status"],
  string
> = {
  protected: "双副本受保护",
  warning: "仅远端副本",
  unprotected: "未启用异机副本",
  misconfigured: "远端配置不完整",
};

function formatGeneratedAt(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value || "--"
    : date.toLocaleString("zh-CN", { hour12: false });
}

function MetricCard({
  label,
  value,
  detail,
  icon: Icon,
  warning = false,
}: {
  label: string;
  value: string;
  detail: string;
  icon: typeof Activity;
  warning?: boolean;
}) {
  return (
    <article className="border-b border-stone-200 py-4 dark:border-white/10 md:border-b-0 md:border-r md:px-4 md:first:pl-0 md:last:border-r-0 md:last:pr-0">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium text-stone-500 dark:text-stone-400">
          {label}
        </span>
        <Icon
          className={cn(
            "size-4",
            warning ? "text-amber-600" : "text-stone-400",
          )}
          aria-hidden="true"
        />
      </div>
      <div className="mt-2 text-2xl font-semibold tracking-tight text-stone-950 dark:text-white">
        {value}
      </div>
      <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
        {detail}
      </p>
    </article>
  );
}

function MonitorContent() {
  const [metrics, setMetrics] = useState<ImageRuntimeMetrics | null>(null);
  const [readiness, setReadiness] = useState<ImageStorageReadiness | null>(
    null,
  );
  const [error, setError] = useState("");
  const [readinessError, setReadinessError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [refreshingReadiness, setRefreshingReadiness] = useState(false);
  const [testingRemoteStorage, setTestingRemoteStorage] = useState(false);
  const [remoteStorageTest, setRemoteStorageTest] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);

  const loadReadiness = useCallback(async (force = false) => {
    setRefreshingReadiness(true);
    try {
      const next = await fetchImageStorageReadiness(force);
      setReadiness(next);
      setReadinessError("");
    } catch (cause) {
      setReadiness(null);
      setReadinessError(
        cause instanceof Error ? cause.message : "图片保护状态加载失败",
      );
    } finally {
      setRefreshingReadiness(false);
    }
  }, []);

  const load = useCallback(
    async (manual = false) => {
      if (manual) setRefreshing(true);
      try {
        const next = await fetchImageRuntimeMetrics();
        setMetrics(next);
        setError("");
        if (manual) {
          void loadReadiness(true);
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "监控数据加载失败");
      } finally {
        if (manual) setRefreshing(false);
      }
    },
    [loadReadiness],
  );

  const testRemoteStorage = useCallback(async () => {
    setTestingRemoteStorage(true);
    setRemoteStorageTest(null);
    try {
      const result = await testImageStorageConnection();
      setRemoteStorageTest(
        result.result.ok
          ? { ok: true, message: "远端连接验证通过。" }
          : {
              ok: false,
              message: "远端连接未通过，请在设置页核对配置和网络。",
            },
      );
    } catch {
      setRemoteStorageTest({
        ok: false,
        message: "远端连接未通过，请在设置页核对配置和网络。",
      });
    } finally {
      setTestingRemoteStorage(false);
    }
  }, []);

  useEffect(() => {
    const initialTimer = window.setTimeout(() => {
      void load();
      void loadReadiness();
    }, 0);
    const metricsTimer = window.setInterval(() => void load(), 3000);
    const readinessTimer = window.setInterval(
      () => void loadReadiness(),
      30000,
    );
    return () => {
      window.clearTimeout(initialTimer);
      window.clearInterval(metricsTimer);
      window.clearInterval(readinessTimer);
    };
  }, [load, loadReadiness]);

  if (!metrics && !error) {
    return (
      <div className="grid min-h-[45vh] place-items-center">
        <LoaderCircle className="size-5 animate-spin text-stone-400" />
      </div>
    );
  }

  const accounts = metrics?.accounts.accounts ?? [];
  const errors = Object.entries(metrics?.errors ?? {}).slice(0, 8);
  const effectiveGlobalConcurrency =
    metrics?.queue.effective_global_concurrency ??
    metrics?.queue.global_concurrency ??
    0;
  const borrowedUserSlots = metrics?.queue.borrowed_user_slots ?? 0;
  const accountSlotCapacity = metrics?.queue.account_slot_capacity;
  const phases = metrics?.queue.phases ?? {
    submitting: 0,
    remote_running: 0,
    polling: 0,
  };
  const slotPercent = metrics?.accounts.total_slots
    ? Math.round(
        (metrics.accounts.used_slots / metrics.accounts.total_slots) * 100,
      )
    : 0;
  const maxDailyTotal = Math.max(
    1,
    ...(metrics?.analytics.daily.map((item) => item.total) || [1]),
  );
  const maxFeatureCount = Math.max(
    1,
    ...(metrics?.analytics.features.map((item) => item.count) || [1]),
  );

  return (
    <section className="mx-auto w-full max-w-[1500px] space-y-6">
      <header className="flex flex-col gap-4 border-b border-stone-200 pb-5 dark:border-white/10 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="text-xs font-semibold tracking-[0.18em] text-stone-500 uppercase">
            Runtime
          </div>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-stone-950 dark:text-stone-50">
            运行监控
          </h1>
          <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
            队列、吞吐、账号槽位与故障熔断，每 3 秒自动更新。
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-stone-400">
            {metrics ? formatGeneratedAt(metrics.generated_at) : "--"}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void load(true)}
            disabled={refreshing}
          >
            <RefreshCw className={cn("size-4", refreshing && "animate-spin")} />
            刷新
          </Button>
        </div>
      </header>

      {error ? (
        <div
          role="alert"
          className="flex items-center gap-2 border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-400/20 dark:bg-red-400/10 dark:text-red-200"
        >
          <AlertTriangle className="size-4" />
          {error}
        </div>
      ) : null}

      {metrics ? (
        <>
          <div className="grid border-y border-stone-200 dark:border-white/10 md:grid-cols-3 xl:grid-cols-6">
            <MetricCard
              label="正在生成"
              value={`${metrics.queue.running} / ${effectiveGlobalConcurrency}`}
              detail={`提交 ${phases.submitting} · 远程 ${phases.remote_running} · 轮询 ${phases.polling}`}
              icon={Activity}
            />
            <MetricCard
              label="等待队列"
              value={`${metrics.queue.queued}`}
              detail={`容量 ${metrics.queue.capacity} · 饱和 ${metrics.queue.saturation_percent}%`}
              icon={Gauge}
              warning={metrics.queue.saturation_percent >= 80}
            />
            <MetricCard
              label="平均耗时"
              value={`${metrics.analytics.summary.average_duration_secs}s`}
              detail={`生成 P95 ${metrics.performance.p95_secs}s · 排队 P95 ${metrics.performance.queue_wait_p95_ms ?? 0}ms`}
              icon={Clock3}
            />
            <MetricCard
              label="分钟吞吐"
              value={`${metrics.performance.throughput_per_minute}`}
              detail={`补位 P95 ${metrics.performance.slot_handoff_p95_ms ?? 0}ms · 槽位 ${accountSlotCapacity ?? "--"} · 借用 ${borrowedUserSlots}`}
              icon={Server}
            />
            <MetricCard
              label="任务成功率"
              value={`${metrics.analytics.summary.success_rate}%`}
              detail={`成功 ${metrics.tasks.success || 0} · 失败 ${metrics.tasks.error || 0}`}
              icon={TrendingUp}
              warning={
                metrics.analytics.summary.success_rate < 80 &&
                metrics.tasks.total > 0
              }
            />
            <MetricCard
              label="用户额度"
              value={`${metrics.user_quotas.remaining}`}
              detail={`${metrics.user_quotas.users} 位用户 · 已用 ${metrics.user_quotas.used}`}
              icon={Users}
            />
          </div>

          <div className="grid gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,.65fr)]">
            <section className="rounded-2xl border border-stone-200 bg-white p-5 dark:border-white/10 dark:bg-stone-950">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <BarChart3 className="size-4 text-violet-600" />
                    <h2 className="text-sm font-semibold text-stone-950 dark:text-white">
                      近 14 日任务量
                    </h2>
                  </div>
                  <p className="mt-1 text-xs text-stone-500">
                    柱高表示当日提交量，绿色段为成功任务。
                  </p>
                </div>
                <span className="text-xs tabular-nums text-stone-500">
                  合计{" "}
                  {metrics.analytics.daily.reduce(
                    (sum, item) => sum + item.total,
                    0,
                  )}
                </span>
              </div>
              <div
                className="mt-6 flex h-48 items-end gap-2 border-b border-stone-200 px-1 dark:border-white/10"
                role="img"
                aria-label="近十四日任务量柱状图"
              >
                {metrics.analytics.daily.map((item) => (
                  <div
                    key={item.date}
                    className="group flex min-w-0 flex-1 flex-col items-center justify-end gap-2"
                  >
                    <div className="relative flex h-36 w-full max-w-10 items-end overflow-hidden rounded-t-md bg-stone-100 dark:bg-white/5">
                      <div
                        className="w-full bg-violet-200 dark:bg-violet-400/20"
                        style={{
                          height: `${Math.max(5, (item.total / maxDailyTotal) * 100)}%`,
                        }}
                      >
                        <div
                          className="w-full bg-emerald-500"
                          style={{
                            height: `${item.total ? (item.success / item.total) * 100 : 0}%`,
                          }}
                        />
                      </div>
                      <span className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-2 hidden -translate-x-1/2 whitespace-nowrap rounded-lg bg-stone-900 px-2 py-1 text-[11px] text-white shadow-lg group-hover:block">
                        {item.date} · {item.total} 项 · 成功 {item.success}
                      </span>
                    </div>
                    <span className="max-w-full truncate text-[10px] text-stone-400">
                      {item.date.slice(5)}
                    </span>
                  </div>
                ))}
                {!metrics.analytics.daily.length ? (
                  <div className="grid h-full w-full place-items-center text-sm text-stone-400">
                    暂无趋势数据
                  </div>
                ) : null}
              </div>
            </section>
            <section className="rounded-2xl border border-stone-200 bg-white p-5 dark:border-white/10 dark:bg-stone-950">
              <h2 className="text-sm font-semibold text-stone-950 dark:text-white">
                功能使用分布
              </h2>
              <p className="mt-1 text-xs text-stone-500">
                识别生成、二创、修复与工具操作。
              </p>
              <div className="mt-5 space-y-3">
                {metrics.analytics.features.slice(0, 8).map((item) => (
                  <div key={item.name}>
                    <div className="flex items-center justify-between gap-3 text-xs">
                      <span className="truncate text-stone-600 dark:text-stone-300">
                        {item.name}
                      </span>
                      <span className="tabular-nums text-stone-500">
                        {item.count}
                      </span>
                    </div>
                    <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-stone-100 dark:bg-white/10">
                      <div
                        className="h-full rounded-full bg-violet-600"
                        style={{
                          width: `${Math.max(4, (item.count / maxFeatureCount) * 100)}%`,
                        }}
                      />
                    </div>
                  </div>
                ))}
                {!metrics.analytics.features.length ? (
                  <p className="py-8 text-center text-xs text-stone-400">
                    暂无功能数据
                  </p>
                ) : null}
              </div>
            </section>
          </div>

          <section className="overflow-hidden rounded-2xl border border-stone-200 bg-white dark:border-white/10 dark:bg-stone-950">
            <div className="flex items-center justify-between border-b border-stone-200 px-5 py-4 dark:border-white/10">
              <div>
                <h2 className="text-sm font-semibold text-stone-950 dark:text-white">
                  用户任务与额度排行
                </h2>
                <p className="mt-1 text-xs text-stone-500">
                  按任务量排序，用于识别高频和异常用户。
                </p>
              </div>
              <Users className="size-4 text-stone-400" />
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-left text-sm">
                <thead className="bg-stone-50 text-xs text-stone-500 dark:bg-white/5">
                  <tr>
                    <th className="px-5 py-3 font-medium">用户</th>
                    <th className="px-3 py-3 font-medium">分组</th>
                    <th className="px-3 py-3 text-right font-medium">任务</th>
                    <th className="px-3 py-3 text-right font-medium">成功</th>
                    <th className="px-3 py-3 text-right font-medium">失败</th>
                    <th className="px-5 py-3 text-right font-medium">
                      剩余额度
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-100 dark:divide-white/10">
                  {metrics.user_rankings.slice(0, 12).map((user) => (
                    <tr key={user.owner_id}>
                      <td className="px-5 py-3">
                        <div className="font-medium text-stone-800 dark:text-stone-100">
                          {user.name}
                        </div>
                        <div className="text-xs text-stone-400">
                          {user.username || user.owner_id}
                        </div>
                      </td>
                      <td className="px-3 py-3 text-stone-500">{user.group}</td>
                      <td className="px-3 py-3 text-right font-semibold tabular-nums">
                        {user.total}
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums text-emerald-600">
                        {user.success}
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums text-rose-600">
                        {user.error}
                      </td>
                      <td className="px-5 py-3 text-right tabular-nums text-stone-600 dark:text-stone-300">
                        {user.remaining_quota ?? "--"}
                      </td>
                    </tr>
                  ))}
                  {!metrics.user_rankings.length ? (
                    <tr>
                      <td
                        colSpan={6}
                        className="px-5 py-10 text-center text-stone-400"
                      >
                        暂无用户任务数据
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </section>

          <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
            <section className="min-w-0 border border-stone-200 bg-white dark:border-white/10 dark:bg-stone-950">
              <div className="flex items-center justify-between border-b border-stone-200 px-4 py-3 dark:border-white/10">
                <div>
                  <h2 className="text-sm font-semibold text-stone-950 dark:text-white">
                    账号运行状态
                  </h2>
                  <p className="mt-0.5 text-xs text-stone-500">
                    槽位 {metrics.accounts.used_slots}/
                    {metrics.accounts.total_slots} · 使用率 {slotPercent}% ·
                    冷却 {metrics.accounts.cooling_accounts}
                  </p>
                </div>
                <span
                  className={cn(
                    "text-xs font-medium",
                    metrics.accounts.cooling_accounts
                      ? "text-amber-600"
                      : "text-emerald-600",
                  )}
                >
                  {metrics.accounts.cooling_accounts
                    ? "存在熔断账号"
                    : "号池稳定"}
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[980px] text-left text-sm">
                  <thead className="bg-stone-50 text-xs text-stone-500 dark:bg-white/5 dark:text-stone-400">
                    <tr>
                      <th className="px-4 py-2.5 font-medium">账号</th>
                      <th className="px-3 py-2.5 font-medium">健康度</th>
                      <th className="px-3 py-2.5 font-medium">链路</th>
                      <th className="px-3 py-2.5 font-medium">槽位</th>
                      <th className="px-3 py-2.5 font-medium">预计完成</th>
                      <th className="px-3 py-2.5 font-medium">成功率</th>
                      <th className="px-3 py-2.5 font-medium">平均耗时</th>
                      <th className="px-3 py-2.5 font-medium">连续失败</th>
                      <th className="px-3 py-2.5 font-medium">熔断</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-stone-100 dark:divide-white/10">
                    {accounts.map((account, index) => (
                      <tr key={`${account.email}-${index}`}>
                        <td className="max-w-64 truncate px-4 py-3 font-medium text-stone-800 dark:text-stone-100">
                          {account.email}
                        </td>
                        <td className="px-3 py-3">
                          <span
                            className={cn(
                              "inline-flex min-w-14 justify-center rounded-full px-2 py-1 text-xs font-semibold tabular-nums",
                              account.health_level === "healthy"
                                ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-200"
                                : account.health_level === "warning"
                                  ? "bg-amber-50 text-amber-700 dark:bg-amber-400/10 dark:text-amber-200"
                                  : "bg-rose-50 text-rose-700 dark:bg-rose-400/10 dark:text-rose-200",
                            )}
                          >
                            {account.health_score}
                          </span>
                        </td>
                        <td className="px-3 py-3 text-stone-500 uppercase">
                          {account.source_type}
                        </td>
                        <td className="px-3 py-3 tabular-nums text-stone-700 dark:text-stone-200">
                          {account.inflight}/{account.concurrency_limit}
                        </td>
                        <td className="px-3 py-3 tabular-nums text-stone-500">
                          {account.predicted_finish_ms
                            ? `${Math.round(account.predicted_finish_ms / 1000)}s`
                            : "--"}
                          {account.scheduler_rank ? (
                            <span className="ml-1 text-xs text-stone-400">
                              #{account.scheduler_rank}
                            </span>
                          ) : null}
                        </td>
                        <td className="px-3 py-3 tabular-nums text-stone-500">
                          {account.success_rate === null
                            ? "--"
                            : `${account.success_rate}%`}
                          <span className="ml-1 text-xs text-stone-400">
                            ({account.success_count}/
                            {account.success_count + account.failure_count})
                          </span>
                        </td>
                        <td className="px-3 py-3 tabular-nums text-stone-500">
                          {account.average_duration_secs
                            ? `${account.average_duration_secs}s`
                            : "--"}
                        </td>
                        <td className="px-3 py-3 tabular-nums text-stone-500">
                          {account.consecutive_failures}
                        </td>
                        <td className="px-3 py-3">
                          <span
                            className={cn(
                              "inline-flex items-center gap-1.5 text-xs font-medium",
                              account.circuit_state === "closed"
                                ? "text-emerald-600"
                                : "text-amber-600",
                            )}
                          >
                            <span className="size-1.5 rounded-full bg-current" />
                            {circuitLabels[account.circuit_state] ||
                              account.circuit_state}
                            {account.cooldown_remaining_secs
                              ? ` ${account.cooldown_remaining_secs}s`
                              : ""}
                          </span>
                        </td>
                      </tr>
                    ))}
                    {!accounts.length ? (
                      <tr>
                        <td
                          colSpan={9}
                          className="px-4 py-10 text-center text-stone-400"
                        >
                          暂无账号运行数据
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </section>

            <aside className="space-y-6">
              <section className="border border-stone-200 bg-white p-4 dark:border-white/10 dark:bg-stone-950">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <Cloud className="size-4 text-violet-600" />
                    <div>
                      <h2 className="text-sm font-semibold text-stone-950 dark:text-white">
                        图片异机保护
                      </h2>
                      <p className="mt-0.5 text-xs text-stone-500">
                        与系统备份包独立统计。
                      </p>
                    </div>
                  </div>
                  {readiness ? (
                    <span
                      className={cn(
                        "rounded-full px-2 py-1 text-[11px] font-medium",
                        readiness.image_protection.status === "protected"
                          ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-200"
                          : readiness.image_protection.status === "unprotected"
                            ? "bg-rose-50 text-rose-700 dark:bg-rose-400/10 dark:text-rose-200"
                            : "bg-amber-50 text-amber-700 dark:bg-amber-400/10 dark:text-amber-200",
                      )}
                    >
                      {
                        imageProtectionStatusLabels[
                          readiness.image_protection.status
                        ]
                      }
                    </span>
                  ) : (
                    <LoaderCircle
                      className={cn(
                        "size-4 text-stone-400",
                        refreshingReadiness && "animate-spin",
                      )}
                    />
                  )}
                </div>

                {readiness ? (
                  <>
                    <p className="mt-3 text-xs leading-5 text-stone-500 dark:text-stone-400">
                      {readiness.image_protection.recommendation}
                    </p>
                    <dl className="mt-4 grid grid-cols-2 gap-y-3 text-sm">
                      <dt className="text-stone-500">当前模式</dt>
                      <dd className="text-right font-medium text-stone-700 dark:text-stone-200">
                        {
                          imageStorageModeLabels[
                            readiness.image_protection.mode
                          ]
                        }
                      </dd>
                      <dt className="text-stone-500">远端副本</dt>
                      <dd
                        className={cn(
                          "text-right font-medium",
                          readiness.image_protection.remote_enabled &&
                            readiness.image_protection.remote_configured
                            ? "text-emerald-600"
                            : "text-amber-600",
                        )}
                      >
                        {readiness.image_protection.remote_enabled
                          ? readiness.image_protection.remote_configured
                            ? "已配置"
                            : "待补齐"
                          : "未启用"}
                      </dd>
                      <dt className="text-stone-500">已覆盖图片</dt>
                      <dd className="text-right tabular-nums text-stone-700 dark:text-stone-200">
                        {readiness.integrity.backed_up}/
                        {readiness.integrity.unique_images}
                      </dd>
                      <dt className="text-stone-500">待补传</dt>
                      <dd
                        className={cn(
                          "text-right tabular-nums",
                          readiness.integrity.local_only
                            ? "text-amber-600"
                            : "text-stone-700 dark:text-stone-200",
                        )}
                      >
                        {readiness.integrity.local_only}
                      </dd>
                      <dt className="text-stone-500">缺失图片</dt>
                      <dd
                        className={cn(
                          "text-right tabular-nums",
                          readiness.integrity.missing
                            ? "text-rose-600"
                            : "text-stone-700 dark:text-stone-200",
                        )}
                      >
                        {readiness.integrity.missing}
                      </dd>
                      <dt className="text-stone-500">系统备份包</dt>
                      <dd className="text-right text-xs font-medium text-stone-700 dark:text-stone-200">
                        {readiness.system_backup.enabled
                          ? readiness.system_backup.includes_images
                            ? "已包含图片"
                            : "不含图片"
                          : "未启用"}
                      </dd>
                    </dl>
                    <div className="mt-4 flex flex-wrap gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="min-h-9"
                        disabled={refreshingReadiness}
                        onClick={() => void loadReadiness(true)}
                      >
                        <RefreshCw
                          className={cn(
                            "size-3.5",
                            refreshingReadiness && "animate-spin",
                          )}
                        />
                        重新体检
                      </Button>
                      {readiness.image_protection.remote_enabled ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="min-h-9"
                          disabled={testingRemoteStorage}
                          onClick={() => void testRemoteStorage()}
                        >
                          {testingRemoteStorage ? (
                            <LoaderCircle className="size-3.5 animate-spin" />
                          ) : (
                            <ShieldCheck className="size-3.5" />
                          )}
                          验证远端连接
                        </Button>
                      ) : null}
                      <Button
                        asChild
                        size="sm"
                        variant="ghost"
                        className="min-h-9"
                      >
                        <Link href="/settings">
                          配置图片存储
                          <ExternalLink className="size-3.5" />
                        </Link>
                      </Button>
                    </div>
                    {remoteStorageTest ? (
                      <p
                        className={cn(
                          "mt-3 text-xs",
                          remoteStorageTest.ok
                            ? "text-emerald-600"
                            : "text-rose-600",
                        )}
                        role="status"
                      >
                        {remoteStorageTest.message}
                      </p>
                    ) : null}
                  </>
                ) : (
                  <div className="mt-4 rounded-lg bg-stone-50 p-3 text-xs leading-5 text-stone-500 dark:bg-white/5 dark:text-stone-400">
                    <p>{readinessError || "正在读取图片副本与体检状态。"}</p>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="mt-2 min-h-8 px-2"
                      disabled={refreshingReadiness}
                      onClick={() => void loadReadiness(true)}
                    >
                      重试
                    </Button>
                  </div>
                )}
              </section>
              <section className="border border-stone-200 bg-white p-4 dark:border-white/10 dark:bg-stone-950">
                <div className="flex items-center gap-2">
                  <Database className="size-4 text-stone-400" />
                  <h2 className="text-sm font-semibold text-stone-950 dark:text-white">
                    任务存储
                  </h2>
                </div>
                <dl className="mt-4 grid grid-cols-2 gap-y-3 text-sm">
                  <dt className="text-stone-500">状态</dt>
                  <dd className="text-right font-medium text-emerald-600">
                    {metrics.storage.healthy ? "健康" : "异常"}
                  </dd>
                  <dt className="text-stone-500">日志模式</dt>
                  <dd className="text-right font-mono uppercase text-stone-700 dark:text-stone-200">
                    {metrics.storage.journal_mode}
                  </dd>
                  <dt className="text-stone-500">完整性</dt>
                  <dd className="text-right font-mono text-stone-700 dark:text-stone-200">
                    {metrics.storage.quick_check}
                  </dd>
                  <dt className="text-stone-500">任务总数</dt>
                  <dd className="text-right tabular-nums text-stone-700 dark:text-stone-200">
                    {metrics.tasks.total}
                  </dd>
                </dl>
              </section>
              <section className="border border-stone-200 bg-white p-4 dark:border-white/10 dark:bg-stone-950">
                <div className="flex items-center gap-2">
                  <Server className="size-4 text-stone-400" />
                  <h2 className="text-sm font-semibold text-stone-950 dark:text-white">
                    安全与备份
                  </h2>
                </div>
                <dl className="mt-4 grid grid-cols-2 gap-y-3 text-sm">
                  <dt className="text-stone-500">管理员密码</dt>
                  <dd
                    className={cn(
                      "text-right font-medium",
                      metrics.security.weak_admin_password
                        ? "text-amber-600"
                        : "text-emerald-600",
                    )}
                  >
                    {metrics.security.weak_admin_password
                      ? "需要加强"
                      : "强度正常"}
                  </dd>
                  <dt className="text-stone-500">AI 审核</dt>
                  <dd
                    className={cn(
                      "text-right font-medium",
                      metrics.security.ai_review_enabled
                        ? "text-emerald-600"
                        : "text-stone-500",
                    )}
                  >
                    {metrics.security.ai_review_enabled
                      ? "已启用"
                      : "未配置密钥"}
                  </dd>
                  <dt className="text-stone-500">自动备份</dt>
                  <dd
                    className={cn(
                      "text-right font-medium",
                      metrics.security.backup_enabled
                        ? "text-emerald-600"
                        : "text-amber-600",
                    )}
                  >
                    {metrics.security.backup_enabled ? "已启用" : "未启用"}
                  </dd>
                  <dt className="text-stone-500">最近备份</dt>
                  <dd className="text-right font-medium text-stone-700 dark:text-stone-200">
                    {metrics.security.backup_last_status || "未执行"}
                  </dd>
                </dl>
              </section>
              <section className="border border-stone-200 bg-white p-4 dark:border-white/10 dark:bg-stone-950">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="size-4 text-stone-400" />
                  <h2 className="text-sm font-semibold text-stone-950 dark:text-white">
                    错误分类
                  </h2>
                </div>
                <div className="mt-3 space-y-2">
                  {errors.map(([code, count]) => (
                    <div
                      key={code}
                      className="flex items-center justify-between gap-3 text-xs"
                    >
                      <span className="min-w-0 truncate text-stone-500">
                        {code}
                      </span>
                      <span className="font-medium tabular-nums text-stone-800 dark:text-stone-100">
                        {count}
                      </span>
                    </div>
                  ))}
                  {!errors.length ? (
                    <p className="py-3 text-xs text-stone-400">暂无失败记录</p>
                  ) : null}
                </div>
              </section>
            </aside>
          </div>
        </>
      ) : null}
    </section>
  );
}

export default function MonitorPage() {
  const { isCheckingAuth, session } = useAuthGuard(["admin"]);
  if (isCheckingAuth || !session || session.role !== "admin") {
    return (
      <div className="grid min-h-[40vh] place-items-center">
        <LoaderCircle className="size-5 animate-spin text-stone-400" />
      </div>
    );
  }
  return <MonitorContent />;
}
