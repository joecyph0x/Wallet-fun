// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Config} from "../../src/v3/Config.sol";
import {WalletMarketV3} from "../../src/v3/WalletMarketV3.sol";
import {V3Test} from "./V3.t.sol";

/// @notice Random buy, sell, cancel, settle, pause/exit, and opt-out. USDC held stays equal to what is owed.
contract V3SolvencyInvariant is Test {
    V3Test internal env;

    function setUp() public {
        env = new V3Test();
        env.setUp();
        bytes4[] memory selectors = new bytes4[](6);
        selectors[0] = env.actBuy.selector;
        selectors[1] = env.actSell.selector;
        selectors[2] = env.actCancel.selector;
        selectors[3] = env.actSettle.selector;
        selectors[4] = env.actPauseOrExit.selector;
        selectors[5] = env.actOptOut.selector;
        targetContract(address(env));
        targetSelector(FuzzSelector({addr: address(env), selectors: selectors}));
    }

    function invariant_usdcHeldEqualsOwed() public view {
        assertEq(env.usdc().balanceOf(address(env.reg())), env.reg().liabilities());
    }

    function invariant_pauseDelayIsTheConfigDelay() public pure {
        assertEq(Config.EXIT_DELAY, 72 hours);
    }
}
