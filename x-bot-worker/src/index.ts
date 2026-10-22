/**
 * Cloudflare Worker that drafts posts for @whalewalletbot.
 *
 * Cron every 5 minutes. Reads real mainnet positions from the public info API
 * and TAIL/FADE odds from the Season 0 testnet pots. It never signs.
 *
 * KV is one snapshot document plus one rate document. A snapshot is written
 * only when a book changed. Free KV allows 1,000 writes a day.
 *
 * DRY_RUN defaults to true: the post is logged and counted, and X is not called.
 * LINK_MODE defaults to none because a URL post costs $0.20 and a plain post $0.015.
 */
import { chunk, decodeUint256, encodeCall, FADE_POT_SELECTOR, LISTINGS_SELECTOR, mainnetInfoUrl, MAX_RPC_BATCH, parseChainId, parseListing, potsFromRaw, TAIL_POT_SELECTOR, TESTNET_CHAIN_ID } from "./chain.js";
import { positionsFromClearinghouse, sumClosedPnl, type Pos, type Snap } from "./events.js";
import { authorizationHeader, randomNonce, TWEET_URL } from "./oauth.js";
import { applyBackoff, backoffSeconds, emptyRate, formatMilli, recordPost, usdToMilli, type RateState } from "./rate.js";
import { decideRun } from "./run.js";
import { PLAIN_MILLI, URL_MILLI, type LinkMode } from "./templates.js";
import { mergeBooks, parseDexes, queriesFor, vaultChildren } from "./sources.js";
import { WHALES } from "./whales.js";

export interface Env {
  XBOT: KVNamespace;
  DRY_RUN?: string;
  MAX_POSTS_PER_DAY?: string;
  MIN_GAP_SEC?: string;
  NOTIONAL_USD?: string;
  PNL_USD?: string;
  ADD_PCT?: string;
  DAILY_RECAP?: string;
  MAINNET_INFO?: string;
  RPC_URL?: string;
  CHAIN_ID?: string;
  REGISTRY?: string;
  SITE?: string;
  WHALE_NOTIONAL?: string;
  LINK_MODE?: string;
  MAX_DAILY_SPEND_USD?: string;
  /** HIP-3 dexes read besides the default dex, comma separated. Default "xyz". */
  PERP_DEXES?: string;
  X_API_KEY?: string;
  X_API_SECRET?: string;
  X_ACCESS_TOKEN?: string;
  X_ACCESS_SECRET?: string;
}

type StoredPost = {
  at: number;
  ticker: string;
  text: string;
  dryRun: boolean;
  costMilli: number;
  postType: "plain" | "url";
  recap: boolean;
};

type BotFile = { v: 1; rate: RateState; posts: StoredPost[] };

const SNAP_KEY = "snap";
const BOT_KEY = "bot";
const RPC = "https://rpc.hyperliquid-testnet.xyz/evm";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/preview") return preview(env);
    return new Response("not found", { status: 404 });
  },
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(run(env).catch((err) => console.log(`[error] ${message(err)}`)));
  },
};

async function run(env: Env): Promise<void> {
  if (!env.XBOT) {
    console.log("[error] KV binding XBOT is missing");
    return;
  }
  const now = Date.now();
  const cfg = readConfig(env);
  const [snapFile, botFile] = await Promise.all([env.XBOT.get(SNAP_KEY), env.XBOT.get(BOT_KEY)]);
  const snaps = loadSnaps(snapFile);
  const bot = loadBot(botFile, now);

  const parsed = await loadBooks(cfg.infoUrl, cfg.dexes);

  const realised = await loadRealised(cfg.infoUrl, parsed, snaps, now);
  const { active, odds } = await loadChain(cfg, parsed.map((p) => p.whale));

  const books = parsed
    .filter((p) => active[p.whale.ticker] !== false)
    .map((p) => ({
      ticker: p.whale.ticker,
      positions: p.positions,
      realised: realised[p.whale.ticker] ?? null,
    }));

  const plan = decideRun({
    now,
    snaps,
    books,
    notionalUsd: cfg.notionalUsd,
    pnlUsd: cfg.pnlUsd,
    addPct: cfg.addPct,
    notionalByTicker: cfg.notionalByTicker,
    rate: bot.rate,
    limits: { maxPerDay: cfg.maxPerDay, minGapSec: cfg.minGapSec, maxSpendMilli: cfg.maxSpendMilli },
    linkMode: cfg.linkMode,
    dailyRecap: cfg.dailyRecap,
    odds,
  });

  let snapsOut = plan.snaps;
  let writeSnap = plan.writeSnap;
  let rate = bot.rate;
  let posts = bot.posts;
  let writeBot = false;

  if (plan.post) {
    const sent = await publish(env, cfg.dryRun, plan.post.text);
    if (sent.ok) {
      snapsOut = plan.post.snap ? { ...snapsOut, [plan.post.ticker]: plan.post.snap } : snapsOut;
      writeSnap = writeSnap || !!plan.post.snap;
      rate = recordPost(rate, now, plan.post.costMilli, plan.post.recap);
      posts = [...posts, {
        at: now,
        ticker: plan.post.ticker,
        text: plan.post.text,
        dryRun: cfg.dryRun,
        costMilli: plan.post.costMilli,
        postType: plan.post.postType,
        recap: plan.post.recap,
      }].slice(-20);
      writeBot = true;
      const tag = cfg.dryRun ? "dry-run" : "posted";
      console.log(`[${tag}] ${plan.post.ticker} ${plan.post.postType} $${formatMilli(plan.post.costMilli)} ${oneLine(plan.post.text)}`);
    } else if (sent.backoffSec > 0) {
      rate = applyBackoff(rate, now, sent.backoffSec);
      writeBot = true;
      console.log(`[backoff] ${sent.status} ${sent.backoffSec}s`);
    } else {
      console.log(`[skip] post failed ${sent.status}`);
    }
  } else if (plan.skip) {
    console.log(`[skip] ${plan.skip}`);
  }

  if (writeSnap) {
    const body = stableSnaps(snapsOut);
    if (body !== stableSnaps(snaps)) await env.XBOT.put(SNAP_KEY, body);
  }
  if (writeBot) {
    const file: BotFile = { v: 1, rate, posts };
    await env.XBOT.put(BOT_KEY, JSON.stringify(file));
  }
  console.log(`[run] whales=${books.length} post=${plan.post?.ticker ?? "-"} dry=${cfg.dryRun} link=${cfg.linkMode}`);
}

async function publish(
  env: Env,
  dryRun: boolean,
  text: string,
): Promise<{ ok: boolean; status: number; backoffSec: number }> {
  if (dryRun) return { ok: true, status: 0, backoffSec: 0 };
  const key = env.X_API_KEY ?? "";
  const secret = env.X_API_SECRET ?? "";
  const token = env.X_ACCESS_TOKEN ?? "";
  const tokenSecret = env.X_ACCESS_SECRET ?? "";
  if (!key || !secret || !token || !tokenSecret) {
    console.log("[skip] missing X credentials");
    return { ok: false, status: 0, backoffSec: 0 };
  }
  const header = await authorizationHeader({
    consumerKey: key,
    consumerSecret: secret,
    token,
    tokenSecret,
    nonce: randomNonce(),
    timestamp: Math.floor(Date.now() / 1000).toString(),
  });
  let res: Response;
  try {
    res = await fetch(TWEET_URL, {
      method: "POST",
      headers: { Authorization: header, "content-type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(12_000),
    });
  } catch (err) {
    console.log(`[x] fetch ${message(err)}`);
    return { ok: false, status: 0, backoffSec: 0 };
  }
  if (res.ok) return { ok: true, status: res.status, backoffSec: 0 };
  const backoffSec = backoffSeconds(res.status, res.headers.get("retry-after"));
  return { ok: false, status: res.status, backoffSec };
}

async function preview(env: Env): Promise<Response> {
  if (!env.XBOT) return json({ ok: false, error: "KV binding XBOT is missing" }, 500);
  const cfg = readConfig(env);
  const now = Date.now();
  const [snapRaw, botRaw] = await Promise.all([env.XBOT.get(SNAP_KEY), env.XBOT.get(BOT_KEY)]);
  const snaps = loadSnaps(snapRaw);
  const bot = loadBot(botRaw, now);
  const day = new Date(now).toISOString().slice(0, 10);
  const spent = bot.rate.day === day ? bot.rate.spentMilli : 0;
  const count = bot.rate.day === day ? bot.rate.count : 0;
  const remaining = Math.max(0, cfg.maxSpendMilli - spent);
  const todayPosts = bot.posts.filter((p) => new Date(p.at).toISOString().slice(0, 10) === day);
  const snapshots = Object.keys(snaps)
    .sort()
    .map((ticker) => {
      const snap = snaps[ticker]!;
      let biggest: { coin: string; notional: number; side: string } | null = null;
      for (const p of snap.positions) {
        if (!biggest || p.notional > biggest.notional) biggest = { coin: p.coin, notional: p.notional, side: p.side };
      }
      return { ticker, positions: snap.positions.length, at: snap.at, biggest };
    });
  return json({
    ok: true,
    dryRun: cfg.dryRun,
    linkMode: cfg.linkMode,
    dailyRecap: cfg.dailyRecap,
    note: "Baseline on the first cron does not post. DRY_RUN logs instead of calling X. A URL post is $0.200. A plain post is $0.015. Posts never @mention a whale.",
    costs: {
      plainUsd: formatMilli(PLAIN_MILLI),
      urlUsd: formatMilli(URL_MILLI),
      maxDailySpendUsd: formatMilli(cfg.maxSpendMilli),
      todaySpentUsd: formatMilli(spent),
      remainingUsd: formatMilli(remaining),
      todayPosts: count,
      todayPlain: todayPosts.filter((p) => p.postType === "plain").length,
      todayUrl: todayPosts.filter((p) => p.postType === "url").length,
      maxPostsPerDay: cfg.maxPerDay,
      minGapSec: cfg.minGapSec,
      backoffUntil: bot.rate.backoffUntil,
    },
    posts: bot.posts.slice(-20).map((p) => ({
      at: p.at,
      ticker: p.ticker,
      text: p.text,
      dryRun: p.dryRun,
      postType: p.postType,
      costUsd: formatMilli(p.costMilli),
      recap: p.recap,
    })),
    snapshots,
  });
}

function readConfig(env: Env) {
  const link = env.LINK_MODE;
  const linkMode: LinkMode = link === "daily" || link === "all" || link === "none" ? link : "none";
  return {
    dryRun: env.DRY_RUN !== "false",
    maxPerDay: positive(env.MAX_POSTS_PER_DAY, 14),
    minGapSec: positive(env.MIN_GAP_SEC, 1200),
    notionalUsd: positive(env.NOTIONAL_USD, 1_000_000),
    pnlUsd: positive(env.PNL_USD, 1_000_000),
    addPct: positive(env.ADD_PCT, 0.5),
    dailyRecap: env.DAILY_RECAP === "true",
    infoUrl: mainnetInfoUrl(env.MAINNET_INFO),
    rpcUrl: env.RPC_URL || RPC,
    chainId: Number(env.CHAIN_ID || "998"),
    linkMode,
    maxSpendMilli: spendMilli(env.MAX_DAILY_SPEND_USD),
    notionalByTicker: notionalOverrides(env.WHALE_NOTIONAL),
    registry: env.REGISTRY || "0x9A00D44E7564004f8557bf7a780793c546ccd4a5",
    dexes: parseDexes(env.PERP_DEXES),
  };
}

function spendMilli(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return usdToMilli(0.3);
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? usdToMilli(n) : usdToMilli(0.3);
}

function positive(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function notionalOverrides(raw: string | undefined): Record<string, number> {
  if (!raw || raw.trim() === "" || raw.trim() === "{}") return {};
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Record<string, number> = {};
    for (const [k, val] of Object.entries(v)) {
      const n = Number(val);
      if (Number.isFinite(n) && n >= 0) out[k.toUpperCase()] = n;
    }
    return out;
  } catch {
    console.log("[config] WHALE_NOTIONAL ignored");
    return {};
  }
}

type Book = { whale: (typeof WHALES)[number]; accounts: string[]; positions: Pos[] | null };

/**
 * One book per whale: the default dex plus each HIP-3 dex in `dexes`.
 * A vault parent is replaced by its child vaults (HIP-3 dexes are skipped for those).
 */
async function loadBooks(infoUrl: string, dexes: readonly string[]): Promise<Book[]> {
  const accounts = await Promise.all(
    WHALES.map(async (w) => {
      if (!w.vault) return [w.whale];
      const kids = vaultChildren(await info(infoUrl, { type: "vaultDetails", vaultAddress: w.whale }));
      return kids.length ? kids : [w.whale];
    }),
  );
  return Promise.all(
    WHALES.map(async (w, i) => {
      const qs = queriesFor(accounts[i]!, w.vault ? [] : dexes);
      const books = await Promise.all(
        qs.map(async (q) =>
          positionsFromClearinghouse(
            await info(infoUrl, q.dex ? { type: "clearinghouseState", user: q.user, dex: q.dex } : { type: "clearinghouseState", user: q.user }),
          ),
        ),
      );
      return { whale: w, accounts: accounts[i]!, positions: mergeBooks(books) };
    }),
  );
}

/** Fill reads for closed coins. Capped so a run stays under the Workers subrequest limit. */
const MAX_FILL_READS = 8;

async function loadRealised(
  infoUrl: string,
  parsed: Book[],
  snaps: Record<string, Snap>,
  now: number,
): Promise<Record<string, Record<string, number>>> {
  const jobs: { ticker: string; users: string[]; since: number; coins: string[] }[] = [];
  for (const row of parsed) {
    if (!row.positions) continue;
    const prev = snaps[row.whale.ticker];
    if (!prev) continue;
    const still = new Set(row.positions.map((p) => p.coin));
    const gone = prev.positions.map((p) => p.coin).filter((c) => !still.has(c));
    if (gone.length) jobs.push({ ticker: row.whale.ticker, users: row.accounts, since: prev.at, coins: gone });
  }
  const out: Record<string, Record<string, number>> = {};
  let budget = MAX_FILL_READS;
  const runnable = jobs.filter((job) => {
    if (job.users.length > budget) return false;
    budget -= job.users.length;
    return true;
  });
  await Promise.all(
    runnable.map(async (job) => {
      const all = await Promise.all(
        job.users.map((user) =>
          info(infoUrl, { type: "userFillsByTime", user, startTime: job.since, endTime: now, aggregateByTime: true }),
        ),
      );
      const bag: Record<string, number> = {};
      for (const coin of job.coins) {
        let sum: number | null = null;
        for (const fills of all) {
          const pnl = sumClosedPnl(fills, coin, job.since);
          if (pnl !== null) sum = (sum ?? 0) + pnl;
        }
        if (sum !== null) bag[coin] = sum;
      }
      out[job.ticker] = bag;
    }),
  );
  return out;
}

type ChainWhale = (typeof WHALES)[number];

async function loadChain(
  cfg: { rpcUrl: string; chainId: number; registry: string },
  whales: readonly ChainWhale[],
): Promise<{ active: Record<string, boolean>; odds: Record<string, { tail: number; fade: number } | null> }> {
  const odds: Record<string, { tail: number; fade: number } | null> = {};
  const active: Record<string, boolean> = {};
  for (const w of whales) odds[w.ticker] = null;
  if (cfg.chainId !== TESTNET_CHAIN_ID) {
    console.log(`[odds] skip chain ${cfg.chainId}`);
    return { active, odds };
  }
  const calls: { method: string; params: unknown[] }[] = [{ method: "eth_chainId", params: [] }];
  for (const w of whales) {
    calls.push({ method: "eth_call", params: [{ to: w.market, data: encodeCall(TAIL_POT_SELECTOR) }, "latest"] });
    calls.push({ method: "eth_call", params: [{ to: w.market, data: encodeCall(FADE_POT_SELECTOR) }, "latest"] });
    calls.push({ method: "eth_call", params: [{ to: cfg.registry, data: encodeCall(LISTINGS_SELECTOR, w.whale) }, "latest"] });
  }
  const results = await rpcBatch(cfg.rpcUrl, calls);
  const chain = parseChainId(results[0]);
  if (chain !== TESTNET_CHAIN_ID) {
    console.log(`[odds] rpc chain ${chain ?? "?"} refused`);
    return { active, odds };
  }
  whales.forEach((w, i) => {
    const base = 1 + i * 3;
    const tail = decodeUint256(results[base]);
    const fade = decodeUint256(results[base + 1]);
    odds[w.ticker] = potsFromRaw(tail, fade);
    const listing = parseListing(results[base + 2]);
    if (listing.known) active[w.ticker] = listing.active;
  });
  return { active, odds };
}

async function rpcBatch(rpc: string, calls: { method: string; params: unknown[] }[]): Promise<(unknown | null)[]> {
  const out: (unknown | null)[] = calls.map(() => null);
  let cursor = 0;
  for (const part of chunk(calls, MAX_RPC_BATCH)) {
    const body = part.map((c, j) => ({ jsonrpc: "2.0", id: j, method: c.method, params: c.params }));
    try {
      const res = await fetch(rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(12_000),
      });
      if (res.ok) {
        const parsed = (await res.json()) as unknown;
        const rows = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" ? [parsed] : [];
        for (const row of rows) {
          if (!row || typeof row !== "object") continue;
          const id = (row as { id?: unknown }).id;
          if (typeof id !== "number" || id < 0 || id >= part.length) continue;
          if ("result" in (row as object)) out[cursor + id] = (row as { result?: unknown }).result ?? null;
        }
      }
    } catch (err) {
      console.log(`[rpc] ${message(err)}`);
    }
    cursor += part.length;
  }
  return out;
}

async function info(url: string, body: unknown): Promise<unknown | null> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.log(`[info] ${message(err)}`);
    return null;
  }
}

function loadSnaps(raw: string | null): Record<string, Snap> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as { whales?: Record<string, unknown> };
    if (!v || typeof v !== "object" || !v.whales) return {};
    const out: Record<string, Snap> = {};
    for (const [k, snap] of Object.entries(v.whales)) {
      if (isSnap(snap)) out[k] = snap;
    }
    return out;
  } catch {
    return {};
  }
}

function isSnap(v: unknown): v is Snap {
  if (!v || typeof v !== "object") return false;
  const s = v as Snap;
  return typeof s.at === "number" && Array.isArray(s.positions);
}

function loadBot(raw: string | null, now: number): BotFile {
  if (!raw) return { v: 1, rate: emptyRate(now), posts: [] };
  try {
    const v = JSON.parse(raw) as Partial<BotFile>;
    const rate = v.rate;
    if (!rate || typeof rate.day !== "string" || typeof rate.count !== "number" || typeof rate.spentMilli !== "number") {
      return { v: 1, rate: emptyRate(now), posts: [] };
    }
    const posts = Array.isArray(v.posts) ? v.posts.filter(isPost).slice(-20) : [];
    return {
      v: 1,
      rate: {
        day: rate.day,
        count: rate.count,
        spentMilli: rate.spentMilli,
        lastPostAt: typeof rate.lastPostAt === "number" ? rate.lastPostAt : 0,
        backoffUntil: typeof rate.backoffUntil === "number" ? rate.backoffUntil : 0,
        recapDay: typeof rate.recapDay === "string" ? rate.recapDay : "",
      },
      posts,
    };
  } catch {
    return { v: 1, rate: emptyRate(now), posts: [] };
  }
}

function isPost(v: unknown): v is StoredPost {
  if (!v || typeof v !== "object") return false;
  const p = v as StoredPost;
  return typeof p.at === "number" && typeof p.text === "string" && typeof p.costMilli === "number";
}

function stableSnaps(snaps: Record<string, Snap>): string {
  const whales: Record<string, Snap> = {};
  for (const k of Object.keys(snaps).sort()) whales[k] = snaps[k]!;
  return JSON.stringify({ v: 1, whales });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : "failed";
}
