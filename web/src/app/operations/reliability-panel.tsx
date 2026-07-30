"use client";

import { useCallback, useEffect, useState } from "react";
import { Activity, Clock3, RefreshCw, Search, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  fetchQuotaLedger,
  fetchSchedulerOverview,
  fetchTaskTimeline,
  type QuotaLedgerEvent,
  type SchedulerAccount,
  type TaskTimeline,
} from "@/lib/api";

import {
  EmptyState,
  MetricCard,
  SectionHeading,
  StatusPill,
  Surface,
} from "./operations-ui";

const actionLabels: Record<QuotaLedgerEvent["action"], string> = {
  allocate: "初始分配",
  adjust: "额度调整",
  reserve: "任务预扣",
  consume: "成功核销",
  refund: "失败退回",
};

export function ReliabilityPanel({ isAdmin }: { isAdmin: boolean }) {
  const [accounts, setAccounts] = useState<SchedulerAccount[]>([]);
  const [slots, setSlots] = useState({ total: 0, used: 0, cooling: 0 });
  const [ledger, setLedger] = useState<QuotaLedgerEvent[]>([]);
  const [ledgerTotal, setLedgerTotal] = useState(0);
  const [taskId, setTaskId] = useState("");
  const [timeline, setTimeline] = useState<TaskTimeline | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isTimelineLoading, setIsTimelineLoading] = useState(false);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const [ledgerResult, schedulerResult] = await Promise.all([
        fetchQuotaLedger({ limit: 50 }),
        isAdmin ? fetchSchedulerOverview() : Promise.resolve(null),
      ]);
      setLedger(ledgerResult.data);
      setLedgerTotal(
        ledgerResult.pagination?.total || ledgerResult.data.length,
      );
      if (schedulerResult) {
        setAccounts(schedulerResult.data.accounts);
        setSlots({
          total: schedulerResult.data.total_slots,
          used: schedulerResult.data.used_slots,
          cooling: schedulerResult.data.cooling_accounts,
        });
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "可靠性数据加载失败",
      );
    } finally {
      setIsLoading(false);
    }
  }, [isAdmin]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const searchTimeline = async () => {
    const id = taskId.trim();
    if (!id) {
      toast.error("请输入任务 ID");
      return;
    }
    setIsTimelineLoading(true);
    try {
      const result = await fetchTaskTimeline(id);
      setTimeline(result.data);
    } catch (error) {
      setTimeline(null);
      toast.error(
        error instanceof Error ? error.message : "任务时间线加载失败",
      );
    } finally {
      setIsTimelineLoading(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="额度流水"
          value={ledgerTotal}
          hint="预扣、核销、退回和调整均可追溯"
        />
        <MetricCard
          label="有效并发槽位"
          value={isAdmin ? slots.total : "按账号池调度"}
          hint={isAdmin ? `当前占用 ${slots.used}` : "用户任务自动公平排队"}
        />
        <MetricCard
          label="熔断账号"
          value={isAdmin ? slots.cooling : "自动隔离"}
          hint="异常账号不会继续接收新任务"
        />
        <MetricCard
          label="恢复策略"
          value="检查点优先"
          hint="重启后续跑安全任务，不安全任务自动退额"
        />
      </div>

      {isAdmin ? (
        <Surface>
          <SectionHeading
            eyebrow="P0 · ACCOUNT ROUTING"
            title="智能账号调度"
            description="先平衡在途任务，再综合剩余额度、成功率、连续失败和历史耗时选择账号。"
            action={
              <Button
                type="button"
                variant="outline"
                className="min-h-11 gap-2 rounded-xl"
                disabled={isLoading}
                onClick={() => void load()}
              >
                <RefreshCw
                  className={isLoading ? "size-4 animate-spin" : "size-4"}
                />
                刷新
              </Button>
            }
          />
          <div className="overflow-x-auto p-5">
            {accounts.length ? (
              <table className="w-full min-w-[860px] text-left text-sm">
                <thead className="text-xs text-stone-500 dark:text-stone-400">
                  <tr className="border-b border-stone-200 dark:border-white/10">
                    <th className="px-3 py-3 font-medium">排序</th>
                    <th className="px-3 py-3 font-medium">账号</th>
                    <th className="px-3 py-3 font-medium">状态</th>
                    <th className="px-3 py-3 font-medium">额度</th>
                    <th className="px-3 py-3 font-medium">成功率</th>
                    <th className="px-3 py-3 font-medium">平均耗时</th>
                    <th className="px-3 py-3 font-medium">槽位</th>
                    <th className="px-3 py-3 font-medium">调度说明</th>
                  </tr>
                </thead>
                <tbody>
                  {accounts
                    .slice()
                    .sort(
                      (left, right) =>
                        left.scheduler_rank - right.scheduler_rank,
                    )
                    .map((account) => (
                      <tr
                        key={`${account.email}-${account.scheduler_rank}`}
                        className="border-b border-stone-100 last:border-0 dark:border-white/[0.06]"
                      >
                        <td className="px-3 py-3 font-semibold text-stone-950 dark:text-white">
                          #{account.scheduler_rank}
                        </td>
                        <td
                          className="max-w-52 truncate px-3 py-3"
                          title={account.email}
                        >
                          {account.email}
                        </td>
                        <td className="px-3 py-3">
                          <StatusPill value={account.circuit_state} />
                        </td>
                        <td className="px-3 py-3">{account.quota}</td>
                        <td className="px-3 py-3">
                          {account.success_rate === null
                            ? "暂无"
                            : `${account.success_rate}%`}
                        </td>
                        <td className="px-3 py-3">
                          {account.average_duration_secs || 0}s
                        </td>
                        <td className="px-3 py-3">
                          {account.inflight}/{account.concurrency_limit}
                        </td>
                        <td className="max-w-72 px-3 py-3 text-xs leading-5 text-stone-500 dark:text-stone-400">
                          {account.selection_reason}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            ) : (
              <EmptyState>当前没有可参与调度的账号。</EmptyState>
            )}
          </div>
        </Surface>
      ) : null}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.15fr)_minmax(360px,0.85fr)]">
        <Surface>
          <SectionHeading
            eyebrow="P0 · CREDIT LEDGER"
            title="额度流水账"
            description="余额变化和成功使用量分别记录，失败退回不会计入已使用额度。"
            action={
              <ShieldCheck
                className="size-5 text-emerald-600"
                aria-hidden="true"
              />
            }
          />
          <div className="p-5">
            {ledger.length ? (
              <div className="space-y-2">
                {ledger.map((event) => (
                  <div
                    key={event.id}
                    className="grid gap-2 rounded-xl border border-stone-200/80 px-4 py-3 sm:grid-cols-[120px_1fr_auto] sm:items-center dark:border-white/10"
                  >
                    <div>
                      <StatusPill value={actionLabels[event.action]} />
                      <p className="mt-1 text-xs text-stone-400">
                        {new Date(event.created_at).toLocaleString()}
                      </p>
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-stone-900 dark:text-stone-100">
                        {event.reason || event.task_id || "额度变更"}
                      </p>
                      <p className="truncate text-xs text-stone-500 dark:text-stone-400">
                        {isAdmin ? `${event.owner_name} · ` : ""}
                        {event.task_id || "无任务 ID"}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="font-semibold text-stone-950 dark:text-white">
                        {event.amount > 0 ? "+" : ""}
                        {event.amount}
                      </p>
                      <p className="text-xs text-stone-500">
                        余额 {event.balance_before} → {event.balance_after}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState>
                新流水会在下一次额度分配或生图任务时自动记录。
              </EmptyState>
            )}
          </div>
        </Surface>

        <Surface>
          <SectionHeading
            eyebrow="P0 · TASK TRACE"
            title="任务全过程追踪"
            description="输入任务 ID，查看排队、选号、生成、下载、保存和恢复阶段。"
            action={
              <Activity className="size-5 text-violet-600" aria-hidden="true" />
            }
          />
          <div className="space-y-4 p-5">
            <div className="flex gap-2">
              <Input
                value={taskId}
                onChange={(event) => setTaskId(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void searchTimeline();
                }}
                placeholder="输入任务 ID"
                aria-label="任务 ID"
                className="min-h-11 rounded-xl"
              />
              <Button
                type="button"
                className="min-h-11 shrink-0 gap-2 rounded-xl bg-stone-950 text-white hover:bg-stone-800 dark:bg-white dark:text-stone-950"
                disabled={isTimelineLoading}
                onClick={() => void searchTimeline()}
              >
                <Search className="size-4" />
                查询
              </Button>
            </div>
            {timeline ? (
              <div>
                <div className="mb-3 flex items-center justify-between rounded-xl bg-stone-50 px-3 py-2 text-sm dark:bg-white/[0.05]">
                  <span className="font-medium">
                    当前阶段：{timeline.current_stage}
                  </span>
                  <StatusPill value={timeline.status} />
                </div>
                <ol className="space-y-0" aria-label="任务阶段时间线">
                  {timeline.items.map((item, index) => (
                    <li
                      key={`${item.stage}-${item.created_at}-${index}`}
                      className="relative flex gap-3 pb-4 last:pb-0"
                    >
                      <div className="flex w-5 shrink-0 justify-center">
                        <span className="relative z-10 mt-1 size-2.5 rounded-full bg-violet-600 ring-4 ring-violet-50 dark:ring-violet-400/10" />
                        {index < timeline.items.length - 1 ? (
                          <span className="absolute top-4 bottom-0 w-px bg-stone-200 dark:bg-white/10" />
                        ) : null}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-sm font-medium text-stone-900 dark:text-stone-100">
                            {item.stage}
                          </p>
                          <span className="inline-flex items-center gap-1 text-xs text-stone-400">
                            <Clock3 className="size-3" />
                            {item.duration_ms
                              ? `${(item.duration_ms / 1000).toFixed(1)}s`
                              : "—"}
                          </span>
                        </div>
                        <p className="text-xs text-stone-500 dark:text-stone-400">
                          {item.detail ||
                            new Date(item.created_at).toLocaleString()}
                        </p>
                      </div>
                    </li>
                  ))}
                </ol>
              </div>
            ) : (
              <EmptyState>查询任务后，这里会显示完整处理链路。</EmptyState>
            )}
          </div>
        </Surface>
      </div>
    </div>
  );
}
