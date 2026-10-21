// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {WalletRegistry} from "../src/WalletRegistry.sol";

/// @title DeploySeason0
/// @notice Deploys the whalewallet.fun Season 0 registry to HyperEVM testnet (chain id 998).
///
///         This script is not part of `forge test` and is not run in CI.
///         It reads DEPLOYER_PRIVATE_KEY from the environment. Do not commit a key.
///         It does not list wallets and does not send anything to mainnet.
///
///             export DEPLOYER_PRIVATE_KEY=0x...
///             forge script script/DeploySeason0.s.sol \
///               --rpc-url hyperevm_testnet --broadcast
///
///         Listing is a separate curator transaction after testnet HyperCore
///         accounts exist. The cold-launch set is documented in the root README.
contract DeploySeason0 is Script {
    function run() external returns (WalletRegistry reg) {
        require(block.chainid == 998, "Season 0 deploy is HyperEVM testnet only (chain id 998)");
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);

        vm.startBroadcast(pk);
        reg = new WalletRegistry(deployer, deployer);
        vm.stopBroadcast();

        console2.log("deployer", deployer);
        console2.log("WalletRegistry", address(reg));
        console2.log("WalletMarket implementation", reg.implementation());
    }
}
