/**
 * Legacy EIP-155 signer and settle calldata.
 *
 * The cron used to import viem for this. On the free plan that showed up as
 * 40–51ms of CPU per run. secp256k1 here is @noble/curves, the same library
 * viem signs with, without viem's ABI coder or account wrapper. The raw
 * transaction matches viem's legacy serialisation (see sign.test.ts).
 * Chain id defaults to 998. A v3 keeper may pass 999. Any other id is refused.
 */
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";

export const TESTNET_CHAIN_ID = 998n;
/** DEMO with an open ETH position estimates about 403k. 400k reverted out of gas. */
export const SETTLE_GAS = 1_000_000n;
/** settle((uint8,uint32)[]). Cached so a run does not hash the signature. */
export const SETTLE_SELECTOR = "0952d9a3";

export type Hex = `0x${string}`;
export type Asset = { memberIndex: number; perp: number };
export type KeeperAccount = { key: string; address: Hex; priv: Uint8Array };

let cached: KeeperAccount | undefined;

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i]!.toString(16).padStart(2, "0");
  return hex;
}

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length % 2) throw new Error("odd hex");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** EIP-55 checksum, same shape viem's privateKeyToAccount returns. */
function checksumAddress(raw20: Uint8Array): Hex {
  const lower = bytesToHex(raw20);
  const hash = bytesToHex(keccak_256(new TextEncoder().encode(lower)));
  let out = "0x";
  for (let i = 0; i < 40; i++) {
    const nibble = Number.parseInt(hash[i]!, 16);
    out += nibble >= 8 ? lower[i]!.toUpperCase() : lower[i];
  }
  return out as Hex;
}

/** Derived once per isolate. Later crons in the same isolate reuse it. */
export function accountFrom(key: string): KeeperAccount {
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error("KEEPER_PRIVATE_KEY is missing or not a 32-byte hex key");
  }
  if (cached?.key === key) return cached;
  const priv = hexToBytes(key);
  const pub = secp256k1.getPublicKey(priv, false);
  const hash = keccak_256(pub.subarray(1));
  const account: KeeperAccount = { key, address: checksumAddress(hash.subarray(12)), priv };
  cached = account;
  return account;
}

function word(n: number | bigint): string {
  return BigInt(n).toString(16).padStart(64, "0");
}

/** ABI for settle(Asset[]). Static tuples, so each asset is two words in place. */
export function encodeSettle(assets: readonly Asset[]): Hex {
  let hex = SETTLE_SELECTOR + word(0x20) + word(assets.length);
  for (const asset of assets) {
    if (!Number.isInteger(asset.memberIndex) || asset.memberIndex < 0 || asset.memberIndex > 255) {
      throw new Error("memberIndex out of range");
    }
    if (!Number.isInteger(asset.perp) || asset.perp < 0 || asset.perp > 0xffffffff) {
      throw new Error("perp out of range");
    }
    hex += word(asset.memberIndex) + word(asset.perp);
  }
  return ("0x" + hex) as Hex;
}

function bytesFromBigint(n: bigint): Uint8Array {
  if (n < 0n) throw new Error("negative");
  if (n === 0n) return new Uint8Array();
  let hex = n.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  return hexToBytes(hex);
}

function concat(parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const part of parts) len += part.length;
  const out = new Uint8Array(len);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

type Rlp = Uint8Array | Rlp[];

function rlpBytes(payload: Uint8Array): Uint8Array {
  if (payload.length === 1 && payload[0]! < 0x80) return payload;
  return withPrefix(0x80, payload);
}

function withPrefix(base: number, payload: Uint8Array): Uint8Array {
  if (payload.length <= 55) {
    const out = new Uint8Array(1 + payload.length);
    out[0] = base + payload.length;
    out.set(payload, 1);
    return out;
  }
  const lenBytes = bytesFromBigint(BigInt(payload.length));
  const out = new Uint8Array(1 + lenBytes.length + payload.length);
  out[0] = base + 55 + lenBytes.length;
  out.set(lenBytes, 1);
  out.set(payload, 1 + lenBytes.length);
  return out;
}

function rlp(input: Rlp): Uint8Array {
  if (input instanceof Uint8Array) return rlpBytes(input);
  return withPrefix(0xc0, concat(input.map(rlp)));
}

export function signLegacy(
  account: KeeperAccount,
  tx: { nonce: number; gasPrice: bigint; gas: bigint; to: string; data: Hex; chainId?: bigint },
): Hex {
  const chainId = tx.chainId ?? TESTNET_CHAIN_ID;
  if (chainId !== 998n && chainId !== 999n) {
    throw new Error(`refusing chain id ${chainId}; keeper signs 998 or 999 only`);
  }
  const to = hexToBytes(tx.to);
  if (to.length !== 20) throw new Error("settle target is not an address");
  const fields: Rlp[] = [
    bytesFromBigint(BigInt(tx.nonce)),
    bytesFromBigint(tx.gasPrice),
    bytesFromBigint(tx.gas),
    to,
    new Uint8Array(),
    hexToBytes(tx.data),
  ];
  const signing = rlp([...fields, bytesFromBigint(chainId), new Uint8Array(), new Uint8Array()]);
  const sig = secp256k1.sign(keccak_256(signing), account.priv);
  const v = chainId * 2n + 35n + BigInt(sig.recovery);
  const raw = rlp([...fields, bytesFromBigint(v), bytesFromBigint(sig.r), bytesFromBigint(sig.s)]);
  return ("0x" + bytesToHex(raw)) as Hex;
}
