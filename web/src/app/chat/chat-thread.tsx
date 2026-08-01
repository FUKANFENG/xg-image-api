"use client";

import {
  Globe2,
  MessageSquareText,
  PanelLeft,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useEffect, useRef } from "react";

import { ChatComposer } from "@/app/chat/chat-composer";
import { ChatMessage } from "@/app/chat/chat-message";
import { Button } from "@/components/ui/button";
import type { TextConversation } from "@/store/text-conversations";

const PROMPT_SUGGESTIONS = [
  "帮我把今天要做的事情整理成一份清晰的执行清单",
  "分析这个项目当前最值得优先优化的三个方向",
  "写一段简洁的 API 接入说明，面向第一次使用的人",
];

type ChatThreadProps = {
  conversation: TextConversation;
  input: string;
  reasoningEffort: string;
  isStreaming: boolean;
  error: string;
  onOpenHistory: () => void;
  onClear: () => void;
  onInputChange: (value: string) => void;
  onReasoningEffortChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
};

export function ChatThread({
  conversation,
  input,
  reasoningEffort,
  isStreaming,
  error,
  onOpenHistory,
  onClear,
  onInputChange,
  onReasoningEffortChange,
  onSend,
  onStop,
}: ChatThreadProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastMessage = conversation.messages.at(-1);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
  }, [conversation.id, lastMessage?.content, lastMessage?.status]);

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col bg-white/85 dark:bg-stone-950/55">
      <header className="flex min-h-16 items-center justify-between gap-3 border-b border-stone-200/80 px-3 sm:px-5 dark:border-white/10">
        <div className="flex min-w-0 items-center gap-2.5">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="打开对话记录"
            onClick={onOpenHistory}
            className="size-9 lg:hidden"
          >
            <PanelLeft className="size-4" />
          </Button>
          <span className="hidden size-9 shrink-0 place-items-center rounded-xl bg-violet-50 text-violet-700 sm:grid dark:bg-violet-400/10 dark:text-violet-200">
            <MessageSquareText className="size-4" />
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-stone-950 sm:text-base dark:text-stone-50">
              {conversation.title}
            </h2>
            <div className="mt-0.5 flex items-center gap-2 text-[11px] text-stone-400">
              <span className="inline-flex items-center gap-1">
                <Globe2 className="size-3" />
                ChatGPT 网页通道
              </span>
              <span aria-hidden="true">·</span>
              <span>Auto 模型</span>
            </div>
          </div>
        </div>

        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onClear}
          disabled={!conversation.messages.length || isStreaming}
          className="rounded-xl text-stone-500 hover:text-rose-600"
        >
          <Trash2 className="size-3.5" />
          <span className="hidden sm:inline">清空当前对话</span>
        </Button>
      </header>

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto bg-stone-50/45 px-3 py-5 sm:px-6 sm:py-7 dark:bg-black/10"
      >
        {conversation.messages.length ? (
          <div
            className="mx-auto max-w-4xl space-y-6"
            aria-live={isStreaming ? "polite" : "off"}
          >
            {conversation.messages.map((message) => (
              <ChatMessage key={message.id} message={message} />
            ))}
          </div>
        ) : (
          <div className="mx-auto flex h-full min-h-80 max-w-3xl flex-col items-center justify-center px-2 text-center">
            <span className="grid size-14 place-items-center rounded-2xl border border-stone-200 bg-white text-violet-600 shadow-sm dark:border-white/10 dark:bg-white/[0.05] dark:text-violet-300">
              <Sparkles className="size-6" />
            </span>
            <h2 className="mt-5 text-xl font-semibold tracking-tight text-stone-950 dark:text-stone-50">
              今天想聊点什么？
            </h2>
            <p className="mt-2 max-w-lg text-sm leading-6 text-stone-500 dark:text-stone-400">
              这里直接调用当前账号池的 ChatGPT 网页对话通道，模型由 Auto
              模式自动选择。
            </p>
            <div className="mt-6 grid w-full gap-2 sm:grid-cols-3">
              {PROMPT_SUGGESTIONS.map((suggestion) => (
                <button
                  type="button"
                  key={suggestion}
                  onClick={() => onInputChange(suggestion)}
                  className="rounded-xl border border-stone-200 bg-white px-3 py-3 text-left text-xs leading-5 text-stone-600 shadow-sm transition hover:border-violet-200 hover:bg-violet-50/50 hover:text-violet-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 dark:border-white/10 dark:bg-white/[0.04] dark:text-stone-300 dark:hover:border-violet-400/30 dark:hover:bg-violet-400/8"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <ChatComposer
        input={input}
        reasoningEffort={reasoningEffort}
        isStreaming={isStreaming}
        error={error}
        onInputChange={onInputChange}
        onReasoningEffortChange={onReasoningEffortChange}
        onSend={onSend}
        onStop={onStop}
      />
    </section>
  );
}
