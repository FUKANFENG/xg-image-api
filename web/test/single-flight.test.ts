import assert from "node:assert/strict";
import test from "node:test";

import { createSingleFlightState, runSingleFlight } from "../src/lib/single-flight.ts";

test("single flight reuses an active request and allows the next refresh after completion", async () => {
  const state = createSingleFlightState<number>();
  let calls = 0;
  let release: ((value: number) => void) | undefined;
  const operation = () => {
    calls += 1;
    return new Promise<number>((resolve) => {
      release = resolve;
    });
  };

  const first = runSingleFlight(state, operation);
  const overlapping = runSingleFlight(state, operation);

  assert.equal(first, overlapping);
  assert.equal(calls, 1);
  release?.(7);
  assert.equal(await first, 7);

  const next = runSingleFlight(state, async () => {
    calls += 1;
    return 9;
  });
  assert.equal(await next, 9);
  assert.equal(calls, 2);
});

test("single flight releases a rejected request", async () => {
  const state = createSingleFlightState<number>();
  await assert.rejects(runSingleFlight(state, async () => {
    throw new Error("network unavailable");
  }), /network unavailable/);

  assert.equal(await runSingleFlight(state, async () => 3), 3);
});
