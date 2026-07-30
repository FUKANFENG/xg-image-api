"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Bot,
  LoaderCircle,
  MessageSquarePlus,
  Send,
  UserRound,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  createAssetConversation,
  fetchAssetConversations,
  fetchCreativeAsset,
  fetchCreativeConversation,
  submitCreativeConversationMessage,
  type CreativeAsset,
  type CreativeConversation,
} from "@/lib/api";
import { USER_DEFAULT_IMAGE_MODEL } from "@/lib/image-model-policy";
import { cn } from "@/lib/utils";

export function ConversationEditor({
  asset,
  onAssetUpdated,
}: {
  asset: CreativeAsset;
  onAssetUpdated: (asset: CreativeAsset) => void;
}) {
  const [conversation, setConversation] = useState<CreativeConversation | null>(
    null,
  );
  const [instruction, setInstruction] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState("");

  const loadConversation = useCallback(async () => {
    setIsLoading(true);
    try {
      const list = await fetchAssetConversations(asset.id);
      const selected = list.items[0]
        ? await fetchCreativeConversation(list.items[0].id)
        : await createAssetConversation(asset.id, `${asset.name} · 连续修改`);
      setConversation(selected);
      setError("");
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : "连续修改记录加载失败",
      );
    } finally {
      setIsLoading(false);
    }
  }, [asset.id, asset.name]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadConversation(), 0);
    return () => window.clearTimeout(timer);
  }, [loadConversation]);

  const hasRunningMessage = useMemo(
    () =>
      conversation?.messages?.some((message) => message.status === "running") ||
      false,
    [conversation],
  );

  useEffect(() => {
    if (!conversation || !hasRunningMessage) return;
    const timer = window.setInterval(() => {
      void Promise.all([
        fetchCreativeConversation(conversation.id),
        fetchCreativeAsset(asset.id),
      ])
        .then(([nextConversation, nextAsset]) => {
          setConversation(nextConversation);
          onAssetUpdated(nextAsset);
        })
        .catch(() => undefined);
    }, 1800);
    return () => window.clearInterval(timer);
  }, [asset.id, conversation, hasRunningMessage, onAssetUpdated]);

  const submit = async () => {
    const content = instruction.trim();
    if (!conversation || !content || hasRunningMessage) return;
    setIsSubmitting(true);
    setError("");
    try {
      const result = await submitCreativeConversationMessage(conversation.id, {
        instruction: content,
        model: USER_DEFAULT_IMAGE_MODEL,
        size: "1024x1024",
        quality: "auto",
      });
      setConversation(result.conversation);
      setInstruction("");
      toast.success("修改要求已加入队列");
    } catch (submitError) {
      setError(
        submitError instanceof Error ? submitError.message : "修改要求提交失败",
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex min-h-32 items-center justify-center rounded-2xl border border-stone-200 bg-white dark:border-white/10 dark:bg-stone-950">
        <LoaderCircle className="size-5 animate-spin text-violet-600" />
      </div>
    );
  }

  return (
    <section
      className="rounded-3xl border border-stone-200 bg-white p-4 dark:border-white/10 dark:bg-stone-950"
      aria-labelledby="conversation-heading"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <MessageSquarePlus className="size-5 text-violet-600" />
            <h3
              id="conversation-heading"
              className="font-semibold text-stone-900 dark:text-white"
            >
              对话式连续修改
            </h3>
          </div>
          <p className="mt-1 text-sm leading-6 text-stone-500">
            每轮自动使用当前成功版本，并参考此前修改要求。
          </p>
        </div>
        <span className="rounded-full bg-stone-100 px-2.5 py-1 text-xs text-stone-500 dark:bg-white/10 dark:text-stone-300">
          {conversation?.messages?.filter((item) => item.role === "user")
            .length || 0}{" "}
          轮
        </span>
      </div>

      <div
        className="mt-4 max-h-80 space-y-3 overflow-y-auto rounded-2xl bg-stone-50 p-3 dark:bg-white/[0.03]"
        aria-live="polite"
      >
        {conversation?.messages?.map((message) => (
          <div
            key={message.id}
            className={cn(
              "flex gap-2",
              message.role === "user" ? "justify-end" : "justify-start",
            )}
          >
            {message.role === "assistant" ? (
              <span className="grid size-8 shrink-0 place-items-center rounded-full bg-violet-100 text-violet-700 dark:bg-violet-400/10 dark:text-violet-200">
                <Bot className="size-4" />
              </span>
            ) : null}
            <div
              className={cn(
                "max-w-[85%] rounded-2xl px-3 py-2 text-sm leading-6",
                message.role === "user"
                  ? "rounded-br-md bg-violet-700 text-white"
                  : "rounded-bl-md border border-stone-200 bg-white text-stone-700 dark:border-white/10 dark:bg-stone-900 dark:text-stone-200",
                message.status === "error" && "bg-rose-600 text-white",
              )}
            >
              <p className="whitespace-pre-wrap">{message.content}</p>
              {message.status === "running" ? (
                <span className="mt-1 inline-flex items-center gap-1 text-xs opacity-80">
                  <LoaderCircle className="size-3 animate-spin" />
                  正在生成新版本
                </span>
              ) : null}
            </div>
            {message.role === "user" ? (
              <span className="grid size-8 shrink-0 place-items-center rounded-full bg-stone-200 text-stone-600 dark:bg-white/10 dark:text-stone-200">
                <UserRound className="size-4" />
              </span>
            ) : null}
          </div>
        ))}
        {!conversation?.messages?.length ? (
          <div className="py-8 text-center text-sm text-stone-500">
            例如：背景亮一点，人物保持不变；或改成横版海报。
          </div>
        ) : null}
      </div>

      <label className="mt-4 block space-y-2">
        <span className="text-sm font-medium text-stone-700 dark:text-stone-200">
          本轮修改要求
        </span>
        <textarea
          value={instruction}
          onChange={(event) => setInstruction(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              void submit();
            }
          }}
          rows={3}
          disabled={hasRunningMessage || isSubmitting}
          className="w-full resize-y rounded-2xl border border-stone-200 bg-stone-50 px-4 py-3 text-base leading-6 outline-none transition focus:border-violet-500 focus:ring-4 focus:ring-violet-500/10 disabled:cursor-not-allowed disabled:opacity-60 dark:border-white/10 dark:bg-stone-900"
          placeholder={
            hasRunningMessage
              ? "当前一轮完成后可继续输入"
              : "只写本轮需要改变的内容…"
          }
        />
      </label>
      {error ? (
        <p
          className="mt-2 text-sm text-rose-600 dark:text-rose-300"
          role="alert"
        >
          {error}
        </p>
      ) : null}
      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <span className="text-xs text-stone-500">
          Ctrl / ⌘ + Enter 快速发送
        </span>
        <Button
          type="button"
          disabled={!instruction.trim() || isSubmitting || hasRunningMessage}
          onClick={() => void submit()}
          className="min-h-11 rounded-xl bg-violet-700 text-white hover:bg-violet-800"
        >
          {isSubmitting || hasRunningMessage ? (
            <LoaderCircle className="size-4 animate-spin" />
          ) : (
            <Send className="size-4" />
          )}
          {hasRunningMessage ? "正在生成" : "发送修改要求"}
        </Button>
      </div>
    </section>
  );
}
