import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isSending, sendQueueState, startSendQueue } from "../src/gmail/sendQueue.js";

describe("Send queue", () => {
  it("sends confirmed emails one after another and reports progress", async () => {
    const order: number[] = [];
    let concurrent = 0;
    const done = startSendQueue(1, [{ outreachId: 10, label: "A" }, { outreachId: 11, label: "B" }], async (id) => {
      concurrent += 1;
      assert.equal(concurrent, 1);
      order.push(id);
      await new Promise((resolve) => setTimeout(resolve, 5));
      concurrent -= 1;
    }, 0);
    assert.equal(isSending(1), true);
    assert.throws(() => startSendQueue(1, [], async () => {}, 0), /already running/);
    const state = await done;
    assert.deepEqual(order, [10, 11]);
    assert.deepEqual(state.sent, ["A", "B"]);
    assert.equal(state.remaining, 0);
    assert.equal(isSending(1), false);
  });

  it("stops at the first failure and leaves the rest unsent", async () => {
    const attempted: number[] = [];
    const state = await startSendQueue(2, [
      { outreachId: 1, label: "A" }, { outreachId: 2, label: "B" }, { outreachId: 3, label: "C" },
    ], async (id) => {
      attempted.push(id);
      if (id === 2) throw new Error("Gmail token expired");
    }, 0);
    assert.deepEqual(attempted, [1, 2]);
    assert.deepEqual(state.sent, ["A"]);
    assert.deepEqual(state.failed, { label: "B", error: "Gmail token expired" });
    assert.equal(state.remaining, 2);
    assert.equal(sendQueueState(2)?.running, false);
  });
});
