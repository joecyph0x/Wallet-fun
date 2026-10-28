// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {Config} from "../src/v3/Config.sol";
import {RegistryProxy} from "../src/v3/BeaconProxy.sol";
import {WalletMarketV3} from "../src/v3/WalletMarketV3.sol";
import {WalletRegistryV3} from "../src/v3/WalletRegistryV3.sol";

interface ISafeThreshold {
    function getThreshold() external view returns (uint256);
}

/// @title DeployV3
/// @notice Deploys the v3 registry proxy, market implementation, and beacon on HyperEVM mainnet.
///
///         Disabled unless ENABLE_V3_DEPLOY=true. This does not broadcast by itself.
///         It refuses every chain except 999.
///
///         OWNER must be a Safe (a contract whose getThreshold() is at least 2).
///         GUARDIAN must be set, and must not be OWNER or the deployer.
///         FEE_WALLET defaults to OWNER when unset.
///
///         Big blocks are for the deployer key only, and only for this deploy.
///         Turn them on with `python3 script/big_blocks.py on --mainnet`, deploy, then
///         `python3 script/big_blocks.py off --mainnet`. Do not enable them for the
///         keeper or the owner Safe.
///
///             ENABLE_V3_DEPLOY=true forge script script/DeployV3.s.sol \
///               --rpc-url https://rpc.hyperliquid.xyz/evm --broadcast --slow \
///               --disable-block-gas-limit
contract DeployV3 is Script {
    function run() external {
        require(block.chainid == 999, "v3 deploy script is HyperEVM mainnet (999) only");
        require(vm.envOr("ENABLE_V3_DEPLOY", false), "v3 mainnet deploy is disabled; this PR does not broadcast");

        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address owner = vm.envAddress("OWNER");
        address guardian = vm.envAddress("GUARDIAN");
        address feeWallet = vm.envOr("FEE_WALLET", owner);
        address usdc = vm.envOr("USDC", Config.MAINNET_USDC);

        require(owner.code.length != 0, "OWNER must be a contract");
        require(owner != deployer, "OWNER must not be the deployer");
        require(guardian != address(0), "GUARDIAN is required");
        require(guardian != owner, "GUARDIAN must not be OWNER");
        require(guardian != deployer, "GUARDIAN must not be the deployer");
        require(ISafeThreshold(owner).getThreshold() >= 2, "OWNER Safe threshold must be at least 2");

        vm.startBroadcast(pk);
        WalletMarketV3 impl = new WalletMarketV3();
        WalletRegistryV3 logic = new WalletRegistryV3();
        RegistryProxy proxy = new RegistryProxy(
            address(logic),
            abi.encodeWithSelector(WalletRegistryV3.initialize.selector, owner, guardian, feeWallet, usdc, address(impl))
        );
        vm.stopBroadcast();

        WalletRegistryV3 reg = WalletRegistryV3(address(proxy));
        require(reg.owner() == owner, "owner");
        require(reg.guardian() == guardian, "guardian");
        require(reg.feeWallet() == feeWallet, "fee wallet");
        require(reg.feeBps() == 25, "fee bps");
        require(reg.maxPotPerSide() == 0, "cap");

        console2.log("registry proxy", address(proxy));
        console2.log("registry logic", address(logic));
        console2.log("market implementation", address(impl));
        console2.log("beacon", address(reg.beacon()));
        console2.log("usdc", usdc);

        string memory json = "deploy";
        vm.serializeUint(json, "chainId", 999);
        vm.serializeAddress(json, "registry", address(proxy));
        vm.serializeAddress(json, "registryLogic", address(logic));
        vm.serializeAddress(json, "marketImplementation", address(impl));
        vm.serializeAddress(json, "beacon", address(reg.beacon()));
        vm.serializeAddress(json, "usdc", usdc);
        vm.serializeAddress(json, "owner", owner);
        vm.serializeAddress(json, "guardian", guardian);
        vm.serializeAddress(json, "feeWallet", feeWallet);
        vm.serializeUint(json, "feeBps", reg.feeBps());
        string memory out = vm.serializeUint(json, "maxPotPerSide", reg.maxPotPerSide());
        vm.writeJson(out, "deployments/999.json");
        console2.log("wrote deployments/999.json");
    }
}
