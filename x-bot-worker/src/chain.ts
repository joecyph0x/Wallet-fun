/**
 * Read-only chain helpers. Pots live on HyperEVM testnet (chain id 998).
 * JSON-RPC batches stay at or below the testnet limit of 20.
 * No signing and no sends.
 */

export const TESTNET_CHAIN_ID = 998;
export const MAINNET_INFO = "https://api.hyperliquid.xyz/info";

/** Positions come from mainnet. A testnet info URL is refused so DEMO books cannot leak in. */
export function mainnetInfoUrl(raw: string | undefined): string {
  if (!raw) return MAINNET_INFO;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" || u.hostname !== "api.hyperliquid.xyz") return MAINNET_INFO;
    return raw;
  } catch {
    return MAINNET_INFO;
  }
}

export const MAX_RPC_BATCH = 20;

/** tailPot() */
export const TAIL_POT_SELECTOR = "2b2dc7c8";
/** fadePot() */
export const FADE_POT_SELECTOR = "e52d1e6d";
/** listings(address) */
export const LISTINGS_SELECTOR = "65d96c82";

const UNIT = 1_000_000;

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  const n = Math.max(1, size);
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}

export function encodeCall(selectorHex: string, addr?: string): string {
  const sel = selectorHex.replace(/^0x/, "");
  if (!addr) return "0x" + sel;
  const clean = addr.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  return "0x" + sel + clean;
}

export function decodeUint256(hex: unknown): bigint | null {
  if (typeof hex !== "string") return null;
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (!/^[0-9a-fA-F]+$/.test(h) || h.length === 0) return null;
  try {
    return BigInt("0x" + h);
  } catch {
    return null;
  }
}

export function parseChainId(hex: unknown): number | null {
  const n = decodeUint256(hex);
  if (n === null || n > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(n);
}

/** listings(address) returns (market, whale, active). Unknown data does not mark the whale inactive. */
export function parseListing(data: unknown): { known: boolean; active: boolean } {
  if (typeof data !== "string") return { known: false, active: true };
  const hex = data.startsWith("0x") ? data.slice(2) : data;
  if (hex.length < 64 * 3 || !/^[0-9a-fA-F]+$/.test(hex)) return { known: false, active: true };
  const market = hex.slice(0, 64);
  if (/^0+$/.test(market)) return { known: true, active: false };
  const activeWord = hex.slice(128, 192);
  return { known: true, active: /[1-9a-fA-F]/.test(activeWord) };
}

export function potsFromRaw(tailRaw: bigint | null, fadeRaw: bigint | null): { tail: number; fade: number } | null {
  if (tailRaw === null || fadeRaw === null) return null;
  const tail = Number(tailRaw) / UNIT;
  const fade = Number(fadeRaw) / UNIT;
  if (!(tail > 0) || !(fade > 0) || !Number.isFinite(tail) || !Number.isFinite(fade)) return null;
  return { tail, fade };
}
