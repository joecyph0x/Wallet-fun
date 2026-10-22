// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {CoreReader} from "../../src/v3/CoreReader.sol";
import {RegistryProxy} from "../../src/v3/BeaconProxy.sol";
import {WalletMarketV3} from "../../src/v3/WalletMarketV3.sol";
import {WalletRegistryV3} from "../../src/v3/WalletRegistryV3.sol";
import {TestUSDC} from "../../src/v3/testnet/TestUSDC.sol";
import {WalletRegistryV3Testnet} from "../../src/v3/testnet/WalletRegistryV3Testnet.sol";
import {HyperCoreStore, PrecompileMock} from "../mocks/MockHyperCore.sol";

/// @notice Testnet-only helpers: the capped TestUSDC faucet and the no-timelock listing call.
contract TestnetV3Test is Test {
    TestUSDC internal usdc;
    WalletRegistryV3Testnet internal reg;
    HyperCoreStore internal store;
    address internal whale = makeAddr("whale");

    function setUp() public {
        vm.chainId(998);
        store = new HyperCoreStore();
        PrecompileMock mock = new PrecompileMock(store);
        vm.etch(CoreReader.CORE_USER_EXISTS, address(mock).code);
        store.set(CoreReader.CORE_USER_EXISTS, abi.encode(whale), abi.encode(CoreReader.CoreUserExists({exists: true})));

        usdc = new TestUSDC();
        WalletMarketV3 impl = new WalletMarketV3();
        WalletRegistryV3Testnet logic = new WalletRegistryV3Testnet();
        RegistryProxy proxy = new RegistryProxy(
            address(logic),
            abi.encodeWithSelector(
                WalletRegistryV3.initialize.selector, address(this), address(this), address(this), address(usdc), address(impl)
            )
        );
        reg = WalletRegistryV3Testnet(address(proxy));
    }

    function _dex0() internal pure returns (uint32[] memory d) {
        d = new uint32[](1);
    }

    function _eth() internal pure returns (uint32[] memory w) {
        w = new uint32[](1);
        w[0] = 4;
    }

    function test_faucetCapsEachCall() public {
        usdc.faucet(1_000e6);
        assertEq(usdc.balanceOf(address(this)), 1_000e6);
        vm.expectRevert(TestUSDC.FaucetCap.selector);
        usdc.faucet(1_000e6 + 1);
        vm.expectRevert(TestUSDC.FaucetCap.selector);
        usdc.mint(whale, 0);
        assertEq(usdc.decimals(), 6);
    }

    function test_testUsdcRefusesOtherChains() public {
        vm.chainId(999);
        vm.expectRevert(TestUSDC.WrongChain.selector);
        new TestUSDC();
    }

    function test_testnetListSkipsTimelockAndSeeds() public {
        usdc.faucet(100e6);
        usdc.approve(address(reg), 100e6);
        address m = reg.testnetList(whale, new address[](0), "DEMO", "Demo", _dex0(), _eth(), 50e6);
        (address listed,, bool active) = reg.listings(whale);
        assertEq(listed, m);
        assertTrue(active);
        assertEq(WalletMarketV3(m).tailPot(), 50e6);
        assertEq(WalletMarketV3(m).fadePot(), 50e6);
        assertTrue(reg.solvent());
    }

    function test_testnetListOwnerOnly() public {
        vm.prank(whale);
        vm.expectRevert(WalletRegistryV3.NotOwner.selector);
        reg.testnetList(whale, new address[](0), "DEMO", "Demo", _dex0(), _eth(), 0);
    }

    function test_testnetListRefusesMainnet() public {
        vm.chainId(999);
        vm.expectRevert(WalletRegistryV3Testnet.TestnetOnly.selector);
        reg.testnetList(whale, new address[](0), "DEMO", "Demo", _dex0(), _eth(), 0);
    }

    function test_timelockedPathsUnchanged() public {
        vm.expectRevert(WalletRegistryV3.Timelocked.selector);
        reg.addMember(whale, whale);
    }
}
