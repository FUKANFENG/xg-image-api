"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CircleAlert, Layers3, LoaderCircle, Presentation } from "lucide-react";

import { PptPanel } from "@/app/debug/components/ppt-panel";
import { PsdPanel } from "@/app/debug/components/psd-panel";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { fetchUserTools, type UserToolsSettings } from "@/lib/api";
import { useAuthGuard } from "@/lib/use-auth-guard";

type UserToolKey = Extract<keyof UserToolsSettings, "ppt" | "psd">;

const toolOrder: UserToolKey[] = ["ppt", "psd"];

const toolMeta: Record<UserToolKey, {
  label: string;
  description: string;
  steps: string[];
  icon: typeof Presentation;
}> = {
  ppt: {
    label: "PPT 智能生成",
    description: "输入主题、受众和重点，生成可直接下载的演示文稿。",
    steps: ["输入主题", "生成演示稿", "下载或继续编辑"],
    icon: Presentation,
  },
  psd: {
    label: "PSD 图层拆分",
    description: "上传参考图并说明需求，输出可编辑 PSD 与图层素材包。",
    steps: ["上传参考图", "智能拆分图层", "下载 PSD 与素材包"],
    icon: Layers3,
  },
};

export default function ToolsPage() {
  const { isCheckingAuth, session } = useAuthGuard(["user"]);
  const [tools, setTools] = useState<UserToolsSettings | null>(null);
  const [error, setError] = useState("");
  const [activeTool, setActiveTool] = useState<UserToolKey>("ppt");
  const [reloadKey, setReloadKey] = useState(0);

  const retryLoadingTools = useCallback(() => {
    setTools(null);
    setError("");
    setReloadKey((value) => value + 1);
  }, []);

  useEffect(() => {
    if (!session) {
      return;
    }

    let isCurrent = true;
    void fetchUserTools()
      .then((data) => {
        if (isCurrent) {
          setTools(data.tools);
          setError("");
        }
      })
      .catch((loadError: unknown) => {
        if (isCurrent) {
          setError(loadError instanceof Error ? loadError.message : "读取工具权限失败");
        }
      });

    return () => {
      isCurrent = false;
    };
  }, [reloadKey, session]);

  const enabledTools = useMemo(() => toolOrder.filter((tool) => tools?.[tool]), [tools]);
  const selectedTool: UserToolKey = enabledTools.includes(activeTool) ? activeTool : (enabledTools[0] ?? "ppt");
  const selectedMeta = toolMeta[selectedTool];
  const SelectedIcon = selectedMeta.icon;
  const isLoading = tools === null && !error;

  if (isCheckingAuth || !session || isLoading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center" aria-live="polite">
        <LoaderCircle className="size-5 animate-spin text-stone-400" />
        <span className="sr-only">正在读取工具权限</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="mx-auto w-full max-w-3xl py-10">
        <div role="alert" className="rounded-[28px] border border-rose-200 bg-rose-50 px-6 py-5 text-sm leading-6 text-rose-700 dark:border-rose-400/25 dark:bg-rose-400/10 dark:text-rose-200">
          <div className="flex items-start gap-3">
            <CircleAlert className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
            <div>
              <p className="font-semibold">工具中心暂时不可用</p>
              <p className="mt-1">{error}</p>
              <Button type="button" variant="outline" className="mt-4 h-11 rounded-xl border-rose-200 bg-white text-rose-700" onClick={retryLoadingTools}>
                重新尝试
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (enabledTools.length === 0) {
    return (
      <div className="mx-auto w-full max-w-3xl py-10">
        <section className="rounded-[30px] border border-white/80 bg-white/90 px-6 py-10 text-center shadow-[0_24px_60px_-42px_rgba(67,56,202,0.45)] dark:border-white/10 dark:bg-stone-900/75">
          <div className="mx-auto grid size-12 place-items-center rounded-2xl bg-violet-50 text-violet-700 dark:bg-violet-400/10 dark:text-violet-200"><CircleAlert className="size-5" aria-hidden="true" /></div>
          <h1 className="mt-4 text-2xl font-semibold tracking-tight text-stone-950 dark:text-white">文档创作工具暂未开放</h1>
          <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-stone-500 dark:text-stone-400">管理员暂未为当前账号开放 PPT 或 PSD 创作工具。你仍可返回创作台继续生成图片。</p>
        </section>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-7xl pb-10 sm:pb-14">
      <Tabs value={selectedTool} onValueChange={(value) => setActiveTool(value as UserToolKey)} className="gap-4">
        <section className="rounded-2xl border border-stone-200 bg-white px-4 py-4 shadow-sm dark:border-white/10 dark:bg-stone-900 sm:px-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex min-w-0 items-start gap-3">
              <div className="grid size-11 shrink-0 place-items-center rounded-xl bg-violet-600 text-white shadow-sm dark:bg-violet-400 dark:text-violet-950">
                <SelectedIcon className="size-5" aria-hidden="true" />
              </div>
              <div className="min-w-0">
                <p className="text-xs font-semibold tracking-[0.12em] text-violet-700 dark:text-violet-200">创作工具</p>
                <h1 className="mt-0.5 text-xl font-semibold tracking-tight text-stone-950 dark:text-white">{selectedMeta.label}</h1>
                <p className="mt-1 text-sm leading-6 text-stone-600 dark:text-stone-300">{selectedMeta.description}</p>
              </div>
            </div>
            <TabsList aria-label="选择创作工具" className="grid !h-auto !w-full grid-cols-2 rounded-xl border border-stone-200 bg-stone-50 p-1 dark:border-white/10 dark:bg-white/[0.04] lg:!w-auto">
              {enabledTools.map((tool) => {
                const meta = toolMeta[tool];
                const Icon = meta.icon;
                return (
                  <TabsTrigger
                    key={tool}
                    value={tool}
                    aria-label={`切换到${meta.label}`}
                    className="h-11 min-w-0 gap-2 rounded-lg px-3 text-sm font-semibold text-stone-500 transition duration-200 ease-out hover:bg-white hover:text-stone-950 focus-visible:ring-violet-500/40 data-[state=active]:bg-white data-[state=active]:text-violet-700 data-[state=active]:shadow-sm motion-reduce:transition-none dark:text-stone-400 dark:hover:bg-white/10 dark:hover:text-white dark:data-[state=active]:bg-white/10 dark:data-[state=active]:text-violet-200 after:hidden lg:min-w-32"
                  >
                    <Icon className="size-4" aria-hidden="true" />
                    <span>{tool === "ppt" ? "PPT 生成" : "PSD 拆分"}</span>
                  </TabsTrigger>
                );
              })}
            </TabsList>
          </div>
          <div className="mt-4 flex flex-wrap gap-x-3 gap-y-2 border-t border-stone-100 pt-3 text-xs font-medium text-stone-500 dark:border-white/10 dark:text-stone-400">
            {selectedMeta.steps.map((step, index) => (
              <span key={step} className="inline-flex items-center gap-2">
                {index > 0 ? <span className="size-1 rounded-full bg-violet-400" aria-hidden="true" /> : null}
                {step}
              </span>
            ))}
          </div>
        </section>

        <div className="min-h-0">
          <div className="sr-only" aria-live="polite">当前工具：{selectedMeta.label}</div>
          {tools?.ppt ? <TabsContent value="ppt" className="mt-0"><PptPanel /></TabsContent> : null}
          {tools?.psd ? <TabsContent value="psd" className="mt-0"><PsdPanel /></TabsContent> : null}
        </div>
      </Tabs>
    </div>
  );
}
