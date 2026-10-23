const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const V3 = require("./v3abi.js");

test("selectors and buy encoding", () => {
  assert.equal(V3.SEL.buy, "0x5af5ca3c");
  assert.equal(V3.SEL.sell, "0x24ce8d5b");
  assert.equal(V3.SEL.claim, "0x4852f54b");
  assert.equal(V3.SEL.cancel, "0xea8a1af0");
  assert.equal(V3.SEL.deposit, "0xb6b55f25");
  assert.equal(V3.SEL.approve, "0x095ea7b3");
  assert.equal(V3.SEL.mint, "0x40c10f19");
  assert.equal(V3.SEL.faucet, "0x57915897");
  assert.equal(V3.encodeUint(V3.SEL.faucet, V3.FAUCET_CAP), V3.SEL.faucet + "0".repeat(56) + "3b9aca00");
  assert.equal(V3.SEL.exitAtLastNav, "0x7b7ef60c");

  const buy = V3.encodeBuy(0, 10_000000n, [{ memberIndex: 0, perp: 4 }]);
  assert.equal(buy.slice(0, 10), V3.SEL.buy);
  assert.equal((buy.length - 2) / 2, 4 + 32 * 6);
  assert.equal(buy.slice(10, 74), "0".repeat(64));
  assert.ok(buy.endsWith("0".repeat(63) + "4"));

  const claim = V3.encodeClaim([]);
  assert.equal(claim, V3.SEL.claim + "0".repeat(62) + "20" + "0".repeat(64));
  assert.equal(V3.encodeUint(V3.SEL.deposit, 1n).slice(10), "0".repeat(63) + "1");
});

test("USDC amounts stay on 6 decimals", () => {
  assert.equal(V3.parseUsdc("10"), 10_000000n);
  assert.equal(V3.parseUsdc("10.5"), 10_500000n);
  assert.equal(V3.parseUsdc("0.000001"), 1n);
  assert.equal(V3.parseUsdc("10.1234567"), null);
  assert.equal(V3.parseUsdc("-1"), null);
  assert.equal(V3.parseUsdc(""), null);
  assert.equal(V3.formatUnits(10_500000n), "10.5");
  assert.equal(V3.formatUnits(10_000000n), "10");
  assert.equal(V3.formatUnits(1n), "0.000001");
  assert.equal(V3.faucetRaw("1000000000"), 1000000000n);
  assert.equal(V3.faucetRaw("10000000000"), 1000000000n);
  assert.equal(V3.faucetRaw("0"), 1000000000n);
  assert.equal(V3.faucetRaw("nope"), 1000000000n);
});

test("network switch stays on testnet unless mainnet", () => {
  const file = path.join(__dirname, "config", "testnet-v3.json");
  const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  const testnet = V3.resolve(cfg);
  assert.equal(testnet.network, "testnet");
  assert.equal(testnet.chainId, 998);
  assert.equal(testnet.faucet, true);
  assert.equal(testnet.faucetAmount, "1000000000");
  assert.equal(testnet.registry, "0x896E8B5952f48205F032224311ba55D5C0a42F3F");
  assert.equal(testnet.usdc, "0xAbef3ab9E36a5dC9416981cA29410bdFaA636490");
  assert.equal(testnet.beacon.toLowerCase(), "0xb8e0d34fa581140d9e04a71aa49bfc77790b0765");
  assert.equal(testnet.marketImplementation.toLowerCase(), "0x63325b2c55c542e455e2c7337975426f9ba3441b");
  assert.equal(V3.isSet(testnet.registry), true);
  assert.equal(V3.isSet(testnet.usdc), true);
  assert.ok(testnet.wallets.some((w) => w.ticker === "DEMO" && w.testnetOnly));
  assert.equal(testnet.wallets.length, 12);
  assert.ok(testnet.wallets.every((w) => V3.isSet(w.market)));
  assert.equal(testnet.wallets.find((w) => w.ticker === "MACHI").market, "0xa91f606e330fe6a000bec3dbded51cd8b550f5af");

  const main = V3.resolve(Object.assign({}, cfg, { network: "mainnet" }));
  assert.equal(main.network, "mainnet");
  assert.equal(main.chainId, 999);
  assert.equal(main.faucet, false);
  assert.equal(main.usdc.toLowerCase(), "0xb88339cb7199b77e23db6e890353e22632ba630f");
  assert.equal(V3.isSet(main.registry), false);

  const typo = V3.resolve(Object.assign({}, cfg, { network: "nope" }));
  assert.equal(typo.network, "testnet");
  assert.equal(typo.chainId, 998);
  assert.equal(V3.resolve({ network: "mainnet", networks: { mainnet: { chainId: 998, rpcUrl: "x", infoApi: "y" } } }), null);
});

test("geoblock fails closed on mainnet and stays off on testnet", () => {
  for (const code of ["US", "GB", "UK", "PR", "GU", "VI", "AS", "KY", "GI", "JE", "IM", "GG"]) {
    assert.equal(V3.decideGeo(code).blocked, true, code);
    assert.equal(V3.decideGeo(code).reason, "region");
    assert.equal(V3.gateGeo("mainnet", code).blocked, true, code);
    assert.equal(V3.gateGeo("testnet", code).blocked, false, code);
    assert.equal(V3.gateGeo("testnet", code).reason, "testnet");
  }
  assert.equal(V3.geoActive("mainnet"), true);
  assert.equal(V3.geoActive("testnet"), false);
  assert.equal(V3.geoActive("nope"), false);
  assert.equal(V3.geoActive(undefined), false);
  assert.equal(V3.decideGeo("DE").blocked, false);
  assert.equal(V3.decideGeo("JP").blocked, false);
  assert.equal(V3.gateGeo("mainnet", "DE").blocked, false);
  assert.equal(V3.gateGeo("mainnet", "JP").blocked, false);
  assert.deepEqual(V3.decideGeo(null), { blocked: true, reason: "unknown" });
  assert.deepEqual(V3.decideGeo(""), { blocked: true, reason: "unknown" });
  assert.deepEqual(V3.gateGeo("mainnet", null), { blocked: true, reason: "unknown" });
  assert.deepEqual(V3.gateGeo("mainnet", ""), { blocked: true, reason: "unknown" });
  assert.equal(V3.gateGeo("testnet", null).blocked, false);
  assert.equal(V3.gateGeo("testnet", "").blocked, false);
  assert.equal(V3.gateGeo(undefined, "US").blocked, false);
  assert.ok(V3.TESTNET_GEO_NOTE.includes("UK") && V3.TESTNET_GEO_NOTE.includes("US"));
  assert.equal(V3.parseTrace("fl=1\nloc=GB\nhttp=http/2\n"), "GB");
  assert.equal(V3.parseTrace("colo=IAD\n"), null);
  assert.equal(V3.parseGeoJson({ country: "us" }), "US");
  assert.equal(V3.parseGeoJson({ country_code: "DE" }), "DE");
  assert.equal(V3.parseGeoJson({ country: "XX" }), null);
  assert.equal(V3.feeText(50), "0.5%");
});

test("wallet send does not stick on a hung estimate or a silent busy flag", async () => {
  assert.equal(V3.readyCheck({ busy: true, cfg: true, configured: true, hasEth: true, live: true }).toast, V3.BUSY_TOAST);
  assert.equal(V3.readyCheck({ busy: false, cfg: false }).ok, false);
  assert.match(V3.readyCheck({ busy: false, cfg: true, configured: false, missing: "registry is empty" }).toast, /registry is empty/);
  assert.match(V3.readyCheck({ busy: false, cfg: true, configured: true, hasEth: false }).toast, /injected wallet/);
  assert.match(V3.readyCheck({ busy: false, cfg: true, configured: true, hasEth: true, live: false, chainLabel: "HyperEVM Testnet" }).toast, /HyperEVM Testnet/);
  assert.equal(V3.readyCheck({ busy: false, cfg: true, configured: true, hasEth: true, live: true }).ok, true);

  const current = "0x2222222222222222222222222222222222222222";
  const other = "0x1111111111111111111111111111111111111111";
  assert.equal(V3.pickAccount([other, current], current), current);
  assert.equal(V3.pickAccount([other], current), other);
  assert.equal(V3.pickAccount([], current), null);
  assert.equal(V3.isReject({ code: 4001, message: "no" }), true);

  const hung = await V3.estimateOrSkip(() => new Promise(() => {}), { from: other }, 30);
  assert.equal(hung.skipped, true);
  await assert.rejects(
    V3.estimateOrSkip(() => Promise.reject(Object.assign(new Error("User rejected"), { code: 4001 })), {}, 200),
    (e) => e.rejected === true
  );

  const calls = [];
  const hash = "0x" + "ab".repeat(32);
  const sent = await V3.driveSend({
    tx: { from: other, to: other, data: "0x" },
    estimateMs: 40,
    sendMs: 200,
    receiptMs: 50,
    receiptTries: 2,
    request: (params) => {
      calls.push(params.method);
      if (params.method === "eth_estimateGas") return new Promise(() => {});
      if (params.method === "eth_sendTransaction") return Promise.resolve(hash);
      return Promise.resolve(null);
    },
    receipt: () => Promise.resolve({ status: "0x1" }),
    wait: () => Promise.resolve(),
  });
  assert.equal(sent.hash, hash);
  assert.deepEqual(calls, ["eth_estimateGas", "eth_sendTransaction"]);

  await assert.rejects(
    V3.driveSend({
      tx: { from: other },
      estimateMs: 20,
      sendMs: 40,
      request: (params) => {
        if (params.method === "eth_estimateGas") return Promise.resolve("0x1");
        return new Promise(() => {});
      },
      receipt: () => Promise.resolve(null),
    }),
    /did not respond/
  );

  await assert.rejects(
    V3.driveSend({
      tx: { from: other },
      estimateMs: 20,
      sendMs: 200,
      receiptMs: 20,
      receiptTries: 2,
      request: (params) => params.method === "eth_sendTransaction" ? Promise.resolve(hash) : Promise.resolve("0x1"),
      receipt: () => Promise.resolve(null),
      wait: () => Promise.resolve(),
    }),
    (e) => e.pending === true && e.hash === hash
  );

  const fast = await V3.withTimeout(Promise.resolve("ok"), 50, "slow");
  assert.equal(fast, "ok");
  await assert.rejects(V3.withTimeout(new Promise(() => {}), 30, "slow wallet"), /slow wallet/);
});

test("fill line counts to the epoch end plus the keeper delay", () => {
  const t = V3.fillDeadline(1000, 600, 20);
  assert.deepEqual(t, { deadline: 1620, due: 1600 });
  assert.equal(V3.KEEPER_DELAY_SEC, 20);
  assert.equal(V3.formatFill("order", 1620, 1600), "Orders fill in ~0:20");
  assert.equal(V3.formatFill("pending", 1620, 1500), "Your order fills in ~2:00");
  assert.equal(V3.formatFill("pending", 1620, 1619.2), "Your order fills in ~0:01");
  assert.equal(V3.formatFill("pending", 1620, 1620), "Filling now…");
  assert.equal(V3.formatFill("order", 1620, 1800), "Filling now…");
  assert.equal(V3.fillDeadline(0, 600).deadline, 0);
  assert.equal(V3.formatFill("order", 0, 1800), "Filling now…");
  assert.deepEqual(V3.orderFillDeadline(1000, 600, 37n, 37n), { deadline: 1620, due: 1600 });
  assert.deepEqual(V3.orderFillDeadline(1000, 600, 31n, 37n), { deadline: 0, due: 0 });
  assert.equal(V3.formatFill("pending", 0, 1800), "Filling now…");
});

test("epoch due rule matches the 10 minute window", () => {
  assert.equal(V3.isDue(0, 100, 600), true);
  assert.equal(V3.isDue(1000, 1599, 600), false);
  assert.equal(V3.isDue(1000, 1600, 600), true);
});

function wordOf(n) {
  return "0x" + n.toString(16).padStart(64, "0");
}

test("a failed read keeps the last good balance and a success of zero replaces it", () => {
  const kept = V3.acceptRead({ error: { message: "rate limit" } }, 2000_000000n);
  assert.equal(kept.ok, false);
  assert.equal(kept.stale, true);
  assert.equal(kept.use, 2000_000000n);
  assert.equal(V3.acceptRead({ result: "0x" }, 2000_000000n).use, 2000_000000n);
  assert.equal(V3.acceptRead(undefined, 2000_000000n).use, 2000_000000n);
  assert.equal(V3.acceptRead({ result: "0x" + "0".repeat(63) }, 9n).ok, false);

  const zero = V3.acceptRead({ result: wordOf(0n) }, 2000_000000n);
  assert.equal(zero.ok, true);
  assert.equal(zero.stale, false);
  assert.equal(zero.use, 0n);

  const first = V3.acceptRead({ error: { message: "missing" } }, null);
  assert.equal(first.use, null);
  assert.equal(first.stale, true);
  assert.equal(V3.acceptRead({ result: wordOf(1000_000000n) }, null).use, 1000_000000n);
});

test("pot cache lasts for the epoch and a zero settle does not refetch immediately", () => {
  assert.equal(V3.potFresh({ last: 1000n, fetchedAt: 1000 }, 1500, 600), true);
  assert.equal(V3.potFresh({ last: 1000n, fetchedAt: 1000 }, 1600, 600), false);
  assert.equal(V3.potFresh({ last: 0n, fetchedAt: 1000 }, 1599, 600), true);
  assert.equal(V3.potFresh({ last: 0n, fetchedAt: 1000 }, 1600, 600), false);
  assert.equal(V3.potFresh(null, 1000, 600), false);
  assert.equal(V3.potFresh({}, 1000, 600), false);
});

test("reads retry a 429 in batches of four and do not invent a zero", async () => {
  assert.deepEqual([0, 1, 2, 3].map(V3.retryWaitMs), [200, 600, 1400, 4000]);
  assert.equal(V3.retryWaitMs(9), 4000);
  assert.equal(V3.isRateLimit(429, ""), true);
  assert.equal(V3.isRateLimit(200, "Too Many Requests"), true);

  const waits = [];
  const sizes = [];
  let n = 0;
  const rows = await V3.readCalls({
    calls: [0, 1, 2, 3, 4].map((i) => ({ to: "0x" + String(i), data: "0x" })),
    retries: 3,
    batchSize: 4,
    sleep: (ms) => { waits.push(ms); return Promise.resolve(); },
    send: (payload) => {
      sizes.push(payload.length);
      n += 1;
      if (n === 1) return Promise.resolve({ status: 429, body: { error: { message: "rate limit" } } });
      if (n === 2) return Promise.resolve({ status: 200, body: { error: { message: "overloaded" } } });
      return Promise.resolve({
        status: 200,
        body: payload.map((p) => ({ id: p.id, result: sizes.length === 3 && p.id === 0 ? wordOf(2000_000000n) : wordOf(0n) })),
      });
    },
  });

  assert.deepEqual(sizes, [4, 4, 4, 1]);
  assert.deepEqual(waits, [200, 600]);
  assert.equal(rows.length, 5);
  assert.equal(V3.acceptRead(rows[0], null).use, 2000_000000n);
  assert.equal(V3.acceptRead(rows[1], 7n).use, 0n);
  assert.equal(V3.acceptRead(rows[4], null).use, 0n);
  assert.equal(V3.needsProviderFallback(rows, [0, 1, 2]), false);

  const hung = await V3.readCalls({
    calls: [{ to: "0xabc", data: "0x70a08231" }],
    retries: 1,
    batchSize: 4,
    sleep: () => Promise.resolve(),
    send: () => Promise.reject(new Error("429 Too Many Requests")),
  });
  const failed = V3.acceptRead(hung[0], 2000_000000n);
  assert.equal(failed.ok, false);
  assert.equal(failed.use, 2000_000000n);
  assert.equal(V3.acceptRead(hung[0], null).use, null);
  assert.equal(V3.needsProviderFallback(hung, [0]), true);
});

function logData() {
  const words = Array.prototype.slice.call(arguments);
  return "0x" + words.map((n) => BigInt(n).toString(16).padStart(64, "0")).join("");
}

test("position value uses navOf and log windows stay within 1000 blocks", () => {
  assert.equal(V3.SEL.navOf, "0xcfa7ef16");
  assert.equal(V3.positionValue(50_000000n, 2_000000n), 100_000000n);
  assert.equal(V3.positionValue(0n, 2_000000n), 0n);
  assert.equal(V3.positionValue(null, 1n), null);
  const ranges = V3.logRanges(10, 2500, 5000);
  assert.deepEqual(ranges, [[10, 1009], [1010, 2009], [2010, 2500]]);
  ranges.forEach((pair) => assert.ok(pair[1] - pair[0] + 1 <= 1000));
  assert.deepEqual(V3.logRanges(5, 4, 1000), []);
});

test("cost basis follows buy and sell fills and ignores a partial history", () => {
  const market = "0xAaBbCcDdEeFf00112233445566778899aAbBcCdD";
  const buy = V3.foldBasis([
    { topic: V3.TOPICS.feePaid, market: market, block: 2, index: 0, data: logData(1, 1, 0, 100_000000n, 1, 0) },
    { topic: V3.TOPICS.exposure, market: market, block: 2, index: 1, data: logData(1, 50_000000n, 1, 1) },
  ]);
  const lot = buy[market.toLowerCase()].F;
  assert.equal(lot.cost, 100_000000n);
  assert.equal(lot.shares, 50_000000n);
  assert.equal(lot.partial, false);
  assert.equal(V3.positionValue(lot.shares, 2_000000n) - lot.cost, 0n);

  const sold = V3.foldBasis([
    { topic: V3.TOPICS.feePaid, market: market, block: 3, index: 0, data: logData(1, 0, 0, 60_000000n, 2, 1) },
    { topic: V3.TOPICS.exposure, market: market, block: 3, index: 1, data: logData(1, 25_000000n, 2, 1) },
  ], buy);
  const left = sold[market.toLowerCase()].F;
  assert.equal(left.shares, 25_000000n);
  assert.equal(left.cost, 50_000000n);
  assert.equal(left.partial, false);

  const gap = V3.foldBasis([
    { topic: V3.TOPICS.exposure, market: market, block: 4, index: 0, data: logData(0, 10_000000n, 3, 1) },
  ]);
  assert.equal(gap[market.toLowerCase()].T.partial, true);

  const kept = V3.foldBasis([], {
    [market.toLowerCase()]: { T: { cost: "0", shares: "0", partial: false }, F: { cost: "100000000", shares: "50000000", partial: false } },
  });
  assert.equal(kept[market.toLowerCase()].F.cost, 100000000n);
  assert.equal(kept[market.toLowerCase()].F.shares, 50000000n);
  assert.equal(kept[market.toLowerCase()].F.partial, false);
});
