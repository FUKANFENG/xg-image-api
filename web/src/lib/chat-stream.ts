import webConfig from "@/constants/common-env";
import {
  chatErrorMessage,
  parseChatStreamData,
  splitSseEvents,
} from "@/lib/chat-sse";

export type ApiChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type StreamChatOptions = {
  messages: ApiChatMessage[];
  reasoningEffort?: string;
  signal: AbortSignal;
  onDelta: (delta: string) => void;
};

function eventData(event: string) {
  return event
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
}

async function responseError(response: Response) {
  const fallback = `请求失败 (${response.status})`;
  try {
    const text = await response.text();
    if (!text) return fallback;
    try {
      return chatErrorMessage(JSON.parse(text)) || text || fallback;
    } catch {
      return text;
    }
  } catch {
    return fallback;
  }
}

export async function streamChatCompletion({
  messages,
  reasoningEffort,
  signal,
  onDelta,
}: StreamChatOptions) {
  const baseUrl = webConfig.apiUrl.replace(/\/$/, "");
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "auto",
      messages,
      stream: true,
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    }),
    signal,
  });

  if (!response.ok) {
    throw new Error(await responseError(response));
  }
  if (!response.body) {
    throw new Error("服务没有返回可读取的对话流");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let done = false;

  const handleEvent = (rawEvent: string) => {
    const parsed = parseChatStreamData(eventData(rawEvent));
    if (parsed.error) throw new Error(parsed.error);
    if (parsed.delta) onDelta(parsed.delta);
    if (parsed.done) done = true;
  };

  while (!done) {
    const result = await reader.read();
    buffer += decoder.decode(result.value || new Uint8Array(), {
      stream: !result.done,
    });
    const parsed = splitSseEvents(buffer);
    buffer = parsed.remainder;
    parsed.events.forEach(handleEvent);
    if (result.done) {
      if (buffer.trim()) handleEvent(buffer);
      break;
    }
  }
}
