// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Season0Test} from "./Season0Test.sol";
import {Season0} from "../src/Season0.sol";
import {WalletMarket} from "../src/WalletMarket.sol";
import {WalletRegistry} from "../src/WalletRegistry.sol";

/// @notice House seed: play points on both sides, inert, and kept out of player balances.
contract HouseTest is Season0Test {
    function test_listingSeedsBothSidesAndDoesNotCreditTheHouseBalance() public view {
        assertEq(market.tailPot(), Season0.HOUSE_SEED);
        assertEq(market.fadePot(), Season0.HOUSE_SEED);
        assertEq(market.tailSupply(), Season0.HOUSE_SEED);
        assertEq(market.fadeSupply(), Season0.HOUSE_SEED);
        assertEq(market.navOf(WalletMarket.Side.Tail), Season0.UNIT);
        assertEq(market.navOf(WalletMarket.Side.Fade), Season0.UNIT);
        assertEq(market.sharesOf(Season0.HOUSE, WalletMarket.Side.Tail), Season0.HOUSE_SEED);
        assertEq(market.sharesOf(Season0.HOUSE, WalletMarket.Side.Fade), Season0.HOUSE_SEED);
        assertEq(reg.points(Season0.HOUSE), 0);
        assertEq(reg.houseMinted(), Season0.HOUSE_SEED * 2);
        assertEq(reg.houseSeedPerSide(), Season0.HOUSE_SEED);
    }

    function test_houseCannotClaimTradeOrCancel() public {
        vm.prank(Season0.HOUSE);
        vm.expectRevert(WalletRegistry.HouseInert.selector);
        reg.claimSeason0();

        vm.prank(Season0.HOUSE);
        vm.expectRevert(WalletMarket.HouseInert.selector);
        market.queueBuy(WalletMarket.Side.Tail, 1);

        vm.prank(Season0.HOUSE);
        vm.expectRevert(WalletMarket.HouseInert.selector);
        market.queueSell(WalletMarket.Side.Fade, 1);

        vm.prank(Season0.HOUSE);
        vm.expectRevert(WalletMarket.HouseInert.selector);
        market.cancel(0);

        assertEq(reg.points(Season0.HOUSE), 0);
        assertEq(market.sharesOf(Season0.HOUSE, WalletMarket.Side.Tail), Season0.HOUSE_SEED);
    }

    function test_tradingFeeDoesNotMintHouseShares() public {
        _book(1000, 1_000_000, 30_000e6);
        uint256 houseShares = market.sharesOf(Season0.HOUSE, WalletMarket.Side.Tail);
        vm.prank(alice);
        market.queueBuy(WalletMarket.Side.Tail, 10_000e6);
        _settle();

        assertEq(market.sharesOf(Season0.HOUSE, WalletMarket.Side.Tail), houseShares);
        assertEq(reg.protocolFees(), 50e6);
        assertEq(market.tailPot(), Season0.HOUSE_SEED + 9_950e6);
        assertEq(reg.points(Season0.HOUSE), 0);
    }

    function test_balancedHouseIsFlatWhenThePotMoves() public {
        _book(1000, 1_000_000, 1_000_000e6);
        _settle();
        uint256 before = _houseValue(market);
        uint256 sum = market.tailPot() + market.fadePot();

        _book(1000, 1_000_000 + 250_000_000, 1_000_000e6);
        skip(60);
        _settle();

        assertGt(market.lastDelta(), 0);
        assertEq(market.tailPot() + market.fadePot(), sum);
        assertEq(_houseValue(market), before, "equal house inventory is zero-sum");
        assertEq(market.sharesOf(Season0.HOUSE, WalletMarket.Side.Tail), Season0.HOUSE_SEED);
        assertEq(market.sharesOf(Season0.HOUSE, WalletMarket.Side.Fade), Season0.HOUSE_SEED);
        assertEq(reg.points(Season0.HOUSE), 0);
    }

    function test_topUpMintsAtNavAndLeavesPlayerValue() public {
        _book(1000, 1_000_000, 30_000e6);
        vm.prank(alice);
        market.queueBuy(WalletMarket.Side.Tail, 10_000e6);
        _settle();

        uint256 shares = market.sharesOf(alice, WalletMarket.Side.Tail);
        uint256 valueBefore = shares * market.tailPot() / market.tailSupply();
        uint256 houseBefore = market.sharesOf(Season0.HOUSE, WalletMarket.Side.Tail);

        reg.topUpHouse(whale, WalletMarket.Side.Tail, 5_000e6);

        uint256 valueAfter = shares * market.tailPot() / market.tailSupply();
        assertApproxEqAbs(valueAfter, valueBefore, 1, "top-up does not move the player's points");
        assertGt(market.sharesOf(Season0.HOUSE, WalletMarket.Side.Tail), houseBefore);
        assertEq(reg.points(Season0.HOUSE), 0);
        assertEq(reg.houseMinted(), Season0.HOUSE_SEED * 2 + 5_000e6);
    }

    function test_seedChangeAppliesToTheNextListingOnly() public {
        uint256 seeded = market.tailPot();
        reg.setHouseSeed(1_000e6);
        assertEq(market.tailPot(), seeded);

        WalletMarket later = _list("LATER", 0xBEE);
        assertEq(later.tailPot(), 1_000e6);
        assertEq(later.fadePot(), 1_000e6);
        assertEq(market.tailPot(), seeded);
    }

    function test_zeroSeedStillLocksTheFirstPoint() public {
        reg.setHouseSeed(0);
        address who = vm.addr(0xE0);
        _setExists(who, true);
        WalletMarket empty = WalletMarket(reg.addWallet(who, new address[](0), "EMPTY", "Empty", _dex0(), _weightEth()));
        assertEq(empty.tailPot(), 0);
        assertEq(empty.sharesOf(Season0.HOUSE, WalletMarket.Side.Tail), 0);

        _setLeg(who, ETH_PERP, 1000, 1_000_000);
        _setMargin(who, 0, 30_000e6, _ntl(1000, 1_000_000));
        vm.prank(alice);
        empty.queueBuy(WalletMarket.Side.Tail, 10_000e6);
        empty.settle(_one());
        _assertConserved();

        assertEq(empty.sharesOf(address(1), WalletMarket.Side.Tail), Season0.MIN_LIQUIDITY);
        assertEq(empty.sharesOf(alice, WalletMarket.Side.Tail), 9_949e6);
    }

    function test_houseAmountIsCappedAndOwnerOnly() public {
        vm.expectRevert(WalletRegistry.HouseAmount.selector);
        reg.setHouseSeed(Season0.MAX_HOUSE_POINTS + 1);
        vm.expectRevert(WalletRegistry.HouseAmount.selector);
        reg.topUpHouse(whale, WalletMarket.Side.Fade, 0);
        vm.expectRevert(WalletRegistry.HouseAmount.selector);
        reg.topUpHouse(whale, WalletMarket.Side.Fade, Season0.MAX_HOUSE_POINTS + 1);

        vm.prank(alice);
        vm.expectRevert(WalletRegistry.NotOwner.selector);
        reg.topUpHouse(whale, WalletMarket.Side.Fade, 1e6);
    }

    function test_drainedSideFloorsAboveZeroAndHouseSharesStay() public {
        _book(1000, 1_000_000, 1_000_000e6);
        _settle();

        uint64 mark = 1_000_000;
        uint256 ts = vm.getBlockTimestamp();
        for (uint256 day; market.fadePot() >= 4 && day < 80; ++day) {
            for (uint256 step; step < 2; ++step) {
                mark += 250_000_000;
                _book(1000, mark, 1_000_000e6);
                ts += 60;
                vm.warp(ts);
                _settle();
            }
            ts = (ts / 1 days + 1) * 1 days;
            vm.warp(ts);
        }

        assertGt(market.fadePot(), 0, "integer capacity cannot move the last units");
        assertLt(market.fadePot(), 100);
        assertEq(market.sharesOf(Season0.HOUSE, WalletMarket.Side.Fade), Season0.HOUSE_SEED);
        assertEq(reg.points(Season0.HOUSE), 0);

        uint256 stuck = market.fadePot();
        mark += 250_000_000;
        _book(1000, mark, 1_000_000e6);
        ts += 60;
        vm.warp(ts);
        _settle();
        assertEq(market.fadePot(), stuck);
        assertEq(market.lastDelta(), 0);

        vm.prank(bob);
        market.queueBuy(WalletMarket.Side.Fade, 1_000e6);
        skip(60);
        _settle();
        assertGt(market.sharesOf(bob, WalletMarket.Side.Fade), 0);
        assertEq(market.sharesOf(Season0.HOUSE, WalletMarket.Side.Fade), Season0.HOUSE_SEED);
    }

    /// @dev Settlement cannot zero a pot. This forces that state to check the restart path.
    function test_topUpRestartsAZeroPotWithoutPayingTheHouseAClaim() public {
        assertEq(market.tailPot(), Season0.HOUSE_SEED);
        vm.store(address(market), bytes32(uint256(8)), bytes32(uint256(0)));
        assertEq(market.tailPot(), 0);

        uint256 supplyBefore = market.tailSupply();
        reg.topUpHouse(whale, WalletMarket.Side.Tail, 5_000e6);

        assertEq(market.tailPot(), 5_000e6);
        assertEq(market.sharesOf(Season0.HOUSE, WalletMarket.Side.Tail), supplyBefore + 5_000e6);
        assertEq(market.tailSupply(), supplyBefore + 5_000e6);
        assertEq(reg.points(Season0.HOUSE), 0);
        assertEq(_houseValue(market), market.tailPot() + market.fadePot());
    }

    function test_optOutLeavesHouseSharesAndRefusesATopUp() public {
        _book(7500, 2_000_000, 30_000e6);
        vm.prank(alice);
        market.queueBuy(WalletMarket.Side.Tail, 4_000e6);
        vm.prank(bob);
        market.queueBuy(WalletMarket.Side.Fade, 4_000e6);
        _settle();

        reg.optOut(whale, _optOutSig());
        vm.expectRevert(WalletMarket.Closed.selector);
        reg.topUpHouse(whale, WalletMarket.Side.Tail, 1_000e6);
        assertEq(market.sharesOf(Season0.HOUSE, WalletMarket.Side.Tail), Season0.HOUSE_SEED);
        assertEq(reg.points(Season0.HOUSE), 0);

        _book(7500, 1_000_000, 30_000e6);
        skip(60);
        _settle();
        assertEq(uint256(market.status()), uint256(WalletMarket.Status.RedeemOnly));

        uint256 bobShares = market.sharesOf(bob, WalletMarket.Side.Fade);
        vm.prank(bob);
        market.queueSell(WalletMarket.Side.Fade, bobShares);
        _settle();
        assertEq(market.sharesOf(bob, WalletMarket.Side.Fade), 0);
        assertGt(reg.points(bob), 0);
        assertEq(market.sharesOf(Season0.HOUSE, WalletMarket.Side.Fade), Season0.HOUSE_SEED);
        assertGt(market.fadePot(), 0, "house inventory stays in the pot after players leave");

        vm.prank(Season0.HOUSE);
        vm.expectRevert(WalletMarket.HouseInert.selector);
        market.queueSell(WalletMarket.Side.Fade, Season0.HOUSE_SEED);
    }

    function _houseValue(WalletMarket m) internal view returns (uint256) {
        return _sideValue(m, WalletMarket.Side.Tail) + _sideValue(m, WalletMarket.Side.Fade);
    }

    function _sideValue(WalletMarket m, WalletMarket.Side side) internal view returns (uint256) {
        uint256 shares = m.sharesOf(Season0.HOUSE, side);
        uint256 pot = side == WalletMarket.Side.Tail ? m.tailPot() : m.fadePot();
        uint256 sup = side == WalletMarket.Side.Tail ? m.tailSupply() : m.fadeSupply();
        if (sup == 0) return 0;
        return shares * pot / sup;
    }

    function _list(string memory ticker, uint256 salt) internal returns (WalletMarket listed) {
        address who = vm.addr(salt);
        _setExists(who, true);
        listed = WalletMarket(reg.addWallet(who, new address[](0), ticker, ticker, _dex0(), _weightEth()));
    }
}
