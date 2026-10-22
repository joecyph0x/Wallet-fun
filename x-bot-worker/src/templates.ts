/**
 * Brand voice: short, degen, emoji-light, no advice, no @mentions.
 * X charges $0.015 for a plain post and $0.20 when the post contains any URL.
 * X also auto-links a bare domain, so "whalewallet.fun" counts. Default posts
 * say "link in bio" or "whalewallet dot fun" instead, and only on some of them.
 */

import type { Side, WhaleEvent } from "./events.js";
import { topEvents } from "./rate.js";
import { displayCoin } from "./sources.js";

export type LinkMode = "none" | "daily" | "all";

export type Odds = { tail: number; fade: number };

/** Thousandths of a dollar. 15 = $0.015, 200 = $0.200. */
export const PLAIN_MILLI = 15;
export const URL_MILLI = 200;

const TLD =
  "com|net|org|io|fun|xyz|app|co|ai|gg|me|ly|dev|info|biz|tv|cc|to|link|site|finance|cash|money|exchange|trade";
const DOMAIN_RE = new RegExp(`(?:^|[^a-z0-9-])(?:[a-z0-9-]+\\.)+(?:${TLD})\\b`, "i");

export function containsUrlOrDomain(text: string): boolean {
  if (/https?:\/\//i.test(text)) return true;
  if (/\bwww\./i.test(text)) return true;
  if (/\bt\.co\b/i.test(text)) return true;
  if (/\bwhalewallet\.fun\b/i.test(text)) return true;
  if (/\bx\.com\b/i.test(text)) return true;
  return DOMAIN_RE.test(text);
}

export function costMilli(text: string): number {
  return containsUrlOrDomain(text) ? URL_MILLI : PLAIN_MILLI;
}

export function postTypeOf(milli: number): "plain" | "url" {
  return milli >= URL_MILLI ? "url" : "plain";
}

export function formatUsd(n: number, signed = false): string {
  const neg = n < 0;
  const v = Math.abs(n);
  const sign = neg ? "-" : signed && n > 0 ? "+" : "";
  if (v >= 1_000_000_000) return compact(v, 1_000_000_000, "B", sign);
  if (v >= 1_000_000) return compact(v, 1_000_000, "M", sign);
  if (v >= 1_000) return compact(v, 1_000, "K", sign);
  return sign + "$" + Math.round(v).toString();
}

export function formatPx(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n >= 100) return withCommas(Math.round(n).toString());
  return n.toFixed(2);
}

export function formatPays(mult: number): string {
  const s = mult.toFixed(1).replace(/\.0$/, "");
  return s + "x";
}

export function oddsLine(odds: Odds | null | undefined): string {
  if (!odds || !(odds.tail > 0) || !(odds.fade > 0)) return "";
  const total = odds.tail + odds.fade;
  return `TAIL pays ${formatPays(total / odds.tail)} · FADE pays ${formatPays(total / odds.fade)}`;
}

/** Drop @ and dots so a coin name cannot become a mention or an auto-linked domain. */
export function safeLabel(s: string): string {
  return s
    .replace(/https?:\/\//gi, "")
    .replace(/@/g, "")
    .replace(/\./g, " ")
    .replace(/[^\p{L}\p{N} :_+-]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function fnv(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export type ComposeInput = {
  ticker: string;
  events?: readonly WhaleEvent[];
  odds?: Odds | null;
  now: number;
  linkMode: LinkMode;
  /** Forces the template and the footer slot. Tests use this. */
  variant?: number;
  recap?: boolean;
  whaleCount?: number;
  biggest?: { ticker: string; coin: string; side: Side; notional: number };
};

const HOST = "whalewallet.fun";

export function compose(input: ComposeInput): string {
  const ticker = safeLabel(input.ticker).replace(/\s+/g, "") || "WHALE";
  const seed = input.variant ?? fnv(seedOf(input));
  const allowUrl = input.linkMode === "all" || (input.linkMode === "daily" && !!input.recap);
  const odds = oddsLine(input.odds);
  const body = input.recap ? recapBody(input, ticker) : eventBody(input.events ?? [], seed);
  const foot = footer(seed, allowUrl, input.recap ? "" : ticker);
  const line = odds && !input.recap ? `${body} ${odds}` : body;
  let text = assemble(line, foot, allowUrl);
  if (!allowUrl && containsUrlOrDomain(text)) {
    text = `🐋 ${ticker} moved.\nSeason 0, points only`;
  }
  return text;
}

function seedOf(input: ComposeInput): string {
  const e = input.events?.[0];
  const hour = new Date(input.now).getUTCHours().toString();
  return `${input.ticker}|${input.recap ? "recap" : e?.kind ?? "none"}|${e?.coin ?? ""}|${hour}`;
}

function eventBody(events: readonly WhaleEvent[], seed: number): string {
  const ranked = topEvents(events);
  if (!ranked.length) return "The board is quiet.";
  if (ranked.length === 1) return single(ranked[0]!, seed % 3);
  const a = short(ranked[0]!);
  const b = short(ranked[1]!);
  const extra = ranked.length > 2 ? ` +${ranked.length - 2} more.` : "";
  const ticker = safeLabel(ranked[0]!.ticker).replace(/\s+/g, "") || "WHALE";
  return `🐋 ${ticker} ${a}, and ${b}.${extra}`;
}

function single(e: WhaleEvent, n: number): string {
  const ticker = safeLabel(e.ticker).replace(/\s+/g, "") || "WHALE";
  const coin = safeLabel(displayCoin(e.coin)) || "a market";
  const usd = formatUsd(e.notional);
  const at = e.entry > 0 ? ` at ${formatPx(e.entry)}` : "";
  const pct = Math.round(e.addFrac * 100).toString();
  const signed = formatUsd(e.pnl, true);
  const prev = e.prevSide ?? (e.side === "long" ? "short" : "long");
  if (e.kind === "open") {
    const lines = [
      `🐋 ${ticker} just opened a ${usd} ${coin} ${e.side}${at}.`,
      `🐋 ${ticker} is in. ${usd} ${coin} ${e.side}${at}.`,
      `New bag. ${ticker} opened ${usd} ${coin} ${e.side}${at}.`,
    ];
    return lines[n] ?? lines[0]!;
  }
  if (e.kind === "close") {
    const lines = [
      `💀 ${ticker} closed the ${coin} ${e.side}. Realised ${signed}.`,
      `${ticker} is out of ${coin}. The ${e.side} booked ${signed}.`,
      `Flat. ${ticker} closed ${coin} ${e.side} for ${signed}.`,
    ];
    return lines[n] ?? lines[0]!;
  }
  if (e.kind === "flip") {
    const lines = [
      `🔄 ${ticker} flipped ${coin} ${prev} → ${e.side}, ${usd}.`,
      `${ticker} switched ${coin} from ${prev} to ${e.side}. Now ${usd}.`,
      `Side change. ${ticker} ${coin} went ${prev} to ${e.side}, ${usd}.`,
    ];
    return lines[n] ?? lines[0]!;
  }
  if (e.kind === "add") {
    const lines = [
      `🐋 ${ticker} added ${pct}% to the ${coin} ${e.side}. Now ${usd}.`,
      `${ticker} sized up the ${coin} ${e.side} by ${pct}%. Book is ${usd}.`,
      `More size. ${ticker} added ${pct}% on ${coin} ${e.side}. Now ${usd}.`,
    ];
    return lines[n] ?? lines[0]!;
  }
  const dir = e.pnl >= 0 ? "up" : "down";
  const abs = formatUsd(Math.abs(e.pnl));
  const lines = [
    `📈 ${ticker} ${coin} ${e.side} is ${dir} ${abs} uPnL.`,
    `${ticker}'s ${coin} ${e.side} moved ${signed} unrealised.`,
    `${ticker} ${coin} ${e.side} uPnL swung ${signed}.`,
  ];
  return lines[n] ?? lines[0]!;
}

function short(e: WhaleEvent): string {
  const coin = safeLabel(displayCoin(e.coin)) || "a market";
  if (e.kind === "open") return `opened a ${formatUsd(e.notional)} ${coin} ${e.side}`;
  if (e.kind === "close") return `closed ${coin} ${e.side} ${formatUsd(e.pnl, true)}`;
  if (e.kind === "flip") return `flipped ${coin} ${e.prevSide ?? "flat"} → ${e.side}`;
  if (e.kind === "add") return `added to the ${coin} ${e.side}, now ${formatUsd(e.notional)}`;
  return `${coin} ${e.side} moved ${formatUsd(e.pnl, true)}`;
}

function recapBody(input: ComposeInput, ticker: string): string {
  const n = input.whaleCount ?? 0;
  const b = input.biggest;
  if (!b || !(b.notional > 0)) return `📒 Daybook. The board is flat. ${n} whales tracked.`;
  const who = safeLabel(b.ticker).replace(/\s+/g, "") || ticker;
  const coin = safeLabel(displayCoin(b.coin)) || "a market";
  return `📒 Daybook. ${who} still on a ${formatUsd(b.notional)} ${coin} ${b.side}. ${n} whales tracked.`;
}

function footer(seed: number, allowUrl: boolean, ticker: string): string {
  const season = "Season 0, points only";
  if (allowUrl) {
    const url = ticker ? `https://${HOST}/#/w/${tickerPath(ticker)}` : `https://${HOST}`;
    return seed % 4 === 2 ? `${url}\n${season}` : url;
  }
  const slot = seed % 4;
  if (slot === 0) return "link in bio";
  if (slot === 1) return "whalewallet dot fun";
  if (slot === 2) return season;
  return "";
}

function tickerPath(ticker: string): string {
  const clean = ticker.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return clean || "HOME";
}

function assemble(body: string, foot: string, keepFoot: boolean): string {
  const joined = foot ? `${body}\n${foot}` : body;
  if (joined.length <= 280) return joined;
  if (!keepFoot) {
    if (body.length <= 280) return body;
    return body.slice(0, 279) + "…";
  }
  const room = 280 - foot.length - 1;
  const trimmed = body.length <= room ? body : body.slice(0, Math.max(0, room - 1)) + "…";
  return `${trimmed}\n${foot}`;
}

function compact(v: number, div: number, suf: string, sign: string): string {
  const x = v / div;
  const s = x >= 100 ? x.toFixed(0) : x.toFixed(1).replace(/\.0$/, "");
  return sign + "$" + s + suf;
}

function withCommas(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
