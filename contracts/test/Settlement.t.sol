// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Season0Test} from "./Season0Test.sol";
import {HyperCoreReader} from "../src/HyperCoreReader.sol";
import {WalletMarket} from "../src/WalletMarket.sol";
import {Season0} from "../src/Season0.sol";

contract SettlementTest is Season0Test {
    function test_precompileMock_roundTripsPositionMarkAndMargin() public {
        _setLeg(whale, 1, 36_000_000, 248_860);
        HyperCoreReader.Position memory p = HyperCoreReader.position(whale, 1);
        assertEq(p.szi, 36_000_000);
        assertEq(HyperCoreReader.markPx(1), 248_860);
        assertEq(HyperCoreReader.l1BlockNumber(), 100);
        assertTrue(HyperCoreReader.coreUserExists(whale));
        HyperCoreReader.AccountMarginSummary memory m = HyperCoreReader.accountMarginSummary(0, whale);
        assertEq(m.accountValue, 30_000e6);
    }

    function test_missingPrecompileReadReverts() public {
        HyperCoreReader.Position memory p =
            HyperCoreReader.Position({szi: 1, entryNtl: 0, isolatedRawUsd: 0, leverage: 1, isIsolated: false});
        store.set(HyperCoreReader.POSITION2, abi.encode(whale, uint32(1)), abi.encode(p));
        vm.expectRevert(abi.encodeWithSelector(HyperCoreReader.PrecompileReadFailed.selector, HyperCoreReader.MARK_PX));
        market.settle(_one());
    }

    function test_firstSettlementSeedsReferenceEquityAndDoesNotMovePots() public {
        _book(7500, 2_000_000, 30_000e6);
        vm.prank(alice);
        market.queueBuy(WalletMarket.Side.Tail, 10_000e6);
        vm.prank(bob);
        market.queueBuy(WalletMarket.Side.Fade, 10_000e6);

        _settle();

        assertEq(market.lastPnl(), 0);
        assertEq(market.lastDelta(), 0);
        assertEq(market.eRef(), 30_000e6);
        assertEq(market.tailPot(), 9_950e6);
        assertEq(market.fadePot(), 9_950e6);
        assertEq(market.navOf(WalletMarket.Side.Tail), 1e6);
        // 1 point of each side is locked to address(1).
        assertEq(market.sharesOf(address(1), WalletMarket.Side.Tail), Season0.MIN_LIQUIDITY);
        assertEq(market.sharesOf(alice, WalletMarket.Side.Tail), 9_949e6);
        assertEq(reg.protocolFees(), 100e6);
        assertEq(uint256(market.status()), uint256(WalletMarket.Status.Active));
    }

    function test_queueDoesNotFillUntilTheNextSettlement() public {
        _book(1000, 1_000_000, 30_000e6);
        vm.prank(alice);
        market.queueBuy(WalletMarket.Side.Tail, 5_000e6);
        assertEq(market.sharesOf(alice, WalletMarket.Side.Tail), 0);
        assertEq(market.tailPot(), 0);

        vm.prank(alice);
        vm.expectRevert(WalletMarket.BadAmount.selector);
        market.queueSell(WalletMarket.Side.Tail, 1);

        _settle();
        assertGt(market.sharesOf(alice, WalletMarket.Side.Tail), 0);
    }

    function test_cancelBuyReturnsPointsAndCancelSellRestoresShares() public {
        _book(1000, 1_000_000, 30_000e6);
        vm.prank(alice);
        uint256 id = market.queueBuy(WalletMarket.Side.Tail, 4_000e6);
        assertEq(reg.points(alice), 6_000e6);
        vm.prank(alice);
        market.cancel(id);
        assertEq(reg.points(alice), 10_000e6);
        _assertConserved();

        vm.prank(alice);
        market.queueBuy(WalletMarket.Side.Tail, 4_000e6);
        _settle();
        uint256 shares = market.sharesOf(alice, WalletMarket.Side.Tail);
        vm.prank(alice);
        uint256 sellId = market.queueSell(WalletMarket.Side.Tail, shares);
        assertEq(market.sharesOf(alice, WalletMarket.Side.Tail), 0);
        vm.prank(alice);
        market.cancel(sellId);
        assertEq(market.sharesOf(alice, WalletMarket.Side.Tail), shares);
        _assertConserved();
    }

    function test_sellAllLeavesTheLockedPoint() public {
        _book(1000, 1_000_000, 30_000e6);
        vm.prank(alice);
        market.queueBuy(WalletMarket.Side.Tail, 10_000e6);
        _settle();
        uint256 shares = market.sharesOf(alice, WalletMarket.Side.Tail);
        vm.prank(alice);
        market.queueSell(WalletMarket.Side.Tail, shares);
        skip(60);
        _settle();
        assertEq(market.tailSupply(), Season0.MIN_LIQUIDITY);
        assertGt(market.tailPot(), 0);
        assertEq(market.sharesOf(alice, WalletMarket.Side.Tail), 0);
    }

    function test_heartbeatAndMarkOnlyWait() public {
        _book(1000, 1_000_000, 30_000e6);
        _settle();

        _book(1000, 1_100_000, 30_000e6);
        skip(10);
        vm.expectRevert(abi.encodeWithSelector(WalletMarket.TooEarly.selector, market.lastSettleTs() + 60));
        market.settle(_one());

        vm.warp(market.lastSettleTs() + 60);
        _settle();
        assertEq(market.lastPnl(), 1000 * 100_000);
        assertFalse(market.lastPositionChanged());
    }

    function test_positionSizeChangeSettlesInsideTheHeartbeat() public {
        _book(1000, 1_000_000, 30_000e6);
        _settle();
        skip(10);
        _book(900, 1_000_000, 30_000e6);
        _settle();
        assertTrue(market.lastPositionChanged());
        assertEq(market.settleCount(), 2);
    }

    function test_settleIsPermissionless() public {
        _book(1000, 1_000_000, 30_000e6);
        vm.prank(carol);
        _settle();
        assertEq(market.settleCount(), 1);
    }

    function test_flatBookSleepsThenWakes() public {
        _book(0, 1_000_000, 0);
        _settle();
        assertEq(uint256(market.status()), uint256(WalletMarket.Status.Sleeping));
        assertEq(market.eRef(), 0);

        _book(1000, 1_000_000, 20_000e6);
        skip(60);
        _settle();
        assertEq(uint256(market.status()), uint256(WalletMarket.Status.Active));
        assertEq(market.eRef(), 20_000e6);

        _book(0, 1_000_000, 20_000e6);
        skip(60);
        _settle();
        assertEq(uint256(market.status()), uint256(WalletMarket.Status.Sleeping));
    }

    function test_zeroReferenceWakesWhenEquityAppears() public {
        _book(0, 1_000_000, 0);
        _settle();
        assertEq(market.eRef(), 0);

        _book(2000, 1_000_000, 8_000e6);
        skip(60);
        _settle();
        assertEq(market.eRef(), 8_000e6);
        assertEq(market.lastPnl(), 0);

        uint64 mark0 = 1_000_000;
        uint64 mark1 = 2_000_000;
        _book(2000, mark1, 50_000e6);
        skip(60);
        _settle();
        assertEq(market.lastPnl(), int256(2000) * int256(uint256(mark1 - mark0)));
        assertEq(market.eRef(), 8_000e6, "deposit after wake does not rewrite eRef");
    }

    function test_membersSumEquityAndPnl() public {
        address child = makeAddr("hlp-child");
        _setExists(child, true);
        reg.addMember(whale, child);

        _setLeg(whale, 1, 1000, 1_000_000);
        _setLeg(child, 1, 500, 1_000_000);
        _setMargin(whale, 0, 10_000e6, _ntl(1000, 1_000_000));
        _setMargin(child, 0, 4_000e6, _ntl(500, 1_000_000));

        WalletMarket.Asset[] memory assets = new WalletMarket.Asset[](2);
        assets[0] = _memberLeg(0, 1);
        assets[1] = _memberLeg(1, 1);
        _settle(assets);
        assertEq(market.eRef(), 14_000e6);
        assertEq(market.lastPnl(), 0);

        _setLeg(whale, 1, 1000, 1_100_000);
        _setLeg(child, 1, 500, 1_100_000);
        _setMargin(whale, 0, 10_000e6, _ntl(1000, 1_100_000));
        _setMargin(child, 0, 4_000e6, _ntl(500, 1_100_000));
        skip(60);
        _settle(assets);
        // 1,000 * 100_000 + 500 * 100_000
        assertEq(market.lastPnl(), 150_000_000);
    }

    function testFuzz_pointsStayConserved(uint96 rawBuy, uint32 bump, bool up) public {
        uint256 buy = bound(rawBuy, 2e6, 9_000e6);
        int64 szi = 1000;
        uint64 mark = 1_000_000;
        _book(szi, mark, 30_000e6);

        vm.prank(alice);
        market.queueBuy(WalletMarket.Side.Tail, buy);
        vm.prank(bob);
        market.queueBuy(WalletMarket.Side.Fade, buy);
        _settle();

        uint256 sum = market.tailPot() + market.fadePot();
        uint256 step = bound(uint256(bump), 0, 100_000);
        uint64 mark2 = up ? mark + uint64(step) : mark - uint64(step / 2);
        _book(szi, mark2, 30_000e6);
        skip(60);
        _settle();
        assertEq(market.tailPot() + market.fadePot(), sum, "pnl move is zero-sum");

        uint256 shares = market.sharesOf(alice, WalletMarket.Side.Tail);
        if (shares > 0) {
            vm.prank(alice);
            market.queueSell(WalletMarket.Side.Tail, shares);
            skip(60);
            _settle();
        }
    }
}
