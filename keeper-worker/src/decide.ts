/**
 * Pure settle decision for the Worker keeper.
 *
 * Same idle rule as keeper/src/idle.ts: a flat whale whose account value has not
 * changed, and which has no queued orders, is settled only on the idle heartbeat.
 * There is no on-chain batch settle, so a run also caps how many transactions it sends.
 * JSON-RPC batches stay at or below the testnet limit of 20.
 */

export const TESTNET_CHAIN_ID = 998;

export const MAX_RPC_BATCH = 20;

export type SettleReason = "first" | "orders" | "woke" | "slept" | "heartbeat" | "idle-heartbeat";

export type MarketSnap = {
  market: string;
  lastSettleTs: bigint;
  openOrders: bigint | undefined;
  lastEquity: bigint;
  lastNtlPos: bigint;
  /** False when the info API did not answer. The market is skipped, matching the box keeper. */
  infoOk: boolean;
  /** Non-zero positions. Meaningful only when infoOk. */
  positionCount: number;
  /** marginSummary.accountValue truncated to 6 decimals, the same scale as lastEquity. */
  accountValue6: bigint | undefined;
};

export type SettleChoice = {
  market: string;
  lastSettleTs: bigint;
  reason: SettleReason;
};

/** HyperEVM testnet is 998. 999 is mainnet and is refused, as is any other id. */
export function assertTestnet(chainId: number): void {
  if (!Number.isInteger(chainId) || chainId !== TESTNET_CHAIN_ID) {
    throw new Error(`refusing chain id ${chainId}; HyperEVM testnet is 998 (999 is mainnet)`);
  }
}

/** Match the box keeper: round(hype * 1e6) * 1e12 wei. 0.005 HYPE = 5e15 wei. */
export function minGasWei(hype: string | number): bigint {
  const n = Number(hype);
  if (!Number.isFinite(n) || n < 0) throw new Error("MIN_GAS_HYPE must be a non-negative number");
  return BigInt(Math.round(n * 1e6)) * 10n ** 12n;
}

export function gasOk(balanceWei: bigint, floorWei: bigint): boolean {
  return balanceWei >= floorWei;
}

/** Truncate a decimal USD string to 6 places. "1000.1234567" -> 1000123456. */
export function accountValue6(raw: string | undefined): bigint | undefined {
  if (raw == null) return undefined;
  const text = raw.trim();
  if (!text || text === "?") return undefined;
  const neg = text.startsWith("-");
  const body = neg ? text.slice(1) : text;
  const [whole, frac = ""] = body.split(".");
  if (!/^\d+$/.test(whole) || (frac !== "" && !/^\d+$/.test(frac))) return undefined;
  if (body.split(".").length > 2) return undefined;
  const micros = BigInt(whole) * 1_000_000n + BigInt((frac + "000000").slice(0, 6) || "0");
  return neg ? -micros : micros;
}

/**
 * Whether this market should be settled now.
 *
 * Queued orders do not bypass the contract's 60s heartbeat (TooEarly), so they
 * are sent only when the heartbeat is already due, or a position opened or
 * closed (the contract allows that early). A flat, unchanged, empty queue waits
 * for the idle heartbeat. Unknown info is skipped rather than settled blind.
 */
export function needsSettle(
  v: MarketSnap,
  nowSec: number,
  heartbeatSec: number,
  idleHeartbeatSec: number,
): SettleReason | null {
  if (!v.infoOk) return null;
  const since = v.lastSettleTs === 0n ? Number.POSITIVE_INFINITY : nowSec - Number(v.lastSettleTs);
  const woke = v.lastNtlPos === 0n && v.positionCount > 0;
  const slept = v.lastNtlPos > 0n && v.positionCount === 0;
  const presence = woke || slept;
  const due = v.lastSettleTs === 0n || since >= heartbeatSec;
  if (!presence && !due) return null;
  if (v.lastSettleTs === 0n) return "first";
  if ((v.openOrders === undefined || v.openOrders > 0n) && (due || presence)) return "orders";
  if (woke) return "woke";
  if (slept) return "slept";
  const flat = v.positionCount === 0;
  const same = v.accountValue6 !== undefined && v.accountValue6 === v.lastEquity;
  if (flat && same && v.openOrders === 0n) {
    return since >= idleHeartbeatSec ? "idle-heartbeat" : null;
  }
  return due ? "heartbeat" : null;
}

const REASON_RANK: Record<SettleReason, number> = {
  orders: 0,
  woke: 1,
  slept: 2,
  first: 3,
  heartbeat: 4,
  "idle-heartbeat": 5,
};

/** Highest priority first, then the oldest lastSettleTs, then market address. Capped. */
export function selectSettles<T extends SettleChoice>(rows: readonly T[], max: number): T[] {
  const cap = Math.max(0, Math.floor(max));
  return [...rows].sort((a, b) => {
    const rank = REASON_RANK[a.reason] - REASON_RANK[b.reason];
    if (rank !== 0) return rank;
    if (a.lastSettleTs < b.lastSettleTs) return -1;
    if (a.lastSettleTs > b.lastSettleTs) return 1;
    const am = a.market.toLowerCase();
    const bm = b.market.toLowerCase();
    if (am < bm) return -1;
    if (am > bm) return 1;
    return 0;
  }).slice(0, cap);
}

/** Keep a registry larger than the free-plan subrequest budget rotating across minutes. */
export function rotateMarkets<T>(rows: readonly T[], cursor: number, max: number): { rows: T[]; next: number } {
  if (max < 1) return { rows: [], next: 0 };
  if (rows.length <= max) return { rows: [...rows], next: 0 };
  const start = ((cursor % rows.length) + rows.length) % rows.length;
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(rows[(start + i) % rows.length]!);
  return { rows: out, next: (start + max) % rows.length };
}

export function chunk<T>(items: readonly T[], size = MAX_RPC_BATCH): T[][] {
  if (!Number.isInteger(size) || size < 1 || size > MAX_RPC_BATCH) {
    throw new Error(`JSON-RPC batch size must be 1..${MAX_RPC_BATCH}`);
  }
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
