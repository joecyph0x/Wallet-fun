import { test } from "node:test";
import assert from "node:assert/strict";
import { pickLatestLog, settleAgeSec, settleStalled } from "./health.js";

test("pickLatestLog keeps the highest block, then the highest log index", () => {
  const picked = pickLatestLog([
    { blockNumber: "0x10", transactionHash: "0xaaa", logIndex: "0x2" },
    { blockNumber: "0x10", transactionHash: "0xbbb", logIndex: "0x5" },
    { blockNumber: "0x0f", transactionHash: "0xccc", logIndex: "0x9" },
  ]);
  assert.deepEqual(picked, { hash: "0xbbb", block: 16 });
  assert.equal(pickLatestLog([]), null);
  assert.equal(pickLatestLog([{ blockNumber: "0x1" }]), null);
});

test("settle age is null until the market has settled", () => {
  assert.equal(settleAgeSec(0, 1_000), null);
  assert.equal(settleAgeSec(900, 1_000), 100);
});

test("a market is stalled only after two epochs without a settle", () => {
  assert.equal(settleStalled(0, 5_000, 600), false);
  assert.equal(settleStalled(1_000, 2_200, 600), false);
  assert.equal(settleStalled(1_000, 2_201, 600), true);
});
