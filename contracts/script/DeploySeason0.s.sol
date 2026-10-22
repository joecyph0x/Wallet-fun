// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {WalletRegistry} from "../src/WalletRegistry.sol";

/// @title DeploySeason0
/// @notice Deploys the whalewallet.fun Season 0 registry to HyperEVM testnet (chain id 998).
///
///         This script does not list wallets. Forge simulates the script locally, and that
///         simulator has no HyperCore precompiles, so a coreUserExists check inside the
///         script is false for every address and addWallet never gets broadcast.
///         Listing is contracts/script/list_whales.py, which sends addWallet with cast.
///         On chain the precompile returns the real bool.
///
///         The registry constructor also deploys the market implementation. That code
///         deposit is above the 3,000,000-gas small-block limit, so the deployer must
///         be in big-block mode and the script must be allowed to exceed the fork's
///         block gas limit:
///
///             WRITE_DEPLOYMENT=1 forge script script/DeploySeason0.s.sol \
///               --rpc-url hyperevm_testnet --broadcast --slow --disable-block-gas-limit
///
///         This script is not part of `forge test` and is not run in CI.
///         It reads DEPLOYER_PRIVATE_KEY from the environment. Do not commit a key.
///         It does not send anything to mainnet.
contract DeploySeason0 is Script {
    /// @dev Called by the test suite. `run` refuses every chain except 998.
    function assertTestnet() public view {
        require(block.chainid == 998, "Season 0 deploy is HyperEVM testnet only (chain id 998)");
    }

    function run() external returns (WalletRegistry reg) {
        assertTestnet();
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address existing = vm.envOr("REGISTRY", address(0));

        if (existing == address(0)) {
            vm.startBroadcast(pk);
            reg = new WalletRegistry(deployer, deployer);
            vm.stopBroadcast();
        } else {
            reg = WalletRegistry(existing);
        }

        console2.log("deployer", deployer);
        console2.log("WalletRegistry", address(reg));
        console2.log("WalletMarket implementation", reg.implementation());
        console2.log("List wallets with: python3 script/list_whales.py");

        if (vm.envOr("WRITE_DEPLOYMENT", false)) {
            _writeRegistry(reg, deployer);
            console2.log("updated registry fields in deployments/998.json");
        }
    }

    /// @dev Patches the registry, implementation, deployer, and deployedAt. Leaves wallet
    ///      rows alone, so a re-run cannot wipe market addresses that list_whales.py recorded.
    ///      deployedAt is the script block timestamp, so a fresh deploy stamps the file.
    function _writeRegistry(WalletRegistry reg, address deployer) internal {
        string memory path = "deployments/998.json";
        string memory raw = vm.readFile(path);
        raw = _replaceAddress(raw, "registry", address(reg));
        raw = _replaceAddress(raw, "implementation", reg.implementation());
        raw = _replaceAddress(raw, "deployer", deployer);
        raw = replaceUint(raw, "deployedAt", block.timestamp);
        vm.writeFile(path, raw);
    }

    /// @dev Replaces the decimal after `"key": ` (or the compact `"key":`). Digit length may change.
    function replaceUint(string memory raw, string memory key, uint256 value) public pure returns (string memory) {
        bytes memory data = bytes(raw);
        bytes memory needle = bytes(string.concat('"', key, '": '));
        bytes memory compact = bytes(string.concat('"', key, '":'));
        uint256 at = _find(data, needle);
        uint256 width = needle.length;
        if (at == type(uint256).max) {
            at = _find(data, compact);
            width = compact.length;
        }
        require(at != type(uint256).max, key);
        uint256 start = at + width;
        uint256 stop = start;
        while (stop < data.length && data[stop] >= hex"30" && data[stop] <= hex"39") {
            stop++;
        }
        require(stop > start, "num");
        return string(_splice(data, start, stop, bytes(vm.toString(value))));
    }

    function _splice(bytes memory data, uint256 start, uint256 stop, bytes memory insert)
        internal
        pure
        returns (bytes memory out)
    {
        out = new bytes(data.length - (stop - start) + insert.length);
        uint256 o;
        for (uint256 i; i < start; ++i) {
            out[o++] = data[i];
        }
        for (uint256 i; i < insert.length; ++i) {
            out[o++] = insert[i];
        }
        for (uint256 i = stop; i < data.length; ++i) {
            out[o++] = data[i];
        }
    }

    function _replaceAddress(string memory raw, string memory key, address value)
        internal
        pure
        returns (string memory)
    {
        bytes memory data = bytes(raw);
        bytes memory needle = bytes(string.concat('"', key, '": "'));
        // Also accept the compact form `"key":"`.
        bytes memory compact = bytes(string.concat('"', key, '":"'));
        uint256 at = _find(data, needle);
        uint256 width = needle.length;
        if (at == type(uint256).max) {
            at = _find(data, compact);
            width = compact.length;
        }
        require(at != type(uint256).max, key);
        uint256 end = at + width;
        // Addresses are 42 bytes (0x + 40 hex). `null` is not expected for these keys.
        require(end + 42 <= data.length, "addr");
        bytes memory next = abi.encodePacked(vm.toString(value));
        require(next.length == 42, "len");
        for (uint256 i; i < 42; ++i) {
            data[end + i] = next[i];
        }
        return string(data);
    }

    function _find(bytes memory hay, bytes memory needle) internal pure returns (uint256) {
        if (needle.length == 0 || hay.length < needle.length) return type(uint256).max;
        uint256 last = hay.length - needle.length;
        for (uint256 i; i <= last; ++i) {
            bool match_ = true;
            for (uint256 j; j < needle.length; ++j) {
                if (hay[i + j] != needle[j]) {
                    match_ = false;
                    break;
                }
            }
            if (match_) return i;
        }
        return type(uint256).max;
    }
}
