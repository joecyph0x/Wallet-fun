import assert from "node:assert/strict";
import { test } from "node:test";
import {
  commitSnap,
  dedupeEvents,
  detectEvents,
  dustMoves,
  isDust,
  positionsFromClearinghouse,
  snapOf,
  sumClosedPnl,
  type Pos,
  type Snap,
  type Thresholds,
  type WhaleEvent,
} from "./events.js";
import { DEMO_WHALE, WHALES } from "./whales.js";

const th: Thresholds = { notionalUsd: 1_000_000, pnlUsd: 1_000_000, addPct: 0.5 };

function pos(coin: string, szi: number, over: Partial<Pos> = {}): Pos {
  return {
    coin,
    szi,
    notional: over.notional ?? 2_000_000,
    upnl: over.upnl ?? 0,
    entry: over.entry ?? 3_412,
    side: over.side ?? (szi > 0 ? "long" : "short"),
  };
}

function book(positions: Pos[], at = 1_000): Snap {
  return snapOf(positions, at);
}

test("the public list is the eleven whales and not DEMO", () => {
  assert.equal(WHALES.length, 11);
  assert.equal(WHALES.some((w) => w.ticker === "DEMO"), false);
  assert.equal(WHALES.some((w) => w.whale.toLowerCase() === DEMO_WHALE), false);
  for (const w of WHALES) {
    assert.equal(w.ticker.includes("@"), false);
    assert.equal(w.ticker.toLowerCase().includes("x.com"), false);
  }
  assert.equal(WHALES.find((w) => w.ticker === "SILK")?.ticker, "SILK");
});

test("the first snapshot emits nothing and still writes", () => {
  const next = book([pos("ETH", 1.5, { notional: 5_200_000 })]);
  const events = detectEvents("MACHI", undefined, next.positions, null, th);
  assert.equal(events.length, 0);
  const committed = commitSnap(undefined, next, events, false);
  assert.equal(committed.write, true);
  assert.equal(committed.snap.positions[0]?.coin, "ETH");
});

test("a new position at or above the notional threshold is an open", () => {
  const prev = book([]);
  const next = [pos("ETH", 1.2, { notional: 5_200_000, entry: 3_412 })];
  const events = detectEvents("MACHI", prev, next, null, th);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, "open");
  assert.equal(events[0]?.score, 5_200_000);
  assert.equal(events[0]?.side, "long");
  const small = [pos("ETH", 1, { notional: 999_999 })];
  const below = detectEvents("MACHI", prev, small, null, th);
  assert.equal(below.length, 0);
  assert.equal(commitSnap(prev, book(small), below, false).write, true);
});

test("a close uses realised pnl, then the stored uPnL", () => {
  const prev = book([pos("BTC", -2, { notional: 4_000_000, upnl: -1_400_000, side: "short" })]);
  const fromFills = detectEvents("WYNN", prev, [], { BTC: -1_400_000 }, th);
  assert.equal(fromFills.length, 1);
  assert.equal(fromFills[0]?.kind, "close");
  assert.equal(fromFills[0]?.side, "short");
  assert.equal(fromFills[0]?.pnl, -1_400_000);
  assert.equal(fromFills[0]?.score, 1_400_000);

  const small = detectEvents("WYNN", prev, [], { BTC: -50_000 }, th);
  assert.equal(small.length, 0);
  assert.equal(commitSnap(prev, book([]), small, false).write, true);

  const fallback = detectEvents("WYNN", prev, [], null, th);
  assert.equal(fallback[0]?.pnl, -1_400_000);

  const quiet = book([pos("BTC", -2, { upnl: 10 })]);
  assert.equal(detectEvents("WYNN", quiet, [], null, th).length, 0);
});

test("a side change is a flip when either book clears the notional bar", () => {
  const prev = book([pos("ETH", 2, { notional: 2_000_000, side: "long" })]);
  const next = [pos("ETH", -3, { notional: 2_100_000, side: "short", entry: 3_500 })];
  const events = detectEvents("JEFF", prev, next, null, th);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, "flip");
  assert.equal(events[0]?.prevSide, "long");
  assert.equal(events[0]?.side, "short");
  assert.equal(events[0]?.score, 2_100_000);

  const dust = book([pos("ETH", 1, { notional: 10 })]);
  const stillDust = [pos("ETH", -1, { notional: 12, side: "short" })];
  const quiet = detectEvents("JEFF", dust, stillDust, null, th);
  assert.equal(quiet.length, 0);
  assert.equal(commitSnap(dust, book(stillDust), quiet, false).write, true);
});

test("size has to grow by more than 50 percent and clear the notional bar", () => {
  const prev = book([pos("SOL", 10, { notional: 3_000_000 })]);
  const exact = detectEvents("BOBBY", prev, [pos("SOL", 15, { notional: 3_400_000 })], null, th);
  assert.equal(exact.length, 0);
  const added = detectEvents("BOBBY", prev, [pos("SOL", 18, { notional: 3_400_000 })], null, th);
  assert.equal(added.length, 1);
  assert.equal(added[0]?.kind, "add");
  assert.equal(Math.round((added[0]?.addFrac ?? 0) * 100), 80);
  const shrunk = detectEvents("BOBBY", prev, [pos("SOL", 4, { notional: 1_200_000 })], null, th);
  assert.equal(shrunk.length, 0);
  const cheap = detectEvents("BOBBY", prev, [pos("SOL", 20, { notional: 10_000 })], null, th);
  assert.equal(cheap.length, 0);
});

test("a large uPnL swing posts once, and not on top of an add", () => {
  const prev = book([pos("ETH", 10, { notional: 5_000_000, upnl: 100_000 })]);
  const swing = detectEvents("HLP", prev, [pos("ETH", 10, { notional: 5_200_000, upnl: 1_300_000 })], null, th);
  assert.equal(swing.length, 1);
  assert.equal(swing[0]?.kind, "swing");
  assert.equal(swing[0]?.pnl, 1_200_000);

  const both = detectEvents("HLP", prev, [pos("ETH", 20, { notional: 8_000_000, upnl: 2_000_000 })], null, th);
  assert.deepEqual(both.map((e) => e.kind), ["add"]);

  const drift = detectEvents("HLP", prev, [pos("ETH", 10, { notional: 9_000_000, upnl: 110_000 })], null, th);
  assert.equal(drift.length, 0);
  const next = book([pos("ETH", 10, { notional: 9_000_000, upnl: 110_000 })]);
  const committed = commitSnap(prev, next, drift, false);
  assert.equal(committed.write, false);
  assert.equal(committed.snap, prev);
});

test("an unposted event keeps the old snapshot", () => {
  const prev = book([pos("ETH", 1, { notional: 100 })]);
  const next = book([pos("ETH", 1, { notional: 100 }), pos("BTC", 1, { notional: 5_000_000 })], 2_000);
  const events = detectEvents("MACHI", prev, next.positions, null, th);
  assert.equal(events[0]?.kind, "open");
  const held = commitSnap(prev, next, events, false);
  assert.equal(held.write, false);
  assert.equal(held.snap, prev);
  const posted = commitSnap(prev, next, events, true);
  assert.equal(posted.write, true);
  assert.equal(posted.snap.positions.length, 2);
});

test("clearinghouse rows and close fills parse without the rest of the payload", () => {
  const parsed = positionsFromClearinghouse({
    assetPositions: [
      { type: "oneWay", position: { coin: "ETH", szi: "-0.8", entryPx: "2396.9", positionValue: "1917.28", unrealizedPnl: "0.24" } },
      { type: "oneWay", position: { coin: "BTC", szi: "0", positionValue: "0", unrealizedPnl: "0", entryPx: "1" } },
    ],
  });
  assert.equal(parsed?.length, 1);
  assert.equal(parsed?.[0]?.side, "short");
  assert.equal(parsed?.[0]?.notional, 1917.28);
  assert.equal(positionsFromClearinghouse({ error: "down" }), null);
  assert.deepEqual(positionsFromClearinghouse({ assetPositions: [] }), []);

  const rows = [
    { coin: "ETH", dir: "Close Long", closedPnl: "-1400000", time: 5_000 },
    { coin: "ETH", dir: "Open Long", closedPnl: "999", time: 5_000 },
    { coin: "BTC", dir: "Close Short", closedPnl: "10", time: 5_000 },
    { coin: "ETH", dir: "Close Long", closedPnl: "5", time: 100 },
  ];
  assert.equal(sumClosedPnl(rows, "ETH", 1_000), -1_400_000);
  assert.equal(sumClosedPnl(rows, "SOL", 1_000), null);
  assert.equal(sumClosedPnl({ not: "array" }, "ETH", 1_000), null);
});

test("dust legs are ignored and identical events collapse", () => {
  assert.equal(isDust(40_000), true);
  assert.equal(isDust(80_000, 20_000_000), true);
  assert.equal(isDust(2_000_000, 20_000_000), false);
  const prev = book([
    pos("DUST", 1, { notional: 10_000 }),
    pos("ETH", 1, { notional: 2_000_000 }),
  ]);
  const closed = detectEvents("HLP", prev, [pos("ETH", 1, { notional: 2_000_000 })], { DUST: 5_000_000 }, th);
  assert.equal(closed.length, 0);
  const tiny = [
    pos("A", 1, { notional: 1_000 }),
    pos("B", 1, { notional: 2_000 }),
    pos("C", 1, { notional: 3_000 }),
  ];
  assert.equal(dustMoves([], tiny), 3);
  const dup: WhaleEvent = {
    kind: "open", ticker: "HLP", coin: "ETH", side: "long", notional: 2, entry: 1, pnl: 0, addFrac: 0, score: 2,
  };
  const smaller = { ...dup, score: 1 };
  assert.equal(dedupeEvents([dup, smaller, dup]).length, 1);
  assert.equal(dedupeEvents([dup, smaller])[0]?.score, 2);
});
