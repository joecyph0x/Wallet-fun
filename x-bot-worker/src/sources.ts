/**
 * Where a whale's positions live on Hyperliquid mainnet.
 *
 * clearinghouseState only returns one perp dex per call. The default dex ("")
 * misses HIP-3 builder dexes such as xyz (stocks, metals, oil), so a whale that
 * trades there looked flat. A vault parent such as HLP holds no positions itself:
 * its trading sits in child vaults, so we read the children and net them.
 *
 * Cloudflare free Workers allow 50 subrequests per run. Keep the dex list short.
 */
import type { Pos } from "./events.js";

/** HIP-3 dexes read for every whale besides the default dex. */
export const DEFAULT_EXTRA_DEXES: readonly string[] = ["xyz"];

/** Most child vaults read for one vault parent. */
export const MAX_VAULT_CHILDREN = 8;

export type Query = { user: string; dex: string };

/** Parse a comma list like "xyz,flx". Empty string means only the default dex. */
export function parseDexes(raw: string | undefined): string[] {
  if (raw === undefined) return [...DEFAULT_EXTRA_DEXES];
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const d = part.trim().toLowerCase();
    if (/^[a-z0-9]{1,16}$/.test(d) && !out.includes(d)) out.push(d);
  }
  return out;
}

/** Child vault addresses from a vaultDetails body. Empty when not a parent. */
export function vaultChildren(body: unknown): string[] {
  if (!body || typeof body !== "object") return [];
  const rel = (body as { relationship?: unknown }).relationship;
  if (!rel || typeof rel !== "object") return [];
  const r = rel as { type?: unknown; data?: unknown };
  if (r.type !== "parent" || !r.data || typeof r.data !== "object") return [];
  const kids = (r.data as { childAddresses?: unknown }).childAddresses;
  if (!Array.isArray(kids)) return [];
  const out: string[] = [];
  for (const k of kids) {
    if (typeof k === "string" && /^0x[0-9a-fA-F]{40}$/.test(k) && !out.includes(k.toLowerCase())) out.push(k.toLowerCase());
  }
  return out.slice(0, MAX_VAULT_CHILDREN);
}

/** Every (account, dex) pair to read for one whale. */
export function queriesFor(accounts: readonly string[], dexes: readonly string[]): Query[] {
  const out: Query[] = [];
  for (const user of accounts) {
    out.push({ user, dex: "" });
    for (const dex of dexes) out.push({ user, dex });
  }
  return out;
}

/**
 * Net positions across accounts and dexes into one book.
 * Null if every read failed, so a failed fetch never looks like a full close.
 * Any single failed read also returns null for the same reason.
 */
export function mergeBooks(books: readonly (Pos[] | null)[]): Pos[] | null {
  if (books.length === 0 || books.some((b) => b === null)) return null;
  const acc = new Map<string, { szi: number; signed: number; upnl: number; cost: number }>();
  for (const book of books) {
    for (const p of book!) {
      const a = acc.get(p.coin) ?? { szi: 0, signed: 0, upnl: 0, cost: 0 };
      a.szi += p.szi;
      a.signed += p.szi > 0 ? p.notional : -p.notional;
      a.upnl += p.upnl;
      a.cost += p.entry * p.szi;
      acc.set(p.coin, a);
    }
  }
  const out: Pos[] = [];
  for (const [coin, a] of acc) {
    if (Math.abs(a.szi) < 1e-12) continue;
    out.push({
      coin,
      szi: a.szi,
      notional: Math.abs(a.signed),
      upnl: a.upnl,
      entry: Math.abs(a.cost / a.szi),
      side: a.szi > 0 ? "long" : "short",
    });
  }
  return out;
}

/**
 * HIP-3 names arrive as `xyz:TSLA`. Posts show `$TSLA`.
 * The dex prefix stays in the snapshot key. A plain coin (ETH) is unchanged.
 */
export function displayCoin(coin: string): string {
  const raw = coin.trim().replace(/@/g, "");
  const i = raw.indexOf(":");
  const name = (i > 0 ? raw.slice(i + 1) : raw).trim();
  if (!name) return raw;
  if (i > 0 && /^[A-Za-z][A-Za-z0-9.]{0,15}$/.test(name)) {
    return "$" + name.replace(/\./g, "").toUpperCase();
  }
  return name;
}

/** Account value in USD from a clearinghouseState body. Null when the field is missing. */
export function accountValueFromClearinghouse(body: unknown): number | null {
  if (!body || typeof body !== "object") return null;
  const row = body as { marginSummary?: { accountValue?: unknown }; crossMarginSummary?: { accountValue?: unknown } };
  const raw = row.marginSummary?.accountValue ?? row.crossMarginSummary?.accountValue;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
