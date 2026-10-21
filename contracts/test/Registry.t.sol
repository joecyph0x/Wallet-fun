// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Season0Test} from "./Season0Test.sol";
import {WalletMarket} from "../src/WalletMarket.sol";
import {WalletRegistry} from "../src/WalletRegistry.sol";
import {Season0} from "../src/Season0.sol";

contract RegistryTest is Season0Test {
    function test_claimOnceAndOnlyTheFaucetMints() public {
        assertEq(reg.points(alice), Season0.START_POINTS);
        vm.prank(alice);
        vm.expectRevert(WalletRegistry.AlreadyClaimed.selector);
        reg.claimSeason0();
        assertEq(reg.totalMinted(), Season0.START_POINTS * 2);
    }

    function test_randomAddressCannotMovePoints() public {
        vm.expectRevert(bytes("market"));
        reg.pullPoints(alice, 1);
        vm.expectRevert(bytes("market"));
        reg.pushPoints(alice, 1);
    }

    function test_optOutRefundsBuysAndWindsDownAtNav() public {
        _book(7500, 2_000_000, 30_000e6);
        vm.prank(alice);
        market.queueBuy(WalletMarket.Side.Tail, 10_000e6);
        vm.prank(bob);
        market.queueBuy(WalletMarket.Side.Fade, 10_000e6);
        _settle();

        // A buy queued after the position is known must be refunded, not filled, once the owner opts out.
        vm.prank(carol);
        reg.claimSeason0();
        vm.prank(carol);
        market.queueBuy(WalletMarket.Side.Tail, 1_000e6);

        uint256 carolBefore = reg.points(carol);
        reg.optOut(whale, _optOutSig());
        assertEq(reg.points(carol), carolBefore + 1_000e6);
        assertEq(uint256(market.status()), uint256(WalletMarket.Status.OptOutPending));

        vm.prank(carol);
        vm.expectRevert(WalletMarket.Closed.selector);
        market.queueBuy(WalletMarket.Side.Tail, 1e6);

        uint256 tailBefore = market.tailPot();
        _book(7500, 1_000_000, 30_000e6);
        skip(60);
        _settle();
        assertLt(market.tailPot(), tailBefore, "the final sample still applies price PnL");
        assertEq(uint256(market.status()), uint256(WalletMarket.Status.RedeemOnly));

        uint256 fadeShares = market.sharesOf(bob, WalletMarket.Side.Fade);
        uint256 potAfterFinal = market.fadePot();
        vm.prank(bob);
        market.queueSell(WalletMarket.Side.Fade, fadeShares);

        // A later mark crash must not move the pot. Sells flush immediately.
        _book(7500, 100_000, 30_000e6);
        int256 pnlBefore = market.lastPnl();
        _settle();
        assertEq(market.lastPnl(), pnlBefore);
        assertLt(market.fadePot(), potAfterFinal);
        assertGt(reg.points(bob), 0);

        vm.expectRevert(WalletRegistry.OptedOutAddress.selector);
        reg.addWallet(whale, new address[](0), "MACHI2", "nope", _dex0(), _weightEth());
    }

    function test_badOptOutSignatureDoesNotBlockTheWallet() public {
        uint256 other = 0xB0B;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(other, reg.hashOptOut(whale));
        vm.expectRevert();
        reg.optOut(whale, abi.encodePacked(r, s, v));
        assertFalse(reg.optedOut(whale));
    }

    function test_optOutIsBoundToThisChain() public {
        bytes memory sig = _optOutSig();
        vm.chainId(1);
        vm.expectRevert();
        reg.optOut(whale, sig);
        assertFalse(reg.optedOut(whale));
    }

    function test_unlistedWalletCanBeBlockedInAdvance() public {
        address sleeper = makeAddr("sleeper");
        uint256 pk = 0x51EE9;
        sleeper = vm.addr(pk);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, reg.hashOptOut(sleeper));
        reg.optOut(sleeper, abi.encodePacked(r, s, v));
        _setExists(sleeper, true);
        vm.expectRevert(WalletRegistry.OptedOutAddress.selector);
        reg.addWallet(sleeper, new address[](0), "SLEEP", "Sleeper", _dex0(), _weightEth());
    }

    function test_pauseBlocksSettleAndCancelStillWorks() public {
        _book(1000, 1_000_000, 30_000e6);
        vm.prank(alice);
        uint256 id = market.queueBuy(WalletMarket.Side.Tail, 2_000e6);

        reg.setGlobalPause(true);
        vm.expectRevert(WalletMarket.Paused.selector);
        market.settle(_one());
        vm.prank(alice);
        market.cancel(id);
        assertEq(reg.points(alice), 10_000e6);

        reg.setGlobalPause(false);
        vm.prank(alice);
        market.queueBuy(WalletMarket.Side.Tail, 2_000e6);
        reg.setWalletPause(whale, true);
        vm.expectRevert(WalletMarket.Paused.selector);
        market.settle(_one());
        reg.setWalletPause(whale, false);
        _settle();
        assertEq(market.settleCount(), 1);
    }

    function test_cannotListTwiceOrReuseATicker() public {
        vm.expectRevert(WalletRegistry.AlreadyListed.selector);
        reg.addWallet(whale, new address[](0), "MACHI", "again", _dex0(), _weightEth());

        address other = makeAddr("other");
        _setExists(other, true);
        vm.expectRevert(WalletRegistry.BadTicker.selector);
        reg.addWallet(other, new address[](0), "MACHI", "copy", _dex0(), _weightEth());
    }

    function test_listingRequiresACoreUser() public {
        address ghost = makeAddr("ghost");
        _setExists(ghost, false);
        vm.expectRevert(WalletRegistry.NoCoreUser.selector);
        reg.addWallet(ghost, new address[](0), "GHOST", "Ghost", _dex0(), _weightEth());
    }

    function test_epsBoundsAndDexZeroStaysOn() public {
        vm.expectRevert(bytes("eps"));
        reg.setEpsBps(whale, 5);
        reg.setEpsBps(whale, 200);
        assertEq(market.epsBps(), 200);

        vm.expectRevert(bytes("dex0"));
        reg.setDexEnabled(whale, 0, false);
    }

    function test_guardianPauseAndOwnership() public {
        address guardian = makeAddr("guardian");
        reg.setGuardian(guardian);
        vm.prank(guardian);
        reg.setGlobalPause(true);
        assertTrue(reg.globalPaused());
        vm.prank(guardian);
        vm.expectRevert(WalletRegistry.NotOwner.selector);
        reg.setEpsBps(whale, 100);

        address next = makeAddr("next-owner");
        reg.transferOwnership(next);
        vm.prank(next);
        reg.acceptOwnership();
        assertEq(reg.owner(), next);
    }
}
