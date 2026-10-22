/**
 * v3 keeper helpers. Settlement is one settleMany per chunk, every 10 minutes.
 * The live worker stays on v2 until PROTOCOL is set to "v3".
 */
import { keccak_256 } from "@noble/hashes/sha3";

export const V3_EPOCH_SEC = 600;
/** Forge measured about 507k for a settle that fills an order bucket. This leaves headroom. */
export const V3_GAS_PER_MARKET = 650_000n;
export const V3_GAS_OVERHEAD = 100_000n;
/** Under the 3,000,000-gas small block. */
export const V3_TX_GAS_CEILING = 2_900_000n;

export type BookAsset = { memberIndex: number; perp: number };

export function marketsPerTx(): number {
  return Number((V3_TX_GAS_CEILING - V3_GAS_OVERHEAD) / V3_GAS_PER_MARKET);
}

export function settleManyGas(n: number): bigint {
  if (!Number.isInteger(n) || n < 1 || n > marketsPerTx()) throw new Error("v3 chunk size");
  const gas = V3_GAS_OVERHEAD + BigInt(n) * V3_GAS_PER_MARKET;
  if (gas > V3_TX_GAS_CEILING) throw new Error("v3 chunk gas");
  return gas;
}

/**
 * v2 keeps the every-minute cron and ignores the 5-minute and 10-minute triggers.
 * v3 runs only on those slow triggers, so a minute cron left in place does not sample.
 */
export function shouldRun(protocol: string | undefined, cron: string | undefined): "v2" | "v3" | "skip" {
  const p = protocol || "v2";
  const slow = cron === "*/10 * * * *" || cron === "*/5 * * * *";
  if (p === "v2") return slow ? "skip" : "v2";
  if (p === "v3") return slow ? "v3" : "skip";
  throw new Error(`unknown PROTOCOL ${p}`);
}

export function assertV3Chain(chainId: number): void {
  if (!Number.isInteger(chainId) || (chainId !== 998 && chainId !== 999)) {
    throw new Error(`refusing chain id ${chainId}; v3 keeper allows 998 or 999`);
  }
}

export function isDue(lastSettleTs: bigint, nowSec: number, epochSec: number): boolean {
  if (!Number.isInteger(nowSec) || nowSec < 0) return false;
  if (!Number.isInteger(epochSec) || epochSec <= 0) return false;
  if (lastSettleTs === 0n) return true;
  return BigInt(nowSec) >= lastSettleTs + BigInt(epochSec);
}

/** meta.universe order is the perp index. Mainnet ETH is 1. Testnet ETH is 4. Neither is hardcoded. */
export function indexByCoin(universe: readonly { name: string }[]): Map<string, number> {
  return new Map(universe.map((asset, i) => [asset.name, i]));
}

export function assetsForWhale(
  byCoin: ReadonlyMap<string, number>,
  positions: readonly { coin: string; szi: string }[],
): { assets: BookAsset[]; unknown: string[] } {
  const assets: BookAsset[] = [];
  const unknown: string[] = [];
  for (const row of positions) {
    if (!row.szi || Number(row.szi) === 0) continue;
    const perp = byCoin.get(row.coin);
    if (perp === undefined) unknown.push(row.coin);
    else assets.push({ memberIndex: 0, perp });
  }
  return { assets, unknown };
}

export function chunkBy<T>(rows: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new Error("chunk");
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

function word(n: number | bigint): string {
  return BigInt(n).toString(16).padStart(64, "0");
}

function selectorOf(sig: string): string {
  const hash = keccak_256(new TextEncoder().encode(sig));
  let hex = "";
  for (let i = 0; i < 4; i++) hex += hash[i]!.toString(16).padStart(2, "0");
  return hex;
}

export const SETTLE_MANY_SELECTOR = selectorOf("settleMany(address[],(uint8,uint32)[][])");

function addressWord(addr: string): string {
  const h = addr.toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{40}$/.test(h)) throw new Error("settleMany market is not an address");
  return h.padStart(64, "0");
}

/** ABI for settleMany(address[],(uint8,uint32)[][]). Inner tuples are static, so each asset is two words. */
export function encodeSettleMany(markets: readonly string[], books: readonly (readonly BookAsset[])[]): `0x${string}` {
  if (markets.length !== books.length) throw new Error("settleMany books length");
  if (markets.length < 1 || markets.length > 16) throw new Error("settleMany batch size");
  const n = markets.length;
  const head = word(0x40) + word(BigInt(96 + 32 * n));
  let marketsBody = word(n);
  for (const market of markets) marketsBody += addressWord(market);

  // Offsets are relative to the first offset word, which sits just after the length.
  const innerAt = 32 * n;
  const offsets: number[] = [];
  let cursor = innerAt;
  const bodies: string[] = [];
  for (const book of books) {
    offsets.push(cursor);
    let body = word(book.length);
    for (const asset of book) {
      if (!Number.isInteger(asset.memberIndex) || asset.memberIndex < 0 || asset.memberIndex > 255) {
        throw new Error("memberIndex out of range");
      }
      if (!Number.isInteger(asset.perp) || asset.perp < 0 || asset.perp > 0xffffffff) {
        throw new Error("perp out of range");
      }
      body += word(asset.memberIndex) + word(asset.perp);
    }
    bodies.push(body);
    cursor += 32 * (1 + 2 * book.length);
  }
  let booksBody = word(n);
  for (const offset of offsets) booksBody += word(offset);
  booksBody += bodies.join("");
  return ("0x" + SETTLE_MANY_SELECTOR + head + marketsBody + booksBody) as `0x${string}`;
}
