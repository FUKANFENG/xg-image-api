"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { streamChatCompletion } from "@/lib/chat-stream";
import {
  createTextConversation,
  createTextMessage,
  loadActiveTextConversationId,
  loadTextConversations,
  saveActiveTextConversationId,
  saveTextConversations,
  titleFromPrompt,
  type TextChatMessage,
  type TextConversation,
} from "@/store/text-conversations";

function sortConversations(items: TextConversation[]) {
  return [...items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function isAbortError(error: unknown, signal: AbortSignal) {
  return (
    signal.aborted ||
    (error instanceof DOMException && error.name === "AbortError")
  );
}

export function useChatWorkspace() {
  const [conversations, setConversations] = useState<TextConversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState("");
  const [input, setInput] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState("");
  const [isHydrated, setIsHydrated] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState("");
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const stored = loadTextConversations();
      const initial = stored.length ? stored : [createTextConversation()];
      const storedActiveId = loadActiveTextConversationId();
      const activeId = initial.some((item) => item.id === storedActiveId)
        ? storedActiveId
        : initial[0].id;
      setConversations(initial);
      setActiveConversationId(activeId);
      setIsHydrated(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!isHydrated) return;
    const timer = window.setTimeout(() => {
      saveTextConversations(conversations);
      saveActiveTextConversationId(activeConversationId);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [activeConversationId, conversations, isHydrated]);

  useEffect(
    () => () => {
      abortControllerRef.current?.abort();
    },
    [],
  );

  const activeConversation = useMemo(
    () =>
      conversations.find((item) => item.id === activeConversationId) ||
      conversations[0],
    [activeConversationId, conversations],
  );

  const updateConversation = useCallback(
    (
      id: string,
      updater: (conversation: TextConversation) => TextConversation,
    ) => {
      setConversations((current) =>
        sortConversations(
          current.map((conversation) =>
            conversation.id === id ? updater(conversation) : conversation,
          ),
        ),
      );
    },
    [],
  );

  const updateMessage = useCallback(
    (
      conversationId: string,
      messageId: string,
      updates: Partial<TextChatMessage>,
    ) => {
      updateConversation(conversationId, (conversation) => ({
        ...conversation,
        updatedAt: new Date().toISOString(),
        messages: conversation.messages.map((message) =>
          message.id === messageId ? { ...message, ...updates } : message,
        ),
      }));
    },
    [updateConversation],
  );

  const createConversation = useCallback(() => {
    const conversation = createTextConversation();
    setConversations((current) => [conversation, ...current]);
    setActiveConversationId(conversation.id);
    setInput("");
    setError("");
  }, []);

  const selectConversation = useCallback((id: string) => {
    setActiveConversationId(id);
    setError("");
  }, []);

  const deleteConversation = useCallback(
    (id: string) => {
      const remaining = conversations.filter((item) => item.id !== id);
      const next = remaining.length ? remaining : [createTextConversation()];
      setConversations(next);
      if (id === activeConversationId) {
        setActiveConversationId(next[0].id);
      }
      setError("");
    },
    [activeConversationId, conversations],
  );

  const clearActiveConversation = useCallback(() => {
    if (!activeConversation) return;
    updateConversation(activeConversation.id, (conversation) => ({
      ...conversation,
      title: "新对话",
      updatedAt: new Date().toISOString(),
      messages: [],
    }));
    setError("");
  }, [activeConversation, updateConversation]);

  const stopGeneration = useCallback(() => {
    abortControllerRef.current?.abort();
  }, []);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || !activeConversation || isStreaming) return;

    const conversationId = activeConversation.id;
    const userMessage = createTextMessage("user", text);
    const assistantMessage = createTextMessage("assistant", "", "streaming");
    const priorMessages = activeConversation.messages.filter(
      (message) => message.content.trim() && message.status !== "error",
    );
    const requestMessages = [...priorMessages, userMessage].map((message) => ({
      role: message.role,
      content: message.content,
    }));
    const hasUserMessage = activeConversation.messages.some(
      (message) => message.role === "user",
    );

    updateConversation(conversationId, (conversation) => ({
      ...conversation,
      title: hasUserMessage ? conversation.title : titleFromPrompt(text),
      updatedAt: new Date().toISOString(),
      messages: [...conversation.messages, userMessage, assistantMessage],
    }));
    setInput("");
    setError("");
    setIsStreaming(true);

    const controller = new AbortController();
    abortControllerRef.current = controller;
    let receivedText = "";

    try {
      await streamChatCompletion({
        messages: requestMessages,
        reasoningEffort,
        signal: controller.signal,
        onDelta: (delta) => {
          receivedText += delta;
          updateMessage(conversationId, assistantMessage.id, {
            content: receivedText,
          });
        },
      });
      if (!receivedText.trim()) {
        throw new Error("模型没有返回文字内容，请稍后重试");
      }
      updateMessage(conversationId, assistantMessage.id, {
        content: receivedText,
        status: "complete",
        error: undefined,
      });
    } catch (caught) {
      if (isAbortError(caught, controller.signal)) {
        updateMessage(conversationId, assistantMessage.id, {
          content: receivedText,
          status: "stopped",
          error: undefined,
        });
      } else {
        const message =
          caught instanceof Error ? caught.message : "对话请求失败";
        updateMessage(conversationId, assistantMessage.id, {
          content: receivedText,
          status: "error",
          error: message,
        });
        setError(message);
      }
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }
      setIsStreaming(false);
    }
  }, [
    activeConversation,
    input,
    isStreaming,
    reasoningEffort,
    updateConversation,
    updateMessage,
  ]);

  return {
    conversations,
    activeConversation,
    activeConversationId,
    input,
    setInput,
    reasoningEffort,
    setReasoningEffort,
    isHydrated,
    isStreaming,
    error,
    createConversation,
    selectConversation,
    deleteConversation,
    clearActiveConversation,
    sendMessage,
    stopGeneration,
  };
}
