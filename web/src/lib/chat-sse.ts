export type ParsedChatStreamEvent = {
  done: boolean;
  delta: string;
  error: string;
};

function messageFromUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const item = value as { message?: unknown; error?: unknown; detail?: unknown };
  return (
    messageFromUnknown(item.message) ||
    messageFromUnknown(item.error) ||
    messageFromUnknown(item.detail)
  );
}

export function splitSseEvents(buffer: string) {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const chunks = normalized.split("\n\n");
  return {
    events: chunks.slice(0, -1),
    remainder: chunks.at(-1) || "",
  };
}

export function parseChatStreamData(data: string): ParsedChatStreamEvent {
  const trimmed = data.trim();
  if (!trimmed) return { done: false, delta: "", error: "" };
  if (trimmed === "[DONE]") return { done: true, delta: "", error: "" };

  try {
    const payload = JSON.parse(trimmed) as {
      choices?: Array<{ delta?: { content?: unknown } }>;
      error?: unknown;
      detail?: unknown;
    };
    const error =
      messageFromUnknown(payload.error) || messageFromUnknown(payload.detail);
    const content = payload.choices?.[0]?.delta?.content;
    return {
      done: false,
      delta: typeof content === "string" ? content : "",
      error,
    };
  } catch {
    return { done: false, delta: "", error: "" };
  }
}

export function chatErrorMessage(value: unknown): string {
  return messageFromUnknown(value);
}
