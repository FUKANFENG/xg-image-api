"use client";

import { LoaderCircle, UsersRound } from "lucide-react";

import { UserAccountsCard } from "@/app/settings/components/user-keys-card";
import { UserOperationsCard } from "@/app/users/user-operations-card";
import { useAuthGuard } from "@/lib/use-auth-guard";

function UserManagementContent() {
  return (
    <section className="space-y-5">
      <header className="flex flex-col gap-3 border-b border-stone-200/80 pb-5 sm:flex-row sm:items-end sm:justify-between dark:border-white/10">
        <div className="flex items-start gap-3">
          <div className="grid size-11 shrink-0 place-items-center rounded-2xl bg-violet-100 text-violet-700 shadow-sm dark:bg-violet-400/15 dark:text-violet-200">
            <UsersRound className="size-5" aria-hidden="true" />
          </div>
          <div>
            <div className="text-xs font-semibold tracking-[0.18em] text-stone-500 uppercase">
              Users
            </div>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight text-stone-950 dark:text-stone-50">
              用户管理
            </h1>
            <p className="mt-1 text-sm leading-6 text-stone-500 dark:text-stone-400">
              查看注册用户，分配生图额度，或快速停用与重置账号。
            </p>
          </div>
        </div>
      </header>
      <UserAccountsCard />
      <UserOperationsCard />
    </section>
  );
}

export default function UserManagementPage() {
  const { isCheckingAuth, session } = useAuthGuard(["admin"]);

  if (isCheckingAuth || !session || session.role !== "admin") {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <LoaderCircle className="size-5 animate-spin text-stone-400" />
      </div>
    );
  }

  return <UserManagementContent />;
}
