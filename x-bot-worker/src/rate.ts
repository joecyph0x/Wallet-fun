/**
 * Post budget. X's free-tier successor is pay-per-use:
 * a plain post is $0.015 and any post that contains a URL is $0.20.
 * The daily cap, the 20 minute gap, and MAX_DAILY_SPEND_USD all have to pass.
 */

import type { WhaleEvent } from "./events.js";

/** One whale can take at most this many of the daily posts. */
export const MAX_POSTS_PER_WHALE = 2;

export type RateState = {
  day: string;
  count: number;
  spentMilli: number;
  lastPostAt: number;
  backoffUntil: number;
  recapDay: string;
  /** Event posts today, keyed by ticker. Recaps are not counted. */
  byWhale: Record<string, number>;
};

export type Limits = {
  maxPerDay: number;
  minGapSec: number;
  maxSpendMilli: number;
};

export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function emptyRate(now: number): RateState {
  return { day: utcDay(now), count: 0, spentMilli: 0, lastPostAt: 0, backoffUntil: 0, recapDay: "", byWhale: {} };
}

export function usdToMilli(usd: number): number {
  if (!Number.isFinite(usd)) return 0;
  return Math.round(usd * 1000);
}

export function formatMilli(milli: number): string {
  const sign = milli < 0 ? "-" : "";
  const v = Math.abs(Math.round(milli));
  const whole = Math.floor(v / 1000);
  const frac = String(v % 1000).padStart(3, "0");
  return sign + whole.toString() + "." + frac;
}

export function effectiveRate(
  state: RateState,
  now: number,
): { day: string; count: number; spentMilli: number; byWhale: Record<string, number> } {
  const day = utcDay(now);
  if (state.day !== day) return { day, count: 0, spentMilli: 0, byWhale: {} };
  return { day, count: state.count, spentMilli: state.spentMilli, byWhale: state.byWhale ?? {} };
}

export function canPost(
  state: RateState,
  now: number,
  costMilli: number,
  limits: Limits,
): { ok: boolean; reason: string } {
  if (state.backoffUntil > now) return { ok: false, reason: "backoff" };
  const today = effectiveRate(state, now);
  if (today.count >= limits.maxPerDay) return { ok: false, reason: "daily cap" };
  if (state.lastPostAt > 0 && now - state.lastPostAt < limits.minGapSec * 1000) {
    return { ok: false, reason: "gap" };
  }
  if (today.spentMilli + costMilli > limits.maxSpendMilli) return { ok: false, reason: "spend" };
  return { ok: true, reason: "" };
}

export function recordPost(
  state: RateState,
  now: number,
  costMilli: number,
  recap: boolean,
  ticker = "",
): RateState {
  const today = effectiveRate(state, now);
  const byWhale = { ...today.byWhale };
  const key = ticker.toUpperCase();
  if (!recap && key) byWhale[key] = (byWhale[key] ?? 0) + 1;
  return {
    day: today.day,
    count: today.count + 1,
    spentMilli: today.spentMilli + costMilli,
    lastPostAt: now,
    backoffUntil: state.backoffUntil,
    recapDay: recap ? today.day : state.recapDay === today.day ? state.recapDay : "",
    byWhale,
  };
}

export function applyBackoff(state: RateState, now: number, seconds: number): RateState {
  if (!(seconds > 0)) return state;
  const until = now + Math.floor(seconds) * 1000;
  return { ...state, backoffUntil: Math.max(state.backoffUntil, until) };
}

const DAY_SEC = 86_400;

/** 429 waits 30 minutes. 401 and 403 wait 6 hours. Retry-After wins, capped at 24h. */
export function backoffSeconds(status: number, retryAfter: string | null, nowMs = Date.now()): number {
  const fallback = status === 429 ? 1_800 : status === 403 || status === 401 ? 21_600 : 0;
  if (retryAfter) {
    const trimmed = retryAfter.trim();
    const n = Number(trimmed);
    if (Number.isFinite(n) && n > 0) return Math.min(DAY_SEC, Math.floor(n));
    const when = Date.parse(trimmed);
    if (Number.isFinite(when) && when > nowMs) return Math.min(DAY_SEC, Math.ceil((when - nowMs) / 1000));
  }
  return fallback;
}

export function chooseWhale(
  groups: readonly { ticker: string; events: readonly { score: number }[] }[],
  posted: Readonly<Record<string, number>> = {},
  maxPerWhale = MAX_POSTS_PER_WHALE,
): { ticker: string; score: number } | null {
  let best: { ticker: string; score: number; posts: number } | null = null;
  for (const g of groups) {
    if (!g.events.length) continue;
    const posts = posted[g.ticker.toUpperCase()] ?? 0;
    if (posts >= maxPerWhale) continue;
    let score = 0;
    for (const e of g.events) if (e.score > score) score = e.score;
    if (
      !best
      || score > best.score
      || (score === best.score && posts < best.posts)
      || (score === best.score && posts === best.posts && g.ticker < best.ticker)
    ) {
      best = { ticker: g.ticker, score, posts };
    }
  }
  return best ? { ticker: best.ticker, score: best.score } : null;
}

export function recapDue(state: RateState, now: number, enabled: boolean): boolean {
  if (!enabled) return false;
  const day = utcDay(now);
  if (state.recapDay === day) return false;
  return new Date(now).getUTCHours() >= 22;
}

export function topEvents(events: readonly WhaleEvent[]): WhaleEvent[] {
  return [...events].sort((a, b) => b.score - a.score || a.coin.localeCompare(b.coin));
}
