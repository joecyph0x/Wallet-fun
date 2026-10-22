# whalewallet.fun

Every Hyperliquid wallet is a memecoin. TAIL it or FADE it.

The site targets the v3 USDC markets. Addresses are read from `contracts/deployments/testnet-v3.json`, which the page loads as `config/testnet-v3.json`. `network` is the only chain switch: it stays `"testnet"` (HyperEVM 998) until someone sets `"mainnet"` (999). The testnet registry, tUSDC, and twelve markets in that file are the chain 998 deploy. Mainnet registry and markets stay zero until that deploy. The page does not read the v2 registry. No keys belong in that file.

Season 0 on the deployed v2 contracts is still play points. Each curated wallet has two sides that share one pot. On settlement, points move from the losing side to the winning side by the whale's mark-to-market PnL, read on HyperEVM from HyperCore. Players queue buys and sells, and those orders fill at the next settlement price. Each market is seeded with house play points on both sides, so a one-sided crowd still has a counterparty. The house does not trade, claim, or take a fee. Copy the whale is a link to Hyperliquid, not an order from this site.

The owner is UK-based. This milestone has no USDC, no transferable token, and no function that turns points into money. Copy the whale only opens the Hyperliquid trade page. It does not send an order.

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

Settlement is permissionless. It runs when 60 seconds have passed, or sooner when a tracked position's size changes. A mark-only move waits for the heartbeat. Buys and sells then fill at that post-move NAV, so an order queued after the move is already visible does not capture it. Listing mints `houseSeedPerSide` play points (default 10,000) onto TAIL and onto FADE, held by `address(2)`. Those shares are not a player balance: they cannot buy, sell, cancel, or claim, and a settlement only moves value the pot math already moves. The owner can `setHouseSeed` for later listings and `topUpHouse` one side of a live market at its current NAV. A side whose pot has been rounded down to zero is restarted by a top-up; opt-out refuses further top-ups so the exit price stays put. The trading fee still goes to `protocolFees` and has no withdraw path. It is not paid to the house. A side listed with a zero seed still locks 1 point at `address(1)` on its first buy. The card shows the pot-split multiple, `(TAIL + FADE) / this side`.

TAIL green is `#39FF88`. FADE pink is `#FF2E88`.

## Layout

```
contracts/   Foundry: registry, market, precompile reader, tests, testnet deploy script
keeper/         Box keeper. A Node process that calls settle on HyperEVM testnet (chain id 998)
keeper-worker/ Cloudflare Worker cron that does the same settle, built for the free plan
web/           Static Season 0 front-end (live testnet pots, Hyperliquid info API)
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

`web/index.html` keeps the Season 0 look: TAIL `#39FF88`, FADE `#FF2E88`, the wave background, and Copy the whale only on the coin trade screen. Each card and wallet page shows the implied multiple for the current pot split, such as `FADE pays 4.2x`, which is `(TAIL pot + FADE pot) / FADE pot`. Curated whale equity, positions, and marks come from mainnet `api.hyperliquid.xyz`. A row with `testnetOnly: true` is read from the active network's `infoApi` instead. DEMO is the testnet-only whale and is listed only on the testnet side of the v3 config.

v3 pots are read from the public RPC for every visitor. No wallet is required to see them. The wallet is required to approve tUSDC, deposit into the registry, and commit a TAIL or FADE bet. A commit fills at next settle (~10–20 min), with a 10 USDC minimum and one pending order per wallet. Cancel before that settle keeps the 0.5% fee. Buy, sell, and Claim all sample the market when the epoch is due, then apply the caller's fill. If the RPC read fails, or the node reports a chain id other than the config's, the page keeps the in-browser preview and the yellow banner says so. `web/config/testnet-v3.json` is a symlink to `contracts/deployments/testnet-v3.json`. A wallet in the active network that the page does not already know is added to the grid. A zero address is still a placeholder. Mainnet registry, beacon, market implementation, and markets are still zero.

The Balance screen approves USDC and then deposits it. Withdraw uses the registry balance and stays available while buys are paused. On testnet, Get test USDC calls `faucet(amount)` on tUSDC (`0xAbef3ab9E36a5dC9416981cA29410bdFaA636490`), at most 1,000 tUSDC (`1000000000`) per call. `mint(to, amount)` has the same cap. Mainnet has no faucet. A pause disables buys only. After 72 hours the coin screen offers pro-rata redeem at the last NAV. Visitors in GB, the UK, the US, and their territories cannot connect or bet. The check tries `/cdn-cgi/trace`, then `get.geojs.io`, then `api.country.is`. If every lookup fails, connecting and betting stay off. Browsing stays open. Season 0 points accrue on real volume and could count toward a possible future airdrop. Nothing is promised.

```bash
node --test web/v3abi.test.js
cd web && python3 -m http.server 8080
```

Connect uses an injected wallet (`window.ethereum`: MetaMask, Rabby, and the like). If the wallet is not on the configured chain, the page asks it to switch, and adds that chain when the wallet does not know it. Testnet is 998. Mainnet is 999, and only the `network` field selects it. On a filled-in deployment the page reads pots, NAV, withdrawable USDC, TAIL and FADE shares, and the pending commit. Buy calls `buy`, sell calls `sell`, cancel calls `cancel`, and Claim calls `claim`. Each of those can lazy-settle. Deposit calls `deposit` after `approve`. Withdraw calls `withdraw`. Opt-out asks the connected wallet for the EIP-712 `OptOut` signature with domain version `3` and submits it. The signature only works from the whale's own key.

A missing config, or a config that is still placeholders, leaves the browser preview running. A rejected connection stays on the read-only pots. No injected wallet can still see the pots; it just cannot trade. The v2 file `web/deployments.json` is not what this page reads.

### Copy the whale

The coin trade screen has **Copy the whale**. The home cards do not, and neither does the Balance screen. It lists up to three of that wallet's largest positions by notional. The user picks one and a small USD size (25, 50, 100, or their own). The confirm screen shows the coin, the same direction (long or short), that size, the whale's leverage, and the builder fee on file. It says this is not financial advice, that the size can be lost, and that the trade is not a USDC bet placed by this site. A flat book says there is nothing to copy.

The button does not sign a HyperCore action. This page is a static file with no bundler. An order signature is the L1 phantom-agent EIP-712 (an msgpack hash of the action, domain `Exchange`, chain id 1337), not the EVM transaction path in `chain.js`. A mistaken signer can hit mainnet. Season 0 must not submit orders, and the builder address in config is the zero address.

After confirm, the page opens the coin's trade page in a new tab. A `testnetOnly` whale uses `https://app.hyperliquid-testnet.xyz/trade/{coin}`. Every other whale uses `https://app.hyperliquid.xyz/trade/{coin}`, which is where that coin exists. The coin is limited to letters, digits, and `:._-`. A HIP-3 name such as `xyz:NVDA` keeps the colon. The link cannot set size or leverage. The confirm screen is what the user copies onto Hyperliquid's ticket. No builder fee is charged.

Next step, testnet first. The user signs `approveBuilderFee` once, with the main wallet rather than an API agent. The action is `hyperliquidChain: "Testnet"`, `maxFeeRate` from config (`"0.05%"`), the builder address, and a nonce, posted to `https://api.hyperliquid-testnet.xyz/exchange`. Later orders add `builder: {"b": "<address>", "f": 50}`. `f` is tenths of a basis point, so 50 is 5 bps (0.05%), and it must be within the approved max. Hyperliquid caps perp builder fees at 0.1% (f = 100) and requires the builder to hold at least 100 USDC of perps account value. Replace the placeholder address before any of that is wired. Talk to mainnet only after the legal review in Monetisation. The approved max is the info request `{"type":"maxBuilderFee","user":"0x…","builder":"0x…"}`.

## Monetisation

Season 0 earns nothing. Points are play money, the builder address is a placeholder, and this site does not sell a listing or a sponsorship.

1. **Pot fees (main).** `FEE_BPS` is 50, so 0.5% of a filled buy stays in `protocolFees`. There is no withdraw function in Season 0.
2. **Builder-code copy trades.** A user who copies a whale can approve a max builder fee once (`approveBuilderFee`). Orders sent for them can then carry `builder: {b, f}`, with `f` in tenths of a basis point (`f` 50 = 5 bps). Config is the `builder` object in `contracts/deployments/998.json`: placeholder address `0x0000…0000`, `feeBps` 5, `f` 50, `maxFeeRate` `"0.05%"`, `hyperliquidChain` `"Testnet"`. The button above does not attach that fee yet.
3. **Paid or featured listings.** A later season could charge to list or pin a wallet. Season 0 listings are free and curated.
4. **Sponsorships.** A ticker, a card, or the share image could carry a sponsor. None are sold in Season 0.

Real money needs legal advice before any of those lines is switched on. The owner is in the UK. The site blocks connecting and betting in the UK, the US, and their territories. Browsing stays open.

## Keeper

`keeper/` reads every wallet in `contracts/deployments/998.json`, including a testnet-only demo whale. It calls `settle` every 60 seconds, and sooner when the testnet info API shows a position-size change. The asset list is that whale's open validator perps (`meta.universe` index, so testnet ETH is 4). A zero market address is skipped. A flat book is settled with an empty asset list. Chain id other than 998 is refused.

Settles in one tick run one after another, and a new tick waits if the previous one is still going. The keeper keeps a local nonce cursor: it reads the node's pending nonce only when the cursor is empty, then increments locally. The testnet RPC's pending count lags a transaction that was just submitted, and re-reading it made the next `settle` reuse a nonce (`nonce too low`). A nonce error clears the cursor and retries that settle once. Any other reject puts the unused nonce back.

A flat whale is not settled every minute. With `SKIP_IDLE=1` (the default), a market whose whale has no open positions, the same account value as the last settle this process sent, and `openOrders == 0` is settled only every `IDLE_HEARTBEAT_SEC` (default 600) as a heartbeat. A queued order, a changed account value, an unreadable `openOrders`, or the first settle still goes out on the normal 60 second heartbeat. `MIN_GAS_HYPE` (default `0.005`) pauses sends and logs `LOW_GAS` when the keeper's HYPE balance is below that. `npm test` covers the nonce cursor and this idle rule.

```bash
cd keeper
npm install
npm run typecheck
npm run settle                                         # dry-run, prints calls
KEEPER_PRIVATE_KEY=0x... npm run settle                # broadcasts. Never commit the key.
```

## Cloudflare Worker keeper

`keeper-worker/` is the same settle loop as a Cloudflare Worker, so it keeps running without a box. A cron trigger fires every minute (`* * * * *`). Each run checks `eth_chainId` and refuses anything other than 998, including mainnet 999, before it sends. It reads markets from the v2 registry `0x9A00D44E7564004f8557bf7a780793c546ccd4a5`, then `lastSettleTs`, `openOrders`, `lastEquity`, and `lastNtlPos` on each market, plus the testnet info API for positions and account value.

Idle skip matches the box keeper, without Workers KV. A flat whale (no open positions), an account value that still equals on-chain `lastEquity`, and `openOrders == 0` is settled only every `IDLE_HEARTBEAT_SEC` (default 600). State is derived from those chain fields and the info API. Free KV allows 1,000 writes a day, and a write every minute would be 1,440, so this worker does not use KV. `GET /health` does not remember the last cron. Isolates do not share memory, so that field was always empty on a fresh request. Each `/health` reads the chain instead: keeper balance, mined nonce, pending nonce, the newest `Settled` log from this keeper in the last 100,000 blocks, and every market's `lastSettleTs` and `openOrders`. `wrangler tail` is still the cron log.

There is no batch `settle` on `WalletMarket`. A run sends at most `MAX_TX_PER_RUN` (default 2) and rotates. Queued orders are first, then a whale that just opened or closed a position, then the oldest `lastSettleTs`. Queued orders do not bypass the contract's 60 second `TooEarly` check, so a one-minute cron is the same fill granularity the chain already has. Sub-minute fills are not available unless a position size changes, and the cron will catch that on its next minute. JSON-RPC batches are at most 20 calls. The pending nonce is read at the start of every run and then incremented locally for the second transaction. Gas is fixed at 1,000,000. A DEMO settle with an open ETH position uses about 403,000, and a 400,000 cap reverted out of gas. The worker does not call `eth_estimateGas` and does not wait for a receipt. The box keeper in `keeper/` sets the same 1,000,000 gas on `writeContract`. Below `MIN_GAS_HYPE` (default 0.005 HYPE) it logs `LOW_GAS` and sends nothing.

`GET /health` returns JSON from the chain: keeper address, balance, nonce, pending nonce, latest settle transaction by this keeper, each market's `lastSettleTs` and age, and errors. It does not return the key.

The free plan allows 10ms of CPU per invocation (network wait does not count), 50 subrequests, and 100,000 requests a day. This cron is 1,440 requests a day. A quiet run with the current 12 markets is about 20 subrequests and zero transactions. A busy run adds at most 2 `eth_sendRawTransaction` calls, so the cap is 2 transactions per minute. Flat whales settle only every 10 minutes. A first deploy measured about 40–51ms of CPU per run with viem imported for signing and ABI encoding. The cron no longer imports viem. It signs with `@noble/curves` and a fixed `settle` selector, and it keeps the derived account on the isolate. The info payloads are about 1KB each and are still `JSON.parse`d, because a hand parser would risk dropping a position. Expect the cron's CPU to fall by roughly the cost of loading viem, into the low tens of milliseconds or below. Confirm on the Cloudflare dashboard after the next deploy. If it is still over 10ms, the paid plan is what lifts that cap. Setting `MAX_TX_PER_RUN` to `"1"` only removes one signature, which is no longer the bulk of the time.

Do not put `KEEPER_PRIVATE_KEY` in `wrangler.toml` or the repo. The non-secret vars live in `[vars]`: `CHAIN_ID`, `RPC_URL`, `INFO_API`, `REGISTRY`, `MIN_GAS_HYPE`, `IDLE_HEARTBEAT_SEC`, `HEARTBEAT_SEC`, `MAX_TX_PER_RUN`.

```bash
cd keeper-worker
npm install
npm test
npm run typecheck
npx wrangler secret put KEEPER_PRIVATE_KEY   # paste the 0x key when prompted. Never commit it.
npx wrangler deploy                           # needs a Cloudflare login. Not run from CI.
npx wrangler tail                             # LOW_GAS, [sent], [due], [error]
```

Fund the keeper address with a little testnet HYPE before the first cron. `GET /health` on the workers.dev host shows the address and balance.

## v3 USDC markets

v3 is a new set of contracts under `contracts/src/v3/`. Nothing here is deployed. `script/DeployV3.s.sol` reverts unless `ENABLE_V3_DEPLOY=true` and the chain id is 999, and this change does not broadcast it. The live testnet registry `0x9A00D44E7564004f8557bf7a780793c546ccd4a5` is untouched. v2 tests still pass.

There is no cheap fix for the deployed v2 markets. Each one is an EIP-1167 clone of implementation `0x7938EF37Af75b2aF39D5956fbB1561c66746Fe4d`, and that implementation has no way to change its code. A source patch would not change the bytecode the keeper calls. v2 `settle` walks every order ever placed, and the keeper's 1,000,000 gas cap runs out at about 290 lifetime orders. Those markets stay on the points game until users move to v3.

v3 differences that matter:

- USDC. Mainnet Circle USDC is `0xb88339CB7199b77E23DB6E890353E22632Ba630f` (6 decimals). Tests use `MockUSDC`. Deposits and withdrawals are pull balances on the registry. A trade never calls `transfer`, so a blacklisted recipient cannot brick a settle. Fees accrue in `protocolFees` and the fee wallet withdraws them. A house seed is USDC the owner actually deposited. It is not minted.
- Settlement is one storage write per epoch, not a loop over orders. Buys and sells commit into the open epoch and fill at the next epoch's NAV. A buy and a settle in the same transaction cannot fill. Cancel is charged the fee, and it reverts once the epoch is due.
- Minimum order is 10 USDC. Each user has their own pending commit. There is no shared 64-slot queue.
- The keeper calls `settleMany` on the registry. A market whose epoch has not elapsed returns false. One bad book does not revert the batch. The cron is every 10 minutes. Five minutes would put the worst-case day over 0.1 HYPE, so 10 minutes is the cadence. `PROTOCOL` defaults to `v2`, so deploying this worker does not start signing chain 999 or slow the testnet keeper. A v3 worker sets `PROTOCOL=v3`, chain 999, the mainnet RPC and info URLs, and the new registry, and it can drop the every-minute cron.
- The guardian can pause new buys immediately. Sells, claims, cancels, and withdrawals stay open. After 72 hours of pause, `exitAtLastNav` redeems pro-rata without a new oracle read. The pot cap defaults to unlimited (`0`). The guardian can only tighten it. Raising it, and every weight, dex, member, fee, listing, beacon, or implementation change, waits 24 hours.
- Markets share one beacon. The registry is an ERC-1967 proxy. Both upgrades go through that timelock. `WalletMarketV3` runtime is 22,706 bytes, under the 24,576 limit, with about 1,870 bytes to spare. The implementation deploy needs a big block because the code deposit is over 3,000,000 gas.
- Equity is perp account value plus spot USDC (token 0, divided by 100). The caller passes every open perp. The perp index is whatever the info API's `meta.universe` order says, so mainnet ETH is 1 and testnet ETH is 4 without a hardcoded id. Returns use 1e18, so a move smaller than one basis point still pays. A one-sided pot has zero capacity, so the funded side does not pay itself.
- `FeePaid` carries the wallet, side, fee, notional, and how many epochs the position was held. `Exposure` carries the side and the epoch it was opened.

Forge gas on the mock precompiles, which cost about 33k more than the documented precompile formula (`2000 + 65` per input and output byte) for one leg. Treat the forge numbers as the conservative side:

| Call | Gas |
| --- | --- |
| Settle, open position, empty bucket | 414,000 |
| Settle that fills one order, or 64 orders | 490,000 to 507,000 |
| Settle, empty bucket, after 1,280 historical orders | 411,000 |
| Buy that also samples a due market | 512,000 |
| Buy or sell once the epoch is already sampled | 174,000 / 170,000 |
| `settleMany` of 3 markets | 1,246,000 |

At 0.1 gwei and a settle every 10 minutes (144 batches a day), 11 markets that all fill cost about `507,000 * 11 * 144 * 1e-10 = 0.080` HYPE/day. Eleven empty buckets cost about 0.066 HYPE/day. A 5-minute cron would be about 0.16 HYPE/day, which misses the target, so the worker uses 10 minutes. Four markets fit in one small block: the transaction gas limit is `100,000 + n * 650,000`, at most 2,700,000. Eleven markets are three transactions. The keeper pays that. A user's own buy or sell is separate and is well under 0.0001 HYPE.

`test/v3/V3.t.sol` ports the six v2 attacks. Same-transaction fill does not mint. Settle gas after 1,280 orders does not grow. Dust and a crowd of real orders do not block a sell. Pause does not block a sell or a withdrawal. An instant `setWeighted` reverts, and the move still pays. A 256-run fuzz checks `USDC.balanceOf(registry) == liabilities()` after buys, cancels, sells, and price moves, which is the same statement as "sum of claims cannot exceed USDC held."

The site reads those calls from `config/testnet-v3.json`. It stays on testnet until `network` is `mainnet`. The testnet addresses in that file are the chain 998 deploy. It does not read `web/deployments.json` or the v2 registry.

## X bot

`x-bot-worker/` is a second Cloudflare Worker, for @whalewalletbot. A cron fires every five minutes (`*/5 * * * *`). Each run reads the eleven public whales (DEMO is skipped) from the mainnet info API `https://api.hyperliquid.xyz/info` (`clearinghouseState`). That call is read-only. The worker never signs, and it has no Hyperliquid key.

It compares the book with the last snapshot in Workers KV. A new position at or above `NOTIONAL_USD` (default $1,000,000), a close whose realised pnl clears `PNL_USD`, a long/short flip, a size increase above `ADD_PCT` (default 50%), or an unrealised pnl swing of at least `PNL_USD` becomes an event. The first snapshot is a baseline and posts nothing, so a deploy does not announce positions that were already open. `WHALE_NOTIONAL` is optional JSON, for example `{"WYNN":"500000"}`, and overrides the open threshold for that ticker. A bad JSON value is ignored.

KV writes happen only when a book actually changed, or when a post is recorded. Mark-price noise and small uPnL drift do not write, so the swing baseline stays put until it crosses the threshold. An event that was not posted keeps the old snapshot and is tried again on a later run. One document holds every whale, so a busy day is a few hundred writes, under the free-plan 1,000 writes a day. The cron itself is 288 requests a day.

Posts are short and use the ticker only. They never @mention a whale, including when the listing name is an X handle. TAIL/FADE odds come from the v2 testnet pots (registry `0x9A00D44E7564004f8557bf7a780793c546ccd4a5`, chain 998). If that read fails, or the RPC is not chain 998, the odds are left off. A line is not financial advice. "Season 0, points only" is added to about one post in four.

X bills a plain post at $0.015 and any post that contains a URL at $0.20. A bare `whalewallet.fun` is auto-linked, so it counts as a URL. `LINK_MODE` controls that:

- `none` (the default) never includes a URL or a bare domain. Some posts say `link in bio` or `whalewallet dot fun` instead.
- `daily` allows one URL, and only on the optional daily recap.
- `all` puts `https://whalewallet.fun/#/w/TICKER` on event posts. That path is the whale page. `#/w/TICKER` is the route the site actually opens.

`MAX_DAILY_SPEND_USD` (default `0.30`) is checked against the post that would be sent. Fourteen plain posts cost $0.21, under the cap. One URL post costs $0.20, so a second URL post the same day is blocked at the default cap. `MAX_POSTS_PER_DAY` (default 14) and a 20 minute gap (`MIN_GAP_SEC`) also apply. The biggest event wins. Several events for one whale become one post. `DAILY_RECAP` defaults to `false`. When it is `true`, one recap can go out after 22:00 UTC if nothing more important was posted and the budget allows.

`DRY_RUN` defaults to `true`. The worker logs the post, stores it for `/preview`, and counts it against the cap and the spend guard, but it does not call X. Set `DRY_RUN` to `false` only after `/preview` looks right. `GET /preview` returns the last 20 composed posts, today's plain-versus-URL spend, and a snapshot summary. It returns no secrets.

A 429 waits 30 minutes, or the `Retry-After` value when that is shorter, and never more than a day. A 401 or 403 waits six hours. The post is not counted when X rejects it. OAuth 1.0a HMAC-SHA1 is WebCrypto. The four credentials are secrets, never `wrangler.toml` keys:

```bash
cd x-bot-worker
npm install
npm test
npm run typecheck
npx wrangler kv namespace create XBOT          # paste the id into wrangler.toml
npx wrangler secret put X_API_KEY
npx wrangler secret put X_API_SECRET
npx wrangler secret put X_ACCESS_TOKEN
npx wrangler secret put X_ACCESS_SECRET
npx wrangler deploy                            # needs a Cloudflare login. Not run from CI.
npx wrangler tail
```

Leave `DRY_RUN` as `true` for the first deploy. The placeholder KV id in `wrangler.toml` has to be replaced or the deploy will not bind storage. The free plan's 10ms CPU cap is the reason this worker has no viem and no signing: a run is JSON, a couple of `eth_call` batches of at most 20, and one HMAC only when a live post is sent. Subrequests stay well under 50 (eleven info calls, fills only when a position disappeared, two RPC batches, two KV reads).

## Deploy

Testnet only. `DeploySeason0` reverts unless `block.chainid` is 998. It deploys the registry and, with `WRITE_DEPLOYMENT=1`, patches the `registry`, `implementation`, and `deployer` fields in `contracts/deployments/998.json`. It leaves the `wallets` array alone. `REGISTRY=0x...` skips the create. The script is not executed by `forge test` or CI.

The script does not list wallets. Forge simulates it on a local EVM, and that simulator has no HyperCore precompiles, so a `coreUserExists` check inside the script is false for every address (`NoCoreUser`) and `addWallet` is never broadcast. Listing is `contracts/script/list_whales.py`. That sends `addWallet` with `cast` on chain 998, one transaction at a time, waiting for the receipt. On chain the precompile returns the real bool.

HyperEVM small blocks are 3,000,000 gas. The latest testnet block's gas limit was `0x2dc6c0`, which is that cap. The registry constructor also creates the market implementation. That runtime is 17,409 bytes, so its code deposit alone is 200 × 17,409 = 3,481,800 gas, which `test_registryCreationNeedsABigBlock` locks. The deploy transaction has to land in a big block (30,000,000 gas). Foundry also applies that 3,000,000 cap during simulation, so the script command needs `--disable-block-gas-limit` or the constructor runs out of gas before anything is broadcast. The init code is about 25KB, under the 49,152-byte init-code limit, and the market runtime is under the 24,576-byte contract limit. Each listing is about 470k gas and fits in a small block.

Season 0 v2 (house-seeded pots) is deployed on HyperEVM testnet. Registry `0x9A00D44E7564004f8557bf7a780793c546ccd4a5`, implementation `0x7938EF37Af75b2aF39D5956fbB1561c66746Fe4d`, deployer `0xFfFC0719380a4d500C3373A26BE1f273bD7C1468`. Explorer: <https://testnet.purrsec.com>. The twelve market addresses, including DEMO, are in `contracts/deployments/998.json`. The v1 registry `0xcA309d8D1Ecd81d85D968CF313E01B25b0D09bd9` and its markets are retired. `DeploySeason0` writes `deployedAt` from the script block timestamp.

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

7. List the whales on chain. The script reads `script/whales.json`, including a `testnetOnly` demo whale, and creates a missing row in `deployments/998.json` instead of stopping. A per-whale `weightedPerps` overrides the file default (DEMO is testnet ETH, index 4). `--dry-run` calls `listings(address)` on the current registry and prints the result. It does not trust a market address left in the file, it sends nothing, and it writes nothing. `--write` broadcasts `addWallet` only when that call returns the zero address, then records the market. The key is `ETH_PRIVATE_KEY` in the environment. `DEPLOYER_PRIVATE_KEY` is copied into that variable for the cast process. It is not passed as `--private-key`.

   ```bash
   export ETH_PRIVATE_KEY="$DEPLOYER_PRIVATE_KEY"
   python3 script/list_whales.py --dry-run
   python3 script/list_whales.py --write
   ```

8. Run the keeper with the same key for a few minutes and confirm `Settled` receipts on <https://testnet.purrsec.com>.

The eleven public whales have no open testnet positions, so those settlements move no pot. A demo with real PnL needs one extra listing whose HyperCore address is a testnet account you control, with a small position opened by hand on the testnet app (ETH perp index 4). Do not run a trading bot for that.

## GitHub Pages

`.github/workflows/pages.yml` publishes `web/` only: `index.html`, `chain.js`, `v3abi.js`, and a real copy of `config/testnet-v3.json` (`cp -L`, because the symlink points outside `web/`). It does not publish `web/deployments.json`. It refuses the upload if the staged site contains a private-key marker. The workflow does not turn GitHub Pages on. That switch stays in the repo settings.

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
- Pots start with a house seed on both sides. The proof-of-concept page still draws demo pots in the browser until a wallet is connected. The first buyer of an unseeded side locks 1 point of shares, and that point stays locked through opt-out.
- The daily cap is a signed running sum of applied `r` inside ±50%. A gain later in the day can give back budget that an earlier loss used.
- Completeness is a two-sided band. The design stated the lower bound. The upper bound rejects a book whose notionals overshoot `ntlPos`.
- HLP children are a curator member list. Their addresses are not in the design doc, so they are not hardcoded. There is no challenge window yet.
- HIP-3 dexes default to off. Enabling a dex is an owner call; weighting a perp is a second call. Until a perp is weighted its mark move has zero PnL and it still counts for completeness.
- No listing fee, no performance skim, no fee split, and no lose-to-earn mint. Player points arrive only from the 10,000-point claim. The house seed is a separate mint into the pots, held at `address(2)`, and it is not a claimable balance. Fees sit in `protocolFees`.
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
