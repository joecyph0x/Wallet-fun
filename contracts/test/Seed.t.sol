// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/console2.sol";
import {Season0Test} from "./Season0Test.sol";
import {DeploySeason0} from "../script/DeploySeason0.s.sol";
import {WalletRegistry} from "../src/WalletRegistry.sol";

/// @dev External so the create is a real call, not an unused expression.
contract DeployProbe {
    function create() external returns (address impl) {
        WalletRegistry reg = new WalletRegistry(address(this), address(this));
        impl = reg.implementation();
    }
}

/// @notice The curated seed file is what the testnet deploy script lists.
contract SeedTest is Season0Test {
    function test_scriptRefusesEveryChainExceptTestnet() public {
        DeploySeason0 deploy = new DeploySeason0();
        vm.expectRevert(bytes("Season 0 deploy is HyperEVM testnet only (chain id 998)"));
        deploy.assertTestnet();
        vm.chainId(998);
        deploy.assertTestnet();
    }

    function test_seedFileMatchesThePocWallets() public view {
        string memory raw = vm.readFile("script/whales.json");
        assertEq(vm.parseJsonUint(raw, ".count"), 11);
        assertEq(vm.parseJsonUint(raw, ".chainId"), 998);
        // Testnet meta.universe index 4 is ETH. Mainnet ETH is index 1.
        assertEq(vm.parseJsonUint(raw, ".weightedPerps[0]"), 4);
        assertEq(vm.parseJsonString(raw, ".whales[0].ticker"), "MACHI");
        assertEq(vm.parseJsonString(raw, ".whales[10].ticker"), "WYNN");
        assertEq(vm.parseJsonString(raw, ".whales[3].name"), unicode"2 frères 2 fauves");
    }

    function test_seedFileListsEveryWhale() public {
        string memory raw = vm.readFile("script/whales.json");
        uint256 n = vm.parseJsonUint(raw, ".count");
        uint32 weighted = uint32(vm.parseJsonUint(raw, ".weightedPerps[0]"));
        uint32[] memory dexes = new uint32[](1);
        dexes[0] = 0;
        uint32[] memory weights = new uint32[](1);
        weights[0] = weighted;

        WalletRegistry fresh = new WalletRegistry(address(this), address(this));
        for (uint256 i; i < n; ++i) {
            string memory base = string.concat(".whales[", vm.toString(i), "]");
            address who = vm.parseJsonAddress(raw, string.concat(base, ".whale"));
            string memory ticker = vm.parseJsonString(raw, string.concat(base, ".ticker"));
            string memory name_ = vm.parseJsonString(raw, string.concat(base, ".name"));
            _setExists(who, true);
            address market = fresh.addWallet(who, new address[](0), ticker, name_, dexes, weights);
            assertTrue(market != address(0));
            assertEq(fresh.tickerToWhale(keccak256(bytes(ticker))), who);
        }
        assertEq(fresh.whaleCount(), 11);
    }

    /// @dev The registry constructor deploys the market implementation. Code deposit is
    ///      200 gas per runtime byte, and HyperEVM small blocks are 3,000,000 gas.
    function test_registryCreationNeedsABigBlock() public {
        address impl = new DeployProbe().create();
        uint256 bytes_ = impl.code.length;
        uint256 deposit = bytes_ * 200;
        console2.log("implementation bytes", bytes_);
        console2.log("implementation code-deposit gas", deposit);
        assertGt(bytes_, 0);
        assertLt(deposit, 30_000_000, "implementation alone exceeds a big block");
        assertGt(deposit, 3_000_000, "small blocks are 3M; the constructor's create needs a big block");
    }
}
