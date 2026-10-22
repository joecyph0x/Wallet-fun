import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { settleAbi } from "./abi.js";
import { accountFrom, encodeSettle, SETTLE_GAS, signLegacy } from "./sign.js";

const GAS = SETTLE_GAS;
const PRICE = 100_000_000n;
const TO = "0x08ACeA438F93ff816C4ACA733F89667752DD9B8c";

test("settle gas covers a DEMO position that used about 403k", () => {
  assert.equal(SETTLE_GAS, 1_000_000n);
});

test("settle calldata matches viem, including an empty book and an open perp", () => {
  const cases = [
    [] as { memberIndex: number; perp: number }[],
    [{ memberIndex: 0, perp: 4 }],
    [{ memberIndex: 0, perp: 4 }, { memberIndex: 1, perp: 16777216 }],
  ];
  for (const assets of cases) {
    const viemData = encodeFunctionData({ abi: settleAbi, functionName: "settle", args: [assets] });
    assert.equal(encodeSettle(assets), viemData);
  }
});

test("legacy signature matches viem on chain 998", async () => {
  const key = generatePrivateKey();
  const viemAccount = privateKeyToAccount(key);
  const account = accountFrom(key);
  assert.equal(account.address, viemAccount.address);
  assert.equal(accountFrom(key).address, account.address);

  const lists = [[], [{ memberIndex: 0, perp: 4 }]] as const;
  for (const [i, assets] of lists.entries()) {
    const data = encodeSettle(assets);
    const raw = signLegacy(account, { nonce: i, gasPrice: PRICE, gas: GAS, to: TO, data });
    const viemRaw = await viemAccount.signTransaction({
      type: "legacy",
      chainId: 998,
      nonce: i,
      gas: GAS,
      gasPrice: PRICE,
      to: TO,
      data,
    });
    assert.equal(raw, viemRaw);
  }
});

test("omitted chain id stays on 998, and 1 is refused", async () => {
  const key = generatePrivateKey();
  const account = accountFrom(key);
  const data = encodeSettle([]);
  const raw = signLegacy(account, { nonce: 0, gasPrice: PRICE, gas: GAS, to: TO, data });
  const viemAccount = privateKeyToAccount(key);
  const viemRaw = await viemAccount.signTransaction({
    type: "legacy",
    chainId: 998,
    nonce: 0,
    gas: GAS,
    gasPrice: PRICE,
    to: TO,
    data,
  });
  assert.equal(raw, viemRaw);
  assert.throws(
    () => signLegacy(account, { nonce: 0, gasPrice: PRICE, gas: GAS, to: TO, data, chainId: 1n }),
    /refusing/,
  );
});
