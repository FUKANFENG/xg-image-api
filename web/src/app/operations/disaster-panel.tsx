"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ArchiveRestore,
  CheckCircle2,
  RefreshCw,
  ShieldAlert,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  fetchBackups,
  restoreDisasterBackup,
  runBackupNow,
  verifyDisasterBackup,
  type BackupItem,
} from "@/lib/api";

import {
  EmptyState,
  SectionHeading,
  StatusPill,
  Surface,
} from "./operations-ui";

type Verification = {
  id: string;
  restoreToken: string;
  expiresAt: string;
  detail: Record<string, unknown>;
};

export function DisasterPanel({ isAdmin }: { isAdmin: boolean }) {
  const [backups, setBackups] = useState<BackupItem[]>([]);
  const [selectedKey, setSelectedKey] = useState("");
  const [verification, setVerification] = useState<Verification | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    if (!isAdmin) return;
    try {
      const result = await fetchBackups();
      setBackups(result.items);
      setSelectedKey((current) => current || result.items[0]?.key || "");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "备份列表加载失败");
    }
  }, [isAdmin]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  if (!isAdmin) {
    return (
      <Surface>
        <SectionHeading
          eyebrow="P2 · DISASTER RECOVERY"
          title="灾备恢复中心"
          description="灾备恢复仅管理员可执行，普通用户的作品和任务会随系统备份统一保护。"
        />
        <div className="p-5">
          <EmptyState>如需恢复数据，请联系管理员操作。</EmptyState>
        </div>
      </Surface>
    );
  }

  const verify = async () => {
    if (!selectedKey) {
      toast.error("请选择备份");
      return;
    }
    setBusy("verify");
    setVerification(null);
    setConfirmation("");
    try {
      const result = await verifyDisasterBackup(selectedKey);
      setVerification({
        id: result.data.id,
        restoreToken: result.data.restore_token,
        expiresAt: result.data.token_expires_at,
        detail: result.data.detail,
      });
      toast.success("备份校验与恢复预演通过");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "备份校验失败");
    } finally {
      setBusy("");
    }
  };

  const restore = async () => {
    if (!verification || confirmation !== "确认恢复") return;
    setBusy("restore");
    try {
      const result = await restoreDisasterBackup({
        run_id: verification.id,
        restore_token: verification.restoreToken,
        confirmation,
      });
      toast.success(`已恢复 ${result.data.restored_files} 个文件；请重启服务`);
      setVerification(null);
      setConfirmation("");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "恢复失败，系统已尝试自动回滚",
      );
    } finally {
      setBusy("");
    }
  };

  const createBackup = async () => {
    setBusy("backup");
    try {
      await runBackupNow();
      await load();
      toast.success("新的灾备快照已创建");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "备份创建失败");
    } finally {
      setBusy("");
    }
  };

  const detail = verification?.detail || {};
  const fileCount = Number(detail.file_count || 0);
  const totalBytes = Number(detail.total_unpacked_bytes || 0);

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,0.8fr)_minmax(420px,1.2fr)]">
      <Surface>
        <SectionHeading
          eyebrow="P2 · BACKUP INVENTORY"
          title="备份库存"
          description="先创建或选择一个快照，再进入校验和恢复预演。"
          action={
            <Button
              type="button"
              variant="outline"
              className="min-h-11 gap-2 rounded-xl"
              disabled={busy === "backup"}
              onClick={() => void createBackup()}
            >
              <ArchiveRestore className="size-4" />
              立即备份
            </Button>
          }
        />
        <div className="space-y-2 p-5">
          {backups.length ? (
            backups.map((item) => (
              <button
                key={item.key}
                type="button"
                className={`w-full rounded-xl border px-4 py-3 text-left transition ${selectedKey === item.key ? "border-violet-500 bg-violet-50 dark:bg-violet-400/10" : "border-stone-200 hover:border-stone-300 dark:border-white/10"}`}
                onClick={() => {
                  setSelectedKey(item.key);
                  setVerification(null);
                }}
              >
                <div className="flex items-center justify-between gap-2">
                  <strong className="truncate text-sm">{item.name}</strong>
                  <StatusPill value={item.encrypted ? "已加密" : "未加密"} />
                </div>
                <p className="mt-1 text-xs text-stone-500">
                  {new Date(item.updated_at || "").toLocaleString()} ·{" "}
                  {(item.size / 1024 / 1024).toFixed(1)} MB
                </p>
              </button>
            ))
          ) : (
            <EmptyState>当前没有可用备份，请先创建快照。</EmptyState>
          )}
        </div>
      </Surface>

      <Surface>
        <SectionHeading
          eyebrow="P2 · SAFE RESTORE"
          title="校验、预演与安全恢复"
          description="正式覆盖前检查归档路径与 SHA-256，并自动创建本机回滚快照。"
          action={
            <ShieldAlert className="size-5 text-amber-600" aria-hidden="true" />
          }
        />
        <div className="space-y-4 p-5">
          <div className="flex gap-2">
            <Input
              value={selectedKey}
              readOnly
              aria-label="选中的备份"
              className="min-h-11 rounded-xl"
            />
            <Button
              type="button"
              className="min-h-11 shrink-0 gap-2 rounded-xl bg-stone-950 text-white dark:bg-white dark:text-stone-950"
              disabled={!selectedKey || busy === "verify"}
              onClick={() => void verify()}
            >
              <RefreshCw
                className={busy === "verify" ? "size-4 animate-spin" : "size-4"}
              />
              校验预演
            </Button>
          </div>

          {verification ? (
            <div className="space-y-4 rounded-xl border border-emerald-200 bg-emerald-50/60 p-4 dark:border-emerald-400/20 dark:bg-emerald-400/[0.06]">
              <div className="flex items-center gap-2 text-emerald-800 dark:text-emerald-300">
                <CheckCircle2 className="size-5" />
                <strong>预演通过</strong>
              </div>
              <dl className="grid gap-3 text-sm sm:grid-cols-3">
                <div>
                  <dt className="text-xs text-stone-500">文件数量</dt>
                  <dd className="mt-1 font-semibold">{fileCount}</dd>
                </div>
                <div>
                  <dt className="text-xs text-stone-500">解包大小</dt>
                  <dd className="mt-1 font-semibold">
                    {(totalBytes / 1024 / 1024).toFixed(1)} MB
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-stone-500">令牌有效期</dt>
                  <dd className="mt-1 font-semibold">
                    {new Date(verification.expiresAt).toLocaleTimeString()}
                  </dd>
                </div>
              </dl>
              <div className="rounded-xl bg-white/80 p-3 text-sm leading-6 text-stone-600 dark:bg-stone-950/60 dark:text-stone-300">
                恢复完成后必须重启服务。出现写入异常时，系统会使用本次操作前创建的回滚快照恢复原文件。
              </div>
              <label
                htmlFor="restore-confirmation"
                className="block text-sm font-medium"
              >
                输入“确认恢复”
              </label>
              <Input
                id="restore-confirmation"
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                autoComplete="off"
                className="min-h-11 rounded-xl"
              />
              <Button
                type="button"
                className="min-h-11 w-full rounded-xl bg-rose-700 text-white hover:bg-rose-600"
                disabled={confirmation !== "确认恢复" || busy === "restore"}
                onClick={() => void restore()}
              >
                执行恢复并创建回滚快照
              </Button>
            </div>
          ) : (
            <EmptyState>
              选择备份并完成预演后，才会显示正式恢复入口。
            </EmptyState>
          )}
        </div>
      </Surface>
    </div>
  );
}
