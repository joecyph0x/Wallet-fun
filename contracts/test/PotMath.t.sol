// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Season0} from "../src/Season0.sol";
import {PotMath} from "../src/PotMath.sol";

contract PotMathTest is Test {
    /// @dev 3,600 ETH with szDecimals 4 is szi = 36,000,000.
    ///      A $1 mark move is +100 raw (10^(6-4)). PnL is $3,600 in 6-decimal USD.
    function test_pricePnl_matchesSzDecimalsIdentity() public pure {
        int256 pnl = PotMath.pricePnl(36_000_000, 248_860, 248_960);
        assertEq(pnl, 3_600e6);
        assertEq(PotMath.pricePnl(-36_000_000, 248_860, 248_960), -3_600e6);
    }

    function test_notional_matchesDollarValue() public pure {
        // 3,600 ETH * $2,488.60 = $8,958,960
        assertEq(PotMath.notional(36_000_000, 248_860), 8_958_960e6);
        assertEq(PotMath.notional(-36_000_000, 248_860), 8_958_960e6);
    }

    function test_hip3Index_xyzNvda() public pure {
        // Design doc: xyz is dex 1, NVDA meta index 2 → 10002. The 110002 order-id form is not used.
        assertEq(Season0.perpIndex(1, 2), 10_002);
        assertEq(Season0.dexOf(10_002), 1);
        assertEq(Season0.dexOf(1), 0);
    }

    function test_sampleAndDailyClamp() public pure {
        (int256 applied, int256 next) = PotMath.appliedReturnBps(80_000e6, 100_000e6, 0);
        assertEq(applied, 2_500);
        assertEq(next, 2_500);

        (applied, next) = PotMath.appliedReturnBps(25_000e6, 100_000e6, 4_000);
        assertEq(applied, 1_000);
        assertEq(next, 5_000);

        (applied, next) = PotMath.appliedReturnBps(25_000e6, 100_000e6, 5_000);
        assertEq(applied, 0);
        assertEq(next, 5_000);

        (applied, next) = PotMath.appliedReturnBps(-25_000e6, 100_000e6, 5_000);
        assertEq(applied, -2_500);
        assertEq(next, 2_500);
    }

    function test_capacityIsTheTightestBound() public pure {
        assertEq(PotMath.capacity(100e6, 80e6, 1_000e6), 80e6);
        // alpha * eRef = 250e6, both pots larger, so the equity cap binds.
        assertEq(PotMath.capacity(1_000e6, 1_000e6, 1_000e6), 250e6);
        assertEq(PotMath.capacity(0, 1_000e6, 1_000e6), 0);
    }

    function test_zeroEquityReturnIsZero() public pure {
        (int256 applied, int256 next) = PotMath.appliedReturnBps(1_000e6, 0, 100);
        assertEq(applied, 0);
        assertEq(next, 100);
    }
}
