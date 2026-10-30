// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {WalletRegistryV3} from "../src/v3/WalletRegistryV3.sol";

/// @title PendingCheck
/// @notice Read-only. Prints the owner, guardian, and any timelocked change
///         before someone signs. Does not broadcast.
///
///             REGISTRY=0x... forge script script/PendingCheck.s.sol --rpc-url <url>
contract PendingCheck is Script {
    function run() external view {
        WalletRegistryV3 reg = WalletRegistryV3(vm.envAddress("REGISTRY"));
        console2.log("owner", reg.owner());
        console2.log("guardian", reg.guardian());
        console2.log("feeWallet", reg.feeWallet());
        console2.log("feeBps", reg.feeBps());
        console2.log("maxPotPerSide", reg.maxPotPerSide());
        bytes memory pending = reg.pendingData();
        uint256 eta = reg.pendingEta();
        if (eta == 0 || pending.length < 4) {
            console2.log("pending: none");
            return;
        }
        bytes4 sel = bytes4(pending);
        console2.log("pending selector");
        console2.logBytes4(sel);
        console2.log("pending eta", eta);
        console2.log("seconds left", eta > block.timestamp ? eta - block.timestamp : 0);
        if (sel == reg.OP_OWNER()) console2.log("op: replace owner");
        else if (sel == reg.OP_GUARDIAN()) console2.log("op: replace guardian (owner must cancel this; the guardian cannot)");
        else if (sel == reg.OP_FEE()) console2.log("op: set fee");
        else if (sel == reg.OP_BEACON()) console2.log("op: upgrade beacon");
        else if (sel == reg.OP_REGISTRY()) console2.log("op: upgrade registry");
        else if (sel == reg.OP_LIST()) console2.log("op: list whale");
        else console2.log("op: other timelocked change");
    }
}
