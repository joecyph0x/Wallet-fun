import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyBackoff,
  backoffSeconds,
  canPost,
  chooseWhale,
  emptyRate,
  formatMilli,
  recordPost,
  recapDue,
  usdToMilli,
  type Limits,
} from "./rate.js";

const limits: Limits = { maxPerDay: 14, minGapSec: 1_200, maxSpendMilli: 300 };
const noon = Date.UTC(2026, 9, 22, 12, 0, 0);

test("money is tracked in thousandths of a dollar", () => {
  assert.equal(usdToMilli(0.015), 15);
  assert.equal(usdToMilli(0.2), 200);
  assert.equal(usdToMilli(0.3), 300);
  assert.equal(formatMilli(15), "0.015");
  assert.equal(formatMilli(200), "0.200");
  assert.equal(formatMilli(210), "0.210");
});

test("fourteen plain posts fit under the spend cap and the fifteenth does not", () => {
  let state = emptyRate(noon);
  for (let i = 0; i < 14; i++) {
    const gate = canPost(state, noon + i * 1_200_000, 15, limits);
    assert.equal(gate.ok, true, `post ${i}`);
    state = recordPost(state, noon + i * 1_200_000, 15, false);
  }
  assert.equal(state.count, 14);
  assert.equal(state.spentMilli, 210);
  assert.equal(canPost(state, noon + 14 * 1_200_000, 15, limits).reason, "daily cap");
});

test("the twenty minute gap and the UTC day roll", () => {
  const state = recordPost(emptyRate(noon), noon, 15, false);
  assert.equal(canPost(state, noon + 19 * 60_000, 15, limits).reason, "gap");
  assert.equal(canPost(state, noon + 20 * 60_000, 15, limits).ok, true);
  const nextDay = Date.UTC(2026, 9, 23, 0, 5, 0);
  const rolled = canPost({ ...state, count: 14, spentMilli: 210 }, nextDay, 15, limits);
  assert.equal(rolled.ok, true);
  const saved = recordPost({ ...state, count: 14, spentMilli: 210 }, nextDay, 15, false);
  assert.equal(saved.day, "2026-10-23");
  assert.equal(saved.count, 1);
  assert.equal(saved.spentMilli, 15);
});

test("a URL post is blocked once it would push the day over $0.30", () => {
  const spent = recordPost(emptyRate(noon), noon - 3_600_000, 200, true);
  assert.equal(canPost(spent, noon, 15, limits).ok, true);
  assert.equal(canPost(spent, noon, 200, limits).reason, "spend");
  const room = recordPost(emptyRate(noon), noon - 3_600_000, 100, false);
  assert.equal(canPost(room, noon, 200, limits).ok, true);
  const tight = recordPost(emptyRate(noon), noon - 3_600_000, 101, false);
  assert.equal(canPost(tight, noon, 200, limits).reason, "spend");
});

test("429 and 403 back off, and Retry-After is capped at a day", () => {
  assert.equal(backoffSeconds(429, null), 1_800);
  assert.equal(backoffSeconds(403, null), 21_600);
  assert.equal(backoffSeconds(401, null), 21_600);
  assert.equal(backoffSeconds(500, null), 0);
  assert.equal(backoffSeconds(429, "10"), 10);
  assert.equal(backoffSeconds(429, "999999"), 86_400);
  assert.equal(backoffSeconds(429, "nope"), 1_800);
  const later = new Date(noon + 60_000).toUTCString();
  assert.equal(backoffSeconds(200, later, noon), 60);
  let state = emptyRate(noon);
  state = applyBackoff(state, noon, 1_800);
  assert.equal(canPost(state, noon + 1_000, 15, limits).reason, "backoff");
  assert.equal(canPost(state, noon + 1_800_000, 15, limits).ok, true);
});

test("the biggest event wins and a tie breaks on ticker", () => {
  const best = chooseWhale([
    { ticker: "MACHI", events: [{ score: 2_000_000 }, { score: 100 }] },
    { ticker: "WYNN", events: [{ score: 9_000_000 }] },
    { ticker: "HLP", events: [] },
  ]);
  assert.equal(best?.ticker, "WYNN");
  const tie = chooseWhale([
    { ticker: "MACHI", events: [{ score: 2_000_000 }] },
    { ticker: "BOBBY", events: [{ score: 2_000_000 }] },
  ]);
  assert.equal(tie?.ticker, "BOBBY");
});

test("the daily recap stays off unless it is enabled and after 22:00 UTC", () => {
  const state = emptyRate(noon);
  const late = Date.UTC(2026, 9, 22, 22, 15, 0);
  assert.equal(recapDue(state, late, false), false);
  assert.equal(recapDue(state, Date.UTC(2026, 9, 22, 21, 59, 0), true), false);
  assert.equal(recapDue(state, late, true), true);
  const done = recordPost(state, late, 15, true);
  assert.equal(done.recapDay, "2026-10-22");
  assert.equal(recapDue(done, late + 3_600_000, true), false);
});
