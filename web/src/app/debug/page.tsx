"use client";

import {
  Braces,
  FlaskConical,
  Layers3,
  LoaderCircle,
  MessageSquareText,
  Presentation,
  Search,
  ShieldCheck,
} from "lucide-react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuthGuard } from "@/lib/use-auth-guard";

import { ChatPanel } from "./components/chat-panel";
import { PptPanel } from "./components/ppt-panel";
import { PsdPanel } from "./components/psd-panel";
import { SearchPanel } from "./components/search-panel";
import { SkillPanel } from "./components/skill-panel";

const tabs = [
  { value: "skills", title: "搜索 Skill", description: "安装与接入", icon: Braces },
  { value: "search", title: "联网搜索", description: "验证搜索链路", icon: Search },
  { value: "ppt", title: "PPT 生成", description: "演示文稿测试", icon: Presentation },
  { value: "psd", title: "PSD 生成", description: "图层拆分测试", icon: Layers3 },
  { value: "chat", title: "文本对话", description: "模型与多模态", icon: MessageSquareText },
];

export default function DebugPage() {
  const { isCheckingAuth, session } = useAuthGuard(["admin"]);

  if (isCheckingAuth || !session || session.role !== "admin") {
    return (
      <div className="flex min-h-[calc(100vh-49px)] items-center justify-center">
        <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <section className="mx-auto w-full max-w-7xl space-y-5 pb-10">
      <header className="flex flex-col gap-4 border-b border-stone-200/80 pb-5 sm:flex-row sm:items-end sm:justify-between dark:border-white/10">
        <div className="flex items-start gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-400/20 dark:bg-violet-400/10 dark:text-violet-200">
            <FlaskConical className="size-5" />
          </span>
          <div>
            <div className="text-xs font-semibold tracking-[0.16em] text-stone-400 uppercase">Diagnostics</div>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight text-stone-950 dark:text-stone-50">功能调试台</h1>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-stone-500 dark:text-stone-400">
              在正式开放给用户前，独立验证搜索、文件生成和 Access Token 对话链路。
            </p>
          </div>
        </div>
        <div className="inline-flex w-fit items-center gap-2 rounded-full border border-stone-200 bg-white/70 px-3 py-1.5 text-xs font-medium text-stone-600 dark:border-white/10 dark:bg-white/[0.04] dark:text-stone-300">
          <ShieldCheck className="size-3.5 text-emerald-600 dark:text-emerald-300" />
          仅管理员可见
        </div>
      </header>

      <Tabs defaultValue="skills" className="min-h-[calc(100vh-180px)] gap-5">
        <div className="rounded-2xl border border-stone-200/80 bg-white/80 p-2 shadow-sm backdrop-blur dark:border-white/10 dark:bg-stone-950/65">
          <TabsList className="grid !h-auto w-full grid-cols-2 gap-1 bg-transparent p-0 sm:grid-cols-3 lg:grid-cols-5">
            {tabs.map(({ value, title, description, icon: Icon }) => (
              <TabsTrigger
                key={value}
                value={value}
                className="group h-auto min-h-16 min-w-0 justify-start rounded-xl px-3 py-2.5 text-left data-[state=active]:bg-stone-950 data-[state=active]:text-white data-[state=active]:shadow-none dark:data-[state=active]:bg-white dark:data-[state=active]:text-stone-950"
              >
                <Icon className="size-4 shrink-0 text-stone-400 transition-colors group-data-[state=active]:text-violet-300 dark:group-data-[state=active]:text-violet-700" />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold">{title}</span>
                  <span className="mt-0.5 hidden truncate text-[11px] font-normal opacity-65 sm:block">{description}</span>
                </span>
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        <TabsContent value="skills">
          <SkillPanel />
        </TabsContent>
        <TabsContent value="search" className="min-h-0">
          <SearchPanel />
        </TabsContent>
        <TabsContent value="ppt" className="min-h-0">
          <PptPanel />
        </TabsContent>
        <TabsContent value="psd" className="min-h-0">
          <PsdPanel />
        </TabsContent>
        <TabsContent value="chat" className="min-h-0">
          <ChatPanel />
        </TabsContent>
      </Tabs>
    </section>
  );
}
