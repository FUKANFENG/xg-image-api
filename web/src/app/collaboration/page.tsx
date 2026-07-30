"use client";

import Image from "next/image";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArchiveRestore,
  CheckCircle2,
  ClipboardCheck,
  FileClock,
  LoaderCircle,
  MessageSquareText,
  RefreshCw,
  ShieldCheck,
  Trash2,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  fetchCreativeAudits,
  fetchCreativeReviews,
  fetchCreativeTrash,
  purgeCreativeTrash,
  resolveCreativeReview,
  restoreCreativeTrash,
  type CreativeAudit,
  type CreativeReview,
  type CreativeTrashItem,
} from "@/lib/api";
import { useAuthGuard } from "@/lib/use-auth-guard";
import { cn } from "@/lib/utils";

const reviewTone = {
  pending: "bg-amber-50 text-amber-700",
  approved: "bg-emerald-50 text-emerald-700",
  rejected: "bg-rose-50 text-rose-700",
};
const reviewLabel = {
  pending: "待审核",
  approved: "已通过",
  rejected: "已驳回",
};

function timeText(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString("zh-CN", { hour12: false });
}

function trashName(item: CreativeTrashItem) {
  const snapshot = item.snapshot;
  return String(
    snapshot.name ||
      snapshot.prompt ||
      `${item.entity_type} · ${item.entity_id.slice(-8)}`,
  );
}

export default function CollaborationPage() {
  const { session, isCheckingAuth } = useAuthGuard();
  const [tab, setTab] = useState<"reviews" | "trash" | "audit">("reviews");
  const [reviews, setReviews] = useState<CreativeReview[]>([]);
  const [trash, setTrash] = useState<CreativeTrashItem[]>([]);
  const [audits, setAudits] = useState<CreativeAudit[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState("");
  const [comments, setComments] = useState<Record<string, string>>({});
  const [auditQuery, setAuditQuery] = useState("");
  const isAdmin = session?.role === "admin";

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const [reviewData, trashData, auditData] = await Promise.all([
        fetchCreativeReviews(),
        fetchCreativeTrash(),
        isAdmin
          ? fetchCreativeAudits({ limit: 300 })
          : Promise.resolve({ items: [] }),
      ]);
      setReviews(reviewData.items);
      setTrash(trashData.items);
      setAudits(auditData.items);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "协作数据加载失败");
    } finally {
      setLoading(false);
    }
  }, [isAdmin, session]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const resolve = async (
    item: CreativeReview,
    status: "approved" | "rejected",
  ) => {
    setBusyId(item.id);
    try {
      await resolveCreativeReview(item.id, status, comments[item.id] || "");
      toast.success(status === "approved" ? "作品已通过" : "作品已驳回");
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "审核失败");
    } finally {
      setBusyId("");
    }
  };

  const handleTrash = async (item: CreativeTrashItem, purge: boolean) => {
    setBusyId(item.id);
    try {
      if (purge) await purgeCreativeTrash(item.id);
      else await restoreCreativeTrash(item.id);
      toast.success(purge ? "已彻底删除" : "已恢复");
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "操作失败");
    } finally {
      setBusyId("");
    }
  };

  const visibleAudits = useMemo(() => {
    const query = auditQuery.trim().toLowerCase();
    if (!query) return audits;
    return audits.filter((item) =>
      [
        item.action,
        item.actor_id,
        item.entity_id,
        item.ip_address,
        item.user_agent,
      ].some((value) => value.toLowerCase().includes(query)),
    );
  }, [auditQuery, audits]);

  if (isCheckingAuth || !session)
    return (
      <main className="grid min-h-[70vh] place-items-center">
        <LoaderCircle className="size-7 animate-spin text-violet-700" />
      </main>
    );

  const tabs = [
    {
      value: "reviews" as const,
      label: isAdmin ? "作品审核" : "我的送审",
      icon: ClipboardCheck,
      count: reviews.filter((item) => item.status === "pending").length,
    },
    {
      value: "trash" as const,
      label: "回收站",
      icon: ArchiveRestore,
      count: trash.length,
    },
    ...(isAdmin
      ? [
          {
            value: "audit" as const,
            label: "操作审计",
            icon: ShieldCheck,
            count: audits.length,
          },
        ]
      : []),
  ];

  return (
    <main className="min-h-screen bg-stone-50 px-3 py-5 text-stone-950 sm:px-6 lg:px-8 dark:bg-stone-950 dark:text-white">
      <div className="mx-auto max-w-[1500px] space-y-5">
        <header className="flex flex-col gap-4 rounded-3xl border border-stone-200 bg-white p-5 shadow-sm sm:flex-row sm:items-end sm:justify-between dark:border-white/10 dark:bg-stone-900">
          <div>
            <p className="text-xs font-bold tracking-[0.2em] text-violet-700">
              REVIEW & GOVERNANCE
            </p>
            <h1 className="mt-2 text-2xl font-black sm:text-3xl">
              {isAdmin ? "协作审核中心" : "交付与回收"}
            </h1>
            <p className="mt-2 text-sm text-stone-500">
              送审、批注、恢复误删内容，关键操作全程留痕。
            </p>
          </div>
          <Button
            variant="outline"
            className="min-h-11 rounded-xl"
            onClick={() => void load()}
          >
            <RefreshCw className="size-4" />
            刷新
          </Button>
        </header>

        <nav className="flex gap-2 overflow-x-auto rounded-2xl border border-stone-200 bg-white p-2 dark:border-white/10 dark:bg-stone-900">
          {tabs.map(({ value, label, icon: Icon, count }) => (
            <button
              key={value}
              onClick={() => setTab(value)}
              className={cn(
                "flex min-h-11 shrink-0 items-center gap-2 rounded-xl px-4 text-sm font-bold",
                tab === value
                  ? "bg-violet-700 text-white shadow-lg shadow-violet-700/20"
                  : "text-stone-500 hover:bg-stone-100 dark:hover:bg-white/10",
              )}
            >
              <Icon className="size-4" />
              {label}
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 text-xs",
                  tab === value
                    ? "bg-white/20"
                    : "bg-stone-100 dark:bg-white/10",
                )}
              >
                {count}
              </span>
            </button>
          ))}
        </nav>

        {loading ? (
          <div className="grid min-h-80 place-items-center rounded-3xl border border-stone-200 bg-white dark:border-white/10 dark:bg-stone-900">
            <LoaderCircle className="size-7 animate-spin text-violet-700" />
          </div>
        ) : null}

        {!loading && tab === "reviews" ? (
          <section className="grid gap-4 lg:grid-cols-2">
            {reviews.map((item) => (
              <article
                key={item.id}
                className="overflow-hidden rounded-3xl border border-stone-200 bg-white shadow-sm dark:border-white/10 dark:bg-stone-900"
              >
                <div className="grid sm:grid-cols-[180px_minmax(0,1fr)]">
                  <div className="relative aspect-square bg-stone-100 sm:aspect-auto dark:bg-white/5">
                    {item.image_url ? (
                      <Image
                        fill
                        sizes="180px"
                        src={item.image_url}
                        alt={item.asset_name}
                        className="object-cover"
                        unoptimized
                      />
                    ) : (
                      <div className="grid h-full min-h-44 place-items-center">
                        <FileClock className="size-9 text-stone-300" />
                      </div>
                    )}
                  </div>
                  <div className="flex min-w-0 flex-col p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h2 className="truncate font-bold">
                          {item.asset_name}
                        </h2>
                        <p className="mt-1 text-xs text-stone-500">
                          版本 V{item.version_number} ·{" "}
                          {timeText(item.submitted_at)}
                        </p>
                      </div>
                      <span
                        className={cn(
                          "shrink-0 rounded-full px-2.5 py-1 text-xs font-bold dark:bg-white/10 dark:text-white",
                          reviewTone[item.status],
                        )}
                      >
                        {reviewLabel[item.status]}
                      </span>
                    </div>
                    {item.comment ? (
                      <div className="mt-4 rounded-xl bg-stone-50 p-3 text-sm leading-6 dark:bg-white/5">
                        <MessageSquareText className="mr-2 inline size-4 text-violet-700" />
                        {item.comment}
                      </div>
                    ) : null}
                    {isAdmin && item.status === "pending" ? (
                      <div className="mt-4 space-y-3">
                        <textarea
                          value={comments[item.id] || ""}
                          onChange={(event) =>
                            setComments((current) => ({
                              ...current,
                              [item.id]: event.target.value,
                            }))
                          }
                          className="min-h-20 w-full rounded-xl border border-stone-200 bg-white px-3 py-2 text-base dark:border-white/10 dark:bg-stone-950"
                          placeholder="填写修改意见或通过说明（可选）"
                        />
                        <div className="grid grid-cols-2 gap-2">
                          <Button
                            disabled={busyId === item.id}
                            onClick={() => void resolve(item, "approved")}
                            className="min-h-11 rounded-xl bg-emerald-600 text-white"
                          >
                            <CheckCircle2 className="size-4" />
                            通过
                          </Button>
                          <Button
                            disabled={busyId === item.id}
                            variant="outline"
                            onClick={() => void resolve(item, "rejected")}
                            className="min-h-11 rounded-xl text-rose-600"
                          >
                            <XCircle className="size-4" />
                            驳回
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="mt-auto pt-4 text-xs text-stone-500">
                        {isAdmin
                          ? `提交用户 ${item.owner_id.slice(-8)}`
                          : "管理员处理后会在这里显示结果"}
                      </div>
                    )}
                  </div>
                </div>
              </article>
            ))}
            {!reviews.length ? (
              <Empty
                icon={ClipboardCheck}
                title="暂无审核记录"
                text="从画布或作品详情提交送审后，会出现在这里。"
              />
            ) : null}
          </section>
        ) : null}

        {!loading && tab === "trash" ? (
          <section className="overflow-hidden rounded-3xl border border-stone-200 bg-white dark:border-white/10 dark:bg-stone-900">
            <div className="divide-y divide-stone-100 dark:divide-white/10">
              {trash.map((item) => (
                <article
                  key={item.id}
                  className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="rounded-full bg-stone-100 px-2.5 py-1 text-xs font-bold dark:bg-white/10">
                        {item.entity_type === "project"
                          ? "项目"
                          : item.entity_type === "asset"
                            ? "作品"
                            : "版本"}
                      </span>
                      <h2 className="truncate font-semibold">
                        {trashName(item)}
                      </h2>
                    </div>
                    <p className="mt-2 text-xs text-stone-500">
                      删除于 {timeText(item.deleted_at)} · 自动清理{" "}
                      {timeText(item.expires_at)}
                      {isAdmin ? ` · 用户 ${item.owner_id.slice(-8)}` : ""}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      disabled={busyId === item.id}
                      variant="outline"
                      className="min-h-10 rounded-xl"
                      onClick={() => void handleTrash(item, false)}
                    >
                      <ArchiveRestore className="size-4" />
                      恢复
                    </Button>
                    <Button
                      disabled={busyId === item.id}
                      variant="outline"
                      className="min-h-10 rounded-xl text-rose-600"
                      onClick={() => void handleTrash(item, true)}
                    >
                      <Trash2 className="size-4" />
                      彻底删除
                    </Button>
                  </div>
                </article>
              ))}
              {!trash.length ? (
                <div className="py-20">
                  <Empty
                    icon={ArchiveRestore}
                    title="回收站为空"
                    text="删除的项目、作品和历史版本会在这里保留 30 天。"
                  />
                </div>
              ) : null}
            </div>
          </section>
        ) : null}

        {!loading && tab === "audit" && isAdmin ? (
          <section className="overflow-hidden rounded-3xl border border-stone-200 bg-white dark:border-white/10 dark:bg-stone-900">
            <div className="border-b border-stone-100 p-4 dark:border-white/10">
              <input
                value={auditQuery}
                onChange={(event) => setAuditQuery(event.target.value)}
                className="min-h-11 w-full rounded-xl border border-stone-200 bg-white px-4 text-base dark:border-white/10 dark:bg-stone-950"
                placeholder="搜索动作、用户、IP、设备或资源编号"
              />
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px] text-left text-sm">
                <thead className="bg-stone-50 text-xs text-stone-500 dark:bg-white/5">
                  <tr>
                    <th className="px-4 py-3">时间</th>
                    <th className="px-4 py-3">动作</th>
                    <th className="px-4 py-3">操作者</th>
                    <th className="px-4 py-3">资源</th>
                    <th className="px-4 py-3">IP / 设备</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-100 dark:divide-white/10">
                  {visibleAudits.map((item) => (
                    <tr key={item.id}>
                      <td className="whitespace-nowrap px-4 py-3 text-xs text-stone-500">
                        {timeText(item.created_at)}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-violet-700">
                        {item.action}
                      </td>
                      <td className="px-4 py-3">
                        <p>{item.actor_id.slice(-12)}</p>
                        <p className="text-xs text-stone-500">
                          {item.actor_role}
                        </p>
                      </td>
                      <td className="px-4 py-3">
                        <p>{item.entity_type || "-"}</p>
                        <p className="font-mono text-xs text-stone-500">
                          {item.entity_id.slice(-12)}
                        </p>
                      </td>
                      <td className="max-w-sm px-4 py-3">
                        <p className="text-xs">
                          {item.ip_address || "本机/未知"}
                        </p>
                        <p
                          className="truncate text-xs text-stone-500"
                          title={item.user_agent}
                        >
                          {item.user_agent || "无设备信息"}
                        </p>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}
      </div>
    </main>
  );
}

function Empty({
  icon: Icon,
  title,
  text,
}: {
  icon: typeof ClipboardCheck;
  title: string;
  text: string;
}) {
  return (
    <div className="col-span-full rounded-3xl border border-dashed border-stone-200 bg-white py-16 text-center dark:border-white/10 dark:bg-stone-900">
      <Icon className="mx-auto size-10 text-stone-300" />
      <h2 className="mt-4 font-bold">{title}</h2>
      <p className="mt-2 text-sm text-stone-500">{text}</p>
    </div>
  );
}
