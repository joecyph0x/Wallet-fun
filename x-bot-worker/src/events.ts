/**
 * Notable position changes against the last KV snapshot.
 * The first snapshot is a baseline: it writes state and emits nothing,
 * so a deploy does not announce positions that were already open.
 */

export type Side = "long" | "short";

export type Pos = {
  coin: string;
  szi: number;
  notional: number;
  upnl: number;
  entry: number;
  side: Side;
};

export type Snap = {
  at: number;
  positions: Pos[];
};

export type Thresholds = {
  notionalUsd: number;
  pnlUsd: number;
  /** 0.5 means a size increase above 50%. */
  addPct: number;
};

export type EventKind = "open" | "close" | "flip" | "add" | "swing";

export type WhaleEvent = {
  kind: EventKind;
  ticker: string;
  coin: string;
  side: Side;
  prevSide?: Side;
  notional: number;
  entry: number;
  /** Close: realised pnl. Swing: uPnL delta. Otherwise 0. */
  pnl: number;
  /** Fraction added, 0.8 means +80% size. */
  addFrac: number;
  score: number;
};

export function snapOf(positions: readonly Pos[], at: number): Snap {
  const copy = positions.map((p) => ({ ...p }));
  copy.sort((a, b) => a.coin.localeCompare(b.coin));
  return { at, positions: copy };
}

export function positionsFromClearinghouse(body: unknown): Pos[] | null {
  if (!body || typeof body !== "object") return null;
  const rows = (body as { assetPositions?: unknown }).assetPositions;
  if (!Array.isArray(rows)) return null;
  const byCoin = new Map<string, Pos>();
  for (const row of rows) {
    const pos = row && typeof row === "object" ? (row as { position?: unknown }).position : undefined;
    if (!pos || typeof pos !== "object") continue;
    const p = pos as Record<string, unknown>;
    if (typeof p.coin !== "string" || !p.coin) continue;
    const szi = Number(p.szi);
    if (!Number.isFinite(szi) || Math.abs(szi) < 1e-12) continue;
    const notional = Math.abs(Number(p.positionValue));
    const upnl = Number(p.unrealizedPnl);
    const entry = Number(p.entryPx);
    byCoin.set(p.coin, {
      coin: p.coin,
      szi,
      notional: Number.isFinite(notional) ? notional : 0,
      upnl: Number.isFinite(upnl) ? upnl : 0,
      entry: Number.isFinite(entry) ? entry : 0,
      side: szi > 0 ? "long" : "short",
    });
  }
  return [...byCoin.values()];
}

/** Sum closedPnl for close fills of one coin at or after `sinceMs`. Null when none match. */
export function sumClosedPnl(rows: unknown, coin: string, sinceMs: number): number | null {
  if (!Array.isArray(rows)) return null;
  let sum = 0;
  let any = false;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    if (r.coin !== coin) continue;
    if (typeof r.time === "number" && r.time < sinceMs) continue;
    const dir = typeof r.dir === "string" ? r.dir : "";
    if (!/close/i.test(dir)) continue;
    const pnl = Number(r.closedPnl);
    if (!Number.isFinite(pnl)) continue;
    sum += pnl;
    any = true;
  }
  return any ? sum : null;
}

export function detectEvents(
  ticker: string,
  prev: Snap | undefined,
  next: readonly Pos[],
  realised: Readonly<Record<string, number>> | null,
  th: Thresholds,
): WhaleEvent[] {
  if (!prev) return [];
  const before = indexPos(prev.positions);
  const after = indexPos(next);
  const events: WhaleEvent[] = [];
  const touched = new Set<string>();

  for (const [coin, now] of after) {
    const was = before.get(coin);
    if (!was) {
      if (now.notional >= th.notionalUsd) {
        events.push(make(ticker, "open", now, now.notional, 0, 0));
        touched.add(coin);
      }
      continue;
    }
    if (was.side !== now.side) {
      if (was.notional >= th.notionalUsd || now.notional >= th.notionalUsd) {
        const flip = make(ticker, "flip", now, Math.max(was.notional, now.notional), 0, 0);
        flip.prevSide = was.side;
        events.push(flip);
        touched.add(coin);
      }
      continue;
    }
    const oldAbs = Math.abs(was.szi);
    const newAbs = Math.abs(now.szi);
    if (oldAbs > 0 && newAbs > oldAbs * (1 + th.addPct) && now.notional >= th.notionalUsd) {
      events.push(make(ticker, "add", now, now.notional, 0, (newAbs - oldAbs) / oldAbs));
      touched.add(coin);
    }
  }

  for (const [coin, was] of before) {
    if (after.has(coin)) continue;
    const pnl = realised && Object.prototype.hasOwnProperty.call(realised, coin) ? realised[coin]! : was.upnl;
    if (Math.abs(pnl) >= th.pnlUsd) {
      events.push(make(ticker, "close", was, Math.abs(pnl), pnl, 0));
    }
  }

  for (const [coin, now] of after) {
    const was = before.get(coin);
    if (!was || was.side !== now.side || touched.has(coin)) continue;
    const delta = now.upnl - was.upnl;
    if (Math.abs(delta) >= th.pnlUsd) {
      events.push(make(ticker, "swing", now, Math.abs(delta), delta, 0));
    }
  }

  return events;
}

/**
 * Write the next snapshot only when the book actually changed.
 * An unposted event keeps the previous snapshot so the next run can still see it.
 * uPnL-only drift does not write: the swing baseline stays put until it crosses the threshold.
 */
export function commitSnap(
  prev: Snap | undefined,
  next: Snap,
  events: readonly WhaleEvent[],
  posted: boolean,
): { snap: Snap; write: boolean } {
  if (!prev) return { snap: next, write: true };
  if (events.length > 0 && !posted) return { snap: prev, write: false };
  if (events.length > 0 && posted) return { snap: next, write: true };
  if (changedShape(prev, next)) return { snap: next, write: true };
  return { snap: prev, write: false };
}

function changedShape(prev: Snap, next: Snap): boolean {
  const a = indexPos(prev.positions);
  const b = indexPos(next.positions);
  if (a.size !== b.size) return true;
  for (const [coin, p] of a) {
    const q = b.get(coin);
    if (!q) return true;
    if (p.side !== q.side) return true;
    const denom = Math.max(Math.abs(p.szi), 1e-12);
    if (Math.abs(q.szi - p.szi) / denom > 0.01) return true;
  }
  return false;
}

function indexPos(positions: readonly Pos[]): Map<string, Pos> {
  const m = new Map<string, Pos>();
  for (const p of positions) m.set(p.coin, p);
  return m;
}

function make(
  ticker: string,
  kind: EventKind,
  pos: Pos,
  score: number,
  pnl: number,
  addFrac: number,
): WhaleEvent {
  return {
    kind,
    ticker,
    coin: pos.coin,
    side: pos.side,
    notional: pos.notional,
    entry: pos.entry,
    pnl,
    addFrac,
    score,
  };
}
