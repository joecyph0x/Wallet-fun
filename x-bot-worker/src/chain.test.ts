import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FADE_POT_SELECTOR,
  LISTINGS_SELECTOR,
  MAINNET_INFO,
  MAX_RPC_BATCH,
  TAIL_POT_SELECTOR,
  TESTNET_CHAIN_ID,
  chunk,
  decodeUint256,
  encodeCall,
  mainnetInfoUrl,
  parseChainId,
  parseListing,
  potsFromRaw,
} from "./chain.js";

function word(hex: string): string {
  return hex.replace(/^0x/, "").padStart(64, "0");
}

test("selectors, chain id, and the batch cap", () => {
  assert.equal(TESTNET_CHAIN_ID, 998);
  assert.equal(MAX_RPC_BATCH, 20);
  assert.equal(encodeCall(TAIL_POT_SELECTOR), "0x2b2dc7c8");
  assert.equal(encodeCall(FADE_POT_SELECTOR), "0xe52d1e6d");
  const data = encodeCall(LISTINGS_SELECTOR, "0x020ca66c30bec2c4fe3861a94e4db4a498a35872");
  assert.equal(data.length, 2 + 8 + 64);
  assert.ok(data.startsWith("0x65d96c82"));
  assert.equal(parseChainId("0x3e6"), 998);
  assert.equal(parseChainId("0x3e7"), 999);
  assert.equal(chunk([1, 2, 3, 4, 5], 2).map((part) => part.length).join(","), "2,2,1");
});

test("pot words and listing active flag", () => {
  assert.deepEqual(potsFromRaw(10_000_000_000n, 10_000_000_000n), { tail: 10_000, fade: 10_000 });
  assert.equal(potsFromRaw(0n, 10n), null);
  assert.equal(decodeUint256("0x0a"), 10n);

  const market = "08acea438f93ff816c4aca733f89667752dd9b8c";
  const whale = "020ca66c30bec2c4fe3861a94e4db4a498a35872";
  assert.deepEqual(parseListing("0x" + word(market) + word(whale) + word("1")), { known: true, active: true });
  assert.deepEqual(parseListing("0x" + word(market) + word(whale) + word("0")), { known: true, active: false });
  assert.deepEqual(parseListing("0x" + word("0") + word("0") + word("0")), { known: true, active: false });
  assert.equal(parseListing("0x").known, false);
  assert.equal(parseListing(null).active, true);

  const live =
    "0x00000000000000000000000008acea438f93ff816c4aca733f89667752dd9b8c" +
    "000000000000000000000000020ca66c30bec2c4fe3861a94e4db4a498a35872" +
    "0000000000000000000000000000000000000000000000000000000000000001";
  assert.deepEqual(parseListing(live), { known: true, active: true });
  assert.equal(potsFromRaw(decodeUint256("0x2540be400"), decodeUint256("0x2540be400"))?.tail, 10_000);
});

test("position reads stay on the mainnet info host", () => {
  assert.equal(mainnetInfoUrl(undefined), MAINNET_INFO);
  assert.equal(mainnetInfoUrl(MAINNET_INFO), MAINNET_INFO);
  assert.equal(mainnetInfoUrl("https://api.hyperliquid-testnet.xyz/info"), MAINNET_INFO);
  assert.equal(mainnetInfoUrl("http://api.hyperliquid.xyz/info"), MAINNET_INFO);
  assert.equal(mainnetInfoUrl("not a url"), MAINNET_INFO);
});
