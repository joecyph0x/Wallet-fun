// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {Config} from "../../src/v3/Config.sol";
import {CoreReader} from "../../src/v3/CoreReader.sol";
import {MarketBeacon, RegistryProxy} from "../../src/v3/BeaconProxy.sol";
import {MockUSDC} from "../../src/v3/MockUSDC.sol";
import {WalletMarketV3} from "../../src/v3/WalletMarketV3.sol";
import {WalletRegistryV3} from "../../src/v3/WalletRegistryV3.sol";
import {HyperCoreStore, PrecompileMock} from "../mocks/MockHyperCore.sol";

/// @dev Buys and then calls settle in the same transaction. v2 filled at the known mark. v3 must not.
contract AtomicTrader {
    function fund(MockUSDC token, WalletRegistryV3 reg, uint256 amt) external {
        token.approve(address(reg), type(uint256).max);
        reg.deposit(amt);
    }

    function buyNow(WalletMarketV3 m, WalletMarketV3.Side side, uint256 amt, WalletMarketV3.Asset[] calldata a) external {
        m.buy(side, amt, a);
        m.settleIfDue(a);
    }

    function sell(WalletMarketV3 m, WalletMarketV3.Side side, uint256 shares, WalletMarketV3.Asset[] calldata a) external {
        m.sell(side, shares, a);
    }

    function claim(WalletMarketV3 m, WalletMarketV3.Asset[] calldata a) external {
        m.claim(a);
    }
}

/// @notice v3 fixture. The six MainnetReview attacks are ported below and must not succeed.
contract V3Test is Test {
    uint256 internal constant SEED = 10_000e6;

    HyperCoreStore internal store;
    MockUSDC public usdc;
    WalletRegistryV3 public reg;
    WalletMarketV3 internal market;
    MarketBeacon internal beacon;

    uint256 internal whalePk = 0xA11CE;
    address internal whale;
    address internal alice;
    address internal bob;
    address internal carol;
    address internal feeWallet;

    function setUp() public virtual {
        whale = vm.addr(whalePk);
        alice = makeAddr("alice");
        bob = makeAddr("bob");
        carol = makeAddr("carol");
        feeWallet = makeAddr("fees");
        vm.warp(1_700_000_000);

        store = new HyperCoreStore();
        PrecompileMock mock = new PrecompileMock(store);
        bytes memory code = address(mock).code;
        vm.etch(CoreReader.POSITION2, code);
        vm.etch(CoreReader.MARK_PX, code);
        vm.etch(CoreReader.ACCOUNT_MARGIN_SUMMARY, code);
        vm.etch(CoreReader.L1_BLOCK_NUMBER, code);
        vm.etch(CoreReader.CORE_USER_EXISTS, code);
        vm.etch(CoreReader.SPOT_BALANCE, code);

        _setExists(whale, true);
        _setL1(100);
        _setSpot(whale, 0);
        _book(100, 3_000e6, 30_000e6);

        usdc = new MockUSDC();
        WalletMarketV3 impl = new WalletMarketV3();
        WalletRegistryV3 logic = new WalletRegistryV3();
        RegistryProxy proxy = new RegistryProxy(
            address(logic),
            abi.encodeWithSelector(
                WalletRegistryV3.initialize.selector, address(this), address(this), feeWallet, address(usdc), address(impl)
            )
        );
        reg = WalletRegistryV3(address(proxy));
        beacon = reg.beacon();

        usdc.mint(address(this), 1_000_000e6);
        usdc.approve(address(reg), type(uint256).max);
        _list(whale, "MACHI", "Machi", SEED);
        (address listed,,) = reg.listings(whale);
        market = WalletMarketV3(listed);

        _fund(alice, 400_000e6);
        _fund(bob, 400_000e6);
        _fund(carol, 400_000e6);
        _assertSolvent();
    }

    // ---------------------------------------------------------------- ported PoCs (each attack fails)

    /// @dev PoC 1. A buy bundled with settle does not fill, so a known +1% lag is not a profit.
    function test_poc_atomicQueueSettleDoesNotFill() public {
        AtomicTrader t = new AtomicTrader();
        usdc.mint(address(t), 20_000e6);
        t.fund(usdc, reg, 20_000e6);
        uint256 start = reg.balanceOf(address(t));

        market.settleIfDue(_one());
        _tick();

        t.buyNow(market, WalletMarketV3.Side.Tail, 5_000e6, _one());
        assertEq(market.sharesOf(address(t), WalletMarketV3.Side.Tail), 0, "same-tx settle must not mint");
        assertFalse(market.settleIfDue(_one()), "epoch is not due again in this transaction");

        _book(100, 3_030e6, 33_000e6);
        _tick();
        assertTrue(market.settleIfDue(_one()));
        t.claim(market, _one());
        uint256 shares = market.sharesOf(address(t), WalletMarketV3.Side.Tail);
        assertGt(shares, 0, "fill waits for the next epoch");

        t.sell(market, WalletMarketV3.Side.Tail, shares, _one());
        _tick();
        market.settleIfDue(_one());
        t.claim(market, _one());

        uint256 end_ = reg.balanceOf(address(t));
        assertLt(end_, start - 20e6, "round trip after the move is already in the price loses the fees");
        _assertSolvent();
    }

    /// @dev A holder who filled on the previous epoch still earns the next sample. That is the product, not the arb.
    function test_holderEarnsTheNextSample() public {
        _seedBook();
        uint256 start = reg.balanceOf(alice);
        _enter(alice, WalletMarketV3.Side.Tail, 5_000e6);
        _book(100, 3_030e6, 33_000e6);
        _tick();
        market.settleIfDue(_one());
        assertEq(market.lastDelta(), 750e6, "0.1 * min(pots, 25% of 30k eRef)");
        uint256 shares = market.sharesOf(alice, WalletMarketV3.Side.Tail);
        vm.prank(alice);
        market.sell(WalletMarketV3.Side.Tail, shares, _one());
        _tick();
        market.settleIfDue(_one());
        vm.prank(alice);
        market.claim(_one());
        assertGt(reg.balanceOf(alice), start, "10x, +1% mark, capacity pays TAIL");
        _assertSolvent();
    }

    /// @dev PoC 2. Historical orders do not change the settle gas. The v2 loop passed ~290 orders and died at 1M.
    function test_poc_settleGasStaysFlat() public {
        _seedBook();
        _tick();
        uint256 empty0 = _gasSettle();

        _dustWallet().buy(market);
        _tick();
        uint256 with1 = _gasSettle();

        for (uint256 i; i < 64; ++i) {
            _dustWallet().buy(market);
        }
        _tick();
        uint256 with64 = _gasSettle();

        for (uint256 round = 1; round < 20; ++round) {
            for (uint256 i; i < 64; ++i) {
                _dustWallet().buy(market);
            }
            _tick();
            market.settleIfDue(_one());
        }
        _tick();
        uint256 after1280 = _gasSettle();

        _tick();
        uint256 g = gasleft();
        vm.prank(alice);
        market.buy(WalletMarketV3.Side.Tail, Config.MIN_ORDER, _one());
        uint256 buyDue = g - gasleft();

        console2.log("settle gas, empty book, 0 historical orders", empty0);
        console2.log("settle gas, 1 order in the open epoch", with1);
        console2.log("settle gas, 64 orders in the open epoch", with64);
        console2.log("settle gas, empty epoch, after 1280 historical orders", after1280);
        console2.log("buy gas when the epoch is due", buyDue);
        assertLt(empty0, 1_500_000, "baseline settle");
        assertLt(with64, 1_500_000, "a full epoch of orders");
        assertLt(after1280, 1_500_000, "history must not push settle over the v2 brick line");
        assertLt(after1280, empty0 + 30_000, "history adds storage, not a loop");
        assertLt(with64, with1 + 40_000, "64 orders cost about the same as one");
        _assertSolvent();
    }

    /// @dev PoC 3. Dust under the minimum reverts, and many real orders do not block someone else's sell.
    function test_poc_dustAndCrowdDoNotBlockExits() public {
        _enter(alice, WalletMarketV3.Side.Tail, 1_000e6);
        uint256 shares = market.sharesOf(alice, WalletMarketV3.Side.Tail);

        for (uint256 i; i < 64; ++i) {
            DustWallet w = _dustWallet();
            vm.expectRevert(WalletMarketV3.MinOrder.selector);
            w.buyDust(market);
        }

        for (uint256 i; i < 70; ++i) {
            _dustWallet().buy(market);
        }

        vm.prank(alice);
        market.sell(WalletMarketV3.Side.Tail, shares, _one());
        assertEq(market.sharesOf(alice, WalletMarketV3.Side.Tail), 0, "exit committed");
        _assertSolvent();
    }

    /// @dev PoC 4. Pause blocks new buys. It does not block a sell or a withdrawal.
    function test_poc_pauseDoesNotFreezeExits() public {
        _enter(alice, WalletMarketV3.Side.Tail, 1_000e6);
        uint256 shares = market.sharesOf(alice, WalletMarketV3.Side.Tail);
        uint256 cash = reg.balanceOf(alice);

        reg.setBuysPaused(true);
        vm.prank(alice);
        vm.expectRevert(WalletMarketV3.BuysPaused.selector);
        market.buy(WalletMarketV3.Side.Tail, Config.MIN_ORDER, _one());

        vm.prank(alice);
        market.sell(WalletMarketV3.Side.Tail, shares, _one());
        assertEq(market.sharesOf(alice, WalletMarketV3.Side.Tail), 0);

        vm.prank(alice);
        reg.withdraw(cash);
        assertEq(usdc.balanceOf(alice), cash);
        _assertSolvent();
    }

    /// @dev PoC 5. Unweighting in the same transaction reverts, and the +10% move still pays TAIL.
    function test_poc_instantUnweightReverts() public {
        _enter(alice, WalletMarketV3.Side.Tail, 1_000e6);
        uint256 before = market.tailPot();

        vm.expectRevert(WalletRegistryV3.Timelocked.selector);
        reg.setWeighted(whale, 1, false);

        _book(100, 3_300e6, 30_000e6);
        _tick();
        market.settleIfDue(_one());
        assertGt(market.tailPot(), before, "the move is not erased");
        _assertSolvent();
    }

    function test_timelockUnweightAppliesNextDay() public {
        _seedBook();
        reg.schedule(abi.encodeWithSelector(reg.OP_WEIGHTED(), whale, uint32(1), false));
        uint256 eta = reg.pendingEta();
        vm.warp(eta - 1 hours);
        vm.expectRevert(abi.encodeWithSelector(WalletRegistryV3.TooEarly.selector, eta));
        reg.execute();
        vm.warp(eta);
        reg.execute();
        assertFalse(market.weighted(1));

        uint256 before = market.tailPot();
        _book(100, 3_300e6, 30_000e6);
        _tick();
        market.settleIfDue(_one());
        assertEq(market.tailPot(), before, "after the timelock the perp is unweighted");
    }

    /// @dev PoC 6, the gas baseline, is the first log line of test_poc_settleGasStaysFlat.
    function test_baselineSettleAndTradeGas() public {
        _seedBook();
        _tick();
        uint256 settle1 = _gasSettle();

        uint256 g = gasleft();
        vm.prank(alice);
        market.buy(WalletMarketV3.Side.Tail, 1_000e6, _one());
        uint256 buyGas = g - gasleft();

        _tick();
        uint256 settle2 = _gasSettle();
        vm.prank(alice);
        market.claim(_one());
        uint256 shares = market.sharesOf(alice, WalletMarketV3.Side.Tail);

        g = gasleft();
        vm.prank(alice);
        market.sell(WalletMarketV3.Side.Tail, shares, _one());
        uint256 sellGas = g - gasleft();

        address w2 = makeAddr("w2");
        address w3 = makeAddr("w3");
        _setExists(w2, true);
        _setExists(w3, true);
        _setSpot(w2, 0);
        _setSpot(w3, 0);
        _setMargin(w2, 0, 1_000e6, 0);
        _setMargin(w3, 0, 1_000e6, 0);
        _list(w2, "BOBBY", "Bobby", 0);
        _list(w3, "HLP", "HLP", 0);
        (address m2,,) = reg.listings(w2);
        (address m3,,) = reg.listings(w3);

        address[] memory ms = new address[](3);
        ms[0] = address(market);
        ms[1] = m2;
        ms[2] = m3;
        WalletMarketV3.Asset[][] memory books = new WalletMarketV3.Asset[][](3);
        books[0] = _one();
        g = gasleft();
        bool[] memory done = reg.settleMany(ms, books);
        uint256 batch = g - gasleft();

        console2.log("per-market settle gas", settle1);
        console2.log("per-market settle gas, second sample", settle2);
        console2.log("user buy gas", buyGas);
        console2.log("user sell gas", sellGas);
        console2.log("settleMany gas, 3 markets", batch);
        console2.log("settleMany market0 settled", done[0] ? 1 : 0);
        console2.log("settleMany market1 settled", done[1] ? 1 : 0);

        assertLt(settle1, 1_500_000);
        assertLt(buyGas, 1_500_000);
        assertLt(sellGas, 1_500_000);
        assertLt(batch, 3_000_000, "one small block");
        assertTrue(done[1], "flat market with an empty book still samples when due");
    }

    function test_gas_precompileCalibration() public view {
        uint256 g = gasleft();
        CoreReader.l1BlockNumber();
        console2.log("mock l1 gas", g - gasleft());
        g = gasleft();
        CoreReader.spotBalance(whale, Config.USDC_SPOT);
        console2.log("mock spot gas", g - gasleft());
        g = gasleft();
        CoreReader.accountMarginSummary(0, whale);
        console2.log("mock margin gas", g - gasleft());
        g = gasleft();
        CoreReader.position(whale, 1);
        console2.log("mock position gas", g - gasleft());
        g = gasleft();
        CoreReader.markPx(1);
        console2.log("mock mark gas", g - gasleft());
    }

    // ---------------------------------------------------------------- economics

    function test_spotUsdcIsInEquity() public {
        _setMargin(whale, 0, 10_000e6, _ntl(100, 3_000e6));
        _setSpot(whale, 2_000_000_000_000); // 20_000e6 USD after /100
        market.settleIfDue(_one());
        assertEq(market.eRef(), 30_000e6, "perp account value plus spot USDC");
        assertEq(market.lastDelta(), 0, "the seeding sample does not move pots");
    }

    function test_subBpsMoveStillPays() public {
        _seedBook();
        uint256 before = market.tailPot();
        _setLeg(whale, 1, 100, 3_000e6 + 1);
        _setMargin(whale, 0, 30_000e6, _ntl(100, 3_000e6 + 1));
        _tick();
        market.settleIfDue(_one());
        assertGt(market.tailPot(), before, "finer than a whole basis point");
        assertLt(uint256(market.lastDelta() < 0 ? -market.lastDelta() : market.lastDelta()), 1e6);
    }

    function test_oneSidedPotDoesNotMove() public {
        address w = makeAddr("flatwhale");
        _setExists(w, true);
        _setSpot(w, 0);
        _bookOn(w, 100, 3_000e6, 30_000e6);
        _list(w, "NMTD", "NMTD", 0);
        (address listed,,) = reg.listings(w);
        WalletMarketV3 m = WalletMarketV3(listed);
        WalletMarketV3.Asset[] memory a = _one();

        m.settleIfDue(a);
        vm.prank(alice);
        m.buy(WalletMarketV3.Side.Tail, 5_000e6, a);
        _tick();
        m.settleIfDue(a);
        vm.prank(alice);
        m.claim(a);

        uint256 tail = m.tailPot();
        assertEq(m.fadePot(), 0);
        _bookOn(w, 100, 3_300e6, 33_000e6);
        _tick();
        m.settleIfDue(a);
        assertEq(m.lastDelta(), 0);
        assertEq(m.tailPot(), tail, "no fade pot means no capacity");
        _assertSolvent();
    }

    function test_missingLegRevertsAndOtherIndexWorks() public {
        address w = makeAddr("multileg");
        _setExists(w, true);
        _setSpot(w, 0);
        _list(w, "JEFF", "Jeff", SEED);
        (address listed,,) = reg.listings(w);
        WalletMarketV3 m = WalletMarketV3(listed);

        reg.schedule(abi.encodeWithSelector(reg.OP_WEIGHTED(), w, uint32(7), true));
        _unlock();
        reg.execute();
        reg.schedule(abi.encodeWithSelector(reg.OP_WEIGHTED(), w, uint32(1), false));
        _unlock();
        reg.execute();

        _setLeg(w, 7, 100, 3_000e6);
        _setLeg(w, 1, 50, 2_000e6);
        uint256 ntl = uint256(_ntl(100, 3_000e6)) + uint256(_ntl(50, 2_000e6));
        _setMargin(w, 0, 30_000e6, uint64(ntl));

        WalletMarketV3.Asset[] memory both = new WalletMarketV3.Asset[](2);
        both[0] = WalletMarketV3.Asset({memberIndex: 0, perp: 7});
        both[1] = WalletMarketV3.Asset({memberIndex: 0, perp: 1});

        // No snaps yet. Leaving the unweighted leg out of the book must revert.
        vm.expectRevert();
        m.settleIfDue(_oneOf(7));
        m.settleIfDue(both);

        _setLeg(w, 7, 100, 3_300e6);
        _setMargin(w, 0, 30_000e6, uint64(uint256(_ntl(100, 3_300e6)) + uint256(_ntl(50, 2_000e6))));
        uint256 before = m.tailPot();
        _tick();
        m.settleIfDue(both);
        assertGt(m.tailPot(), before, "perp index 7 is weighted; index 1 is carried for completeness");
    }

    function test_cancelLocksAtTheBoundaryAndIsNotFree() public {
        _seedBook();
        uint256 start = reg.balanceOf(alice);
        vm.prank(alice);
        market.buy(WalletMarketV3.Side.Tail, 1_000e6, _one());
        vm.prank(alice);
        market.cancel();
        assertLt(reg.balanceOf(alice), start, "cancel inside the window keeps the fee");
        assertGt(reg.protocolFees(), 0);

        vm.prank(alice);
        market.buy(WalletMarketV3.Side.Tail, 1_000e6, _one());
        _tick();
        vm.prank(alice);
        vm.expectRevert(WalletMarketV3.EpochClosed.selector);
        market.cancel();
        market.settleIfDue(_one());
        vm.prank(alice);
        market.claim(_one());
        assertGt(market.sharesOf(alice, WalletMarketV3.Side.Tail), 0);
        _assertSolvent();
    }

    function test_capDefaultsOffAndGuardianCanOnlyTighten() public {
        _seedBook();
        vm.prank(alice);
        market.buy(WalletMarketV3.Side.Tail, 50_000e6, _one());

        reg.tightenCap(SEED);
        vm.prank(bob);
        vm.expectRevert(WalletMarketV3.PotCap.selector);
        market.buy(WalletMarketV3.Side.Fade, Config.MIN_ORDER, _one());

        vm.expectRevert(WalletRegistryV3.CapDirection.selector);
        reg.tightenCap(SEED + 1);
        vm.expectRevert(WalletRegistryV3.CapDirection.selector);
        reg.tightenCap(0);
        vm.expectRevert(WalletRegistryV3.Timelocked.selector);
        reg.raiseCap(SEED * 10);

        reg.schedule(abi.encodeWithSelector(reg.OP_CAP(), uint256(0)));
        _unlock();
        reg.execute();
        assertEq(reg.maxPotPerSide(), 0);
        vm.prank(bob);
        market.buy(WalletMarketV3.Side.Fade, Config.MIN_ORDER, _one());
    }

    function test_feesAndHouseSeedAreRealUsdc() public {
        assertEq(usdc.balanceOf(address(reg)), reg.liabilities());
        assertEq(market.usdcHeld(), SEED * 2, "seed sits in the pots");
        assertEq(reg.houseBalance(), 0);
        assertEq(reg.totalBalances(), 1_200_000e6, "user deposits are balances; the seed is not");

        _enter(alice, WalletMarketV3.Side.Tail, 1_000e6);
        assertGt(reg.protocolFees(), 0);
        uint256 fees = reg.protocolFees();
        reg.claimFees();
        assertEq(usdc.balanceOf(feeWallet), fees);
        assertEq(reg.protocolFees(), 0);

        uint256 houseShares = market.sharesOf(Config.HOUSE, WalletMarketV3.Side.Fade);
        reg.schedule(abi.encodeWithSelector(reg.OP_HOUSE_SELL(), whale, uint8(WalletMarketV3.Side.Fade), houseShares));
        _unlock();
        reg.execute();
        _tick();
        reg.claimHouse(whale, _one());
        assertGt(reg.houseBalance(), 0);
        uint256 house = reg.houseBalance();
        uint256 ownerBefore = usdc.balanceOf(address(this));
        reg.withdrawHouse(house);
        assertEq(usdc.balanceOf(address(this)), ownerBefore + house);
        _assertSolvent();
    }

    function test_emergencyExitAfterLongPause() public {
        _enter(alice, WalletMarketV3.Side.Tail, 2_000e6);
        _enter(bob, WalletMarketV3.Side.Tail, 2_000e6);
        reg.setBuysPaused(true);
        vm.prank(alice);
        vm.expectRevert(WalletMarketV3.NotEmergency.selector);
        market.exitAtLastNav();

        // The pause is old enough, but a settle an hour ago still blocks the exit.
        vm.warp(reg.pauseSince() + Config.EXIT_DELAY - 1 hours);
        market.settleIfDue(_one());
        vm.warp(reg.pauseSince() + Config.EXIT_DELAY);
        vm.prank(alice);
        vm.expectRevert(WalletMarketV3.NotEmergency.selector);
        market.exitAtLastNav();

        vm.warp(market.lastSettleTs() + Config.EXIT_DELAY);
        uint256 pot = market.tailPot();
        uint256 supply = market.tailSupply();
        uint256 shares = market.sharesOf(alice, WalletMarketV3.Side.Tail);
        uint256 expectPay = shares * pot / supply;
        uint256 before = reg.balanceOf(alice);
        vm.prank(alice);
        market.exitAtLastNav();
        assertEq(market.sharesOf(alice, WalletMarketV3.Side.Tail), 0);
        assertEq(reg.balanceOf(alice), before + expectPay);
        vm.prank(bob);
        market.exitAtLastNav();
        _assertSolvent();
    }

    function test_notDueMarketIsSkippedInTheBatch() public {
        market.settleIfDue(_one());
        address[] memory ms = new address[](1);
        ms[0] = address(market);
        WalletMarketV3.Asset[][] memory books = new WalletMarketV3.Asset[][](1);
        books[0] = _one();
        bool[] memory done = reg.settleMany(ms, books);
        assertFalse(done[0]);
        uint256 ts = market.lastSettleTs();
        _tick();
        done = reg.settleMany(ms, books);
        assertTrue(done[0]);
        assertGt(market.lastSettleTs(), ts);
    }

    function test_listingsAbiMatchesTheKeeper() public pure {
        assertEq(bytes4(keccak256("whaleCount()")), bytes4(hex"3ed96f41"));
        assertEq(bytes4(keccak256("whales(uint256)")), bytes4(hex"eb1d2d40"));
        assertEq(bytes4(keccak256("listings(address)")), bytes4(hex"65d96c82"));
        assertEq(bytes4(keccak256("lastSettleTs()")), bytes4(hex"e89da2f3"));
    }

    function test_upgradeWaitsForTheTimelock() public {
        WalletMarketV3 next = new WalletMarketV3();
        reg.schedule(abi.encodeWithSelector(reg.OP_BEACON(), address(next)));
        _unlock();
        reg.execute();
        assertEq(beacon.implementation(), address(next));

        WalletRegistryV3 nextReg = new WalletRegistryV3();
        reg.schedule(abi.encodeWithSelector(reg.OP_REGISTRY(), address(nextReg)));
        _unlock();
        reg.execute();
        bytes32 slot = bytes32(uint256(0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc));
        assertEq(address(uint160(uint256(vm.load(address(reg), slot)))), address(nextReg));
    }

    function testFuzz_claimsDoNotExceedUsdc(uint128 aAmt, uint128 bAmt, uint256 salt) public {
        uint256 buyA = bound(aAmt, Config.MIN_ORDER, 20_000e6);
        uint256 buyB = bound(bAmt, Config.MIN_ORDER, 20_000e6);
        uint256 steps = bound(salt, 1, 3);
        _seedBook();

        for (uint256 i; i < steps; ++i) {
            uint64 mark = uint64(3_000e6 * (9_000 + (uint256(keccak256(abi.encode(salt, i))) % 2_001)) / 10_000);
            _book(100, mark, 30_000e6);
            _tick();

            vm.prank(alice);
            market.buy(WalletMarketV3.Side.Tail, buyA, _one());
            vm.prank(bob);
            market.buy(WalletMarketV3.Side.Fade, buyB, _one());
            if (buyA % 5 == 0) {
                vm.prank(alice);
                market.cancel();
            }
            _assertSolvent();

            _tick();
            market.settleIfDue(_one());
            vm.prank(alice);
            market.claim(_one());
            vm.prank(bob);
            market.claim(_one());
            _assertSolvent();

            uint256 shares = market.sharesOf(alice, WalletMarketV3.Side.Tail);
            if (shares != 0 && salt % 2 == 1) {
                vm.prank(alice);
                market.sell(WalletMarketV3.Side.Tail, shares, _one());
                _tick();
                market.settleIfDue(_one());
                vm.prank(alice);
                market.claim(_one());
                _assertSolvent();
            }
        }

        uint256 owed = reg.balanceOf(alice) + reg.balanceOf(bob) + reg.balanceOf(carol);
        assertLe(owed + reg.protocolFees() + reg.houseBalance(), usdc.balanceOf(address(reg)));
        assertEq(usdc.balanceOf(address(reg)), reg.liabilities(), "every wei is a balance, a fee, house, or a pot");
    }

    // ---------------------------------------------------------------- helpers

    /// @dev External so via_ir cannot treat block.timestamp as constant across calls.
    function advanceEpoch(WalletMarketV3 m) external {
        require(msg.sender == address(this), "clock");
        uint256 last = m.lastSettleTs();
        uint256 target = (last == 0 ? block.timestamp : last) + Config.EPOCH;
        if (target <= block.timestamp) target = block.timestamp + Config.EPOCH;
        vm.warp(target);
    }

    function advancePending() external {
        require(msg.sender == address(this), "clock");
        vm.warp(reg.pendingEta());
    }

    function _tick() internal {
        this.advanceEpoch(market);
    }

    function _unlock() internal {
        this.advancePending();
    }

    function _list(address who, string memory ticker, string memory name_, uint256 seed) internal {
        reg.schedule(
            abi.encodeWithSelector(
                reg.OP_LIST(), who, new address[](0), ticker, name_, _dex0(), _weight(1), seed
            )
        );
        _unlock();
        reg.execute();
    }

    function _fund(address user, uint256 amt) internal {
        usdc.mint(user, amt);
        vm.startPrank(user);
        usdc.approve(address(reg), type(uint256).max);
        reg.deposit(amt);
        vm.stopPrank();
    }

    function _seedBook() internal {
        if (market.lastSettleTs() == 0) market.settleIfDue(_one());
    }

    function _enter(address user, WalletMarketV3.Side side, uint256 amt) internal {
        _seedBook();
        vm.prank(user);
        market.buy(side, amt, _one());
        _tick();
        market.settleIfDue(_one());
        vm.prank(user);
        market.claim(_one());
    }

    function _gasSettle() internal returns (uint256 used) {
        uint256 g = gasleft();
        market.settleIfDue(_one());
        used = g - gasleft();
    }

    function _dustWallet() internal returns (DustWallet w) {
        w = new DustWallet();
        usdc.mint(address(w), 1_000e6);
        w.fund(usdc, reg);
    }

    function _assertSolvent() internal view {
        assertEq(usdc.balanceOf(address(reg)), reg.liabilities(), "insolvent");
    }

    function _dex0() internal pure returns (uint32[] memory dexes) {
        dexes = new uint32[](1);
        dexes[0] = 0;
    }

    function _weight(uint32 perp) internal pure returns (uint32[] memory w) {
        w = new uint32[](1);
        w[0] = perp;
    }

    function _one() internal pure returns (WalletMarketV3.Asset[] memory a) {
        a = _oneOf(1);
    }

    function _oneOf(uint32 perp) internal pure returns (WalletMarketV3.Asset[] memory a) {
        a = new WalletMarketV3.Asset[](1);
        a[0] = WalletMarketV3.Asset({memberIndex: 0, perp: perp});
    }

    function _setExists(address user, bool exists_) internal {
        store.set(CoreReader.CORE_USER_EXISTS, abi.encode(user), abi.encode(CoreReader.CoreUserExists({exists: exists_})));
    }

    function _setL1(uint64 n) internal {
        store.set(CoreReader.L1_BLOCK_NUMBER, "", abi.encode(n));
    }

    function _setSpot(address user, uint64 total) internal {
        store.set(
            CoreReader.SPOT_BALANCE,
            abi.encode(user, Config.USDC_SPOT),
            abi.encode(CoreReader.SpotBalance({total: total, hold: 0, entryNtl: 0}))
        );
    }

    function _setMargin(address user, uint32 dex, int64 equity, uint64 ntl) internal {
        store.set(
            CoreReader.ACCOUNT_MARGIN_SUMMARY,
            abi.encode(dex, user),
            abi.encode(CoreReader.AccountMarginSummary({accountValue: equity, marginUsed: 0, ntlPos: ntl, rawUsd: equity}))
        );
    }

    function _setLeg(address user, uint32 perp, int64 szi, uint64 mark) internal {
        store.set(
            CoreReader.POSITION2,
            abi.encode(user, perp),
            abi.encode(CoreReader.Position({szi: szi, entryNtl: 0, isolatedRawUsd: 0, leverage: 1, isIsolated: false}))
        );
        store.set(CoreReader.MARK_PX, abi.encode(perp), abi.encode(mark));
    }

    function _ntl(int64 szi, uint64 mark) internal pure returns (uint64) {
        uint256 n = uint256(int256(szi) < 0 ? -int256(szi) : int256(szi)) * uint256(mark);
        require(n <= type(uint64).max, "ntl");
        return uint64(n);
    }

    function _book(int64 szi, uint64 mark, int64 equity) internal {
        _bookOn(whale, szi, mark, equity);
    }

    function _bookOn(address who, int64 szi, uint64 mark, int64 equity) internal {
        _setLeg(who, 1, szi, mark);
        _setMargin(who, 0, equity, szi == 0 ? 0 : _ntl(szi, mark));
    }

    function actBuy(uint256 seed, uint256 amt, uint8 sideRaw) external {
        amt = bound(amt, Config.MIN_ORDER, 2_000e6);
        vm.prank(_actor(seed));
        try market.buy(_side(sideRaw), amt, _one()) {} catch {}
    }

    function actSell(uint256 seed, uint256 shares, uint8 sideRaw) external {
        address actor = _actor(seed);
        WalletMarketV3.Side side = _side(sideRaw);
        uint256 have = market.sharesOf(actor, side);
        if (have == 0) return;
        shares = bound(shares, 1, have);
        vm.prank(actor);
        try market.sell(side, shares, _one()) {} catch {}
    }

    function actCancel(uint256 seed) external {
        vm.prank(_actor(seed));
        try market.cancel() {} catch {}
    }

    function actSettle(uint256 warpSeed) external {
        if (warpSeed % 2 == 0) vm.warp(block.timestamp + Config.EPOCH);
        try market.settleIfDue(_one()) {} catch {}
    }

    function actPauseOrExit(uint256 seed) external {
        if (!reg.buysPaused()) reg.setBuysPaused(true);
        uint256 when = block.timestamp;
        uint256 pauseAt = reg.pauseSince() + Config.EXIT_DELAY;
        uint256 settleAt = market.lastSettleTs() == 0 ? when : market.lastSettleTs() + Config.EXIT_DELAY;
        if (pauseAt > when) when = pauseAt;
        if (settleAt > when) when = settleAt;
        vm.warp(when);
        vm.prank(_actor(seed));
        try market.exitAtLastNav() {} catch {}
    }

    function actOptOut() external {
        if (reg.optedOut(whale)) return;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(whalePk, reg.hashOptOut(whale));
        try reg.optOut(whale, abi.encodePacked(r, s, v)) {} catch {}
    }

    function _actor(uint256 seed) internal view returns (address) {
        uint256 i = seed % 3;
        if (i == 0) return alice;
        if (i == 1) return bob;
        return carol;
    }

    function _side(uint8 sideRaw) internal pure returns (WalletMarketV3.Side) {
        return sideRaw % 2 == 0 ? WalletMarketV3.Side.Tail : WalletMarketV3.Side.Fade;
    }
}

/// @dev One address, one pending order. There is no shared queue to fill.
contract DustWallet {
    function fund(MockUSDC token, WalletRegistryV3 reg) external {
        token.approve(address(reg), type(uint256).max);
        reg.deposit(token.balanceOf(address(this)));
    }

    function buy(WalletMarketV3 m) external {
        m.buy(WalletMarketV3.Side.Fade, Config.MIN_ORDER, _eth());
    }

    function buyDust(WalletMarketV3 m) external {
        m.buy(WalletMarketV3.Side.Fade, 1, _eth());
    }

    function _eth() internal pure returns (WalletMarketV3.Asset[] memory a) {
        a = new WalletMarketV3.Asset[](1);
        a[0] = WalletMarketV3.Asset({memberIndex: 0, perp: 1});
    }
}
