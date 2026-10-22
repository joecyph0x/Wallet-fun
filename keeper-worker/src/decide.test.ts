import { test } from "node:test";
import assert from "node:assert/strict";
import {
  accountValue6,
  assertTestnet,
  chunk,
  gasOk,
  minGasWei,
  needsSettle,
  rotateMarkets,
  selectSettles,
  type MarketSnap,
} from "./decide.js";

const now = 1_700_000_000;

function snap(over: Partial<MarketSnap> = {}): MarketSnap {
  return {
    market: "0x0000000000000000000000000000000000000001",
    lastSettleTs: BigInt(now - 60),
    openOrders: 0n,
    lastEquity: 1_000_000_000n,
    lastNtlPos: 0n,
    infoOk: true,
    positionCount: 0,
    accountValue6: 1_000_000_000n,
    ...over,
  };
}

test("chain 998 is accepted and 999 is refused", () => {
  assert.doesNotThrow(() => assertTestnet(998));
  assert.throws(() => assertTestnet(999), /999/);
  assert.throws(() => assertTestnet(1), /refusing chain id 1/);
  assert.throws(() => assertTestnet(998.5), /refusing/);
});

test("gas floor matches the box keeper wei conversion", () => {
  assert.equal(minGasWei("0.005"), 5_000_000_000_000_000n);
  assert.equal(gasOk(minGasWei("0.005"), minGasWei("0.005")), true);
  assert.equal(gasOk(minGasWei("0.005") - 1n, minGasWei("0.005")), false);
});

test("account value truncates to 6 decimals", () => {
  assert.equal(accountValue6("1000.0"), 1_000_000_000n);
  assert.equal(accountValue6("1000.1234567"), 1_000_123_456n);
  assert.equal(accountValue6("0"), 0n);
  assert.equal(accountValue6("?"), undefined);
  assert.equal(accountValue6("-1.5"), -1_500_000n);
});

test("flat unchanged whale with an empty queue waits for the idle heartbeat", () => {
  assert.equal(needsSettle(snap(), now, 60, 600), null);
  assert.equal(needsSettle(snap({ lastSettleTs: BigInt(now - 599) }), now, 60, 600), null);
  assert.equal(needsSettle(snap({ lastSettleTs: BigInt(now - 600) }), now, 60, 600), "idle-heartbeat");
});

test("first settle, queued orders, unread queue, and a changed account value are due", () => {
  assert.equal(needsSettle(snap({ lastSettleTs: 0n }), now, 60, 600), "first");
  assert.equal(needsSettle(snap({ openOrders: 2n }), now, 60, 600), "orders");
  assert.equal(needsSettle(snap({ openOrders: undefined }), now, 60, 600), "orders");
  assert.equal(needsSettle(snap({ accountValue6: 1_000_000_001n }), now, 60, 600), "heartbeat");
});

test("queued orders do not settle inside the 60s heartbeat", () => {
  assert.equal(needsSettle(snap({ lastSettleTs: BigInt(now - 30), openOrders: 4n }), now, 60, 600), null);
});

test("a position opening or closing can settle before the heartbeat", () => {
  assert.equal(needsSettle(snap({ lastSettleTs: BigInt(now - 10), positionCount: 1 }), now, 60, 600), "woke");
  assert.equal(
    needsSettle(snap({ lastSettleTs: BigInt(now - 10), lastNtlPos: 5n, positionCount: 0 }), now, 60, 600),
    "slept",
  );
});

test("a whale that still has positions settles on the 60s heartbeat", () => {
  assert.equal(
    needsSettle(snap({ lastNtlPos: 5n, positionCount: 2, lastSettleTs: BigInt(now - 60) }), now, 60, 600),
    "heartbeat",
  );
  assert.equal(
    needsSettle(snap({ lastNtlPos: 5n, positionCount: 2, lastSettleTs: BigInt(now - 30) }), now, 60, 600),
    null,
  );
});

test("info API failure skips the market", () => {
  assert.equal(needsSettle(snap({ infoOk: false, lastSettleTs: 0n }), now, 60, 600), null);
});

test("selectSettles caps and prefers orders, then wakes, then the oldest heartbeat", () => {
  const rows = [
    { market: "0xaaa", lastSettleTs: 10n, reason: "heartbeat" as const },
    { market: "0xbbb", lastSettleTs: 50n, reason: "orders" as const },
    { market: "0xccc", lastSettleTs: 1n, reason: "heartbeat" as const },
    { market: "0xddd", lastSettleTs: 3n, reason: "woke" as const },
    { market: "0xeee", lastSettleTs: 9n, reason: "idle-heartbeat" as const },
  ];
  const picked = selectSettles(rows, 2);
  assert.deepEqual(picked.map((r) => r.market), ["0xbbb", "0xddd"]);
  const next = selectSettles(
    rows.filter((r) => r.reason === "heartbeat" || r.reason === "idle-heartbeat"),
    2,
  );
  assert.deepEqual(next.map((r) => r.market), ["0xccc", "0xaaa"]);
});

test("rotateMarkets walks a large registry and chunk refuses batches over 20", () => {
  const markets = ["a", "b", "c", "d", "e"];
  const first = rotateMarkets(markets, 0, 2);
  assert.deepEqual(first.rows, ["a", "b"]);
  const second = rotateMarkets(markets, first.next, 2);
  assert.deepEqual(second.rows, ["c", "d"]);
  assert.deepEqual(rotateMarkets(markets, 0, 10).rows, markets);
  assert.equal(chunk([1, 2, 3], 2).length, 2);
  assert.equal(chunk(new Array(21).fill(0), 20).length, 2);
  assert.throws(() => chunk([1], 21), /20/);
});
