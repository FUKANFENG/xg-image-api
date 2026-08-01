"use client";

import { Bot, Check, Copy, User } from "lucide-react";
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { TextChatMessage } from "@/store/text-conversations";

function formatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function StreamingDots() {
  return (
    <span className="inline-flex items-center gap-1 py-1" aria-label="正在回复">
      {[0, 1, 2].map((index) => (
        <span
          key={index}
          className="size-1.5 animate-pulse rounded-full bg-violet-500"
          style={{ animationDelay: `${index * 140}ms` }}
        />
      ))}
    </span>
  );
}

function AssistantContent({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ children, ...props }) => (
          <a
            {...props}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-violet-700 underline decoration-violet-300 underline-offset-4 hover:text-violet-900 dark:text-violet-300 dark:hover:text-violet-200"
          >
            {children}
          </a>
        ),
        p: ({ children }) => (
          <p className="my-2 first:mt-0 last:mb-0">{children}</p>
        ),
        ul: ({ children }) => (
          <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>
        ),
        ol: ({ children }) => (
          <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>
        ),
        blockquote: ({ children }) => (
          <blockquote className="my-3 border-l-2 border-stone-300 pl-4 text-stone-600 dark:border-stone-600 dark:text-stone-300">
            {children}
          </blockquote>
        ),
        code: ({ children, className }) => (
          <code
            className={cn(
              "rounded bg-stone-100 px-1.5 py-0.5 font-mono text-[0.9em] dark:bg-white/10",
              className,
            )}
          >
            {children}
          </code>
        ),
        pre: ({ children }) => (
          <pre className="my-3 overflow-x-auto rounded-xl border border-stone-200 bg-stone-950 p-4 text-[13px] leading-6 text-stone-100 dark:border-white/10">
            {children}
          </pre>
        ),
      }}
    >
      {content}
    </ReactMarkdown>
  );
}

export function ChatMessage({ message }: { message: TextChatMessage }) {
  const [copied, setCopied] = useState(false);
  const isUser = message.role === "user";

  const copyMessage = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("复制失败，请手动选择文字");
    }
  };

  return (
    <article
      className={cn(
        "group flex items-start gap-3",
        isUser && "flex-row-reverse",
      )}
      aria-label={isUser ? "我的消息" : "助手回复"}
    >
      <span
        className={cn(
          "mt-0.5 grid size-8 shrink-0 place-items-center rounded-full",
          isUser
            ? "bg-stone-950 text-white dark:bg-white dark:text-stone-950"
            : "bg-violet-100 text-violet-700 dark:bg-violet-400/15 dark:text-violet-200",
        )}
      >
        {isUser ? <User className="size-4" /> : <Bot className="size-4" />}
      </span>

      <div
        className={cn(
          "min-w-0 max-w-[88%] sm:max-w-[80%]",
          !isUser && "flex-1",
        )}
      >
        <div
          className={cn(
            "mb-1.5 flex items-center gap-2 text-[11px] text-stone-400",
            isUser && "justify-end",
          )}
        >
          <span className="font-semibold tracking-wide uppercase">
            {isUser ? "我" : "Assistant"}
          </span>
          <time dateTime={message.createdAt}>{formatTime(message.createdAt)}</time>
        </div>

        <div
          className={cn(
            "relative text-sm leading-7",
            isUser
              ? "rounded-2xl rounded-tr-md bg-stone-950 px-4 py-2.5 whitespace-pre-wrap text-white dark:bg-white dark:text-stone-950"
              : "rounded-2xl rounded-tl-md border border-stone-200/80 bg-white px-4 py-3 text-stone-700 shadow-sm dark:border-white/10 dark:bg-white/[0.05] dark:text-stone-200",
            !isUser && message.content && "pr-10",
          )}
        >
          {message.content ? (
            isUser ? (
              message.content
            ) : (
              <AssistantContent content={message.content} />
            )
          ) : message.status === "streaming" ? (
            <StreamingDots />
          ) : (
            <span className="text-stone-400">回复已停止</span>
          )}

          {!isUser && message.content ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="复制回复"
              onClick={() => void copyMessage()}
              className="absolute right-1.5 top-1.5 size-7 text-stone-400 opacity-60 transition sm:opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            >
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            </Button>
          ) : null}
        </div>

        {message.status === "stopped" ? (
          <p className="mt-1.5 text-xs text-amber-700 dark:text-amber-300">
            已停止生成，已保留当前内容
          </p>
        ) : null}
        {message.status === "error" && message.error ? (
          <p role="alert" className="mt-1.5 text-xs text-rose-700 dark:text-rose-300">
            {message.error}
          </p>
        ) : null}
      </div>
    </article>
  );
}
