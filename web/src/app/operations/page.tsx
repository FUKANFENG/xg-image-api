"use client";

import {
  Activity,
  ArchiveRestore,
  Gauge,
  MessageSquareText,
  Sparkles,
} from "lucide-react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuthGuard } from "@/lib/use-auth-guard";

import { CollaborationPanel } from "./collaboration-panel";
import { DisasterPanel } from "./disaster-panel";
import { EfficiencyPanel } from "./efficiency-panel";
import { ReliabilityPanel } from "./reliability-panel";

export default function OperationsPage() {
  const { isCheckingAuth, session } = useAuthGuard(["user", "admin"]);

  if (isCheckingAuth || !session) {
    return (
      <main className="grid min-h-[65vh] place-items-center" aria-busy="true">
        <div className="flex items-center gap-3 text-sm text-stone-500">
          <span className="size-4 animate-spin rounded-full border-2 border-stone-300 border-t-violet-600" />
          正在载入运营中心
        </div>
      </main>
    );
  }

  const isAdmin = session.role === "admin";

  return (
    <main className="min-h-screen bg-[#f7f5f1] px-3 py-5 text-stone-900 sm:px-5 lg:px-8 dark:bg-stone-950 dark:text-stone-100">
      <div className="mx-auto max-w-[1500px] space-y-5">
        <header className="overflow-hidden rounded-2xl border border-stone-200/80 bg-stone-950 px-5 py-6 text-white shadow-[0_18px_48px_rgba(28,25,23,0.14)] sm:px-7 sm:py-8 dark:border-white/10">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <div className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/[0.06] px-3 py-1.5 text-xs font-semibold tracking-[0.14em] uppercase">
                <Sparkles className="size-3.5 text-violet-300" />
                XG Operations
              </div>
              <h1 className="mt-4 text-3xl font-bold tracking-tight sm:text-4xl">
                创作运营中心
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-7 text-stone-300 sm:text-base">
                把账号调度、额度事实账、任务追踪、批量创作、协作交付和灾备恢复放到一条清晰链路中。
              </p>
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4 lg:w-[500px]">
              {[
                ["账号", "动态调度"],
                ["额度", "逐笔可查"],
                ["任务", "断点恢复"],
                ["交付", "来源可追溯"],
              ].map(([label, value]) => (
                <div
                  key={label}
                  className="rounded-xl border border-white/10 bg-white/[0.05] px-3 py-3"
                >
                  <p className="text-stone-400">{label}</p>
                  <p className="mt-1 font-semibold text-white">{value}</p>
                </div>
              ))}
            </div>
          </div>
        </header>

        <Tabs defaultValue="reliability" className="space-y-5">
          <TabsList className="grid !h-auto w-full grid-cols-2 gap-1 rounded-2xl border border-stone-200/80 bg-white p-1.5 shadow-sm sm:grid-cols-4 dark:border-white/10 dark:bg-stone-900">
            <TabsTrigger
              value="reliability"
              className="h-11 min-h-11 gap-2 rounded-xl data-[state=active]:bg-stone-950 data-[state=active]:text-white dark:data-[state=active]:bg-white dark:data-[state=active]:text-stone-950"
            >
              <Activity className="size-4" />
              可靠性
            </TabsTrigger>
            <TabsTrigger
              value="efficiency"
              className="h-11 min-h-11 gap-2 rounded-xl data-[state=active]:bg-stone-950 data-[state=active]:text-white dark:data-[state=active]:bg-white dark:data-[state=active]:text-stone-950"
            >
              <Gauge className="size-4" />
              创作效率
            </TabsTrigger>
            <TabsTrigger
              value="collaboration"
              className="h-11 min-h-11 gap-2 rounded-xl data-[state=active]:bg-stone-950 data-[state=active]:text-white dark:data-[state=active]:bg-white dark:data-[state=active]:text-stone-950"
            >
              <MessageSquareText className="size-4" />
              协作交付
            </TabsTrigger>
            <TabsTrigger
              value="disaster"
              className="h-11 min-h-11 gap-2 rounded-xl data-[state=active]:bg-stone-950 data-[state=active]:text-white dark:data-[state=active]:bg-white dark:data-[state=active]:text-stone-950"
            >
              <ArchiveRestore className="size-4" />
              灾备恢复
            </TabsTrigger>
          </TabsList>
          <TabsContent value="reliability">
            <ReliabilityPanel isAdmin={isAdmin} />
          </TabsContent>
          <TabsContent value="efficiency">
            <EfficiencyPanel />
          </TabsContent>
          <TabsContent value="collaboration">
            <CollaborationPanel />
          </TabsContent>
          <TabsContent value="disaster">
            <DisasterPanel isAdmin={isAdmin} />
          </TabsContent>
        </Tabs>
      </div>
    </main>
  );
}
