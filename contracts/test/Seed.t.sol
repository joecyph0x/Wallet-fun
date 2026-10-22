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

    function test_deployScriptStampsDeployedAtOfEitherLength() public {
        DeploySeason0 deploy = new DeploySeason0();
        string memory raw = '{"deployedAt": 1, "registry": "0x0000000000000000000000000000000000000001"}';
        assertEq(
            deploy.replaceUint(raw, "deployedAt", 1792635480),
            '{"deployedAt": 1792635480, "registry": "0x0000000000000000000000000000000000000001"}'
        );
        assertEq(deploy.replaceUint('{"deployedAt":1792629161}', "deployedAt", 10), '{"deployedAt":10}');
    }

    function test_deploymentFileHasTheTestnetAddresses() public view {
        string memory raw = vm.readFile("deployments/998.json");
        assertEq(vm.parseJsonUint(raw, ".chainId"), 998);
        assertEq(vm.parseJsonAddress(raw, ".registry"), 0x9A00D44E7564004f8557bf7a780793c546ccd4a5);
        assertEq(vm.parseJsonAddress(raw, ".implementation"), 0x7938EF37Af75b2aF39D5956fbB1561c66746Fe4d);
        assertEq(vm.parseJsonAddress(raw, ".deployer"), 0xFfFC0719380a4d500C3373A26BE1f273bD7C1468);
        assertEq(vm.parseJsonUint(raw, ".deployedAt"), 1792635480);
        assertEq(vm.parseJsonString(raw, ".wallets[0].ticker"), "MACHI");
        assertEq(vm.parseJsonAddress(raw, ".wallets[0].market"), 0x08ACeA438F93ff816C4ACA733F89667752DD9B8c);
        assertEq(vm.parseJsonString(raw, ".wallets[10].ticker"), "WYNN");
        assertEq(vm.parseJsonAddress(raw, ".wallets[10].market"), 0xc8Ed33C46Fa9F1E343C442A3532fd39DC9995394);
        assertEq(vm.parseJsonString(raw, ".wallets[11].ticker"), "DEMO");
        assertEq(vm.parseJsonAddress(raw, ".wallets[11].whale"), 0x6dD538C00055D7EA6d451B97a94E463E8Ce89519);
        assertEq(vm.parseJsonAddress(raw, ".wallets[11].market"), 0x41Fdb4AAbA614655AEE5d63762681AEE2B4F494A);
        assertTrue(vm.parseJsonBool(raw, ".wallets[11].testnetOnly"));
        assertEq(vm.parseJsonAddress(raw, ".builder.address"), address(0));
        assertEq(vm.parseJsonUint(raw, ".builder.feeBps"), 5);
        assertEq(vm.parseJsonUint(raw, ".builder.f"), 50);
        assertEq(vm.parseJsonString(raw, ".builder.maxFeeRate"), "0.05%");
        assertEq(vm.parseJsonString(raw, ".builder.hyperliquidChain"), "Testnet");
        for (uint256 i; i < 12; ++i) {
            string memory market = vm.parseJsonString(raw, string.concat(".wallets[", vm.toString(i), "].market"));
            assertTrue(bytes(market).length == 42);
            assertTrue(keccak256(bytes(market)) != keccak256(bytes("0x0000000000000000000000000000000000000000")));
        }
    }

    function test_seedFileMatchesThePocWallets() public view {
        string memory raw = vm.readFile("script/whales.json");
        assertEq(vm.parseJsonUint(raw, ".count"), 12);
        assertEq(vm.parseJsonUint(raw, ".chainId"), 998);
        // Testnet meta.universe index 4 is ETH. Mainnet ETH is index 1.
        assertEq(vm.parseJsonUint(raw, ".weightedPerps[0]"), 4);
        assertEq(vm.parseJsonString(raw, ".whales[0].ticker"), "MACHI");
        assertEq(vm.parseJsonString(raw, ".whales[10].ticker"), "WYNN");
        assertEq(vm.parseJsonString(raw, ".whales[11].ticker"), "DEMO");
        assertEq(vm.parseJsonAddress(raw, ".whales[11].whale"), 0x6dD538C00055D7EA6d451B97a94E463E8Ce89519);
        assertTrue(vm.parseJsonBool(raw, ".whales[11].testnetOnly"));
        assertEq(vm.parseJsonUint(raw, ".whales[11].weightedPerps[0]"), 4);
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
        assertEq(fresh.whaleCount(), n);
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
