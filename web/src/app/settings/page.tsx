"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Cable,
  CloudCog,
  DatabaseBackup,
  ImageIcon,
  LoaderCircle,
  Network,
  PanelsTopLeft,
  SlidersHorizontal,
} from "lucide-react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuthGuard } from "@/lib/use-auth-guard";

import { BackupSettingsCard } from "./components/backup-settings-card";
import { ApiDocsCard } from "./components/api-docs-card";
import { ConfigCard } from "./components/config-card";
import { CPAPoolDialog } from "./components/cpa-pool-dialog";
import { CPAPoolsCard } from "./components/cpa-pools-card";
import { ImportBrowserDialog } from "./components/import-browser-dialog";
import { ProxyRuntimeCard } from "./components/proxy-runtime-card";
import { SettingsHeader } from "./components/settings-header";
import { Sub2APIConnections } from "./components/sub2api-connections";
import { ThirdPartyAppsCard } from "./components/third-party-apps-card";
import { useSettingsStore } from "./store";

const settingsTabs = [
  { value: "basic", title: "基础配置", description: "运行、风控与存储", icon: SlidersHorizontal },
  { value: "backup", title: "备份", description: "数据备份与恢复", icon: DatabaseBackup },
  { value: "api-docs", title: "接口接入", description: "密钥和调用方式", icon: Cable },
  { value: "canvas", title: "画布入口", description: "第三方创作工具", icon: PanelsTopLeft },
  { value: "proxy", title: "FlareSolverr", description: "代理运行状态", icon: Network },
  { value: "cpa", title: "CPA", description: "代理池管理", icon: CloudCog },
  { value: "sub2api", title: "Sub2API", description: "外部账号同步", icon: ImageIcon },
];

const settingsTabValues = new Set(settingsTabs.map((tab) => tab.value));

function SettingsDataController() {
  const didLoadRef = useRef(false);
  const initialize = useSettingsStore((state) => state.initialize);
  const loadPools = useSettingsStore((state) => state.loadPools);
  const loadBackups = useSettingsStore((state) => state.loadBackups);
  const pools = useSettingsStore((state) => state.pools);
  const backupState = useSettingsStore((state) => state.backupState);

  useEffect(() => {
    if (didLoadRef.current) {
      return;
    }
    didLoadRef.current = true;
    void initialize();
  }, [initialize]);

  useEffect(() => {
    const hasRunningJobs = pools.some((pool) => {
      const status = pool.import_job?.status;
      return status === "pending" || status === "running";
    });
    if (!hasRunningJobs) {
      return;
    }

    const timer = window.setInterval(() => {
      void loadPools(true);
    }, 1500);
    return () => window.clearInterval(timer);
  }, [loadPools, pools]);

  useEffect(() => {
    if (!backupState?.running) {
      return;
    }
    const timer = window.setInterval(() => {
      void loadBackups(true);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [backupState?.running, loadBackups]);

  return null;
}

function SettingsPageContent() {
  const [activeTab, setActiveTab] = useState(() => {
    if (typeof window === "undefined") {
      return "basic";
    }
    const requestedTab = new URLSearchParams(window.location.search).get("tab");
    return requestedTab && settingsTabValues.has(requestedTab)
      ? requestedTab
      : "basic";
  });

  const handleTabChange = useCallback((value: string) => {
    setActiveTab(value);
    const url = new URL(window.location.href);
    if (value === "basic") {
      url.searchParams.delete("tab");
    } else {
      url.searchParams.set("tab", value);
    }
    window.history.replaceState(null, "", `${url.pathname}${url.search}`);
  }, []);

  return (
    <section className="mx-auto w-full max-w-7xl space-y-5 pb-10">
      <SettingsDataController />
      <SettingsHeader />
      <Tabs value={activeTab} onValueChange={handleTabChange} className="gap-5">
        <div className="rounded-2xl border border-stone-200/80 bg-white/80 p-2 shadow-sm backdrop-blur dark:border-white/10 dark:bg-stone-950/65">
          <TabsList className="grid !h-auto w-full grid-cols-2 gap-1 bg-transparent p-0 sm:grid-cols-4 xl:grid-cols-7">
            {settingsTabs.map((tab) => (
              <TabsTrigger
                key={tab.value}
                value={tab.value}
                className="group h-auto min-h-16 min-w-0 justify-start rounded-xl px-3 py-2.5 text-left data-[state=active]:bg-stone-950 data-[state=active]:text-white data-[state=active]:shadow-none dark:data-[state=active]:bg-white dark:data-[state=active]:text-stone-950"
              >
                <tab.icon className="size-4 shrink-0 text-stone-400 transition-colors group-data-[state=active]:text-violet-300 dark:group-data-[state=active]:text-violet-700" />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold">{tab.title}</span>
                  <span className="mt-0.5 hidden truncate text-[11px] font-normal opacity-65 sm:block">{tab.description}</span>
                </span>
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        <TabsContent value="basic">
          <ConfigCard />
        </TabsContent>
        <TabsContent value="proxy">
          <ProxyRuntimeCard />
        </TabsContent>
        <TabsContent value="backup">
          <BackupSettingsCard />
        </TabsContent>
        <TabsContent value="canvas">
          <ThirdPartyAppsCard />
        </TabsContent>
        <TabsContent value="api-docs">
          <ApiDocsCard />
        </TabsContent>
        <TabsContent value="cpa">
          <CPAPoolsCard />
        </TabsContent>
        <TabsContent value="sub2api">
          <Sub2APIConnections />
        </TabsContent>
      </Tabs>
      <CPAPoolDialog />
      <ImportBrowserDialog />
    </section>
  );
}

export default function SettingsPage() {
  const { isCheckingAuth, session } = useAuthGuard(["admin"]);

  if (isCheckingAuth || !session || session.role !== "admin") {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <LoaderCircle className="size-5 animate-spin text-stone-400" />
      </div>
    );
  }

  return <SettingsPageContent />;
}
