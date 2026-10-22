// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {Config} from "../src/v3/Config.sol";
import {RegistryProxy} from "../src/v3/BeaconProxy.sol";
import {WalletMarketV3} from "../src/v3/WalletMarketV3.sol";
import {WalletRegistryV3} from "../src/v3/WalletRegistryV3.sol";

/// @title DeployV3
/// @notice Deploys the v3 registry proxy, market implementation, and beacon.
///
///         Disabled unless ENABLE_V3_DEPLOY=true. This PR does not broadcast it,
///         and it refuses every chain except HyperEVM mainnet (999).
///         It reads DEPLOYER_PRIVATE_KEY, OWNER, GUARDIAN, and FEE_WALLET from the
///         environment. USDC defaults to the mainnet Circle address. The key is
///         not printed.
///
///         Not part of `forge test` or CI. Do not run it until the contracts have
///         an independent review.
///
///             ENABLE_V3_DEPLOY=true forge script script/DeployV3.s.sol \
///               --rpc-url https://rpc.hyperliquid.xyz/evm --broadcast --slow \
///               --disable-block-gas-limit
contract DeployV3 is Script {
    function run() external {
        require(block.chainid == 999, "v3 deploy script is HyperEVM mainnet (999) only");
        require(vm.envOr("ENABLE_V3_DEPLOY", false), "v3 mainnet deploy is disabled; this PR does not broadcast");

        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address owner = vm.envAddress("OWNER");
        address guardian = vm.envAddress("GUARDIAN");
        address feeWallet = vm.envAddress("FEE_WALLET");
        address usdc = vm.envOr("USDC", Config.MAINNET_USDC);

        vm.startBroadcast(pk);
        WalletMarketV3 impl = new WalletMarketV3();
        WalletRegistryV3 logic = new WalletRegistryV3();
        RegistryProxy proxy = new RegistryProxy(
            address(logic),
            abi.encodeWithSelector(WalletRegistryV3.initialize.selector, owner, guardian, feeWallet, usdc, address(impl))
        );
        vm.stopBroadcast();

        console2.log("registry", address(proxy));
        console2.log("market implementation", address(impl));
        console2.log("usdc", usdc);
    }
}
