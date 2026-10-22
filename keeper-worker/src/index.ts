/**
 * Cloudflare Worker keeper for whalewallet.fun Season 0.
 *
 * Cron every minute. Reads WalletRegistry on HyperEVM testnet (chain id 998),
 * settles markets that are due, and refuses every other chain. The signing key
 * arrives as the KEEPER_PRIVATE_KEY secret. It is never written to wrangler.toml.
 *
 * There is no multicall on WalletMarket.settle. Each run signs at most
 * MAX_TX_PER_RUN transactions (default 2). Queued orders fill on the contract's
 * 60s heartbeat, so a one-minute cron is the same granularity the chain already
 * enforces. Signing uses @noble/curves directly so the isolate does not load viem.
 */
import { SEL, SETTLED_TOPIC, SETTLED_TOPIC_V3 } from "./abi.js";
import {
  accountValue6,
  assertTestnet,
  chunk,
  gasOk,
  minGasWei,
  needsSettle,
  rotateMarkets,
  selectSettles,
  type MarketSnap,
  type SettleReason,
} from "./decide.js";
import { pickLatestLog, settleAgeSec, type LogRow } from "./health.js";
import { accountFrom, encodeSettle, SETTLE_GAS, signLegacy, type Hex, type KeeperAccount } from "./sign.js";
import {
  assertV3Chain,
  assetsForWhale,
  chunkBy,
  encodeSettleMany,
  isDue,
  marketsPerTx,
  settleManyGas,
  shouldRun,
  V3_EPOCH_SEC,
} from "./v3.js";

type Address = Hex;

export interface Env {
  KEEPER_PRIVATE_KEY?: string;
  CHAIN_ID: string;
  RPC_URL: string;
  INFO_API: string;
  REGISTRY: string;
  MIN_GAS_HYPE: string;
  IDLE_HEARTBEAT_SEC: string;
  HEARTBEAT_SEC: string;
  MAX_TX_PER_RUN: string;
  /** "v2" (default) keeps the testnet minute cron. "v3" runs settleMany on the slow cron. */
  PROTOCOL?: string;
  EPOCH_SEC?: string;
}

type RpcCall = { method: string; params: unknown[] };
type RpcRow = { id?: number; result?: unknown; error?: { message?: string } };

type Report = {
  ok: boolean;
  chainId: number | null;
  keeper: string | null;
  lastRun: string | null;
  balanceHype: string | null;
  settled: { market: string; whale: string; hash: string; reason: string }[];
  skippedIdle: number;
  considered: number;
  lowGas: boolean;
  errors: string[];
  note: string;
};

/** Free-plan subrequest cap is 50. Leave room for view batches, info calls, and sends. */
const MAX_MARKETS_PER_RUN = 24;
/**
 * How far back /health looks for this keeper's Settled logs. The testnet RPC rejects
 * eth_getLogs over more than 1,000 blocks ("query exceeds max block range 1000"), so this
 * is about 16 minutes of 1s blocks, enough to see the last 10-minute v3 pass.
 */
const LOG_LOOKBACK = 999n;
const NOTE =
  "Read from chain on each request. Isolates do not share memory. wrangler tail is the cron log. No KV.";

let nonceNext: number | undefined;
let perpByCoin: Map<string, number> | undefined;
let marketCursor = 0;
const recentSend = new Map<string, number>();

function emptyReport(): Report {
  return {
    ok: true,
    chainId: null,
    keeper: null,
    lastRun: null,
    balanceHype: null,
    settled: [],
    skippedIdle: 0,
    considered: 0,
    lowGas: false,
    errors: [],
    note: NOTE,
  };
}

function message(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.split("\n")[0]!.slice(0, 300);
}

function formatHype(wei: bigint): string {
  return (Number(wei / 10n ** 12n) / 1e6).toFixed(6);
}

function word(n: bigint | number): string {
  return BigInt(n).toString(16).padStart(64, "0");
}

function words(hex: string | undefined): string[] {
  const h = String(hex || "0x").replace(/^0x/, "");
  const out: string[] = [];
  for (let i = 0; i < h.length; i += 64) out.push(h.slice(i, i + 64));
  return out;
}

function asAddress(wordHex: string | undefined): Address {
  const h = (wordHex || "").replace(/^0x/, "").padStart(64, "0");
  return `0x${h.slice(24)}` as Address;
}

function u256(hex: unknown): bigint | undefined {
  if (typeof hex !== "string" || !hex || hex === "0x") return undefined;
  try {
    return BigInt(hex);
  } catch {
    return undefined;
  }
}

/** One HTTP request per chunk. The testnet RPC rejects a JSON-RPC batch above 20. */
async function rpcBatch(env: Env, calls: RpcCall[], budget: { n: number }): Promise<RpcRow[]> {
  const out: RpcRow[] = new Array(calls.length);
  let offset = 0;
  for (const slice of chunk(calls)) {
    budget.n += 1;
    if (budget.n > 50) throw new Error("subrequest budget reached");
    const payload = slice.map((call, j) => ({ jsonrpc: "2.0", id: j, method: call.method, params: call.params }));
    const res = await fetch(env.RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = (await res.json()) as RpcRow | RpcRow[];
    const rows = Array.isArray(body) ? body : [body];
    const byId = new Map(rows.map((row) => [row.id, row]));
    slice.forEach((_, j) => {
      out[offset + j] = byId.get(j) ?? { error: { message: "missing rpc row" } };
    });
    offset += slice.length;
  }
  return out;
}

function resultOf(row: RpcRow | undefined, label: string): string {
  if (!row || row.error) throw new Error(row?.error?.message || `${label} failed`);
  if (typeof row.result !== "string") throw new Error(`${label} empty`);
  return row.result;
}

async function info<T>(env: Env, body: unknown, budget: { n: number }): Promise<T | undefined> {
  budget.n += 1;
  if (budget.n > 50) return undefined;
  try {
    const res = await fetch(env.INFO_API, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return undefined;
    return (await res.json()) as T;
  } catch {
    return undefined;
  }
}

async function perps(env: Env, budget: { n: number }): Promise<Map<string, number> | undefined> {
  if (perpByCoin) return perpByCoin;
  const meta = await info<{ universe?: { name: string }[] }>(env, { type: "meta" }, budget);
  if (!meta?.universe) return undefined;
  perpByCoin = new Map(meta.universe.map((asset, i) => [asset.name, i]));
  return perpByCoin;
}

type Book = { assets: { memberIndex: number; perp: number }[]; positionCount: number; accountValue6: bigint | undefined };

async function discover(env: Env, whale: Address, budget: { n: number }): Promise<Book | undefined> {
  const map = await perps(env, budget);
  const state = await info<{
    assetPositions?: { position: { coin: string; szi: string } }[];
    marginSummary?: { accountValue?: string };
  }>(env, { type: "clearinghouseState", user: whale }, budget);
  if (!map || !state) return undefined;
  const assets: { memberIndex: number; perp: number }[] = [];
  let positionCount = 0;
  for (const row of state.assetPositions ?? []) {
    if (!row.position.szi || Number(row.position.szi) === 0) continue;
    positionCount += 1;
    const perp = map.get(row.position.coin);
    if (perp === undefined) continue;
    assets.push({ memberIndex: 0, perp });
  }
  return { assets, positionCount, accountValue6: accountValue6(state.marginSummary?.accountValue) };
}

function takeNonce(pending: number, latest: number): number {
  if (nonceNext !== undefined && nonceNext - latest > 30) nonceNext = undefined;
  if (nonceNext === undefined || pending > nonceNext) nonceNext = pending;
  const nonce = nonceNext;
  nonceNext = nonce + 1;
  return nonce;
}

function rewindNonce(nonce: number) {
  if (nonceNext === nonce + 1) nonceNext = nonce;
}

async function sendSettle(
  env: Env,
  account: KeeperAccount,
  market: Address,
  assets: { memberIndex: number; perp: number }[],
  nonce: number,
  gasPrice: bigint,
  budget: { n: number },
): Promise<Hex> {
  const raw = signLegacy(account, {
    nonce,
    gasPrice,
    gas: SETTLE_GAS,
    to: market,
    data: encodeSettle(assets),
  });
  const rows = await rpcBatch(env, [{ method: "eth_sendRawTransaction", params: [raw] }], budget);
  const hash = resultOf(rows[0], "eth_sendRawTransaction");
  return hash as Hex;
}

async function loadMarkets(env: Env, budget: { n: number }): Promise<{ market: Address; whale: Address }[]> {
  const countRow = await rpcBatch(
    env,
    [{ method: "eth_call", params: [{ to: env.REGISTRY, data: SEL.whaleCount }, "latest"] }],
    budget,
  );
  const count = Number(u256(resultOf(countRow[0], "whaleCount")) ?? 0n);
  if (!Number.isFinite(count) || count < 0 || count > 500) throw new Error("whaleCount unreadable");
  const whaleCalls: RpcCall[] = [];
  for (let i = 0; i < count; i++) {
    whaleCalls.push({
      method: "eth_call",
      params: [{ to: env.REGISTRY, data: SEL.whales + word(i) }, "latest"],
    });
  }
  const whaleRows = whaleCalls.length ? await rpcBatch(env, whaleCalls, budget) : [];
  const whales = whaleRows.map((row, i) => asAddress(words(resultOf(row, `whales(${i})`))[0]));
  const listCalls: RpcCall[] = whales.map((whale) => ({
    method: "eth_call",
    params: [{ to: env.REGISTRY, data: SEL.listings + word(BigInt(whale)) }, "latest"],
  }));
  const listRows = listCalls.length ? await rpcBatch(env, listCalls, budget) : [];
  const markets: { market: Address; whale: Address }[] = [];
  listRows.forEach((row, i) => {
    const w = words(resultOf(row, "listings"));
    const market = asAddress(w[0]);
    const whale = w[1] ? asAddress(w[1]) : whales[i]!;
    const active = (u256(w[2] ? "0x" + w[2] : undefined) ?? 0n) !== 0n;
    if (!active || market === "0x0000000000000000000000000000000000000000") return;
    markets.push({ market, whale });
  });
  return markets;
}

const VIEW_SELS = [SEL.lastSettleTs, SEL.openOrders, SEL.lastEquity, SEL.lastNtlPos] as const;

async function loadViews(
  env: Env,
  markets: { market: Address; whale: Address }[],
  budget: { n: number },
): Promise<Map<string, { lastSettleTs: bigint; openOrders: bigint | undefined; lastEquity: bigint; lastNtlPos: bigint }>> {
  const calls: RpcCall[] = [];
  for (const row of markets) {
    for (const sel of VIEW_SELS) {
      calls.push({ method: "eth_call", params: [{ to: row.market, data: sel }, "latest"] });
    }
  }
  const rows = calls.length ? await rpcBatch(env, calls, budget) : [];
  const out = new Map<string, { lastSettleTs: bigint; openOrders: bigint | undefined; lastEquity: bigint; lastNtlPos: bigint }>();
  markets.forEach((row, i) => {
    const base = i * VIEW_SELS.length;
    const cell = (k: number) => rows[base + k];
    const last = u256(cell(0)?.result);
    const orders = cell(1)?.error ? undefined : u256(cell(1)?.result);
    const equity = u256(cell(2)?.result);
    const ntl = u256(cell(3)?.result);
    if (last === undefined || equity === undefined || ntl === undefined) return;
    out.set(row.market.toLowerCase(), {
      lastSettleTs: last,
      openOrders: orders,
      lastEquity: equity,
      lastNtlPos: ntl,
    });
  });
  return out;
}

export async function run(env: Env): Promise<Report> {
  const report = emptyReport();
  const budget = { n: 0 };
  try {
    assertTestnet(Number(env.CHAIN_ID));
    const account = accountFrom(env.KEEPER_PRIVATE_KEY || "");
    report.keeper = account.address;
    const floor = minGasWei(env.MIN_GAS_HYPE || "0.005");
    const heartbeatSec = Number(env.HEARTBEAT_SEC || "60");
    const idleSec = Number(env.IDLE_HEARTBEAT_SEC || "600");
    const maxTx = Number(env.MAX_TX_PER_RUN || "2");

    const head = await rpcBatch(env, [
      { method: "eth_chainId", params: [] },
      { method: "eth_getBalance", params: [account.address, "latest"] },
      { method: "eth_getTransactionCount", params: [account.address, "pending"] },
      { method: "eth_getTransactionCount", params: [account.address, "latest"] },
      { method: "eth_gasPrice", params: [] },
    ], budget);
    const chainId = Number(resultOf(head[0], "eth_chainId"));
    assertTestnet(chainId);
    report.chainId = chainId;
    const balance = u256(resultOf(head[1], "balance")) ?? 0n;
    report.balanceHype = formatHype(balance);
    const pending = Number(u256(resultOf(head[2], "pending nonce")) ?? 0n);
    const latest = Number(u256(resultOf(head[3], "latest nonce")) ?? 0n);
    const gasPrice = u256(resultOf(head[4], "gasPrice")) ?? 0n;
    console.log(`[run] keeper=${account.address} chain=${chainId} balance=${report.balanceHype} HYPE nonce=${pending} subrequests=${budget.n}`);

    if (!gasOk(balance, floor)) {
      report.lowGas = true;
      report.ok = false;
      console.log(`LOW_GAS balance=${report.balanceHype} HYPE < ${env.MIN_GAS_HYPE || "0.005"}; settling paused until topped up`);
      report.lastRun = new Date().toISOString();
      return report;
    }

    const listed = await loadMarkets(env, budget);
    const windowed = rotateMarkets(listed, marketCursor, MAX_MARKETS_PER_RUN);
    marketCursor = windowed.next;
    const views = await loadViews(env, windowed.rows, budget);
    const nowSec = Math.floor(Date.now() / 1000);
    const nowMs = Date.now();
    const due: {
      market: Address;
      whale: Address;
      lastSettleTs: bigint;
      reason: SettleReason;
      assets: { memberIndex: number; perp: number }[];
    }[] = [];

    for (const row of windowed.rows) {
      const view = views.get(row.market.toLowerCase());
      if (!view) {
        report.errors.push(`${row.market} views unreadable`);
        continue;
      }
      if (nowMs - (recentSend.get(row.market.toLowerCase()) ?? 0) < 90_000) continue;
      const book = await discover(env, row.whale, budget);
      if (!book) console.log(`[skip] ${row.market} info API unavailable`);
      const snap: MarketSnap = {
        market: row.market,
        lastSettleTs: view.lastSettleTs,
        openOrders: view.openOrders,
        lastEquity: view.lastEquity,
        lastNtlPos: view.lastNtlPos,
        infoOk: !!book,
        positionCount: book?.positionCount ?? 0,
        accountValue6: book?.accountValue6,
      };
      const reason = needsSettle(snap, nowSec, heartbeatSec, idleSec);
      report.considered += 1;
      if (!reason) {
        if (book && book.positionCount === 0 && (book.accountValue6 === undefined || book.accountValue6 === view.lastEquity) && view.openOrders === 0n) {
          report.skippedIdle += 1;
        }
        continue;
      }
      if (!book) continue;
      due.push({ market: row.market, whale: row.whale, lastSettleTs: view.lastSettleTs, reason, assets: book.assets });
    }

    const picked = selectSettles(due, maxTx);
    console.log(`[due] considered=${report.considered} idleSkipped=${report.skippedIdle} sending=${picked.length} cap=${maxTx}`);
    for (const row of picked) {
      const nonce = takeNonce(pending, latest);
      try {
        const hash = await sendSettle(env, account, row.market, row.assets, nonce, gasPrice, budget);
        recentSend.set(row.market.toLowerCase(), Date.now());
        report.settled.push({ market: row.market, whale: row.whale, hash, reason: row.reason });
        console.log(`[sent] ${row.market} ${hash} (${row.reason}) nonce=${nonce}`);
      } catch (err) {
        rewindNonce(nonce);
        const line = `${row.market} ${message(err)}`;
        report.errors.push(line);
        console.log(`[revert] ${line}`);
      }
    }
    report.ok = report.errors.length === 0;
  } catch (err) {
    const line = message(err);
    report.ok = false;
    report.errors.push(line);
    console.log(`[error] ${line}`);
  }
  report.lastRun = new Date().toISOString();
  console.log(`[done] settled=${report.settled.length} errors=${report.errors.length} subrequests=${budget.n}`);
  return report;
}

type HealthMarket = {
  market: string;
  whale: string;
  lastSettleTs: number;
  ageSec: number | null;
  openOrders: number | null;
};

type HealthBody = {
  ok: boolean;
  chainId: number | null;
  keeper: string | null;
  balanceHype: string | null;
  nonce: number | null;
  pendingNonce: number | null;
  latestTx: string | null;
  latestTxBlock: number | null;
  markets: HealthMarket[];
  errors: string[];
  note: string;
};

async function latestKeeperTx(
  env: Env,
  keeper: Address,
  markets: { market: Address }[],
  block: bigint,
  budget: { n: number },
): Promise<{ hash: string; block: number } | null> {
  if (!markets.length) return null;
  const from = block > LOG_LOOKBACK ? block - LOG_LOOKBACK : 0n;
  const rows = await rpcBatch(env, [{
    method: "eth_getLogs",
    params: [{
      fromBlock: "0x" + from.toString(16),
      toBlock: "latest",
      address: markets.map((row) => row.market),
      topics: [(env.PROTOCOL || "v2") === "v3" ? SETTLED_TOPIC_V3 : SETTLED_TOPIC, null, "0x" + word(BigInt(keeper))],
    }],
  }], budget);
  if (rows[0]?.error) throw new Error(rows[0].error.message || "eth_getLogs failed");
  if (!Array.isArray(rows[0]?.result)) throw new Error("eth_getLogs failed");
  return pickLatestLog(rows[0].result as LogRow[]);
}

function assertKeeperChain(env: Env, chainId: number): void {
  if ((env.PROTOCOL || "v2") === "v3") assertV3Chain(chainId);
  else assertTestnet(chainId);
}

async function runV3(env: Env): Promise<Report> {
  const report = emptyReport();
  const budget = { n: 0 };
  try {
    assertV3Chain(Number(env.CHAIN_ID));
    const account = accountFrom(env.KEEPER_PRIVATE_KEY || "");
    report.keeper = account.address;
    const floor = minGasWei(env.MIN_GAS_HYPE || "0.005");
    const epochSec = Number(env.EPOCH_SEC || String(V3_EPOCH_SEC));

    const head = await rpcBatch(env, [
      { method: "eth_chainId", params: [] },
      { method: "eth_getBalance", params: [account.address, "latest"] },
      { method: "eth_getTransactionCount", params: [account.address, "pending"] },
      { method: "eth_getTransactionCount", params: [account.address, "latest"] },
      { method: "eth_gasPrice", params: [] },
    ], budget);
    const chainId = Number(resultOf(head[0], "eth_chainId"));
    assertV3Chain(chainId);
    report.chainId = chainId;
    const balance = u256(resultOf(head[1], "balance")) ?? 0n;
    report.balanceHype = formatHype(balance);
    const pending = Number(u256(resultOf(head[2], "pending nonce")) ?? 0n);
    const latest = Number(u256(resultOf(head[3], "latest nonce")) ?? 0n);
    const gasPrice = u256(resultOf(head[4], "gasPrice")) ?? 0n;
    console.log(`[v3] keeper=${account.address} chain=${chainId} balance=${report.balanceHype} HYPE`);

    if (!gasOk(balance, floor)) {
      report.lowGas = true;
      report.ok = false;
      console.log(`LOW_GAS balance=${report.balanceHype} HYPE`);
      report.lastRun = new Date().toISOString();
      return report;
    }

    const listed = await loadMarkets(env, budget);
    const nowSec = Math.floor(Date.now() / 1000);
    const viewCalls: RpcCall[] = [];
    for (const row of listed) {
      viewCalls.push({ method: "eth_call", params: [{ to: row.market, data: SEL.lastSettleTs }, "latest"] });
      viewCalls.push({ method: "eth_call", params: [{ to: row.market, data: SEL.memberCount }, "latest"] });
      viewCalls.push({ method: "eth_call", params: [{ to: row.market, data: SEL.dexCount }, "latest"] });
    }
    const views = viewCalls.length ? await rpcBatch(env, viewCalls, budget) : [];
    const map = await perps(env, budget);
    const ready: { market: Address; whale: Address; assets: { memberIndex: number; perp: number }[] }[] = [];

    for (let i = 0; i < listed.length; i++) {
      const row = listed[i]!;
      report.considered += 1;
      const last = u256(views[i * 3]?.result);
      const members = views[i * 3 + 1]?.error ? undefined : u256(views[i * 3 + 1]?.result);
      const dexes = views[i * 3 + 2]?.error ? undefined : u256(views[i * 3 + 2]?.result);
      if (last === undefined) {
        report.errors.push(`${row.market} lastSettleTs unreadable`);
        continue;
      }
      if (!isDue(last, nowSec, epochSec)) {
        report.skippedIdle += 1;
        continue;
      }
      if (members !== 1n || dexes !== 1n || !map) {
        report.errors.push(`${row.market} book is not a single dex-0 account`);
        continue;
      }
      const state = await info<{ assetPositions?: { position: { coin: string; szi: string } }[] }>(
        env,
        { type: "clearinghouseState", user: row.whale },
        budget,
      );
      if (!state) {
        report.errors.push(`${row.market} info API unavailable`);
        continue;
      }
      const built = assetsForWhale(
        map,
        (state.assetPositions ?? []).map((p) => p.position),
      );
      if (built.unknown.length) {
        report.errors.push(`${row.market} unknown coin ${built.unknown.join(",")}`);
        continue;
      }
      ready.push({ market: row.market, whale: row.whale, assets: built.assets });
    }

    const chunks = chunkBy(ready, marketsPerTx());
    console.log(`[v3 due] markets=${ready.length} txs=${chunks.length}`);
    for (const chunk of chunks) {
      const nonce = takeNonce(pending, latest);
      try {
        const data = encodeSettleMany(
          chunk.map((row) => row.market),
          chunk.map((row) => row.assets),
        );
        const raw = signLegacy(account, {
          nonce,
          gasPrice,
          gas: settleManyGas(chunk.length),
          to: env.REGISTRY,
          data,
          chainId: BigInt(chainId),
        });
        const rows = await rpcBatch(env, [{ method: "eth_sendRawTransaction", params: [raw] }], budget);
        const hash = resultOf(rows[0], "eth_sendRawTransaction");
        for (const row of chunk) {
          report.settled.push({ market: row.market, whale: row.whale, hash, reason: "epoch" });
        }
        console.log(`[v3 sent] ${chunk.length} markets ${hash} nonce=${nonce}`);
      } catch (err) {
        rewindNonce(nonce);
        const line = message(err);
        report.errors.push(line);
        console.log(`[v3 revert] ${line}`);
      }
    }
    report.ok = report.errors.length === 0;
  } catch (err) {
    const line = message(err);
    report.ok = false;
    report.errors.push(line);
    console.log(`[v3 error] ${line}`);
  }
  report.lastRun = new Date().toISOString();
  return report;
}

async function health(env: Env): Promise<HealthBody> {
  const body: HealthBody = {
    ok: true,
    chainId: null,
    keeper: null,
    balanceHype: null,
    nonce: null,
    pendingNonce: null,
    latestTx: null,
    latestTxBlock: null,
    markets: [],
    errors: [],
    note: NOTE,
  };
  const budget = { n: 0 };
  try {
    assertKeeperChain(env, Number(env.CHAIN_ID));
    if (!env.KEEPER_PRIVATE_KEY) throw new Error("KEEPER_PRIVATE_KEY is not set");
    const account = accountFrom(env.KEEPER_PRIVATE_KEY);
    body.keeper = account.address;
    const head = await rpcBatch(env, [
      { method: "eth_chainId", params: [] },
      { method: "eth_getBalance", params: [account.address, "latest"] },
      { method: "eth_getTransactionCount", params: [account.address, "latest"] },
      { method: "eth_getTransactionCount", params: [account.address, "pending"] },
      { method: "eth_blockNumber", params: [] },
    ], budget);
    const chainId = Number(resultOf(head[0], "eth_chainId"));
    assertKeeperChain(env, chainId);
    body.chainId = chainId;
    body.balanceHype = formatHype(u256(resultOf(head[1], "balance")) ?? 0n);
    body.nonce = Number(u256(resultOf(head[2], "nonce")) ?? 0n);
    body.pendingNonce = Number(u256(resultOf(head[3], "pending nonce")) ?? 0n);
    const block = u256(resultOf(head[4], "block")) ?? 0n;
    const listed = await loadMarkets(env, budget);
    const sels = [SEL.lastSettleTs, SEL.openOrders];
    const calls: RpcCall[] = [];
    for (const row of listed) {
      for (const sel of sels) calls.push({ method: "eth_call", params: [{ to: row.market, data: sel }, "latest"] });
    }
    const views = calls.length ? await rpcBatch(env, calls, budget) : [];
    const nowSec = Math.floor(Date.now() / 1000);
    body.markets = listed.map((row, i) => {
      const last = Number(u256(views[i * 2]?.result) ?? 0n);
      const ordersRow = views[i * 2 + 1];
      const orders = ordersRow?.error || ordersRow?.result == null ? null : Number(u256(ordersRow.result) ?? 0n);
      return {
        market: row.market,
        whale: row.whale,
        lastSettleTs: last,
        ageSec: settleAgeSec(last, nowSec),
        openOrders: orders,
      };
    });
    try {
      const latest = await latestKeeperTx(env, account.address, listed, block, budget);
      body.latestTx = latest?.hash ?? null;
      body.latestTxBlock = latest?.block ?? null;
    } catch (err) {
      body.errors.push(message(err));
    }
    body.ok = body.errors.length === 0;
  } catch (err) {
    body.ok = false;
    body.errors.push(message(err));
  }
  return body;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/health") return json(await health(env));
    return new Response("not found", { status: 404 });
  },
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const which = shouldRun(env.PROTOCOL, event.cron);
    if (which === "skip") return;
    const job = which === "v3" ? runV3(env) : run(env);
    ctx.waitUntil(job.catch((err) => console.log(`[error] ${message(err)}`)));
  },
};
