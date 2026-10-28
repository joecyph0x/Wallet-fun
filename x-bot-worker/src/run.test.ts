import assert from "node:assert/strict";
import { test } from "node:test";
import { snapOf, type Pos } from "./events.js";
import { emptyRate, recordPost, type Limits } from "./rate.js";
import { decideRun, type RunInput } from "./run.js";
import { URL_MILLI, containsUrlOrDomain } from "./templates.js";

const noon = Date.UTC(2026, 9, 22, 15, 0, 0);
const late = Date.UTC(2026, 9, 22, 22, 30, 0);
const fresh = noon - 5 * 60_000;
const freshLate = late - 5 * 60_000;
const limits: Limits = { maxPerDay: 14, minGapSec: 1_200, maxSpendMilli: 300 };

function pos(coin: string, szi: number, notional: number, over: Partial<Pos> = {}): Pos {
  return {
    coin,
    szi,
    notional,
    upnl: over.upnl ?? 0,
    entry: over.entry ?? 3_412,
    side: over.side ?? (szi > 0 ? "long" : "short"),
  };
}

function input(over: Partial<RunInput> = {}): RunInput {
  return {
    now: noon,
    snaps: {},
    books: [],
    notionalUsd: 1_000_000,
    pnlUsd: 1_000_000,
    addPct: 0.5,
    notionalByTicker: {},
    rate: emptyRate(noon),
    limits,
    linkMode: "none",
    dailyRecap: false,
    odds: {},
    ...over,
  };
}

test("the first look stores a baseline and does not post", () => {
  const plan = decideRun(input({
    books: [{ ticker: "MACHI", positions: [pos("ETH", 1.2, 5_200_000)], realised: null }],
    odds: { MACHI: { tail: 10_000, fade: 10_000 } },
  }));
  assert.equal(plan.post, null);
  assert.equal(plan.writeSnap, true);
  assert.equal(plan.snaps.MACHI?.positions[0]?.coin, "ETH");
});

test("a failed read does not wipe the stored book", () => {
  const prev = snapOf([pos("ETH", 1, 5_000_000)], fresh);
  const plan = decideRun(input({
    snaps: { MACHI: prev },
    books: [{ ticker: "MACHI", positions: null, realised: null }],
  }));
  assert.equal(plan.writeSnap, false);
  assert.equal(plan.post, null);
  assert.equal(plan.snaps.MACHI, prev);
});

test("the biggest whale is posted and a blocked post keeps the old snapshot", () => {
  const empty = snapOf([], fresh);
  const plan = decideRun(input({
    snaps: { MACHI: empty, WYNN: empty },
    books: [
      { ticker: "MACHI", positions: [pos("ETH", 1, 2_000_000)], realised: null },
      { ticker: "WYNN", positions: [pos("BTC", 1, 9_000_000)], realised: null },
    ],
    variant: 3,
  }));
  assert.equal(plan.post?.ticker, "WYNN");
  assert.equal(plan.post?.postType, "plain");
  assert.equal(containsUrlOrDomain(plan.post?.text ?? ""), false);
  assert.equal(plan.snaps.WYNN, empty);
  assert.ok((plan.post?.snap?.positions.length ?? 0) > 0);

  const gapped = decideRun(input({
    snaps: { MACHI: empty },
    books: [{ ticker: "MACHI", positions: [pos("ETH", 1, 5_000_000)], realised: null }],
    rate: recordPost(emptyRate(noon), noon - 60_000, 15, false),
  }));
  assert.equal(gapped.post, null);
  assert.equal(gapped.skip, "gap");
  assert.equal(gapped.snaps.MACHI, empty);
});

test("mark-only drift is not a write and a per-whale threshold is honoured", () => {
  const prev = snapOf([pos("ETH", 10, 5_000_000)], fresh);
  const drift = decideRun(input({
    snaps: { MACHI: prev },
    books: [{ ticker: "MACHI", positions: [pos("ETH", 10, 5_500_000, { upnl: 100 })], realised: null }],
  }));
  assert.equal(drift.post, null);
  assert.equal(drift.writeSnap, false);

  const quiet = decideRun(input({
    snaps: { WYNN: snapOf([], fresh) },
    books: [{ ticker: "WYNN", positions: [pos("BTC", 1, 600_000)], realised: null }],
  }));
  assert.equal(quiet.post, null);
  assert.equal(quiet.writeSnap, true);

  const lowered = decideRun(input({
    snaps: { WYNN: snapOf([], fresh) },
    books: [{ ticker: "WYNN", positions: [pos("BTC", 1, 600_000)], realised: null }],
    notionalByTicker: { WYNN: 500_000 },
    variant: 3,
  }));
  assert.equal(lowered.post?.ticker, "WYNN");
  assert.ok(lowered.post?.text.includes("$600K"));
});

test("link mode all spends $0.20 and the default cap stops a second URL post", () => {
  const prev = snapOf([], fresh);
  const plan = decideRun(input({
    snaps: { MACHI: prev },
    books: [{ ticker: "MACHI", positions: [pos("ETH", 1, 5_200_000)], realised: null }],
    linkMode: "all",
    rate: recordPost(emptyRate(noon), noon - 3_600_000, URL_MILLI, false),
    variant: 3,
  }));
  assert.equal(plan.post, null);
  assert.equal(plan.skip, "spend");
  assert.equal(plan.snaps.MACHI, prev);
});

test("the recap is off by default and a daily URL recap is a separate post", () => {
  const flat = snapOf([], freshLate);
  const off = decideRun(input({
    now: late,
    snaps: { MACHI: flat },
    books: [{ ticker: "MACHI", positions: [], realised: null }],
    dailyRecap: false,
  }));
  assert.equal(off.post, null);

  const on = decideRun(input({
    now: late,
    snaps: { MACHI: snapOf([pos("ETH", 1, 5_200_000)], freshLate) },
    books: [{ ticker: "MACHI", positions: [pos("ETH", 1, 5_200_000)], realised: null }],
    dailyRecap: true,
    linkMode: "daily",
    variant: 3,
  }));
  assert.equal(on.post?.recap, true);
  assert.ok(on.post?.text.includes("https://whalewallet.fun"));
  assert.equal(on.post?.costMilli, URL_MILLI);

  const plain = decideRun(input({
    now: late,
    snaps: { MACHI: flat },
    books: [{ ticker: "MACHI", positions: [], realised: null }],
    dailyRecap: true,
    linkMode: "none",
    variant: 3,
  }));
  assert.equal(plain.post?.recap, true);
  assert.equal(containsUrlOrDomain(plain.post?.text ?? "x"), false);

  const busy = decideRun(input({
    now: late,
    snaps: { MACHI: flat, WYNN: flat },
    books: [
      { ticker: "WYNN", positions: [pos("BTC", 1, 9_000_000)], realised: null },
    ],
    dailyRecap: true,
    linkMode: "daily",
    variant: 3,
  }));
  assert.equal(busy.post?.recap, false);
  assert.equal(busy.post?.ticker, "WYNN");
  assert.equal(containsUrlOrDomain(busy.post?.text ?? ""), false);
});

test("a snapshot older than a few minutes is a new baseline, not a post", () => {
  const stale = snapOf([], noon - 30 * 60_000);
  const plan = decideRun(input({
    snaps: { MACHI: stale },
    books: [{ ticker: "MACHI", positions: [pos("ETH", 1, 5_200_000)], realised: null }],
    variant: 3,
  }));
  assert.equal(plan.post, null);
  assert.equal(plan.writeSnap, true);
  assert.equal(plan.snaps.MACHI?.positions[0]?.coin, "ETH");
});

test("one whale cannot take a third post while another whale still has a move", () => {
  const empty = snapOf([], fresh);
  let rate = emptyRate(noon - 3_600_000);
  rate = recordPost(rate, noon - 3_600_000, 15, false, "FUMBLER");
  rate = recordPost(rate, noon - 2_400_000, 15, false, "FUMBLER");
  const plan = decideRun(input({
    snaps: { FUMBLER: empty, MACHI: empty },
    books: [
      { ticker: "FUMBLER", positions: [pos("ETH", 1, 9_000_000)], realised: null },
      { ticker: "MACHI", positions: [pos("BTC", 1, 2_000_000)], realised: null },
    ],
    rate,
    variant: 3,
  }));
  assert.equal(plan.post?.ticker, "MACHI");
  assert.equal(/\bbets?\b/i.test(plan.post?.text ?? ""), false);
  assert.ok(plan.post?.text.includes("$BTC"));
  assert.ok(plan.post?.text.endsWith("🟢🩷") || plan.post?.text.endsWith("🩷"));
});

test("a book of only small legs does not get a summary post", () => {
  const prev = snapOf([
    pos("A", 1, 10_000),
    pos("B", 1, 20_000),
    pos("C", 1, 30_000),
  ], fresh);
  const plan = decideRun(input({
    snaps: { HLP: prev },
    books: [{
      ticker: "HLP",
      positions: [],
      realised: { A: 5_000_000, B: 5_000_000, C: 5_000_000 },
      accountUsd: 40_000_000,
    }],
  }));
  assert.equal(plan.post, null);
  assert.equal((plan.post?.text ?? "").includes("shuffled"), false);
});
