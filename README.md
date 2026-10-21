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

`web/index.html` is the Season 0 proof of concept. It is a single static file: whale equity, positions, and marks come from `api.hyperliquid.xyz` in the browser, and pots, the queue, and points live in `localStorage`.

```bash
cd web && python3 -m http.server 8080
```

Still to wire to the contracts:

- `claimSeason0()` and the player's points balance, instead of the local 10,000-point wallet
- `queueBuy`, `queueSell`, `cancel`, and fill events, instead of the in-browser queue
- NAV, pots, `eRef`, status, and `Settled` / `PositionSampled` from the market, instead of simulated pots
- the registry's curated list, sleep / wake, and the EIP-712 opt-out (the page only toasts today)
- the keeper's testnet addresses once a deploy exists

The page already tells visitors that Season 0 points have no cash value and that a real-money product is not offered to UK or US persons. Geoblocking and terms for a later real-money season are not part of this milestone.

## Keeper

`keeper/` is a dry-runnable loop for HyperEVM testnet. It calls `settle` on a heartbeat of 60 seconds and also when the public info API reports a position-size change. A zero market address is skipped. Chain id other than 998 is refused.

```bash
cd keeper
npm install
npm run typecheck
CONFIG=config/testnet.example.json npm run settle          # prints calls
KEEPER_PRIVATE_KEY=0x... CONFIG=config/testnet.json npm run settle
```

`KEEPER_PRIVATE_KEY` is an environment variable. The example config has no key. Do not commit one.

## Deploy

`contracts/script/DeploySeason0.s.sol` deploys the registry and the market implementation. It reverts unless `block.chainid` is 998, and it reads `DEPLOYER_PRIVATE_KEY` from the environment. It does not list wallets and it is not part of `forge test` or CI.

```bash
cd contracts
export DEPLOYER_PRIVATE_KEY=0x...    # testnet key only
forge script script/DeploySeason0.s.sol --rpc-url hyperevm_testnet --broadcast
```

Listing is a later curator transaction, after the testnet HyperCore accounts exist. `addWallet` checks `coreUserExists`. Mainnet addresses will not list on testnet unless those accounts exist there.

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
8. The testnet checklist (decimals inside a contract call, gas at 35 positions, invalid-index gas burn) still needs a live HyperEVM run. This milestone mocks those reads.
9. Should lose-to-earn points stay an indexer concern, computed from fees and realised losses in the events?
10. Confirm the cold-launch display names are still the owners' own, and whether James Wynn ships as a sleeping coin.
