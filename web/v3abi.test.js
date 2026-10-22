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
});

test("network switch stays on testnet unless mainnet", () => {
  const file = path.join(__dirname, "config", "testnet-v3.json");
  const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  const testnet = V3.resolve(cfg);
  assert.equal(testnet.network, "testnet");
  assert.equal(testnet.chainId, 998);
  assert.equal(testnet.faucet, true);
  assert.equal(V3.isSet(testnet.registry), false);
  assert.equal(V3.isSet(testnet.usdc), false);
  assert.equal(testnet.placeholders.registry, "PLACEHOLDER_REGISTRY");
  assert.equal(testnet.placeholders.usdc, "PLACEHOLDER_MOCK_USDC");
  assert.ok(testnet.wallets.some((w) => w.ticker === "DEMO" && w.testnetOnly));
  assert.ok(testnet.wallets.every((w) => !V3.isSet(w.market)));

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

test("geoblock fails closed and covers territories", () => {
  for (const code of ["US", "GB", "UK", "PR", "GU", "VI", "AS", "KY", "GI", "JE", "IM", "GG"]) {
    assert.equal(V3.decideGeo(code).blocked, true, code);
    assert.equal(V3.decideGeo(code).reason, "region");
  }
  assert.equal(V3.decideGeo("DE").blocked, false);
  assert.equal(V3.decideGeo("JP").blocked, false);
  assert.deepEqual(V3.decideGeo(null), { blocked: true, reason: "unknown" });
  assert.deepEqual(V3.decideGeo(""), { blocked: true, reason: "unknown" });
  assert.equal(V3.parseTrace("fl=1\nloc=GB\nhttp=http/2\n"), "GB");
  assert.equal(V3.parseTrace("colo=IAD\n"), null);
  assert.equal(V3.parseGeoJson({ country: "us" }), "US");
  assert.equal(V3.parseGeoJson({ country_code: "DE" }), "DE");
  assert.equal(V3.parseGeoJson({ country: "XX" }), null);
  assert.equal(V3.feeText(50), "0.5%");
});

test("epoch due rule matches the 10 minute window", () => {
  assert.equal(V3.isDue(0, 100, 600), true);
  assert.equal(V3.isDue(1000, 1599, 600), false);
  assert.equal(V3.isDue(1000, 1600, 600), true);
});
