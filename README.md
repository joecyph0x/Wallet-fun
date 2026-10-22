# whalewallet.fun

Every Hyperliquid wallet is a memecoin. TAIL it or FADE it.

Season 0 is play points only. Each curated wallet has two sides that share one pot. On settlement, points move from the losing side to the winning side by the whale's mark-to-market PnL, read on HyperEVM from HyperCore. Players queue buys and sells, and those orders fill at the next settlement price. There is no house bankroll, no market making, and no copy-trading.

The owner is UK-based. This milestone has no USDC, no transferable token, and no function that turns points into money.

## Mechanic

For each tracked perp, using raw precompile integers:

```
pricePnl = Σ szi_prev × (mark_now − mark_prev)
```

`szi` is size × 10^szDecimals and `markPx` is price × 10^(6 − szDecimals), so the product is already 6-decimal USD. Deposits, withdrawals, funding, and fees do not enter the number.

```
r        = clamp(pricePnl / eRef, −25%, +25%)   and inside a signed ±50% UTC-day budget
capacity = min(TAIL pot, FADE pot, 25% × eRef)
delta    = r × capacity
TAIL pot += delta
FADE pot −= delta
```

`eRef` is account value summed across the listing's members and enabled perp dexes, snapshotted at listing and again on the first settlement of each UTC day. The sample that crosses midnight still uses the previous `eRef`. A wallet whose reference equity is zero starts being measured the same day it shows equity. A positive reference is not rewritten mid-day, so a withdrawal cannot inflate `r`.

A keeper-supplied asset list is complete only when the sum of `|szi × mark|` sits within ±1% of `ntlPos` (owner-tunable from 0.10% to 5%). Missing or extra notionals revert, and anyone can resubmit the full list. Assets on an enabled dex with PnL weight off still count toward that check and toward the `weightedNtl` field on `Settled`.

HIP-3 markets use perp index `dex × 10000 + metaIndex` (`position2` / `markPx`). Dex 0 is on at listing. Other dexes, including trade.xyz, stay off until the curator enables them. Validator perp 1 is ETH on mainnet; xyz:NVDA is index 10002 (`dex 1`, meta `2`).

Settlement is permissionless. It runs when 60 seconds have passed, or sooner when a tracked position's size changes. A mark-only move waits for the heartbeat. Buys and sells then fill at that post-move NAV, so an order queued after the move is already visible does not capture it. The first buy of a side locks 1 point of shares at `address(1)` so an empty side cannot be inflated. The 0.5% fee is accounted as `protocolFees` and has no withdraw path.

TAIL green is `#39FF88`. FADE pink is `#FF2E88`.

## Layout

```
contracts/   Foundry: registry, market, precompile reader, tests, testnet deploy script
keeper/      TypeScript skeleton that calls settle on HyperEVM testnet (chain id 998)
web/         Static Season 0 front-end PoC (local points, live Hyperliquid info API)
```

`WalletRegistry` is the curator, the points faucet, and the opt-out registry. `WalletMarket` is cloned per wallet and holds the pots, the queue, and `settle`. `HyperCoreReader` matches the [hyper-evm-lib](https://github.com/hyperliquid-dev/hyper-evm-lib) encodings for `position2` (`0x0813`), `markPx` (`0x0806`), `accountMarginSummary` (`0x080F`), `coreUserExists` (`0x0810`), and `l1BlockNumber` (`0x0809`). Tests etch a mock at those addresses, so `forge test` does not need a fork.

Points enter through one `claimSeason0()` of 10,000 points per address. That is the only mint. 1 point = 1e6 base units, the same scale as precompile USD, which is how the 25% equity cap compares pots to a whale's account. It is not a redemption rate.

Opt-out is EIP-712 from the HyperCore wallet. The typed data is `OptOut(address wallet)` with domain name `whalewallet.fun`, version `1`, and the registry as `verifyingContract`. Queued buys refund immediately, the next settlement is the last PnL sample, and then the market only fills sells at the frozen NAV. The address cannot be listed again.

A listing can name up to eight members (the wallet plus subaccounts or HLP children). Season 0 has no challenge window on member changes; the curator is trusted for that.

`Settled`, `PositionSampled`, `WhaleAwake`, `WhaleAsleep`, `OrderFilled`, and `OptedOut` are the indexer and X-bot feed.

## Run the tests

[Foundry](https://book.getfoundry.sh/getting-started/installation) is required. `forge-std` is vendored under `contracts/lib`.

```bash
make test
# or
cd contracts && forge test -vv
```

CI runs that same command. It does not run the deploy script and it does not talk to HyperEVM.

## Front-end

`web/index.html` keeps the Season 0 look. Whale equity, positions, and marks still come from mainnet `api.hyperliquid.xyz`. The eleven listed whales are flat on HyperEVM testnet, so a settlement there has PnL 0 while the cards still show mainnet positions. A testnet bar under the proof-of-concept banner says that on every page.

Pots and points stay in `localStorage` until a wallet is connected on chain 998. `web/deployments.json` is a symlink to `contracts/deployments/998.json`, which holds the deployed registry and all 11 market addresses. A missing wallet still leaves the simulated demo running. The public page does not send transactions by itself.

```bash
cd web && python3 -m http.server 8080
```

Connect uses an injected wallet (`window.ethereum`: MetaMask, Rabby, and the like). If the wallet is not on chain 998, the page asks it to switch, and adds HyperEVM testnet when the wallet does not know the chain. On testnet the page reads pots, NAV, your points, your TAIL and FADE shares, and the last settlement from the contracts. Buy calls `queueBuy`, sell calls `queueSell`, cancel calls `cancel`, and Claim calls `claimSeason0`. Sell is how points come back to your balance at the next settlement. There is no cash withdraw. Opt-out asks the connected wallet for the EIP-712 `OptOut` signature and submits it. The signature only works from the whale's own key.

A missing file, a rejected connection, or no injected wallet leaves the simulated demo running.

## Keeper

`keeper/` reads `contracts/deployments/998.json`. It calls `settle` every 60 seconds, and sooner when the testnet info API shows a position-size change. The asset list is the whale's open validator perps (`meta.universe` index, so testnet ETH is 4). A zero market address is skipped. A flat book is settled with an empty asset list. Chain id other than 998 is refused.

Settles in one tick run one after another, and a new tick waits if the previous one is still going. The keeper keeps a local nonce cursor: it reads the node's pending nonce only when the cursor is empty, then increments locally. The testnet RPC's pending count lags a transaction that was just submitted, and re-reading it made the next `settle` reuse a nonce (`nonce too low`). A nonce error clears the cursor and retries that settle once. Any other reject puts the unused nonce back. `npm test` covers the cursor.

```bash
cd keeper
npm install
npm run typecheck
npm run settle                                         # dry-run, prints calls
KEEPER_PRIVATE_KEY=0x... npm run settle                # broadcasts. Never commit the key.
```

## Deploy

Testnet only. `DeploySeason0` reverts unless `block.chainid` is 998. It deploys the registry and, with `WRITE_DEPLOYMENT=1`, patches the `registry`, `implementation`, and `deployer` fields in `contracts/deployments/998.json`. It leaves the `wallets` array alone. `REGISTRY=0x...` skips the create. The script is not executed by `forge test` or CI.

The script does not list wallets. Forge simulates it on a local EVM, and that simulator has no HyperCore precompiles, so a `coreUserExists` check inside the script is false for every address (`NoCoreUser`) and `addWallet` is never broadcast. Listing is `contracts/script/list_whales.py`. That sends `addWallet` with `cast` on chain 998, one transaction at a time, waiting for the receipt. On chain the precompile returns the real bool.

HyperEVM small blocks are 3,000,000 gas. The latest testnet block's gas limit was `0x2dc6c0`, which is that cap. The registry constructor also creates the market implementation. That runtime is 17,409 bytes, so its code deposit alone is 200 × 17,409 = 3,481,800 gas, which `test_registryCreationNeedsABigBlock` locks. The deploy transaction has to land in a big block (30,000,000 gas). Foundry also applies that 3,000,000 cap during simulation, so the script command needs `--disable-block-gas-limit` or the constructor runs out of gas before anything is broadcast. The init code is about 25KB, under the 49,152-byte init-code limit, and the market runtime is under the 24,576-byte contract limit. Each listing is about 470k gas and fits in a small block.

Season 0 is deployed on HyperEVM testnet. Registry `0xcA309d8D1Ecd81d85D968CF313E01B25b0D09bd9`, implementation `0xa1e336F6616C8c753774e40C1aC3e3851761A4E9`, deployer `0xFfFC0719380a4d500C3373A26BE1f273bD7C1468`. Explorer: <https://testnet.purrsec.com>. The eleven market addresses are in `contracts/deployments/998.json`.

1. Create a throwaway key. Do not commit it and do not print it.

   ```bash
   mkdir -p /tmp/ww-secret && chmod 700 /tmp/ww-secret
   cast wallet new --json > /tmp/ww-secret/key.json
   chmod 600 /tmp/ww-secret/key.json
   ```

2. Fund it from the official faucet: <https://app.hyperliquid-testnet.xyz/drip>. The same address must already have deposited on Hyperliquid mainnet. The faucet then credits 1,000 mock USDC on HyperCore. The info call is `{"type":"claimDrip","user":"<address>"}` on `https://api.hyperliquid-testnet.xyz/info`. An address with no mainnet deposit gets `Cannot claim drip because user <address> does not exist on mainnet.` Stop there. Do not use another faucet.

3. Put testnet HYPE on HyperEVM. The drip is mock USDC, not gas. Buy a little testnet HYPE with that USDC on HyperCore, then send the HYPE to `0x2222222222222222222222222222222222222222`. That credits the same address on the EVM (18 decimals). At the current 0.1 gwei base fee, 0.05 HYPE covers the big-block deploy, the eleven listings, and a few keeper cycles.

4. Turn on big blocks for that address. It has to be a Core user first, which the drip does. From the [official Python SDK](https://github.com/hyperliquid-dex/hyperliquid-python-sdk):

   ```python
   from hyperliquid.exchange import Exchange
   from hyperliquid.utils import constants
   from eth_account import Account
   wallet = Account.from_key(os.environ["DEPLOYER_PRIVATE_KEY"])
   print(Exchange(wallet, constants.TESTNET_API_URL).use_big_blocks(True))
   ```

   That submits `{"type":"evmUserModify","usingBigBlocks":true}`. `bigBlockGasPrice` is not implemented on `rpc.hyperliquid-testnet.xyz`; `eth_gasPrice` was `0x5f5e100` (0.1 gwei) when this was checked.

5. Deploy the registry. The flag is required: without `--disable-block-gas-limit` the simulation hits the small-block cap and the script never broadcasts.

   ```bash
   export DEPLOYER_PRIVATE_KEY="$(python3 -c 'import json; d=json.load(open("/tmp/ww-secret/key.json")); row=d["data"][0] if isinstance(d, dict) else d[0]; print(row["private_key"])')"
   cd contracts
   WRITE_DEPLOYMENT=1 forge script script/DeploySeason0.s.sol \
     --rpc-url hyperevm_testnet --broadcast --slow --disable-block-gas-limit
   ```

6. Turn big blocks off before listing and before the keeper. Listings and settles fit in small blocks, and big blocks only arrive about once a minute.

   ```python
   print(Exchange(wallet, constants.TESTNET_API_URL).use_big_blocks(False))
   ```

   That submits `{"type":"evmUserModify","usingBigBlocks":false}`.

7. List the whales on chain. `--dry-run` sends nothing and writes nothing. `--write` broadcasts `addWallet` for any whale that is not listed yet, then records the market addresses.

   ```bash
   python3 script/list_whales.py --dry-run
   python3 script/list_whales.py --write
   ```

8. Run the keeper with the same key for a few minutes and confirm `Settled` receipts on <https://testnet.purrsec.com>.

The eleven public whales have no open testnet positions, so those settlements move no pot. A demo with real PnL needs one extra listing whose HyperCore address is a testnet account you control, with a small position opened by hand on the testnet app (ETH perp index 4). Do not run a trading bot for that.

## GitHub Pages

`.github/workflows/pages.yml` publishes `web/` only: `index.html`, `chain.js`, and a real copy of `deployments.json` (`cp -L`, because the symlink points outside `web/`). It refuses the upload if the staged site contains a private-key marker. The workflow does not turn GitHub Pages on. That switch stays in the repo settings.

Cold-launch set, from the design doc's self-set names. Re-check them live before listing. HLP's child addresses are not hardcoded; add them with `addMember` after reading `vaultDetails`.

| Ticker | Name | Address |
|---|---|---|
| MACHI | Machi Big Brother | `0x020ca66c30bec2c4fe3861a94e4db4a498a35872` |
| HLP | HLP Vault | `0xdfc24b077bc1425ad1dea75bcb6f8158e10df303` |
| BOBBY | BobbyBigSize | `0x7fdafde5cfb5465924316eced2d3715494c517d1` |
| FAUVES | 2 frères 2 fauves | `0x49e96e255ba418d08e66c35b588e2f2f3766e1d0` |
| NMTD | NMTD | `0xf517639a8872e756ac98d3c65507d2ebc25cc032` |
| PURRINA | PURRINA Pro Plan | `0x0871deb34bfd2052b1c10dc4f6c0912a2a47e927` |
| JEFF | we love u jeff | `0x1367df28c0681431b8a8f3d887576a1cad85560e` |
| FUMBLER | perpfumbler | `0x523852be2db1a76a0e088ecbff32e849544054e5` |
| CATHOT | cat hot wallet | `0xcb58b8f5ec6d47985f0728465c25a08ef9ad2c7b` |
| SILK | x.com/SilkBtc | `0x880ac484a1743862989a441d6d867238c7aa311c` |
| WYNN | James Wynn (sleeping at design time) | `0x5078c2fbea2b2ad61bc840bc023e35fce56bedb6` |

## Design choices

- Position-integrated mark PnL, not the change in account value.
- Next-settlement fills. PnL is applied, then the queue, all at one NAV snapshot.
- Caps from the design doc: α = 0.25, ±25% per settlement, signed ±50% per UTC day.
- Curated listings, cold launch, and a wallet-owner opt-out. No open listing.
- Precompile reads are gas-capped so one bad index cannot burn the rest of the transaction.
- Real-money behaviour is absent. There is no USDC token, no CoreWriter, and no fee withdraw.

## Deviations from the design doc

- TAIL and FADE are non-transferable point shares inside the market, not ERC-20s. Season 0 forbids a token.
- Heartbeat is 60 seconds, plus a settle on position-size change.
- Pots start empty. The proof-of-concept page seeds demo pots in the browser; the contracts do not. The first buyer of a side locks 1 point of shares, and that point stays locked through opt-out.
- The daily cap is a signed running sum of applied `r` inside ±50%. A gain later in the day can give back budget that an earlier loss used.
- Completeness is a two-sided band. The design stated the lower bound. The upper bound rejects a book whose notionals overshoot `ntlPos`.
- HLP children are a curator member list. Their addresses are not in the design doc, so they are not hardcoded. There is no challenge window yet.
- HIP-3 dexes default to off. Enabling a dex is an owner call; weighting a perp is a second call. Until a perp is weighted its mark move has zero PnL and it still counts for completeness.
- No listing fee, no performance skim, no fee split, and no lose-to-earn mint. Points arrive only from the 10,000-point claim. Fees sit in `protocolFees`.
- No keeper bounty. `Settled` records the caller so a bounty can be paid later from fees.
- Sleep is automatic when tracked notional is zero. Pause is a separate guardian halt. Cancel still works while paused. Buys wait.
- Opt-out of an already listed wallet reports `OptedOutAddress` on any future `addWallet`, including while the old market still exists.
- The crossing-midnight sample uses yesterday's `eRef` and consumes the new day's cap budget. A zero `eRef` is raised to current equity before that sample if the account is funded.

## Open questions

1. Is the daily cap a signed net ±50%, or a cap on the sum of absolute moves?
2. Is ε = 1% right on testnet for cross, isolated, and multi-asset accounts?
3. What are HLP's current child addresses from `vaultDetails`, and should Season 0 list that family on day one?
4. Is 1 play-point ≡ $1 the right scale for the α comparison, with a 10,000-point claim?
5. Opt-out needs an EOA signature. How should agent or contract HyperCore wallets opt out?
6. Should guardian pause expire on its own so a paused market cannot hold points indefinitely?
7. Should a newly weighted perp wait one sample before its mark move counts as PnL?
8. A flat-book testnet settle reads equity at 6 decimals (BOBBY's $1,000 came back as 1,000,000,000). Gas at 35 positions, and invalid-index gas burn, still need a live book that is not flat. The unit tests mock those reads.
9. Should lose-to-earn points stay an indexer concern, computed from fees and realised losses in the events?
10. Confirm the cold-launch display names are still the owners' own, and whether James Wynn ships as a sleeping coin.
