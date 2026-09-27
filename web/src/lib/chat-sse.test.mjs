import assert from "node:assert/strict";
import test from "node:test";

import {
  chatHttpErrorMessage,
  parseChatStreamData,
  splitSseEvents,
} from "./chat-sse.ts";

test("keeps an incomplete SSE frame for the next network chunk", () => {
  const parsed = splitSseEvents(
    ': stream-open\n\ndata: {"choices":[{"delta":{"content":"你"}}]}\n\ndata: {"cho',
  );

  assert.equal(parsed.events.length, 2);
  assert.equal(parsed.remainder, 'data: {"cho');
});

test("reads chat deltas, completion markers, and structured errors", () => {
  assert.deepEqual(
    parseChatStreamData('{"choices":[{"delta":{"content":"你好"}}]}'),
    { done: false, delta: "你好", error: "" },
  );
  assert.deepEqual(parseChatStreamData("[DONE]"), {
    done: true,
    delta: "",
    error: "",
  });
  assert.deepEqual(parseChatStreamData('{"error":{"message":"账号限流"}}'), {
    done: false,
    delta: "",
    error: "账号限流",
  });
});

test("does not expose a Cloudflare HTML error page in the chat UI", () => {
  const html = '<!DOCTYPE html><html><title>502: Bad gateway</title></html>';

  assert.equal(
    chatHttpErrorMessage(502, "text/html; charset=UTF-8", html),
    "公网网关暂时无法连接对话服务 (502)，请稍后重试",
  );
});

test("preserves a structured API error message", () => {
  assert.equal(
    chatHttpErrorMessage(
      429,
      "application/json",
      '{"error":{"message":"账号限流"}}',
    ),
    "账号限流",
  );
});
