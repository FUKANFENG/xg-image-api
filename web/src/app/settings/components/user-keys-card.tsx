"use client";

import { useEffect, useRef, useState } from "react";
import { Ban, CheckCircle2, LockKeyhole, LoaderCircle, Pencil, RefreshCw, Trash2, UserRound } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
  deleteUserAccount,
  fetchUserAccounts,
  updateUserAccount,
  type UserAccount,
} from "@/lib/api";

function formatDateTime(value?: string | null) {
  if (!value) {
    return "—";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function parseQuota(value: string) {
  return Math.min(100000, Math.max(0, Math.floor(Number(value) || 0)));
}

function validatePassword(password: string, confirmation: string, required: boolean) {
  if (!password && !confirmation && !required) {
    return "";
  }
  if (password.length < 8) {
    return "密码至少需要 8 位";
  }
  if (password !== confirmation) {
    return "两次输入的密码不一致";
  }
  return "";
}

export function UserAccountsCard() {
  const didLoadRef = useRef(false);
  const [items, setItems] = useState<UserAccount[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [pendingIds, setPendingIds] = useState<Set<string>>(() => new Set());
  const [deletingItem, setDeletingItem] = useState<UserAccount | null>(null);
  const [editingItem, setEditingItem] = useState<UserAccount | null>(null);
  const [editName, setEditName] = useState("");
  const [editUsername, setEditUsername] = useState("");
  const [editPassword, setEditPassword] = useState("");
  const [editPasswordConfirmation, setEditPasswordConfirmation] = useState("");
  const [editQuota, setEditQuota] = useState("0");

  const load = async () => {
    setIsLoading(true);
    try {
      const data = await fetchUserAccounts();
      setItems(data.items);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "加载用户账号失败");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (didLoadRef.current) {
      return;
    }
    didLoadRef.current = true;
    void load();
  }, []);

  const setItemPending = (id: string, isPending: boolean) => {
    setPendingIds((current) => {
      const next = new Set(current);
      if (isPending) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  };

  const handleToggle = async (item: UserAccount) => {
    setItemPending(item.id, true);
    try {
      const data = await updateUserAccount(item.id, { enabled: !item.enabled });
      setItems(data.items);
      toast.success(item.enabled ? "用户账号已停用，现有会话已失效" : "用户账号已启用");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "更新用户账号失败");
    } finally {
      setItemPending(item.id, false);
    }
  };

  const handleDelete = async () => {
    if (!deletingItem) {
      return;
    }
    const item = deletingItem;
    setItemPending(item.id, true);
    try {
      const data = await deleteUserAccount(item.id);
      setItems(data.items);
      setDeletingItem(null);
      toast.success("用户账号已删除");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除用户账号失败");
    } finally {
      setItemPending(item.id, false);
    }
  };

  const openEditDialog = (item: UserAccount) => {
    setEditingItem(item);
    setEditName(item.name);
    setEditUsername(item.username || "");
    setEditPassword("");
    setEditPasswordConfirmation("");
    setEditQuota(String(item.image_quota));
  };

  const handleEdit = async () => {
    if (!editingItem) {
      return;
    }
    const item = editingItem;
    const usernameValue = editUsername.trim();
    const passwordError = validatePassword(editPassword, editPasswordConfirmation, !item.password_configured);
    if (!usernameValue) {
      toast.error("请输入登录账号");
      return;
    }
    if (passwordError) {
      toast.error(passwordError);
      return;
    }

    const nextQuota = parseQuota(editQuota);
    const updates = {
      ...(editName.trim() !== item.name ? { name: editName.trim() } : {}),
      ...(usernameValue !== item.username ? { username: usernameValue } : {}),
      ...(nextQuota !== item.image_quota ? { image_quota: nextQuota } : {}),
      ...(editPassword ? { password: editPassword } : {}),
    };
    if (Object.keys(updates).length === 0) {
      setEditingItem(null);
      return;
    }

    setItemPending(item.id, true);
    try {
      const data = await updateUserAccount(item.id, updates);
      setItems(data.items);
      setEditingItem(null);
      setEditPassword("");
      setEditPasswordConfirmation("");
      toast.success(editPassword ? "用户密码已更新，原会话已失效" : "用户账号已更新");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "更新用户账号失败");
    } finally {
      setItemPending(item.id, false);
    }
  };

  return (
    <>
      <Card className="rounded-2xl border-white/80 bg-white/90 shadow-sm">
        <CardContent className="space-y-6 p-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex items-center gap-3">
              <div className="flex size-10 items-center justify-center rounded-xl bg-violet-50 dark:bg-violet-400/10">
                <UserRound className="size-5 text-violet-700 dark:text-violet-200" />
              </div>
              <div>
                <h2 className="text-lg font-semibold tracking-tight">注册用户与生图额度</h2>
                <p className="text-sm leading-6 text-stone-500">用户自行注册；你可以查看注册用户、分配可生成张数，或停用和重置密码。</p>
              </div>
            </div>
            <Button type="button" variant="outline" className="h-11 rounded-xl border-stone-200 bg-white px-4 text-stone-700" onClick={() => void load()} disabled={isLoading}>
              <RefreshCw className={isLoading ? "size-4 animate-spin" : "size-4"} />
              刷新用户
            </Button>
          </div>

          {isLoading ? (
            <div className="flex items-center justify-center py-10"><LoaderCircle className="size-5 animate-spin text-stone-400" /></div>
          ) : items.length === 0 ? (
            <div className="rounded-xl bg-stone-50 px-6 py-10 text-center text-sm leading-6 text-stone-500">
              暂无注册用户。使用者可从登录页自行注册；新账号初始额度为 100 张，管理员可按需调整。
            </div>
          ) : (
            <div className="space-y-3">
              {items.map((item) => {
                const isPending = pendingIds.has(item.id);
                return (
                  <div key={item.id} className="flex flex-col gap-4 rounded-2xl border border-stone-200 bg-white px-4 py-4 dark:border-white/10 dark:bg-white/5 lg:flex-row lg:items-center lg:justify-between">
                    <div className="min-w-0 space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="truncate text-sm font-semibold text-stone-800 dark:text-stone-100">{item.name}</div>
                        <Badge variant={item.enabled ? "success" : "secondary"} className="rounded-md">{item.enabled ? "已启用" : "已停用"}</Badge>
                        {!item.password_configured ? <Badge variant="warning" className="rounded-md">待设置密码</Badge> : null}
                      </div>
                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs leading-5 text-stone-500">
                        <span>账号 {item.username || "—"}</span>
                        <span>剩余 {item.image_quota} 张</span>
                        <span>已消耗 {item.image_quota_used} 张</span>
                        <span>最近登录 {formatDateTime(item.last_used_at)}</span>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <Button type="button" variant="outline" className="h-10 rounded-xl border-stone-200 bg-white px-4 text-stone-700" onClick={() => openEditDialog(item)} disabled={isPending}>
                        {isPending ? <LoaderCircle className="size-4 animate-spin" /> : <Pencil className="size-4" />}
                        管理用户
                      </Button>
                      <Button type="button" variant="outline" className="h-10 rounded-xl border-stone-200 bg-white px-4 text-stone-700" onClick={() => void handleToggle(item)} disabled={isPending}>
                        {isPending ? <LoaderCircle className="size-4 animate-spin" /> : item.enabled ? <Ban className="size-4" /> : <CheckCircle2 className="size-4" />}
                        {item.enabled ? "停用" : "启用"}
                      </Button>
                      <Button type="button" variant="outline" className="h-10 rounded-xl border-rose-200 bg-white px-4 text-rose-600 hover:bg-rose-50 hover:text-rose-700" onClick={() => setDeletingItem(item)} disabled={isPending}>
                        {isPending ? <LoaderCircle className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                        删除
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={Boolean(deletingItem)} onOpenChange={(open) => (!open ? setDeletingItem(null) : null)}>
        <DialogContent className="rounded-2xl p-6">
          <DialogHeader className="gap-2">
            <DialogTitle>删除用户账号</DialogTitle>
            <DialogDescription className="text-sm leading-6">确认删除「{deletingItem?.name}」吗？该用户将无法再登录，历史任务记录会按现有保留期保存。</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="secondary" className="h-10 rounded-xl bg-stone-100 px-5 text-stone-700 hover:bg-stone-200" onClick={() => setDeletingItem(null)} disabled={deletingItem ? pendingIds.has(deletingItem.id) : false}>取消</Button>
            <Button type="button" className="h-10 rounded-xl bg-rose-600 px-5 text-white hover:bg-rose-700" onClick={() => void handleDelete()} disabled={deletingItem ? pendingIds.has(deletingItem.id) : false}>
              {deletingItem && pendingIds.has(deletingItem.id) ? <LoaderCircle className="size-4 animate-spin" /> : <Trash2 className="size-4" />}删除账号
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(editingItem)} onOpenChange={(open) => { if (!open) setEditingItem(null); }}>
        <DialogContent className="rounded-2xl p-6">
          <DialogHeader className="gap-2">
            <DialogTitle>管理注册用户</DialogTitle>
            <DialogDescription className="text-sm leading-6">修改剩余额度会立即生效；重置密码会使该用户的当前会话失效。</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2 sm:col-span-2">
              <label htmlFor="edit-user-display-name" className="text-sm font-medium text-stone-700">显示名称</label>
              <Input id="edit-user-display-name" value={editName} onChange={(event) => setEditName(event.target.value)} className="h-11 rounded-xl border-stone-200 bg-white" />
            </div>
            <div className="space-y-2">
              <label htmlFor="edit-user-username" className="text-sm font-medium text-stone-700">登录账号</label>
              <Input id="edit-user-username" autoComplete="off" value={editUsername} onChange={(event) => setEditUsername(event.target.value)} className="h-11 rounded-xl border-stone-200 bg-white" />
            </div>
            <div className="space-y-2">
              <label htmlFor="edit-user-quota" className="text-sm font-medium text-stone-700">剩余额度（张）</label>
              <Input id="edit-user-quota" type="number" min="0" max="100000" inputMode="numeric" value={editQuota} onChange={(event) => setEditQuota(event.target.value)} className="h-11 rounded-xl border-stone-200 bg-white" />
            </div>
            <div className="space-y-2">
              <label htmlFor="edit-user-password" className="text-sm font-medium text-stone-700">新密码（可选）</label>
              <Input id="edit-user-password" type="password" autoComplete="new-password" value={editPassword} onChange={(event) => setEditPassword(event.target.value)} placeholder={editingItem?.password_configured ? "留空则不修改" : "此旧账号需要设置密码"} className="h-11 rounded-xl border-stone-200 bg-white" />
            </div>
            <div className="space-y-2">
              <label htmlFor="edit-user-password-confirm" className="text-sm font-medium text-stone-700">确认新密码</label>
              <Input id="edit-user-password-confirm" type="password" autoComplete="new-password" value={editPasswordConfirmation} onChange={(event) => setEditPasswordConfirmation(event.target.value)} placeholder="再次输入新密码" className="h-11 rounded-xl border-stone-200 bg-white" />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="secondary" className="h-10 rounded-xl bg-stone-100 px-5 text-stone-700 hover:bg-stone-200" onClick={() => setEditingItem(null)} disabled={editingItem ? pendingIds.has(editingItem.id) : false}>取消</Button>
            <Button type="button" className="h-10 rounded-xl bg-stone-950 px-5 text-white hover:bg-stone-800" onClick={() => void handleEdit()} disabled={editingItem ? pendingIds.has(editingItem.id) : false}>
              {editingItem && pendingIds.has(editingItem.id) ? <LoaderCircle className="size-4 animate-spin" /> : <LockKeyhole className="size-4" />}保存修改
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
