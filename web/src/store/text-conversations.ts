export type TextMessageStatus =
  | "complete"
  | "streaming"
  | "stopped"
  | "error";

export type TextChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  status: TextMessageStatus;
  error?: string;
};

export type TextConversation = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: TextChatMessage[];
};

const STORAGE_KEY = "xg:text-conversations:v1";
const ACTIVE_STORAGE_KEY = "xg:text_conversation_active_id";
const MAX_CONVERSATIONS = 30;
export const EMPTY_CONVERSATION_TITLE = "新对话";

function createId() {
  if (
    typeof globalThis.crypto !== "undefined" &&
    "randomUUID" in globalThis.crypto
  ) {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function isMessage(value: unknown): value is TextChatMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<TextChatMessage>;
  return (
    typeof message.id === "string" &&
    (message.role === "user" || message.role === "assistant") &&
    typeof message.content === "string" &&
    typeof message.createdAt === "string"
  );
}

function normalizeConversation(value: unknown): TextConversation | null {
  if (!value || typeof value !== "object") return null;
  const conversation = value as Partial<TextConversation>;
  if (
    typeof conversation.id !== "string" ||
    typeof conversation.title !== "string" ||
    typeof conversation.createdAt !== "string" ||
    typeof conversation.updatedAt !== "string" ||
    !Array.isArray(conversation.messages)
  ) {
    return null;
  }

  return {
    id: conversation.id,
    title: conversation.title || EMPTY_CONVERSATION_TITLE,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    messages: conversation.messages.filter(isMessage).map((message) => ({
      ...message,
      status:
        message.status === "streaming"
          ? "stopped"
          : message.status || "complete",
    })),
  };
}

export function createTextConversation(): TextConversation {
  const now = new Date().toISOString();
  return {
    id: createId(),
    title: EMPTY_CONVERSATION_TITLE,
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
}

export function createTextMessage(
  role: TextChatMessage["role"],
  content: string,
  status: TextMessageStatus = "complete",
): TextChatMessage {
  return {
    id: createId(),
    role,
    content,
    createdAt: new Date().toISOString(),
    status,
  };
}

export function titleFromPrompt(prompt: string) {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  if (!normalized) return EMPTY_CONVERSATION_TITLE;
  return normalized.length > 18
    ? `${normalized.slice(0, 18).trimEnd()}…`
    : normalized;
}

export function loadTextConversations() {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(STORAGE_KEY) || "[]",
    ) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalizeConversation)
      .filter((item): item is TextConversation => Boolean(item))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, MAX_CONVERSATIONS);
  } catch {
    return [];
  }
}

export function saveTextConversations(conversations: TextConversation[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(conversations.slice(0, MAX_CONVERSATIONS)),
    );
  } catch {
    // Local storage can be unavailable or full. The active session still works.
  }
}

export function loadActiveTextConversationId() {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(ACTIVE_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

export function saveActiveTextConversationId(id: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ACTIVE_STORAGE_KEY, id);
  } catch {
    // Keep the in-memory selection when storage is unavailable.
  }
}
