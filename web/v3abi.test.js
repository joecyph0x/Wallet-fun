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

test("epoch due rule matches the 10 minute window", () => {
  assert.equal(V3.isDue(0, 100, 600), true);
  assert.equal(V3.isDue(1000, 1599, 600), false);
  assert.equal(V3.isDue(1000, 1600, 600), true);
});
