"use client";

import { LoaderCircle } from "lucide-react";
import { useState } from "react";

import { ChatSidebar } from "@/app/chat/chat-sidebar";
import { ChatThread } from "@/app/chat/chat-thread";
import { useChatWorkspace } from "@/app/chat/use-chat-workspace";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { TextConversation } from "@/store/text-conversations";

type PendingAction =
  | { kind: "delete"; conversation: TextConversation }
  | { kind: "clear"; conversation: TextConversation }
  | null;

export function ChatWorkspace() {
  const workspace = useChatWorkspace();
  const [mobileHistoryOpen, setMobileHistoryOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);

  if (!workspace.isHydrated || !workspace.activeConversation) {
    return (
      <div className="grid min-h-[34rem] flex-1 place-items-center rounded-2xl border border-stone-200/80 bg-white/80 dark:border-white/10 dark:bg-stone-950/55">
        <LoaderCircle className="size-6 animate-spin text-stone-400" />
      </div>
    );
  }

  const sidebar = (mobile = false) => (
    <ChatSidebar
      conversations={workspace.conversations}
      activeConversationId={workspace.activeConversationId}
      disabled={workspace.isStreaming}
      onCreate={() => {
        workspace.createConversation();
        if (mobile) setMobileHistoryOpen(false);
      }}
      onSelect={(id) => {
        workspace.selectConversation(id);
        if (mobile) setMobileHistoryOpen(false);
      }}
      onRequestDelete={(conversation) =>
        setPendingAction({ kind: "delete", conversation })
      }
    />
  );

  const confirmAction = () => {
    if (!pendingAction) return;
    if (pendingAction.kind === "delete") {
      workspace.deleteConversation(pendingAction.conversation.id);
    } else {
      workspace.clearActiveConversation();
    }
    setPendingAction(null);
  };

  const isClearAction = pendingAction?.kind === "clear";

  return (
    <>
      <div className="grid min-h-[40rem] flex-1 overflow-hidden rounded-2xl border border-stone-200/80 bg-white/85 shadow-sm lg:grid-cols-[17rem_minmax(0,1fr)] dark:border-white/10 dark:bg-stone-950/55">
        <div className="hidden min-h-0 border-r border-stone-200/80 lg:block dark:border-white/10">
          {sidebar()}
        </div>
        <ChatThread
          conversation={workspace.activeConversation}
          input={workspace.input}
          reasoningEffort={workspace.reasoningEffort}
          isStreaming={workspace.isStreaming}
          error={workspace.error}
          onOpenHistory={() => setMobileHistoryOpen(true)}
          onClear={() =>
            setPendingAction({
              kind: "clear",
              conversation: workspace.activeConversation!,
            })
          }
          onInputChange={workspace.setInput}
          onReasoningEffortChange={workspace.setReasoningEffort}
          onSend={() => void workspace.sendMessage()}
          onStop={workspace.stopGeneration}
        />
      </div>

      <Sheet open={mobileHistoryOpen} onOpenChange={setMobileHistoryOpen}>
        <SheetContent
          side="left"
          className="w-[min(88vw,320px)] gap-0 p-0 sm:max-w-[320px]"
        >
          <SheetHeader className="border-b border-stone-200/80 px-4 py-4 text-left dark:border-white/10">
            <SheetTitle>对话记录</SheetTitle>
          </SheetHeader>
          <div className="min-h-0 flex-1">{sidebar(true)}</div>
        </SheetContent>
      </Sheet>

      <Dialog
        open={Boolean(pendingAction)}
        onOpenChange={(open) => !open && setPendingAction(null)}
      >
        <DialogContent className="w-[min(92vw,440px)] rounded-2xl">
          <DialogHeader>
            <DialogTitle>
              {isClearAction ? "清空当前对话？" : "删除这条对话？"}
            </DialogTitle>
            <DialogDescription className="leading-6">
              {isClearAction
                ? "当前会话里的全部消息会从本机浏览器中移除，此操作无法撤销。"
                : `“${pendingAction?.conversation.title || "新对话"}”及其消息会从本机浏览器中移除，此操作无法撤销。`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                取消
              </Button>
            </DialogClose>
            <Button type="button" variant="destructive" onClick={confirmAction}>
              {isClearAction ? "确认清空" : "确认删除"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
