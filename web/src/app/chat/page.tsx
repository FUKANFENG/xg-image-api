"use client";

import { Globe2, LoaderCircle, MessageSquareText, Sparkles } from "lucide-react";

import { ChatWorkspace } from "@/app/chat/chat-workspace";
import { useAuthGuard } from "@/lib/use-auth-guard";

export default function ChatPage() {
  const { isCheckingAuth, session } = useAuthGuard(["admin"]);

  if (isCheckingAuth || !session) {
    return (
      <div className="grid min-h-[70vh] place-items-center">
        <LoaderCircle className="size-6 animate-spin text-stone-400" />
      </div>
    );
  }

  return (
    <div className="flex min-h-[calc(100dvh-5rem)] flex-1 flex-col gap-3 pb-2 sm:min-h-[calc(100dvh-7rem)] sm:gap-4">
      <header className="flex flex-col gap-3 px-1 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="flex items-center gap-2 text-[11px] font-semibold tracking-[0.18em] text-stone-400 uppercase">
            <MessageSquareText className="size-3.5" />
            Chat Workspace
          </p>
          <h1 className="mt-1.5 text-2xl font-semibold tracking-tight text-stone-950 sm:text-3xl dark:text-stone-50">
            网页对话
          </h1>
          <p className="mt-1.5 max-w-2xl text-sm leading-6 text-stone-500 dark:text-stone-400">
            使用当前账号池进行多轮文字对话，结果实时流式返回。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-stone-200 bg-white/80 px-3 py-1.5 text-stone-600 dark:border-white/10 dark:bg-white/5 dark:text-stone-300">
            <Globe2 className="size-3.5 text-emerald-600 dark:text-emerald-400" />
            网页通道
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-stone-200 bg-white/80 px-3 py-1.5 text-stone-600 dark:border-white/10 dark:bg-white/5 dark:text-stone-300">
            <Sparkles className="size-3.5 text-violet-600 dark:text-violet-300" />
            Auto 模型
          </span>
        </div>
      </header>

      <ChatWorkspace />
    </div>
  );
}
