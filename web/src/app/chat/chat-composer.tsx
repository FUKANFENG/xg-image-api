"use client";

import { CornerDownLeft, Send, Square } from "lucide-react";
import type { FormEvent, KeyboardEvent } from "react";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

type ChatComposerProps = {
  input: string;
  reasoningEffort: string;
  isStreaming: boolean;
  error: string;
  onInputChange: (value: string) => void;
  onReasoningEffortChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
};

export function ChatComposer({
  input,
  reasoningEffort,
  isStreaming,
  error,
  onInputChange,
  onReasoningEffortChange,
  onSend,
  onStop,
}: ChatComposerProps) {
  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!input.trim() || isStreaming) return;
    onSend();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div className="border-t border-stone-200/80 bg-white/95 px-3 py-3 sm:px-5 sm:py-4 dark:border-white/10 dark:bg-stone-950/80">
      {error ? (
        <div
          role="alert"
          className="mx-auto mb-3 max-w-4xl rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/20 dark:text-rose-300"
        >
          {error}
        </div>
      ) : null}

      <form
        onSubmit={submit}
        className="mx-auto max-w-4xl rounded-2xl border border-stone-200 bg-white p-2 shadow-sm transition focus-within:border-stone-300 focus-within:ring-2 focus-within:ring-stone-200/60 dark:border-white/10 dark:bg-white/[0.04] dark:focus-within:border-white/20 dark:focus-within:ring-white/5"
      >
        <label htmlFor="web-chat-input" className="sr-only">
          输入对话内容
        </label>
        <Textarea
          id="web-chat-input"
          data-testid="chat-input"
          value={input}
          onChange={(event) => onInputChange(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="输入消息，向网页端 Auto 模型提问…"
          disabled={isStreaming}
          rows={3}
          className="max-h-48 min-h-20 resize-none border-0 bg-transparent px-3 py-2 text-[15px] leading-6 shadow-none focus-visible:ring-0 dark:bg-transparent"
        />

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-stone-100 px-1 pt-2 dark:border-white/8">
          <div className="flex min-w-0 items-center gap-2">
            <span className="rounded-lg bg-stone-100 px-2 py-1 text-xs font-medium text-stone-600 dark:bg-white/8 dark:text-stone-300">
              Auto
            </span>
            <Select
              value={reasoningEffort || "default"}
              onValueChange={(value) =>
                onReasoningEffortChange(value === "default" ? "" : value)
              }
              disabled={isStreaming}
            >
              <SelectTrigger
                aria-label="思考强度"
                className="h-8 w-[112px] rounded-lg border-0 bg-stone-50 px-2 text-xs shadow-none dark:bg-white/5"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">默认思考</SelectItem>
                <SelectItem value="low">低</SelectItem>
                <SelectItem value="medium">中</SelectItem>
                <SelectItem value="high">高</SelectItem>
                <SelectItem value="xhigh">超高</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {isStreaming ? (
            <Button
              type="button"
              variant="outline"
              onClick={onStop}
              className="h-9 rounded-xl border-stone-300"
            >
              <Square className="size-3.5 fill-current" />
              停止
            </Button>
          ) : (
            <Button
              type="submit"
              data-testid="chat-send"
              disabled={!input.trim()}
              className="h-9 rounded-xl bg-stone-950 px-4 text-white hover:bg-stone-800 dark:bg-white dark:text-stone-950 dark:hover:bg-stone-200"
            >
              <Send className="size-4" />
              发送
            </Button>
          )}
        </div>
      </form>

      <p className="mx-auto mt-2 flex max-w-4xl items-center justify-center gap-1.5 text-[11px] text-stone-400">
        <CornerDownLeft className="size-3" />
        Enter 发送 · Shift + Enter 换行
      </p>
    </div>
  );
}
