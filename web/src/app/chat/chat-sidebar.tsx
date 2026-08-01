"use client";

import { MessageSquare, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { TextConversation } from "@/store/text-conversations";

function formatUpdatedAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const today = new Date();
  const isToday = date.toDateString() === today.toDateString();
  return new Intl.DateTimeFormat("zh-CN", {
    ...(isToday ? {} : { month: "2-digit", day: "2-digit" }),
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

type ChatSidebarProps = {
  conversations: TextConversation[];
  activeConversationId: string;
  disabled?: boolean;
  onCreate: () => void;
  onSelect: (id: string) => void;
  onRequestDelete: (conversation: TextConversation) => void;
};

export function ChatSidebar({
  conversations,
  activeConversationId,
  disabled,
  onCreate,
  onSelect,
  onRequestDelete,
}: ChatSidebarProps) {
  return (
    <aside className="flex h-full min-h-0 flex-col bg-stone-50/80 dark:bg-black/15">
      <div className="border-b border-stone-200/80 p-3 dark:border-white/10">
        <Button
          type="button"
          onClick={onCreate}
          disabled={disabled}
          className="h-10 w-full justify-start rounded-xl bg-stone-950 text-white hover:bg-stone-800 dark:bg-white dark:text-stone-950 dark:hover:bg-stone-200"
        >
          <Plus className="size-4" />
          新建对话
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <p className="px-2 pb-2 pt-1 text-[11px] font-semibold tracking-[0.14em] text-stone-400 uppercase">
          本机对话记录
        </p>
        <div className="space-y-1" role="list">
          {conversations.map((conversation) => {
            const active = conversation.id === activeConversationId;
            return (
              <div
                key={conversation.id}
                role="listitem"
                className={cn(
                  "group flex items-center gap-1 rounded-xl border border-transparent p-1 transition",
                  active
                    ? "border-stone-200 bg-white shadow-sm dark:border-white/10 dark:bg-white/8"
                    : "hover:bg-stone-100 dark:hover:bg-white/5",
                )}
              >
                <button
                  type="button"
                  onClick={() => onSelect(conversation.id)}
                  aria-current={active ? "page" : undefined}
                  className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
                >
                  <MessageSquare
                    className={cn(
                      "size-4 shrink-0",
                      active ? "text-violet-600" : "text-stone-400",
                    )}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-stone-700 dark:text-stone-200">
                      {conversation.title}
                    </span>
                    <span className="mt-0.5 block text-[11px] text-stone-400">
                      {conversation.messages.length} 条 ·{" "}
                      {formatUpdatedAt(conversation.updatedAt)}
                    </span>
                  </span>
                </button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  disabled={disabled}
                  aria-label={`删除对话：${conversation.title}`}
                  onClick={() => onRequestDelete(conversation)}
                  className="size-8 shrink-0 text-stone-400 opacity-0 hover:text-rose-600 group-hover:opacity-100 focus-visible:opacity-100"
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            );
          })}
        </div>
      </div>

      <p className="border-t border-stone-200/80 px-4 py-3 text-[11px] leading-5 text-stone-400 dark:border-white/10">
        对话记录只保存在当前浏览器，最多保留 30 个会话。
      </p>
    </aside>
  );
}
