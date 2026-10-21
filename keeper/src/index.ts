/**
 * whalewallet.fun Season 0 keeper skeleton.
 *
 * Every minute, and sooner when a tracked position's size changes, this
 * process calls WalletMarket.settle on HyperEVM testnet (chain id 998).
 * It does not trade, does not hold user funds, and refuses any other chain.
 *
 *   CONFIG=config/testnet.example.json npm run settle
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

const TESTNET_CHAIN_ID = 998;

type Asset = { memberIndex: number; perp: number; symbol?: string };
type WalletConfig = { ticker: string; market: Address; user?: Address; assets: Asset[] };
type KeeperConfig = {
  chainId: number;
  rpcUrl: string;
  heartbeatSec: number;
  pollSec: number;
  infoApi?: string;
  wallets: WalletConfig[];
};

const configPath =
  process.env.CONFIG ?? fileURLToPath(new URL("../config/testnet.example.json", import.meta.url));
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

function assetsOf(w: WalletConfig) {
  return w.assets.map((a) => ({ memberIndex: a.memberIndex, perp: a.perp }));
}

async function positionFingerprint(user: Address): Promise<string | undefined> {
  if (!config.infoApi) return undefined;
  try {
    const res = await fetch(config.infoApi, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "clearinghouseState", user }),
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as {
      assetPositions?: { position: { coin: string; szi: string } }[];
    };
    return (body.assetPositions ?? [])
      .map((p) => `${p.position.coin}:${p.position.szi}`)
      .sort()
      .join("|");
  } catch {
    return undefined;
  }
}

async function settleOne(w: WalletConfig, reason: string) {
  if (w.market === zeroAddress) {
    console.log(`[skip] ${w.ticker} has no market address yet (${reason})`);
    return;
  }
  const args = [assetsOf(w)] as const;
  if (!walletClient || !account) {
    console.log(`[dry-run] settle ${w.ticker} ${w.market} (${reason})`, JSON.stringify(args[0]));
    lastSent.set(w.market, Date.now());
    return;
  }
  try {
    const hash = await walletClient.writeContract({
      address: w.market,
      abi: settleAbi,
      functionName: "settle",
      args,
    });
    console.log(`[sent] ${w.ticker} ${hash} (${reason})`);
    lastSent.set(w.market, Date.now());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`[revert] ${w.ticker} ${message.split("\n")[0]}`);
  }
}

async function tick() {
  const chainId = await publicClient.getChainId();
  if (chainId !== TESTNET_CHAIN_ID) {
    throw new Error(`refusing chain id ${chainId}; Season 0 keeper is testnet-only`);
  }
  const now = Date.now();
  for (const w of config.wallets) {
    const due = !lastSent.has(w.market) || now - (lastSent.get(w.market) ?? 0) >= config.heartbeatSec * 1000;
    let changed = false;
    if (w.user && w.user !== zeroAddress) {
      const fp = await positionFingerprint(w.user);
      if (fp !== undefined) {
        const prev = lastBook.get(w.user);
        changed = prev !== undefined && prev !== fp;
        lastBook.set(w.user, fp);
      }
    }
    if (changed || due) await settleOne(w, changed ? "position change" : "heartbeat");
  }
}

console.log(
  account
    ? `whalewallet.fun keeper ${account.address} on chain ${config.chainId}`
    : "whalewallet.fun keeper dry-run (set KEEPER_PRIVATE_KEY to broadcast)",
);

await tick();
setInterval(() => {
  tick().catch((err) => console.error(err instanceof Error ? err.message : err));
}, config.pollSec * 1000);
