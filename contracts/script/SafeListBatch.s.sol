// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {Config} from "../src/v3/Config.sol";
import {WalletRegistryV3} from "../src/v3/WalletRegistryV3.sol";

/// @title SafeListBatch
/// @notice Prints Safe Transaction Builder JSON for whale listings. Read-only.
///         One USDC approve, then one `schedule` per whale. Each schedule waits 24h
///         and the registry holds only one pending change, so the Safe executes or
///         cancels before the next schedule. Does not broadcast.
///
///             forge script script/SafeListBatch.s.sol
///
///         REGISTRY, USDC, and SEED_PER_SIDE (6-decimal USDC, default 0) come from
///         the environment. CHAIN_ID defaults to 999. Testnet-only rows in
///         script/whales.json are skipped on 999.
contract SafeListBatch is Script {
    /// @dev Same selector as WalletRegistryV3.OP_LIST. Kept here so this script
    ///      can build calldata without an RPC call.
    bytes4 internal constant OP_LIST =
        bytes4(keccak256("opAddWallet(address,address[],string,string,uint32[],uint32[],uint256)"));

    function run() external {
        address registry = vm.envAddress("REGISTRY");
        address usdc = vm.envOr("USDC", Config.MAINNET_USDC);
        uint256 chainId = vm.envOr("CHAIN_ID", uint256(999));
        uint256 seed = vm.envOr("SEED_PER_SIDE", uint256(0));
        string memory raw = vm.readFile("script/whales.json");
        uint256 n = vm.parseJsonUint(raw, ".count");
        uint256 listed;
        for (uint256 i; i < n; ++i) {
            string memory base = string.concat(".whales[", vm.toString(i), "]");
            if (chainId != 998 && vm.keyExists(raw, string.concat(base, ".testnetOnly"))) continue;
            listed++;
        }
        uint256 approveAmt = seed * 2 * listed;
        bytes memory approveData =
            abi.encodeWithSignature("approve(address,uint256)", registry, approveAmt);

        string memory txs = "[";
        txs = string.concat(txs, _tx(usdc, approveData, "approve USDC for the registry"));
        for (uint256 i; i < n; ++i) {
            string memory base = string.concat(".whales[", vm.toString(i), "]");
            if (chainId != 998 && vm.keyExists(raw, string.concat(base, ".testnetOnly"))) continue;
            address whale = vm.parseJsonAddress(raw, string.concat(base, ".whale"));
            string memory ticker = vm.parseJsonString(raw, string.concat(base, ".ticker"));
            string memory name_ = vm.parseJsonString(raw, string.concat(base, ".name"));
            uint32[] memory dexes = new uint32[](1);
            dexes[0] = 0;
            uint32[] memory weighted = _weighted(raw, base);
            bytes memory op = abi.encodeWithSelector(
                OP_LIST, whale, new address[](0), ticker, name_, dexes, weighted, seed
            );
            bytes memory scheduleData = abi.encodeWithSelector(WalletRegistryV3.schedule.selector, op);
            txs = string.concat(txs, ",");
            txs = string.concat(txs, _tx(registry, scheduleData, string.concat("schedule ", ticker, " ", name_)));
        }
        txs = string.concat(txs, "]");

        string memory json = string.concat(
            '{"version":"1.0","chainId":"',
            vm.toString(chainId),
            '","meta":{"name":"List whales","description":"Approve USDC, then schedule one listing at a time. Execute or cancel before the next schedule."},"transactions":',
            txs,
            "}"
        );
        console2.log(json);
    }

    function _weighted(string memory raw, string memory base) internal view returns (uint32[] memory weighted) {
        string memory key = string.concat(base, ".weightedPerps");
        if (vm.keyExists(raw, key)) {
            bytes memory parsed = vm.parseJson(raw, key);
            uint256[] memory nums = abi.decode(parsed, (uint256[]));
            weighted = new uint32[](nums.length);
            for (uint256 i; i < nums.length; ++i) weighted[i] = uint32(nums[i]);
            return weighted;
        }
        uint256[] memory fileDefault = abi.decode(vm.parseJson(raw, ".weightedPerps"), (uint256[]));
        weighted = new uint32[](fileDefault.length);
        for (uint256 i; i < fileDefault.length; ++i) weighted[i] = uint32(fileDefault[i]);
    }

    function _tx(address to, bytes memory data, string memory note) internal view returns (string memory) {
        return string.concat(
            '{"to":"',
            vm.toString(to),
            '","value":"0","data":"',
            vm.toString(data),
            '","contractMethod":null,"contractInputsValues":null,"note":"',
            note,
            '"}'
        );
    }
}
