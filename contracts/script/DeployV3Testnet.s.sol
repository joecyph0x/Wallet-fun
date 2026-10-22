// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {RegistryProxy} from "../src/v3/BeaconProxy.sol";
import {WalletMarketV3} from "../src/v3/WalletMarketV3.sol";
import {WalletRegistryV3} from "../src/v3/WalletRegistryV3.sol";
import {TestUSDC} from "../src/v3/testnet/TestUSDC.sol";
import {WalletRegistryV3Testnet} from "../src/v3/testnet/WalletRegistryV3Testnet.sol";

/// @title DeployV3Testnet
/// @notice HyperEVM TESTNET (998) only. Deploys TestUSDC (open 1,000-per-call faucet),
///         the v3 market implementation, the testnet registry logic, and the registry
///         proxy (which creates the beacon). Listing is a separate cast step, because
///         forge's simulator has no HyperCore precompiles.
///
///         Reads DEPLOYER_PRIVATE_KEY from the environment. Owner, guardian, and fee
///         wallet default to the deployer. USDC=0x... reuses an existing TestUSDC.
///
///             forge script script/DeployV3Testnet.s.sol --rpc-url hyperevm_testnet \
///               --broadcast --slow --disable-block-gas-limit
///
///         The market implementation is over the 3,000,000-gas small block, so the
///         deployer needs big blocks on (evmUserModify usingBigBlocks=true) first.
contract DeployV3Testnet is Script {
    function run() external {
        require(block.chainid == 998, "DeployV3Testnet is HyperEVM testnet (998) only");
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address me = vm.addr(pk);
        address owner = vm.envOr("OWNER", me);
        address guardian = vm.envOr("GUARDIAN", me);
        address feeWallet = vm.envOr("FEE_WALLET", me);
        address usdc = vm.envOr("USDC", address(0));

        vm.startBroadcast(pk);
        if (usdc == address(0)) usdc = address(new TestUSDC());
        WalletMarketV3 impl = new WalletMarketV3();
        WalletRegistryV3Testnet logic = new WalletRegistryV3Testnet();
        RegistryProxy proxy = new RegistryProxy(
            address(logic),
            abi.encodeWithSelector(WalletRegistryV3.initialize.selector, owner, guardian, feeWallet, usdc, address(impl))
        );
        vm.stopBroadcast();

        console2.log("usdc", usdc);
        console2.log("market implementation", address(impl));
        console2.log("registry logic", address(logic));
        console2.log("registry", address(proxy));
        console2.log("beacon", address(WalletRegistryV3(address(proxy)).beacon()));
    }
}
