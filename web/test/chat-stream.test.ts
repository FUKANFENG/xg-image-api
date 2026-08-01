import assert from "node:assert/strict";
import test from "node:test";

import {
  parseChatStreamData,
  splitSseEvents,
} from "../src/lib/chat-sse.ts";

test("splitSseEvents keeps an incomplete frame for the next network chunk", () => {
  const parsed = splitSseEvents(
    ': stream-open\n\ndata: {"choices":[{"delta":{"content":"你"}}]}\n\ndata: {"cho',
  );

  assert.equal(parsed.events.length, 2);
  assert.equal(parsed.remainder, 'data: {"cho');
});

test("parseChatStreamData reads deltas, done markers, and errors", () => {
  assert.deepEqual(
    parseChatStreamData('{"choices":[{"delta":{"content":"你好"}}]}'),
    { done: false, delta: "你好", error: "" },
  );
  assert.deepEqual(parseChatStreamData("[DONE]"), {
    done: true,
    delta: "",
    error: "",
  });
  assert.deepEqual(
    parseChatStreamData('{"error":{"message":"账号限流"}}'),
    { done: false, delta: "", error: "账号限流" },
  );
});
