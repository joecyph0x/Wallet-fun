/**
 * whalewallet.fun Season 0 keeper skeleton.
 *
 * Every minute, and sooner when a tracked position's size changes, this
 * process calls WalletMarket.settle on HyperEVM testnet (chain id 998).
 * It does not trade, does not hold user funds, and refuses any other chain.
 *
 *   npm run settle
 *   CONFIG=../contracts/deployments/998.json npm run settle
 *
 * The signing key is read from KEEPER_PRIVATE_KEY. If that variable is unset
 * the process prints the calls and does not broadcast. Never commit a key.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { settleAbi } from "./abi.js";
import { resetNonce, takeNonce, type NonceCursor } from "./nonce.js";

const TESTNET_CHAIN_ID = 998;

type Asset = { memberIndex: number; perp: number; symbol?: string };
type WalletConfig = {
  ticker: string;
  market: Address;
  user?: Address;
  whale?: Address;
  testnetOnly?: boolean;
  assets?: Asset[];
};
type KeeperConfig = {
  chainId: number;
  rpcUrl: string;
  heartbeatSec: number;
  pollSec: number;
  infoApi?: string;
  wallets: WalletConfig[];
};

const configPath =
  process.env.CONFIG ?? fileURLToPath(new URL("../../contracts/deployments/998.json", import.meta.url));
const config = JSON.parse(readFileSync(configPath, "utf8")) as KeeperConfig;

if (config.chainId !== TESTNET_CHAIN_ID) {
  throw new Error("whalewallet.fun Season 0 keeper runs only on HyperEVM testnet (chain id 998)");
}

const hyperEvmTestnet = defineChain({
  id: TESTNET_CHAIN_ID,
  name: "HyperEVM Testnet",
  nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
  rpcUrls: { default: { http: [config.rpcUrl] } },
});

const publicClient = createPublicClient({ chain: hyperEvmTestnet, transport: http(config.rpcUrl) });
const key = process.env.KEEPER_PRIVATE_KEY;
const account = key ? privateKeyToAccount(key as Hex) : undefined;
const walletClient = account
  ? createWalletClient({ account, chain: hyperEvmTestnet, transport: http(config.rpcUrl) })
  : undefined;

const lastSent = new Map<string, number>();
const lastBook = new Map<string, string>();
let perpByCoin: Map<string, number> | undefined;
/** Pending nonce from the node lags a tx that was just submitted. Increment locally instead. */
const nonceCursor: NonceCursor = {};
let ticking = false;

function isNonceError(message: string): boolean {
  return /nonce/i.test(message);
}

function userOf(w: WalletConfig): Address | undefined {
  return w.whale ?? w.user;
}

async function info<T>(body: unknown): Promise<T | undefined> {
  if (!config.infoApi) return undefined;
  const res = await fetch(config.infoApi, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) return undefined;
  return (await res.json()) as T;
}

async function perps(): Promise<Map<string, number> | undefined> {
  if (perpByCoin) return perpByCoin;
  const meta = await info<{ universe?: { name: string }[] }>({ type: "meta" });
  if (!meta?.universe) return undefined;
  perpByCoin = new Map(meta.universe.map((a, i) => [a.name, i]));
  return perpByCoin;
}

type Book = { assets: { memberIndex: number; perp: number }[]; fp: string };

/** Open validator-perp positions. An empty list is a valid flat book. undefined means the API failed. */
async function discover(user: Address): Promise<Book | undefined> {
  const fixed = config.wallets.find((w) => userOf(w) === user && w.assets && w.assets.length > 0);
  if (fixed?.assets) {
    const assets = fixed.assets.map((a) => ({ memberIndex: a.memberIndex, perp: a.perp }));
    return { assets, fp: assets.map((a) => String(a.perp)).join(",") };
  }
  try {
    const map = await perps();
    const state = await info<{ assetPositions?: { position: { coin: string; szi: string } }[] }>({
      type: "clearinghouseState",
      user,
    });
    if (!map || !state) return undefined;
    const assets = [];
    const fp = [];
    for (const row of state.assetPositions ?? []) {
      const perp = map.get(row.position.coin);
      if (perp === undefined) continue;
      fp.push(`${perp}:${row.position.szi}`);
      if (!row.position.szi || Number(row.position.szi) === 0) continue;
      assets.push({ memberIndex: 0, perp });
    }
    return { assets, fp: fp.sort().join("|") };
  } catch {
    return undefined;
  }
}

async function sendSettle(w: WalletConfig, args: readonly [{ memberIndex: number; perp: number }[]]): Promise<Hex> {
  if (!walletClient || !account) throw new Error("no wallet");
  const pending = nonceCursor.next === undefined
    ? await publicClient.getTransactionCount({ address: account.address, blockTag: "pending" })
    : 0;
  const nonce = takeNonce(nonceCursor, pending);
  try {
    return await walletClient.writeContract({
      address: w.market,
      abi: settleAbi,
      functionName: "settle",
      args,
      nonce,
    });
  } catch (err) {
    // The node rejected the send, so that nonce was not consumed.
    if (nonceCursor.next === nonce + 1) nonceCursor.next = nonce;
    throw err;
  }
}

async function settleOne(w: WalletConfig, reason: string, assets: { memberIndex: number; perp: number }[]) {
  if (w.market === zeroAddress) {
    console.log(`[skip] ${w.ticker} has no market address yet (${reason})`);
    return;
  }
  const args = [assets] as const;
  if (!walletClient || !account) {
    console.log(`[dry-run] settle ${w.ticker} ${w.market} (${reason})`, JSON.stringify(args[0]));
    lastSent.set(w.market, Date.now());
    return;
  }
  const attempt = () => sendSettle(w, args);
  try {
    const hash = await attempt();
    console.log(`[sent] ${w.ticker} ${hash} (${reason}) nonce-cursor=${nonceCursor.next}`);
    lastSent.set(w.market, Date.now());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!isNonceError(message)) {
      console.log(`[revert] ${w.ticker} ${message.split("\n")[0]}`);
      return;
    }
    // The pending count was stale. Read it again and send this settle once more.
    resetNonce(nonceCursor);
    try {
      const hash = await attempt();
      console.log(`[sent] ${w.ticker} ${hash} (${reason}, nonce retry)`);
      lastSent.set(w.market, Date.now());
    } catch (err2) {
      const again = err2 instanceof Error ? err2.message : String(err2);
      console.log(`[revert] ${w.ticker} ${again.split("\n")[0]}`);
    }
  }
}

async function tick() {
  if (ticking) {
    console.log("[skip] previous tick still running");
    return;
  }
  ticking = true;
  try {
    const chainId = await publicClient.getChainId();
    if (chainId !== TESTNET_CHAIN_ID) {
      throw new Error(`refusing chain id ${chainId}; Season 0 keeper is testnet-only`);
    }
    const now = Date.now();
    for (const w of config.wallets) {
      const due = !lastSent.has(w.market) || now - (lastSent.get(w.market) ?? 0) >= config.heartbeatSec * 1000;
      const user = userOf(w);
      let assets: { memberIndex: number; perp: number }[] = [];
      let changed = false;
      if (user && user !== zeroAddress) {
        const book = await discover(user);
        if (!book) {
          console.log(`[skip] ${w.ticker} info API unavailable`);
          continue;
        }
        assets = book.assets;
        const prev = lastBook.get(user);
        changed = prev !== undefined && prev !== book.fp;
        lastBook.set(user, book.fp);
      }
      if (changed || due) await settleOne(w, changed ? "position change" : "heartbeat", assets);
    }
  } finally {
    ticking = false;
  }
}

console.log(
  (account
    ? `whalewallet.fun keeper ${account.address} on chain ${config.chainId}`
    : "whalewallet.fun keeper dry-run (set KEEPER_PRIVATE_KEY to broadcast)") +
    `, ${config.wallets.length} markets from config`,
);

await tick();
setInterval(() => {
  tick().catch((err) => console.error(err instanceof Error ? err.message : err));
}, config.pollSec * 1000);
