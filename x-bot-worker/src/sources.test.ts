import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pos } from "./events.js";
import { positionsFromClearinghouse } from "./events.js";
import { DEFAULT_EXTRA_DEXES, MAX_VAULT_CHILDREN, displayCoin, mergeBooks, parseDexes, queriesFor, vaultChildren } from "./sources.js";
import { safeLabel } from "./templates.js";
import { WHALES } from "./whales.js";

function pos(coin: string, szi: number, notional: number, upnl = 0, entry = 1): Pos {
  return { coin, szi, notional, upnl, entry, side: szi > 0 ? "long" : "short" };
}

test("parseDexes defaults to xyz and cleans input", () => {
  assert.deepEqual(parseDexes(undefined), [...DEFAULT_EXTRA_DEXES]);
  assert.deepEqual(parseDexes(""), []);
  assert.deepEqual(parseDexes(" xyz, FLX ,xyz,bad dex,"), ["xyz", "flx"]);
});

test("vaultChildren reads a parent vault and ignores others", () => {
  const kids = ["0x010461c14e146ac35fe42271bdc1134ee31c703a", "0x31CA8395CF837DE08B24DA3F660E77761DFB974B"];
  assert.deepEqual(vaultChildren({ relationship: { type: "parent", data: { childAddresses: kids } } }), [
    kids[0],
    kids[1]!.toLowerCase(),
  ]);
  assert.deepEqual(vaultChildren({ relationship: { type: "normal" } }), []);
  assert.deepEqual(vaultChildren(null), []);
  assert.deepEqual(vaultChildren({ relationship: { type: "parent", data: { childAddresses: ["nope", 7] } } }), []);
  const many = Array.from({ length: 20 }, (_, i) => `0x${i.toString(16).padStart(40, "0")}`);
  assert.equal(vaultChildren({ relationship: { type: "parent", data: { childAddresses: many } } }).length, MAX_VAULT_CHILDREN);
});

test("queriesFor reads the default dex and each extra dex per account", () => {
  assert.deepEqual(queriesFor(["0xa", "0xb"], ["xyz"]), [
    { user: "0xa", dex: "" },
    { user: "0xa", dex: "xyz" },
    { user: "0xb", dex: "" },
    { user: "0xb", dex: "xyz" },
  ]);
});

test("mergeBooks keeps HIP-3 positions next to default-dex ones", () => {
  // FAUVES on 22 Oct: flat on the default dex, a large xyz book.
  const main = positionsFromClearinghouse({ assetPositions: [] });
  const xyz = positionsFromClearinghouse({
    assetPositions: [
      { position: { coin: "xyz:SILVER", szi: "-297101.66", positionValue: "16216402.8", unrealizedPnl: "703610.9", entryPx: "57" } },
    ],
  });
  const merged = mergeBooks([main, xyz])!;
  assert.equal(merged.length, 1);
  assert.equal(merged[0]!.coin, "xyz:SILVER");
  assert.equal(merged[0]!.side, "short");
  assert.ok(merged[0]!.notional > 16_000_000);
});

test("mergeBooks nets child vaults per coin", () => {
  const a = [pos("BTC", 0.8, 64_000, 100, 80_000), pos("ALT", 2_000_000, 16_000)];
  const b = [pos("BTC", -0.8, 64_000, -90, 80_000), pos("ALT", 669_636, 5_760), pos("CELO", -166_653, 13_391, 686)];
  const merged = mergeBooks([a, b])!;
  const by = Object.fromEntries(merged.map((p) => [p.coin, p]));
  assert.equal(by.BTC, undefined, "offsetting child positions cancel");
  assert.equal(by.ALT!.side, "long");
  assert.equal(by.ALT!.notional, 21_760);
  assert.equal(by.CELO!.side, "short");
  assert.equal(by.CELO!.upnl, 686);
});

test("mergeBooks returns null when any read failed", () => {
  assert.equal(mergeBooks([[pos("ETH", 1, 1)], null]), null);
  assert.equal(mergeBooks([]), null);
  assert.deepEqual(mergeBooks([[], []]), []);
});

test("displayCoin drops the dex prefix for posts only", () => {
  assert.equal(displayCoin("xyz:SILVER"), "SILVER");
  assert.equal(displayCoin("ETH"), "ETH");
  assert.equal(safeLabel(displayCoin("xyz:GOLD")), "GOLD");
});

test("HLP is read as a vault parent, others as plain accounts", () => {
  const vaults = WHALES.filter((w) => w.vault).map((w) => w.ticker);
  assert.deepEqual(vaults, ["HLP"]);
});
