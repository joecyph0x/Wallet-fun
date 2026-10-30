// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/Test.sol";
import {V3Test} from "./V3.t.sol";
import {Config} from "../../src/v3/Config.sol";
import {WalletMarketV3} from "../../src/v3/WalletMarketV3.sol";
import {WalletRegistryV3} from "../../src/v3/WalletRegistryV3.sol";

/// @notice Regression tests from the v3 security scan. Each exploit must fail.
contract ScanPoC is V3Test {
    /// @dev H-1. An open sell must not let the other holder exit for more than their share of the pot.
    function test_scan_exitOverpaysWhenOthersHaveOpenSells() public {
        _enter(alice, WalletMarketV3.Side.Tail, 2_000e6);
        _enter(bob, WalletMarketV3.Side.Tail, 2_000e6);

        uint256 pot = market.tailPot();
        uint256 totalShares = market.tailSupply();
        uint256 aShares = market.sharesOf(alice, WalletMarketV3.Side.Tail);
        uint256 bShares = market.sharesOf(bob, WalletMarketV3.Side.Tail);
        uint256 fairAlice = aShares * pot / totalShares;
        uint256 fairBob = bShares * pot / totalShares;
        vm.prank(bob);
        market.sell(WalletMarketV3.Side.Tail, bShares, _one());

        reg.setBuysPaused(true);
        vm.warp(market.lastSettleTs() + Config.EXIT_DELAY);

        uint256 a0 = reg.balanceOf(alice);
        vm.prank(alice);
        market.exitAtLastNav();
        uint256 alicePaid = reg.balanceOf(alice) - a0;
        assertLe(alicePaid, fairAlice, "alice must not be overpaid");
        assertEq(alicePaid, fairAlice, "alice is paid her pro-rata share");

        uint256 b0 = reg.balanceOf(bob);
        vm.prank(bob);
        market.exitAtLastNav();
        uint256 bobPaid = reg.balanceOf(bob) - b0;
        assertLe(bobPaid, fairBob, "bob must not be overpaid");
        _assertSolvent();
    }

    /// @dev M-1. A settle that would store more than 32 snaps reverts, and the market still settles.
    function test_scan_snapshotOverflowBricksSettlement() public {
        _seedBook();
        uint256 total;
        for (uint32 p = 1; p <= 40; ++p) {
            int64 szi = p <= 32 ? int64(100) : int64(1);
            _setLeg(whale, p, szi, 3_000e6);
            total += uint256(int256(szi)) * 3_000e6;
        }
        _setMargin(whale, 0, 30_000e6, uint64(total));
        WalletMarketV3.Asset[] memory big = new WalletMarketV3.Asset[](32);
        for (uint32 i; i < 32; ++i) big[i] = WalletMarketV3.Asset(0, i + 1);
        _tick();
        assertTrue(market.settleIfDue(big), "32 big legs cover >99%");

        WalletMarketV3.Asset[] memory dust = new WalletMarketV3.Asset[](8);
        for (uint32 i; i < 8; ++i) dust[i] = WalletMarketV3.Asset(0, 33 + i);
        _tick();
        vm.expectRevert(WalletMarketV3.TooManyAssets.selector);
        market.settleIfDue(dust);

        assertTrue(market.settleIfDue(big), "the griefing settle is not stored");
        vm.prank(alice);
        market.claim(_one());
        _assertSolvent();
    }

    /// @dev M-2. Enabling a dex adds it to the margin list. Duplicates are rejected.
    function test_scan_dexListStaysInSyncAndDuplicatesRevert() public {
        vm.prank(address(reg));
        market.applyDex(1, true);
        assertTrue(market.dexEnabled(1));
        assertEq(market.dexCount(), 2);
        assertEq(market.dexes(1), 1);

        vm.prank(address(reg));
        market.applyDex(1, false);
        assertFalse(market.dexEnabled(1));
        assertEq(market.dexCount(), 2, "disabled dex stays listed but is skipped");

        vm.prank(address(reg));
        vm.expectRevert(WalletMarketV3.BadAmount.selector);
        market.addMember(address(0));
        vm.prank(address(reg));
        vm.expectRevert(WalletMarketV3.BadAmount.selector);
        market.addMember(whale);
    }

    /// @dev L-2. The guardian can clear a scheduled upgrade. A stranger cannot.
    function test_scan_guardianCanCancelTimelock() public {
        reg.schedule(abi.encodeWithSelector(reg.OP_GUARDIAN(), carol));
        _unlock();
        reg.execute();
        assertEq(reg.guardian(), carol);

        reg.schedule(abi.encodeWithSelector(reg.OP_FEE(), uint256(10)));
        assertGt(reg.pendingEta(), 0);
        vm.prank(bob);
        vm.expectRevert(WalletRegistryV3.NotGuardian.selector);
        reg.cancelPending();
        vm.prank(carol);
        reg.cancelPending();
        assertEq(reg.pendingEta(), 0);
    }

    /// @dev L-4. An upgrade target with no code is rejected.
    function test_scan_upgradeTargetMustHaveCode() public {
        reg.schedule(abi.encodeWithSelector(reg.OP_BEACON(), address(0x1234)));
        _unlock();
        vm.expectRevert(WalletRegistryV3.BadAddress.selector);
        reg.execute();
        reg.cancelPending();

        reg.schedule(abi.encodeWithSelector(reg.OP_REGISTRY(), address(0x1234)));
        _unlock();
        vm.expectRevert(WalletRegistryV3.BadAddress.selector);
        reg.execute();
    }

    /// @dev Gas sample for one due market inside settleMany. Logged, not a ceiling.
    function test_scan_settleManyGas() public {
        market.settleIfDue(_one());
        _tick();
        address[] memory ms = new address[](1);
        ms[0] = address(market);
        WalletMarketV3.Asset[][] memory books = new WalletMarketV3.Asset[][](1);
        books[0] = _one();
        uint256 g = gasleft();
        reg.settleMany(ms, books);
        console2.log("settleMany gas", g - gasleft());
    }
}
