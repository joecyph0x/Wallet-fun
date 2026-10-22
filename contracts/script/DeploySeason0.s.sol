// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {HyperCoreReader} from "../src/HyperCoreReader.sol";
import {WalletRegistry} from "../src/WalletRegistry.sol";

/// @title DeploySeason0
/// @notice Deploys the whalewallet.fun Season 0 registry to HyperEVM testnet (chain id 998)
///         and lists the curated wallets in script/whales.json.
///
///         This script is not part of `forge test` and is not run in CI.
///         It reads DEPLOYER_PRIVATE_KEY from the environment. Do not commit a key.
///         It does not send anything to mainnet.
///
///         Set WRITE_DEPLOYMENT=1 to overwrite contracts/deployments/998.json, which is
///         the address book the web app and the keeper read. A dry run does not write it.
///
///             export DEPLOYER_PRIVATE_KEY=0x...    # testnet key only, never commit it
///             cd contracts
///             WRITE_DEPLOYMENT=1 forge script script/DeploySeason0.s.sol \
///               --rpc-url hyperevm_testnet --broadcast --slow
///
///         Pass REGISTRY=0x... to skip the create and only list wallets on an
///         existing registry owned by that key.
contract DeploySeason0 is Script {
    struct Listed {
        address whale;
        address market;
        string ticker;
        string name;
        string listError;
    }

    /// @dev Called by the test suite. `run` refuses every chain except 998.
    function assertTestnet() public view {
        require(block.chainid == 998, "Season 0 deploy is HyperEVM testnet only (chain id 998)");
    }

    function run() external {
        assertTestnet();
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address existing = vm.envOr("REGISTRY", address(0));

        WalletRegistry reg;
        if (existing == address(0)) {
            vm.startBroadcast(pk);
            reg = new WalletRegistry(deployer, deployer);
            vm.stopBroadcast();
        } else {
            reg = WalletRegistry(existing);
        }

        uint32 weighted = _weightedPerp();
        Listed[] memory listed = _seed(reg, pk, weighted);
        console2.log("deployer", deployer);
        console2.log("WalletRegistry", address(reg));
        console2.log("WalletMarket implementation", reg.implementation());
        console2.log("weighted testnet ETH perp", uint256(weighted));
        for (uint256 i; i < listed.length; ++i) {
            console2.log(listed[i].ticker, listed[i].market);
            if (bytes(listed[i].listError).length != 0) console2.log("  listError", listed[i].listError);
        }

        if (vm.envOr("WRITE_DEPLOYMENT", false)) {
            _write(reg, deployer, weighted, listed);
            console2.log("wrote contracts/deployments/998.json");
        }
    }

    function _seed(WalletRegistry reg, uint256 pk, uint32 weighted) internal returns (Listed[] memory listed) {
        string memory raw = vm.readFile("script/whales.json");
        uint256 n = vm.parseJsonUint(raw, ".count");
        listed = new Listed[](n);
        uint32[] memory dexes = _dex0();
        uint32[] memory weights = _one(weighted);
        for (uint256 i; i < n; ++i) {
            string memory base = string.concat(".whales[", vm.toString(i), "]");
            Listed memory row;
            row.whale = vm.parseJsonAddress(raw, string.concat(base, ".whale"));
            row.ticker = vm.parseJsonString(raw, string.concat(base, ".ticker"));
            row.name = vm.parseJsonString(raw, string.concat(base, ".name"));
            (address market,,) = reg.listings(row.whale);
            if (market != address(0)) {
                row.market = market;
            } else if (!_coreExists(row.whale)) {
                row.listError = "NoCoreUser";
            } else {
                vm.startBroadcast(pk);
                row.market = reg.addWallet(row.whale, new address[](0), row.ticker, row.name, dexes, weights);
                vm.stopBroadcast();
            }
            listed[i] = row;
        }
    }

    function _coreExists(address user) internal view returns (bool) {
        (bool ok, bytes memory ret) = HyperCoreReader.CORE_USER_EXISTS.staticcall(abi.encode(user));
        if (!ok || ret.length == 0) return false;
        return abi.decode(ret, (bool));
    }

    function _weightedPerp() internal view returns (uint32) {
        string memory raw = vm.readFile("script/whales.json");
        return uint32(vm.parseJsonUint(raw, ".weightedPerps[0]"));
    }

    function _dex0() internal pure returns (uint32[] memory dexes) {
        dexes = new uint32[](1);
        dexes[0] = 0;
    }

    function _one(uint32 perp) internal pure returns (uint32[] memory w) {
        w = new uint32[](1);
        w[0] = perp;
    }

    function _write(WalletRegistry reg, address deployer, uint32 weighted, Listed[] memory listed) internal {
        string memory wallets = "[";
        for (uint256 i; i < listed.length; ++i) {
            if (i != 0) wallets = string.concat(wallets, ",");
            wallets = string.concat(
                wallets,
                '{"ticker":"',
                listed[i].ticker,
                '","name":"',
                listed[i].name,
                '","whale":"',
                vm.toString(listed[i].whale),
                '","market":"',
                vm.toString(listed[i].market),
                '","weightedPerps":[',
                vm.toString(weighted),
                '],"listError":"',
                listed[i].listError,
                '"}'
            );
        }
        wallets = string.concat(wallets, "]");
        string memory out = string.concat(
            '{"chainId":998,"name":"HyperEVM Testnet","rpcUrl":"https://rpc.hyperliquid-testnet.xyz/evm","infoApi":"https://api.hyperliquid-testnet.xyz/info","explorer":"https://testnet.purrsec.com","heartbeatSec":60,"pollSec":15,"nativeCurrency":{"name":"HYPE","symbol":"HYPE","decimals":18},"registry":"',
            vm.toString(address(reg)),
            '","implementation":"',
            vm.toString(reg.implementation()),
            '","deployer":"',
            vm.toString(deployer),
            '","deployedAt":',
            vm.toString(block.timestamp),
            ',"note":"Written by DeploySeason0. A zero market means that wallet was not listed.","wallets":',
            wallets,
            "}"
        );
        vm.writeFile("deployments/998.json", out);
    }
}
