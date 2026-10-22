/**
 * One cron decision, with no IO. The worker fetches, then calls this,
 * then writes KV only when a snapshot changed or a post was recorded.
 */

import { commitSnap, detectEvents, snapOf, type Pos, type Snap, type WhaleEvent } from "./events.js";
import { canPost, chooseWhale, recapDue, type Limits, type RateState } from "./rate.js";
import { compose, costMilli, postTypeOf, type LinkMode, type Odds } from "./templates.js";

export type Book = {
  ticker: string;
  /** Null when the info API failed. The stored snapshot is left alone. */
  positions: Pos[] | null;
  realised: Readonly<Record<string, number>> | null;
};

export type RunInput = {
  now: number;
  snaps: Record<string, Snap>;
  books: readonly Book[];
  notionalUsd: number;
  pnlUsd: number;
  addPct: number;
  notionalByTicker: Readonly<Record<string, number>>;
  rate: RateState;
  limits: Limits;
  linkMode: LinkMode;
  dailyRecap: boolean;
  odds: Readonly<Record<string, Odds | null>>;
  variant?: number;
};

export type PlannedPost = {
  ticker: string;
  text: string;
  costMilli: number;
  postType: "plain" | "url";
  recap: boolean;
  /** Present for an event post. Applied to KV only after the post is accepted. */
  snap?: Snap;
};

export type RunPlan = {
  /** Snapshots if the post does not land. Event whales stay on the previous book. */
  snaps: Record<string, Snap>;
  writeSnap: boolean;
  post: PlannedPost | null;
  skip: string;
};

export function decideRun(input: RunInput): RunPlan {
  const snaps: Record<string, Snap> = { ...input.snaps };
  let writeSnap = false;
  const groups: { ticker: string; events: WhaleEvent[]; next: Snap }[] = [];

  for (const book of input.books) {
    if (!book.positions) continue;
    const next = snapOf(book.positions, input.now);
    const prev = input.snaps[book.ticker];
    const events = detectEvents(book.ticker, prev, book.positions, book.realised, {
      notionalUsd: input.notionalByTicker[book.ticker] ?? input.notionalUsd,
      pnlUsd: input.pnlUsd,
      addPct: input.addPct,
    });
    if (events.length > 0) {
      groups.push({ ticker: book.ticker, events, next });
      continue;
    }
    const committed = commitSnap(prev, next, [], false);
    if (committed.write) {
      snaps[book.ticker] = committed.snap;
      writeSnap = true;
    }
  }

  const limits = input.limits;
  const choice = chooseWhale(groups);
  if (choice) {
    const group = groups.find((g) => g.ticker === choice.ticker);
    if (!group) return { snaps, writeSnap, post: null, skip: "" };
    const text = compose({
      ticker: group.ticker,
      events: group.events,
      odds: input.odds[group.ticker] ?? null,
      now: input.now,
      linkMode: input.linkMode,
      variant: input.variant,
    });
    const cost = costMilli(text);
    const gate = canPost(input.rate, input.now, cost, limits);
    if (!gate.ok) return { snaps, writeSnap, post: null, skip: gate.reason };
    return {
      snaps,
      writeSnap,
      skip: "",
      post: {
        ticker: group.ticker,
        text,
        costMilli: cost,
        postType: postTypeOf(cost),
        recap: false,
        snap: group.next,
      },
    };
  }

  if (!recapDue(input.rate, input.now, input.dailyRecap)) {
    return { snaps, writeSnap, post: null, skip: "" };
  }
  const biggest = biggestOpen(input);
  const text = compose({
    ticker: biggest?.ticker ?? "WHALE",
    now: input.now,
    linkMode: input.linkMode,
    variant: input.variant,
    recap: true,
    whaleCount: input.books.length,
    biggest: biggest ?? undefined,
    odds: null,
  });
  const cost = costMilli(text);
  const gate = canPost(input.rate, input.now, cost, limits);
  if (!gate.ok) return { snaps, writeSnap, post: null, skip: gate.reason };
  return {
    snaps,
    writeSnap,
    skip: "",
    post: { ticker: biggest?.ticker ?? "RECAP", text, costMilli: cost, postType: postTypeOf(cost), recap: true },
  };
}

function biggestOpen(input: RunInput): { ticker: string; coin: string; side: Pos["side"]; notional: number } | null {
  let best: { ticker: string; coin: string; side: Pos["side"]; notional: number } | null = null;
  for (const book of input.books) {
    const positions = book.positions ?? input.snaps[book.ticker]?.positions ?? [];
    for (const p of positions) {
      if (!best || p.notional > best.notional) {
        best = { ticker: book.ticker, coin: p.coin, side: p.side, notional: p.notional };
      }
    }
  }
  return best;
}
