// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Season0Test} from "./Season0Test.sol";
import {WalletMarket} from "../src/WalletMarket.sol";
import {Season0} from "../src/Season0.sol";

/// @notice The gaming cases from the design doc: self-fade, front-running, hidden positions,
///         deposits and withdrawals, plus the per-check and per-day caps.
contract GamingTest is Season0Test {
    function _seedBothSides() internal {
        vm.prank(alice);
        market.queueBuy(WalletMarket.Side.Tail, 10_000e6);
        vm.prank(bob);
        market.queueBuy(WalletMarket.Side.Fade, 10_000e6);
    }

    /// @dev Whale equity $30,000, pots deeper than α·E ($7,500). A 25% loss moves $1,875.
    function test_selfFadeGainsAtMostQuarterOfWhaleLoss() public {
        _book(7500, 2_000_000, 30_000e6);
        vm.prank(alice);
        market.queueBuy(WalletMarket.Side.Tail, 10_000e6);
        vm.prank(whale);
        reg.claimSeason0();
        vm.prank(whale);
        market.queueBuy(WalletMarket.Side.Fade, 10_000e6);
        _settle();

        uint256 fadeBefore = market.fadePot();
        uint256 shares = market.sharesOf(whale, WalletMarket.Side.Fade);
        uint256 supply = market.fadeSupply();
        uint256 personalBefore = shares * fadeBefore / supply;

        // Mark falls. Raw loss = 7,500 * 1,000,000 = $7,500 = 25% of eRef.
        _book(7500, 1_000_000, 30_000e6);
        skip(60);
        _settle();

        uint256 whaleLoss = 7_500e6;
        uint256 potGain = market.fadePot() - fadeBefore;
        assertEq(market.lastPnl(), -int256(whaleLoss));
        assertEq(market.lastAppliedRBps(), -2_500);
        assertEq(potGain * 4, whaleLoss, "pot move is exactly loss / 4 when C = alpha * eRef");

        uint256 personalAfter = shares * market.fadePot() / market.fadeSupply();
        uint256 personalGain = personalAfter - personalBefore;
        assertLt(personalGain * 4, whaleLoss, "the whale's own FADE shares capture strictly less than the loss / 4");
    }

    function test_sampleCapLimitsEightyPercentLoss() public {
        _book(7500, 4_000_000, 30_000e6);
        _seedBothSides();
        _settle();

        // dMark = -3_200_000 → pnl = 7500 * -3_200_000 = -$24,000 = -80% of eRef.
        _book(7500, 800_000, 30_000e6);
        skip(60);
        _settle();

        assertEq(market.lastPnl(), -24_000e6);
        assertEq(market.lastAppliedRBps(), -2_500);
        assertEq(uint256(-market.lastDelta()) * 4, 7_500e6);
    }

    function test_dailyCapStopsTheThirdQuarter() public {
        // α·E = $2,000, pots ≈ $9,950, so three 25% samples stay inside the equity cap.
        _book(2000, 5_000_000, 8_000e6);
        _seedBothSides();
        _settle();
        assertEq(market.dailyRBps(), 0);

        uint64 mark = 5_000_000;
        int256[3] memory expected = [int256(2_500), int256(2_500), int256(0)];
        for (uint256 i; i < 3; ++i) {
            mark += 1_000_000;
            _book(2000, mark, 8_000e6);
            skip(60);
            _settle();
            assertEq(market.lastAppliedRBps(), expected[i]);
        }
        assertEq(market.dailyRBps(), 5_000);

        mark -= 1_000_000;
        _book(2000, mark, 8_000e6);
        skip(60);
        _settle();
        assertEq(market.lastAppliedRBps(), -2_500, "the other direction still has room");
        assertEq(market.dailyRBps(), 2_500);
    }

    function test_frontRunBuysAtThePostSettlementNav() public {
        _book(7500, 2_000_000, 30_000e6);
        _seedBothSides();
        _settle();

        uint256 aliceShares = market.sharesOf(alice, WalletMarket.Side.Tail);
        uint256 aliceBefore = aliceShares * market.tailPot() / market.tailSupply();
        uint256 bobShares = market.sharesOf(bob, WalletMarket.Side.Fade);

        // The whale's mark has already moved. Carol buys TAIL and Bob dumps FADE before settle.
        _book(7500, 3_000_000, 30_000e6);
        vm.prank(carol);
        reg.claimSeason0();
        vm.prank(carol);
        market.queueBuy(WalletMarket.Side.Tail, 10_000e6);
        vm.prank(bob);
        market.queueSell(WalletMarket.Side.Fade, bobShares);

        skip(60);
        uint256 bobPointsBefore = reg.points(bob);
        _settle();

        uint256 aliceAfter = aliceShares * market.tailPot() / market.tailSupply();
        assertGt(aliceAfter, aliceBefore, "a holder from before the move keeps the PnL");

        uint256 carolShares = market.sharesOf(carol, WalletMarket.Side.Tail);
        uint256 carolValue = carolShares * market.tailPot() / market.tailSupply();
        assertApproxEqAbs(carolValue, 9_950e6, 1e6, "queued buy is filled at the new NAV");
        assertLt(carolValue, 10_500e6, "the queued buy does not collect the whale's gain");

        uint256 bobGot = reg.points(bob) - bobPointsBefore;
        assertLt(bobGot, bobShares * 95 / 100, "a queued sell cannot exit at the pre-move NAV");
    }

    function test_hiddenPositionRevertsUntilTheBookIsComplete() public {
        _setLeg(whale, 1, 1000, 1000);
        _setLeg(whale, 2, 1000, 1000);
        _setMargin(whale, 0, 1_000_000e6, 2_000_000);

        vm.expectRevert(
            abi.encodeWithSelector(WalletMarket.IncompleteBook.selector, uint256(1_000_000), uint256(2_000_000))
        );
        market.settle(_one());
        assertEq(market.settleCount(), 0, "a reverted sample does not stick");

        _settle(_legs(1, 2));
        assertEq(market.settleCount(), 1);
        assertEq(market.lastNtlPos(), 2_000_000);
    }

    function test_omittedDustWithinEpsilonPasses() public {
        // Asset 2 is 10_000 / 1_010_000 ≈ 0.99%, inside the 1% band.
        _setLeg(whale, 1, 1000, 1000);
        _setLeg(whale, 2, 10, 1000);
        _setMargin(whale, 0, 1_000_000e6, 1_010_000);
        _settle();
        assertEq(market.settleCount(), 1);
    }

    function test_omittedTwoPercentReverts() public {
        _setLeg(whale, 1, 980, 1000);
        _setLeg(whale, 2, 20, 1000);
        _setMargin(whale, 0, 1_000_000e6, 1_000_000);
        vm.expectRevert(
            abi.encodeWithSelector(WalletMarket.IncompleteBook.selector, uint256(980_000), uint256(1_000_000))
        );
        market.settle(_one());
    }

    function test_notionalAboveTheBandReverts() public {
        _setLeg(whale, 1, 1000, 1000);
        _setMargin(whale, 0, 1_000_000e6, 500_000);
        vm.expectRevert(
            abi.encodeWithSelector(WalletMarket.IncompleteBook.selector, uint256(1_000_000), uint256(500_000))
        );
        market.settle(_one());
    }

    function test_depositAndWithdrawalDoNotChangePricePnl() public {
        _book(1000, 1000, 1_000_000e6);
        _settle();
        assertEq(market.eRef(), 1_000_000e6);

        // Mark +100 and a $5,000,000 deposit land in the same sample.
        int64 equityAfterDeposit = 1_000_000e6 + 5_000_000e6;
        _book(1000, 1100, equityAfterDeposit);
        skip(60);
        _settle();

        assertEq(market.lastPnl(), 100_000, "pnl is size * mark delta");
        assertTrue(market.lastPnl() != int256(equityAfterDeposit) - int256(1_000_000e6));
        assertEq(market.eRef(), 1_000_000e6, "a mid-day deposit does not rewrite eRef");
        assertEq(market.lastEquity(), uint256(int256(equityAfterDeposit)));

        // Withdrawal, mark unchanged.
        _book(1000, 1100, 1_000_000e6);
        skip(60);
        _settle();
        assertEq(market.lastPnl(), 0);
        assertEq(market.eRef(), 1_000_000e6);
    }

    function test_dayRollNormalizesWithThePreviousReferenceEquity() public {
        _book(7500, 2_000_000, 30_000e6);
        _seedBothSides();
        _settle();

        // Exhaust the daily cap so a same-day sample would be clamped to zero.
        _book(7500, 3_000_000, 30_000e6);
        skip(60);
        _settle();
        _book(7500, 4_000_000, 30_000e6);
        skip(60);
        _settle();
        assertEq(market.dailyRBps(), 5_000);

        uint256 nextDay = (vm.getBlockTimestamp() / 1 days + 1) * 1 days;
        vm.warp(nextDay);
        // Equity doubles via a deposit. Raw pnl is another $7,500 = 25% of the OLD eRef
        // and 12.5% of the new equity. The crossing sample must use the old eRef.
        _book(7500, 5_000_000, 60_000e6);
        _settle();

        assertEq(market.lastPnl(), 7_500e6);
        assertEq(market.lastAppliedRBps(), 2_500, "25% of yesterday's eRef, not 12.5% of the deposit");
        assertEq(market.eRef(), 60_000e6, "eRef updates after the crossing sample");
        assertEq(market.dailyRBps(), 2_500, "the crossing sample starts the new day's budget");
    }

    function test_hip3DexStaysOutOfPnlUntilWeighted() public {
        assertEq(Season0.perpIndex(1, 2), 10_002);

        WalletMarket.Asset[] memory early = new WalletMarket.Asset[](1);
        early[0] = WalletMarket.Asset({memberIndex: 0, perp: 10_002});
        vm.expectRevert(abi.encodeWithSelector(WalletMarket.DexNotTracked.selector, uint32(10_002)));
        market.settle(early);

        reg.setDexEnabled(whale, 1, true);
        _setLeg(whale, 1, 1000, 1_000_000);
        _setLeg(whale, 10_002, 500, 1_000_000);
        _setMargin(whale, 0, 30_000e6, _ntl(1000, 1_000_000));
        _setMargin(whale, 1, 0, _ntl(500, 1_000_000));

        WalletMarket.Asset[] memory both = _legs(1, 10_002);
        _settle(both);
        assertEq(market.lastPnl(), 0);

        // xyz mark doubles. It is enabled for completeness and still has zero PnL weight.
        _setLeg(whale, 10_002, 500, 2_000_000);
        _setMargin(whale, 1, 0, _ntl(500, 2_000_000));
        skip(60);
        _settle(both);
        assertEq(market.lastPnl(), 0);
        assertEq(market.lastWeightedNtl(), _ntl(1000, 1_000_000));
        assertGt(market.lastNtlPos(), market.lastWeightedNtl());

        reg.setWeighted(whale, 10_002, true);
        _setLeg(whale, 10_002, 500, 3_000_000);
        _setMargin(whale, 1, 0, _ntl(500, 3_000_000));
        skip(60);
        _settle(both);
        assertEq(market.lastPnl(), 500 * 1_000_000, "once weighted, pnl is prev size * mark delta");
    }
}
