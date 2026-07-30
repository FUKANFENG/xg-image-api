"use client";

import { ShieldCheck, SlidersHorizontal } from "lucide-react";

export function SettingsHeader() {
  return (
    <header className="flex flex-col gap-4 border-b border-stone-200/80 pb-5 sm:flex-row sm:items-end sm:justify-between dark:border-white/10">
      <div className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-400/20 dark:bg-violet-400/10 dark:text-violet-200">
          <SlidersHorizontal className="size-5" />
        </span>
        <div>
          <div className="text-xs font-semibold tracking-[0.16em] text-stone-400 uppercase">System settings</div>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-stone-950 dark:text-stone-50">系统设置</h1>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-stone-500 dark:text-stone-400">
            集中管理账号调度、接口接入、内容安全和图片存储。
          </p>
        </div>
      </div>
      <div className="inline-flex w-fit items-center gap-2 rounded-full border border-stone-200 bg-white/70 px-3 py-1.5 text-xs font-medium text-stone-600 dark:border-white/10 dark:bg-white/[0.04] dark:text-stone-300">
        <ShieldCheck className="size-3.5 text-emerald-600 dark:text-emerald-300" />
        管理员配置
      </div>
    </header>
  );
}
