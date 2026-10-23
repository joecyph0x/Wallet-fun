import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { accountFrom, SETTLE_GAS, signLegacy } from "./sign.js";
import {
  V3_TX_GAS_CEILING,
  assetsForWhale,
  chunkBy,
  encodeSettleMany,
  indexByCoin,
  delayUntilAfterEpochMs,
  isDue,
  marketsPerTx,
  settleManyGas,
  shouldRun,
} from "./v3.js";

const settleManyAbi = [
  {
    type: "function",
    name: "settleMany",
    stateMutability: "nonpayable",
    inputs: [
      { name: "markets", type: "address[]" },
      {
        name: "books",
        type: "tuple[][]",
        components: [
          { name: "memberIndex", type: "uint8" },
          { name: "perp", type: "uint32" },
        ],
      },
    ],
    outputs: [{ name: "settled", type: "bool[]" }],
  },
] as const;

test("v2 ignores the slow cron and v3 checks every minute", () => {
  assert.equal(shouldRun(undefined, "* * * * *"), "v2");
  assert.equal(shouldRun("v2", "*/10 * * * *"), "skip");
  assert.equal(shouldRun("v2", "*/5 * * * *"), "skip");
  assert.equal(shouldRun("v3", "*/10 * * * *"), "v3");
  assert.equal(shouldRun("v3", "*/5 * * * *"), "v3");
  assert.equal(shouldRun("v3", "* * * * *"), "v3");
  assert.equal(shouldRun("v3", "0 0 * * *"), "skip");
  assert.throws(() => shouldRun("v4", "* * * * *"), /PROTOCOL/);
});

test("a market is due on the epoch, not because the position changed", () => {
  assert.equal(isDue(0n, 1_700_000_000, 600), true);
  assert.equal(isDue(1_700_000_000n, 1_700_000_599, 600), false);
  assert.equal(isDue(1_700_000_000n, 1_700_000_600, 600), true);
});

test("an early cron waits until the epoch boundary plus 20s", () => {
  const last = 1_700_000_000n;
  const boundary = 1_700_000_600;
  assert.equal(delayUntilAfterEpochMs([last], boundary - 8, 600), 28_000);
  assert.equal(delayUntilAfterEpochMs([last], boundary - 30, 600), 50_000);
  assert.equal(delayUntilAfterEpochMs([last], boundary - 31, 600), 0);
  assert.equal(delayUntilAfterEpochMs([last], boundary - 60, 600), 0);
  assert.equal(delayUntilAfterEpochMs([last], boundary + 5, 600), 0);
  assert.equal(delayUntilAfterEpochMs([0n], boundary - 8, 600), 0);
  assert.equal(delayUntilAfterEpochMs([last - 600n, last], boundary - 8, 600), 28_000);
  assert.equal(delayUntilAfterEpochMs([last, last + 10n], boundary - 8, 600), 38_000);
});

test("ETH perp index comes from meta.universe, 1 on mainnet and 4 on testnet", () => {
  const mainnet = indexByCoin([{ name: "BTC" }, { name: "ETH" }, { name: "HYPE" }]);
  const testnet = indexByCoin(["A", "B", "C", "D", "ETH"].map((name) => ({ name })));
  assert.equal(mainnet.get("ETH"), 1);
  assert.equal(testnet.get("ETH"), 4);
  const book = assetsForWhale(mainnet, [
    { coin: "ETH", szi: "1.5" },
    { coin: "BTC", szi: "0" },
    { coin: "DOGE", szi: "10" },
  ]);
  assert.deepEqual(book.assets, [{ memberIndex: 0, perp: 1 }]);
  assert.deepEqual(book.unknown, ["DOGE"]);
});

test("a settleMany chunk stays inside a small block", () => {
  assert.equal(marketsPerTx(), 4);
  assert.ok(V3_TX_GAS_CEILING < 3_000_000n);
  assert.equal(settleManyGas(4), 2_700_000n);
  assert.equal(chunkBy([1, 2, 3, 4, 5], 4).length, 2);
});

test("settleMany calldata matches viem", () => {
  const markets = [
    "0x08ACeA438F93ff816C4ACA733F89667752DD9B8c",
    "0x0aeFE1f1d097e1D0178510c110cD045ea91f6D62",
  ] as const;
  const books = [[{ memberIndex: 0, perp: 1 }], []] as const;
  const viemData = encodeFunctionData({
    abi: settleManyAbi,
    functionName: "settleMany",
    args: [markets, books],
  });
  assert.equal(encodeSettleMany(markets, books), viemData);
});

test("v3 legacy signature matches viem on chain 999 and refuses any other id", async () => {
  const key = generatePrivateKey();
  const viemAccount = privateKeyToAccount(key);
  const account = accountFrom(key);
  const data = encodeSettleMany(
    ["0x08ACeA438F93ff816C4ACA733F89667752DD9B8c"],
    [[{ memberIndex: 0, perp: 1 }]],
  );
  const raw = signLegacy(account, {
    nonce: 3,
    gasPrice: 100_000_000n,
    gas: SETTLE_GAS,
    to: "0x9A00D44E7564004f8557bf7a780793c546ccd4a5",
    data,
    chainId: 999n,
  });
  const viemRaw = await viemAccount.signTransaction({
    type: "legacy",
    chainId: 999,
    nonce: 3,
    gas: SETTLE_GAS,
    gasPrice: 100_000_000n,
    to: "0x9A00D44E7564004f8557bf7a780793c546ccd4a5",
    data,
  });
  assert.equal(raw, viemRaw);
  assert.throws(() => signLegacy(account, { nonce: 0, gasPrice: 1n, gas: 1n, to: markets0(viemAccount.address), data, chainId: 1n }), /refusing/);
});

function markets0(addr: string): `0x${string}` {
  return addr as `0x${string}`;
}
