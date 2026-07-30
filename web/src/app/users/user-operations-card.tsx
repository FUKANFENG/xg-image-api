"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Check,
  LoaderCircle,
  Save,
  ShieldAlert,
  SlidersHorizontal,
  Users,
  WalletCards,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  fetchCreativePolicies,
  fetchUserAccounts,
  updateCreativePolicy,
  updateUserAccount,
  updateUserQuotaBatch,
  type CreativePolicy,
  type UserAccount,
} from "@/lib/api";
import { cn } from "@/lib/utils";

const featureOptions = [
  { key: "image_generation", label: "文字生图" },
  { key: "image_edit", label: "图片二创" },
  { key: "batch", label: "批量任务" },
  { key: "conversation", label: "连续修改" },
  { key: "ai_tools", label: "AI 图片工具" },
  { key: "local_tools", label: "本地图片工具" },
] as const;

function defaultPolicy(
  subjectId: string,
  subjectType: "user" | "group",
): CreativePolicy {
  return {
    subject_id: subjectId,
    subject_type: subjectType,
    features: {},
    rate_limit_per_minute: 0,
    frozen: false,
    abnormal_reason: "",
    updated_at: "",
  };
}

export function UserOperationsCard() {
  const [users, setUsers] = useState<UserAccount[]>([]);
  const [policies, setPolicies] = useState<CreativePolicy[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [quotaMode, setQuotaMode] = useState<"add" | "set">("add");
  const [quotaAmount, setQuotaAmount] = useState(100);
  const [policyTarget, setPolicyTarget] = useState("group:default");
  const [draftPolicy, setDraftPolicy] = useState<CreativePolicy>(() =>
    defaultPolicy("group:default", "group"),
  );
  const [draftGroup, setDraftGroup] = useState("default");
  const [isLoading, setIsLoading] = useState(true);
  const [isSavingQuota, setIsSavingQuota] = useState(false);
  const [isSavingPolicy, setIsSavingPolicy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const [userResult, policyResult] = await Promise.all([
        fetchUserAccounts(),
        fetchCreativePolicies(),
      ]);
      setUsers(userResult.items);
      setPolicies(policyResult.items);
      setError("");
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : "运营策略加载失败",
      );
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const groups = useMemo(
    () =>
      Array.from(
        new Set(["default", ...users.map((user) => user.group || "default")]),
      ),
    [users],
  );
  const selectedUser = users.find((user) => user.id === policyTarget);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const subjectType = policyTarget.startsWith("group:") ? "group" : "user";
      const existing = policies.find((item) => item.subject_id === policyTarget);
      setDraftPolicy(
        existing
          ? { ...existing, features: { ...existing.features } }
          : defaultPolicy(policyTarget, subjectType),
      );
      const user = users.find((item) => item.id === policyTarget);
      setDraftGroup(user?.group || "default");
    }, 0);
    return () => window.clearTimeout(timer);
  }, [policies, policyTarget, users]);

  const applyQuota = async () => {
    if (!selectedIds.size) {
      setError("请先勾选需要调整额度的用户");
      return;
    }
    setIsSavingQuota(true);
    try {
      const result = await updateUserQuotaBatch({
        user_ids: [...selectedIds],
        mode: quotaMode,
        amount: quotaAmount,
      });
      setUsers(result.items);
      toast.success(`已更新 ${result.updated.length} 位用户额度`);
    } catch (quotaError) {
      setError(
        quotaError instanceof Error ? quotaError.message : "批量额度更新失败",
      );
    } finally {
      setIsSavingQuota(false);
    }
  };

  const savePolicy = async () => {
    setIsSavingPolicy(true);
    try {
      if (selectedUser && (selectedUser.group || "default") !== draftGroup) {
        await updateUserAccount(selectedUser.id, {
          group: draftGroup || "default",
        });
      }
      const saved = await updateCreativePolicy(policyTarget, {
        subject_type: draftPolicy.subject_type,
        features: draftPolicy.features,
        rate_limit_per_minute: draftPolicy.rate_limit_per_minute,
        frozen:
          draftPolicy.subject_type === "user" ? draftPolicy.frozen : false,
        abnormal_reason:
          draftPolicy.subject_type === "user"
            ? draftPolicy.abnormal_reason
            : "",
      });
      setPolicies((current) => [
        ...current.filter((item) => item.subject_id !== saved.subject_id),
        saved,
      ]);
      await load();
      toast.success("用户策略已保存");
    } catch (policyError) {
      setError(
        policyError instanceof Error ? policyError.message : "策略保存失败",
      );
    } finally {
      setIsSavingPolicy(false);
    }
  };

  if (isLoading)
    return (
      <div className="grid min-h-48 place-items-center rounded-2xl border border-stone-200 dark:border-white/10">
        <LoaderCircle className="size-5 animate-spin text-violet-600" />
      </div>
    );

  return (
    <section className="space-y-5 rounded-3xl border border-stone-200 bg-white p-5 shadow-sm dark:border-white/10 dark:bg-stone-950">
      <div className="flex items-start gap-3">
        <span className="grid size-10 place-items-center rounded-xl bg-violet-100 text-violet-700 dark:bg-violet-400/10 dark:text-violet-200">
          <SlidersHorizontal className="size-5" />
        </span>
        <div>
          <h2 className="font-semibold text-stone-950 dark:text-white">
            额度与功能策略
          </h2>
          <p className="mt-1 text-sm leading-6 text-stone-500">
            批量分配额度，并按用户或分组控制功能、速率和异常冻结。
          </p>
        </div>
      </div>
      {error ? (
        <p
          className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-400/10 dark:text-rose-200"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(360px,.8fr)]">
        <div className="min-w-0 overflow-hidden rounded-2xl border border-stone-200 dark:border-white/10">
          <div className="flex flex-col gap-3 border-b border-stone-200 bg-stone-50 p-4 sm:flex-row sm:items-end dark:border-white/10 dark:bg-white/5">
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <WalletCards className="size-4 text-violet-600" />
                <h3 className="text-sm font-semibold">批量额度</h3>
              </div>
              <p className="mt-1 text-xs text-stone-500">
                已选择 {selectedIds.size} 位用户
              </p>
            </div>
            <select
              aria-label="额度操作"
              value={quotaMode}
              onChange={(event) =>
                setQuotaMode(event.target.value as "add" | "set")
              }
              className="h-11 rounded-xl border border-stone-200 bg-white px-3 text-sm dark:border-white/10 dark:bg-stone-950"
            >
              <option value="add">增加额度</option>
              <option value="set">设为额度</option>
            </select>
            <input
              aria-label="额度数量"
              type="number"
              min={0}
              max={100000}
              value={quotaAmount}
              onChange={(event) =>
                setQuotaAmount(
                  Math.max(
                    0,
                    Math.min(100000, Number(event.target.value) || 0),
                  ),
                )
              }
              className="h-11 w-full rounded-xl border border-stone-200 bg-white px-3 text-base tabular-nums sm:w-28 dark:border-white/10 dark:bg-stone-950"
            />
            <Button
              type="button"
              disabled={isSavingQuota || !selectedIds.size}
              onClick={() => void applyQuota()}
              className="min-h-11 rounded-xl bg-violet-700 text-white"
            >
              {isSavingQuota ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : (
                <Check className="size-4" />
              )}
              应用
            </Button>
          </div>
          <div className="max-h-[420px] overflow-auto">
            <table className="w-full min-w-[620px] text-left text-sm">
              <thead className="sticky top-0 bg-white text-xs text-stone-500 shadow-[0_1px_0_rgba(0,0,0,.08)] dark:bg-stone-950">
                <tr>
                  <th className="px-4 py-3">
                    <input
                      type="checkbox"
                      aria-label="选择全部用户"
                      checked={
                        users.length > 0 && selectedIds.size === users.length
                      }
                      onChange={(event) =>
                        setSelectedIds(
                          event.target.checked
                            ? new Set(users.map((user) => user.id))
                            : new Set(),
                        )
                      }
                    />
                  </th>
                  <th className="px-3 py-3 font-medium">用户</th>
                  <th className="px-3 py-3 font-medium">分组</th>
                  <th className="px-3 py-3 text-right font-medium">剩余</th>
                  <th className="px-4 py-3 text-right font-medium">策略</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100 dark:divide-white/10">
                {users.map((user) => {
                  const policy = policies.find(
                    (item) => item.subject_id === user.id,
                  );
                  return (
                    <tr key={user.id}>
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          aria-label={`选择 ${user.name}`}
                          checked={selectedIds.has(user.id)}
                          onChange={(event) =>
                            setSelectedIds((current) => {
                              const next = new Set(current);
                              if (event.target.checked) next.add(user.id);
                              else next.delete(user.id);
                              return next;
                            })
                          }
                        />
                      </td>
                      <td className="px-3 py-3">
                        <div className="font-medium text-stone-800 dark:text-stone-100">
                          {user.name}
                        </div>
                        <div className="text-xs text-stone-400">
                          {user.username || user.id}
                        </div>
                      </td>
                      <td className="px-3 py-3 text-stone-500">
                        {user.group || "default"}
                      </td>
                      <td className="px-3 py-3 text-right font-semibold tabular-nums">
                        {user.image_quota}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          type="button"
                          onClick={() => setPolicyTarget(user.id)}
                          className={cn(
                            "min-h-10 rounded-xl px-3 text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500",
                            policyTarget === user.id
                              ? "bg-violet-700 text-white"
                              : policy?.frozen
                                ? "bg-rose-50 text-rose-700 dark:bg-rose-400/10 dark:text-rose-200"
                                : "bg-stone-100 text-stone-600 hover:bg-stone-200 dark:bg-white/10 dark:text-stone-300",
                          )}
                        >
                          {policy?.frozen ? "已冻结" : "配置"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        <div className="rounded-2xl border border-stone-200 p-4 dark:border-white/10">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <ShieldAlert className="size-4 text-violet-600" />
                <h3 className="text-sm font-semibold">策略编辑</h3>
              </div>
              <p className="mt-1 text-xs text-stone-500">
                用户设置覆盖所属分组设置。
              </p>
            </div>
          </div>
          <label className="mt-4 block space-y-2 text-sm font-medium">
            <span>策略对象</span>
            <select
              value={policyTarget}
              onChange={(event) => setPolicyTarget(event.target.value)}
              className="h-11 w-full rounded-xl border border-stone-200 bg-white px-3 dark:border-white/10 dark:bg-stone-950"
            >
              <optgroup label="分组">
                {groups.map((group) => (
                  <option key={group} value={`group:${group}`}>
                    分组：{group}
                  </option>
                ))}
              </optgroup>
              <optgroup label="用户">
                {users.map((user) => (
                  <option key={user.id} value={user.id}>
                    用户：{user.name}
                  </option>
                ))}
              </optgroup>
            </select>
          </label>
          {selectedUser ? (
            <label className="mt-4 block space-y-2 text-sm font-medium">
              <span>用户分组</span>
              <input
                value={draftGroup}
                onChange={(event) => setDraftGroup(event.target.value)}
                className="h-11 w-full rounded-xl border border-stone-200 bg-white px-3 text-base dark:border-white/10 dark:bg-stone-950"
              />
            </label>
          ) : null}
          <fieldset className="mt-5">
            <legend className="text-sm font-semibold">功能开关</legend>
            <div className="mt-3 grid grid-cols-2 gap-2">
              {featureOptions.map((feature) => {
                const enabled = draftPolicy.features[feature.key] !== false;
                return (
                  <label
                    key={feature.key}
                    className={cn(
                      "flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border px-3 text-sm transition",
                      enabled
                        ? "border-violet-200 bg-violet-50 text-violet-800 dark:border-violet-400/30 dark:bg-violet-400/10 dark:text-violet-100"
                        : "border-stone-200 text-stone-500 dark:border-white/10",
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={enabled}
                      onChange={(event) =>
                        setDraftPolicy((current) => ({
                          ...current,
                          features: {
                            ...current.features,
                            [feature.key]: event.target.checked,
                          },
                        }))
                      }
                    />
                    <span>{feature.label}</span>
                  </label>
                );
              })}
            </div>
          </fieldset>
          <label className="mt-4 block space-y-2 text-sm font-medium">
            <span>每分钟操作上限</span>
            <input
              type="number"
              min={0}
              max={600}
              value={draftPolicy.rate_limit_per_minute}
              onChange={(event) =>
                setDraftPolicy((current) => ({
                  ...current,
                  rate_limit_per_minute: Math.max(
                    0,
                    Math.min(600, Number(event.target.value) || 0),
                  ),
                }))
              }
              className="h-11 w-full rounded-xl border border-stone-200 bg-white px-3 text-base tabular-nums dark:border-white/10 dark:bg-stone-950"
            />
            <span className="block text-xs font-normal text-stone-500">
              0 表示不单独限制；每项功能分别计数。
            </span>
          </label>
          {draftPolicy.subject_type === "user" ? (
            <>
              <label className="mt-4 flex min-h-11 items-center justify-between rounded-xl border border-stone-200 px-3 text-sm font-medium dark:border-white/10">
                <span>冻结异常用户</span>
                <input
                  type="checkbox"
                  checked={draftPolicy.frozen}
                  onChange={(event) =>
                    setDraftPolicy((current) => ({
                      ...current,
                      frozen: event.target.checked,
                    }))
                  }
                />
              </label>
              {draftPolicy.frozen ? (
                <label className="mt-3 block space-y-2 text-sm font-medium">
                  <span>冻结原因</span>
                  <textarea
                    value={draftPolicy.abnormal_reason}
                    onChange={(event) =>
                      setDraftPolicy((current) => ({
                        ...current,
                        abnormal_reason: event.target.value,
                      }))
                    }
                    rows={2}
                    className="w-full rounded-xl border border-stone-200 bg-white px-3 py-2 text-base dark:border-white/10 dark:bg-stone-950"
                    placeholder="用户登录后会看到此原因"
                  />
                </label>
              ) : null}
            </>
          ) : null}
          <Button
            type="button"
            disabled={isSavingPolicy}
            onClick={() => void savePolicy()}
            className="mt-5 min-h-11 w-full rounded-xl bg-violet-700 text-white"
          >
            {isSavingPolicy ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              <Save className="size-4" />
            )}
            保存策略
          </Button>
        </div>
      </div>
    </section>
  );
}
