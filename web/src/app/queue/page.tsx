"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bell,
  BellRing,
  CirclePause,
  CirclePlay,
  Clock3,
  Gauge,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  SlidersHorizontal,
  Square,
  UsersRound,
  Volume2,
  VolumeX,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  bulkRetryImageTasks,
  cancelImageTask,
  fetchAdminImageQueue,
  fetchImageRuntimeMetrics,
  fetchImageTasks,
  pauseImageTask,
  resumePausedImageTask,
  updateImageTaskPriority,
  type ImageRuntimeMetrics,
  type ImageTask,
} from "@/lib/api";
import { useAuthGuard } from "@/lib/use-auth-guard";
import { cn } from "@/lib/utils";

const statusMeta = {
  queued: {
    label: "排队中",
    tone: "bg-amber-50 text-amber-700",
    dot: "bg-amber-500",
  },
  paused: {
    label: "已暂停",
    tone: "bg-sky-50 text-sky-700",
    dot: "bg-sky-500",
  },
  running: {
    label: "生成中",
    tone: "bg-violet-50 text-violet-700",
    dot: "bg-violet-500",
  },
  success: {
    label: "已完成",
    tone: "bg-emerald-50 text-emerald-700",
    dot: "bg-emerald-500",
  },
  error: {
    label: "失败",
    tone: "bg-rose-50 text-rose-700",
    dot: "bg-rose-500",
  },
} as const;

function formatSeconds(value?: number) {
  const seconds = Math.max(0, Math.round(value || 0));
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

function beep() {
  const AudioContextClass =
    window.AudioContext ||
    (window as typeof window & { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!AudioContextClass) return;
  const context = new AudioContextClass();
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.frequency.value = 720;
  gain.gain.setValueAtTime(0.06, context.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.25);
  oscillator.connect(gain).connect(context.destination);
  oscillator.start();
  oscillator.stop(context.currentTime + 0.25);
  oscillator.addEventListener("ended", () => void context.close());
}

export default function QueuePage() {
  const { session, isCheckingAuth } = useAuthGuard();
  const [tasks, setTasks] = useState<ImageTask[]>([]);
  const [metrics, setMetrics] = useState<ImageRuntimeMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [filter, setFilter] = useState<"all" | "active" | "error">("active");
  const [desktopNotify, setDesktopNotify] = useState(false);
  const [soundNotify, setSoundNotify] = useState(false);
  const previous = useRef(new Map<string, ImageTask["status"]>());
  const isAdmin = session?.role === "admin";

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDesktopNotify(localStorage.getItem("xg.queue.desktop") === "1");
      setSoundNotify(localStorage.getItem("xg.queue.sound") === "1");
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const load = useCallback(
    async (quiet = false) => {
      if (!session) return;
      if (!quiet) setLoading(true);
      try {
        const [taskResponse, metricResponse] = await Promise.all([
          isAdmin ? fetchAdminImageQueue() : fetchImageTasks([]),
          isAdmin
            ? fetchImageRuntimeMetrics().catch(() => null)
            : Promise.resolve(null),
        ]);
        const nextTasks = taskResponse.items;
        for (const task of nextTasks) {
          const before = previous.current.get(task.id);
          if (
            before &&
            before !== task.status &&
            (task.status === "success" || task.status === "error")
          ) {
            const title =
              task.status === "success" ? "图片任务已完成" : "图片任务失败";
            if (desktopNotify && Notification.permission === "granted") {
              new Notification(title, {
                body: task.prompt || task.error || task.id,
              });
            }
            if (soundNotify) beep();
          }
          previous.current.set(task.id, task.status);
        }
        setTasks(nextTasks);
        setMetrics(metricResponse);
      } catch (error) {
        if (!quiet)
          toast.error(error instanceof Error ? error.message : "队列加载失败");
      } finally {
        if (!quiet) setLoading(false);
      }
    },
    [desktopNotify, isAdmin, session, soundNotify],
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

  const visible = useMemo(() => {
    const filtered = tasks.filter((task) => {
      if (filter === "active")
        return ["queued", "paused", "running"].includes(task.status);
      if (filter === "error") return task.status === "error";
      return true;
    });
    return filtered.sort((a, b) => {
      const activeA = ["queued", "paused", "running"].includes(a.status)
        ? 1
        : 0;
      const activeB = ["queued", "paused", "running"].includes(b.status)
        ? 1
        : 0;
      return activeB - activeA || b.updated_at.localeCompare(a.updated_at);
    });
  }, [filter, tasks]);

  const mutate = async (
    taskId: string,
    operation: () => Promise<unknown>,
    message: string,
  ) => {
    setBusy((items) => [...items, taskId]);
    try {
      await operation();
      toast.success(message);
      await load(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "操作失败");
    } finally {
      setBusy((items) => items.filter((item) => item !== taskId));
    }
  };

  const retrySelected = async () => {
    if (!selected.length) return;
    setBusy((items) => [...items, ...selected]);
    try {
      const result = await bulkRetryImageTasks(selected);
      setSelected([]);
      toast.success(
        `已重新提交 ${result.items.length} 个任务${result.errors.length ? `，${result.errors.length} 个失败` : ""}`,
      );
      await load(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "批量重试失败");
    } finally {
      setBusy([]);
    }
  };

  const toggleDesktop = async () => {
    const next = !desktopNotify;
    if (next && Notification.permission !== "granted") {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") return toast.error("请先允许浏览器通知");
    }
    setDesktopNotify(next);
    localStorage.setItem("xg.queue.desktop", next ? "1" : "0");
  };

  const toggleSound = () => {
    const next = !soundNotify;
    setSoundNotify(next);
    localStorage.setItem("xg.queue.sound", next ? "1" : "0");
    if (next) beep();
  };

  if (isCheckingAuth || !session)
    return (
      <main className="grid min-h-[70vh] place-items-center">
        <LoaderCircle className="size-7 animate-spin text-violet-700" />
      </main>
    );

  const counts = tasks.reduce<Record<string, number>>((result, task) => {
    result[task.status] = (result[task.status] || 0) + 1;
    return result;
  }, {});
  const summaryCards: Array<{
    label: string;
    value: string | number;
    icon: typeof Gauge;
    color: string;
  }> = [
    {
      label: "正在执行",
      value: counts.running || 0,
      icon: Gauge,
      color: "text-violet-700",
    },
    {
      label: "等待 / 暂停",
      value: (counts.queued || 0) + (counts.paused || 0),
      icon: Clock3,
      color: "text-amber-700",
    },
    {
      label: isAdmin ? "活跃用户" : "预计等待",
      value: isAdmin
        ? metrics?.queue.active_users || 0
        : formatSeconds(
            tasks.find((item) => item.status === "queued")?.estimated_wait_secs,
          ),
      icon: UsersRound,
      color: "text-sky-700",
    },
    {
      label: isAdmin ? "账号槽位" : "已完成",
      value: isAdmin
        ? `${metrics?.accounts.used_slots || 0}/${metrics?.accounts.total_slots || 0}`
        : counts.success || 0,
      icon: SlidersHorizontal,
      color: "text-emerald-700",
    },
  ];

  return (
    <main className="min-h-screen bg-stone-50 px-3 py-5 text-stone-950 sm:px-6 lg:px-8 dark:bg-stone-950 dark:text-white">
      <div className="mx-auto max-w-[1500px] space-y-5">
        <header className="flex flex-col gap-4 rounded-3xl border border-stone-200 bg-white p-5 shadow-sm sm:flex-row sm:items-end sm:justify-between dark:border-white/10 dark:bg-stone-900">
          <div>
            <p className="text-xs font-bold tracking-[0.2em] text-violet-700">
              TASK ORCHESTRATION
            </p>
            <h1 className="mt-2 text-2xl font-black sm:text-3xl">
              {isAdmin ? "全局队列控制台" : "我的生成队列"}
            </h1>
            <p className="mt-2 text-sm text-stone-500">
              暂停、继续、调优先级，任务完成后自动提醒。
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              className="min-h-11 rounded-xl"
              onClick={() => void toggleDesktop()}
            >
              {desktopNotify ? (
                <BellRing className="size-4" />
              ) : (
                <Bell className="size-4" />
              )}
              桌面提醒
            </Button>
            <Button
              variant="outline"
              className="min-h-11 rounded-xl"
              onClick={toggleSound}
            >
              {soundNotify ? (
                <Volume2 className="size-4" />
              ) : (
                <VolumeX className="size-4" />
              )}
              声音
            </Button>
            <Button
              variant="outline"
              className="min-h-11 rounded-xl"
              onClick={() => void load()}
            >
              <RefreshCw className="size-4" />
              刷新
            </Button>
          </div>
        </header>

        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {summaryCards.map(({ label, value, icon: Icon, color }) => (
            <article
              key={label}
              className="rounded-2xl border border-stone-200 bg-white p-4 dark:border-white/10 dark:bg-stone-900"
            >
              <div className="flex items-center gap-3">
                <span
                  className={cn(
                    "grid size-10 place-items-center rounded-xl bg-stone-100 dark:bg-white/10",
                    color,
                  )}
                >
                  <Icon className="size-5" />
                </span>
                <div>
                  <p className="text-xs text-stone-500">{label}</p>
                  <p className="mt-0.5 text-xl font-black">{value}</p>
                </div>
              </div>
            </article>
          ))}
        </section>

        <section className="overflow-hidden rounded-3xl border border-stone-200 bg-white shadow-sm dark:border-white/10 dark:bg-stone-900">
          <div className="flex flex-col gap-3 border-b border-stone-100 p-4 sm:flex-row sm:items-center sm:justify-between dark:border-white/10">
            <div className="flex gap-1 rounded-xl bg-stone-100 p-1 dark:bg-white/10">
              {(
                [
                  ["active", "执行中"],
                  ["error", "失败"],
                  ["all", "全部"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  onClick={() => setFilter(value)}
                  className={cn(
                    "min-h-10 rounded-lg px-4 text-sm font-semibold",
                    filter === value
                      ? "bg-white text-violet-700 shadow-sm dark:bg-stone-800"
                      : "text-stone-500",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            <Button
              disabled={!selected.length || busy.length > 0}
              onClick={() => void retrySelected()}
              className="min-h-11 rounded-xl bg-violet-700 text-white"
            >
              <RotateCcw className="size-4" />
              批量重试 {selected.length ? `(${selected.length})` : ""}
            </Button>
          </div>
          {loading ? (
            <div className="grid min-h-72 place-items-center">
              <LoaderCircle className="size-7 animate-spin text-violet-700" />
            </div>
          ) : visible.length ? (
            <div className="divide-y divide-stone-100 dark:divide-white/10">
              {visible.map((task) => {
                const meta = statusMeta[task.status];
                const isBusy = busy.includes(task.id);
                const retryChecked = selected.includes(task.id);
                return (
                  <article
                    key={`${task.owner_id || "self"}-${task.id}`}
                    className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center"
                  >
                    <div className="flex min-w-0 items-start gap-3">
                      {task.status === "error" && task.retryable ? (
                        <input
                          aria-label="选择失败任务"
                          type="checkbox"
                          checked={retryChecked}
                          onChange={(event) =>
                            setSelected((items) =>
                              event.target.checked
                                ? [...items, task.id]
                                : items.filter((item) => item !== task.id),
                            )
                          }
                          className="mt-3 size-4 accent-violet-700"
                        />
                      ) : (
                        <span
                          className={cn(
                            "mt-3 size-2.5 shrink-0 rounded-full",
                            meta.dot,
                            task.status === "running" && "animate-pulse",
                          )}
                        />
                      )}
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={cn(
                              "rounded-full px-2.5 py-1 text-xs font-bold dark:bg-white/10 dark:text-white",
                              meta.tone,
                            )}
                          >
                            {meta.label}
                          </span>
                          <span className="text-xs text-stone-500">
                            {task.mode === "edit" ? "图像编辑" : "文生图"}
                          </span>
                          {isAdmin && task.owner_id ? (
                            <span className="rounded-full bg-stone-100 px-2 py-1 font-mono text-[11px] text-stone-500 dark:bg-white/10">
                              用户 {task.owner_id.slice(-8)}
                            </span>
                          ) : null}
                          <span className="text-xs text-stone-400">
                            优先级 {task.priority || 0}
                          </span>
                        </div>
                        <p className="mt-2 line-clamp-2 text-sm font-medium leading-6">
                          {task.prompt || task.error || `任务 ${task.id}`}
                        </p>
                        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-stone-500">
                          <span>
                            {task.model || "gpt-image-2"} ·{" "}
                            {task.size || "自动"}
                          </span>
                          {task.queue_position ? (
                            <span>
                              队列 {task.queue_position}/
                              {task.queue_total || "-"}
                            </span>
                          ) : null}
                          {task.estimated_wait_secs ? (
                            <span>
                              预计 {formatSeconds(task.estimated_wait_secs)}
                            </span>
                          ) : null}
                          <span>
                            耗时{" "}
                            {formatSeconds(
                              task.elapsed_secs ||
                                (task.duration_ms || 0) / 1000,
                            )}
                          </span>
                          {task.error ? (
                            <span className="text-rose-600">{task.error}</span>
                          ) : null}
                        </div>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      {task.status === "queued" || task.status === "paused" ? (
                        <select
                          aria-label="任务优先级"
                          value={task.priority || 0}
                          disabled={isBusy}
                          onChange={(event) =>
                            void mutate(
                              task.id,
                              () =>
                                updateImageTaskPriority(
                                  task.id,
                                  Number(event.target.value),
                                ),
                              "优先级已更新",
                            )
                          }
                          className="min-h-10 rounded-xl border border-stone-200 bg-white px-3 text-sm dark:border-white/10 dark:bg-stone-950"
                        >
                          {[-10, -5, 0, 5, 10].map((value) => (
                            <option key={value} value={value}>
                              {value === 10
                                ? "紧急"
                                : value === 5
                                  ? "较高"
                                  : value === 0
                                    ? "普通"
                                    : value === -5
                                      ? "较低"
                                      : "最低"}
                            </option>
                          ))}
                        </select>
                      ) : null}
                      {task.status === "queued" ? (
                        <Button
                          variant="outline"
                          className="min-h-10 rounded-xl"
                          disabled={isBusy}
                          onClick={() =>
                            void mutate(
                              task.id,
                              () => pauseImageTask(task.id),
                              "任务已暂停",
                            )
                          }
                        >
                          <CirclePause className="size-4" />
                          暂停
                        </Button>
                      ) : null}
                      {task.status === "paused" ? (
                        <Button
                          variant="outline"
                          className="min-h-10 rounded-xl"
                          disabled={isBusy}
                          onClick={() =>
                            void mutate(
                              task.id,
                              () => resumePausedImageTask(task.id),
                              "任务已继续",
                            )
                          }
                        >
                          <CirclePlay className="size-4" />
                          继续
                        </Button>
                      ) : null}
                      {["queued", "paused", "running"].includes(task.status) ? (
                        <Button
                          variant="outline"
                          className="min-h-10 rounded-xl text-rose-600"
                          disabled={isBusy}
                          onClick={() =>
                            void mutate(
                              task.id,
                              () => cancelImageTask(task.id),
                              "任务已停止",
                            )
                          }
                        >
                          <Square className="size-3.5" />
                          停止
                        </Button>
                      ) : null}
                      {isBusy ? (
                        <LoaderCircle className="size-4 animate-spin text-violet-700" />
                      ) : null}
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="grid min-h-72 place-items-center text-center">
              <div>
                <Clock3 className="mx-auto size-10 text-stone-300" />
                <h2 className="mt-3 font-bold">当前没有任务</h2>
                <p className="mt-1 text-sm text-stone-500">
                  新任务提交后会实时出现在这里。
                </p>
              </div>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
