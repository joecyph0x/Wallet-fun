// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Config} from "../../src/v3/Config.sol";
import {RegistryProxy} from "../../src/v3/BeaconProxy.sol";
import {MockUSDC} from "../../src/v3/MockUSDC.sol";
import {WalletMarketV3} from "../../src/v3/WalletMarketV3.sol";
import {WalletRegistryV3} from "../../src/v3/WalletRegistryV3.sol";
import {WalletRegistryV3Testnet} from "../../src/v3/testnet/WalletRegistryV3Testnet.sol";
import {V3Test} from "./V3.t.sol";

contract NextOwner {}

/// @notice Owner rotation, guardian cancel limits, and the single pending slot.
contract AdminTest is V3Test {
    function test_safeListScriptUsesTheRegistryListSelector() public view {
        assertEq(
            reg.OP_LIST(),
            bytes4(keccak256("opAddWallet(address,address[],string,string,uint32[],uint32[],uint256)"))
        );
    }

    function test_ownerReplacesItselfAfterTheTimelock() public {
        NextOwner next = new NextOwner();
        bytes memory op = abi.encodeWithSelector(reg.OP_OWNER(), address(next));
        reg.schedule(op);
        uint256 eta = reg.pendingEta();
        vm.expectRevert(abi.encodeWithSelector(WalletRegistryV3.TooEarly.selector, eta));
        reg.execute();

        _unlock();
        reg.execute();
        assertEq(reg.owner(), address(next));

        bytes memory fee = abi.encodeWithSelector(reg.OP_FEE(), uint256(10));
        vm.expectRevert(WalletRegistryV3.NotOwner.selector);
        reg.schedule(fee);

        vm.prank(address(next));
        reg.schedule(fee);
        assertGt(reg.pendingEta(), 0);
    }

    function test_guardianCannotCancelItsOwnReplacement() public {
        reg.schedule(abi.encodeWithSelector(reg.OP_GUARDIAN(), carol));
        _unlock();
        reg.execute();
        assertEq(reg.guardian(), carol);

        reg.schedule(abi.encodeWithSelector(reg.OP_GUARDIAN(), bob));
        vm.prank(carol);
        vm.expectRevert(WalletRegistryV3.GuardianCannotCancelOwnReplacement.selector);
        reg.cancelPending();
        assertGt(reg.pendingEta(), 0);

        reg.cancelPending();
        assertEq(reg.pendingEta(), 0);
        assertEq(reg.guardian(), carol);

        reg.schedule(abi.encodeWithSelector(reg.OP_GUARDIAN(), bob));
        _unlock();
        reg.execute();
        assertEq(reg.guardian(), bob);
    }

    function test_guardianCanStillCancelEveryOtherOp() public {
        reg.schedule(abi.encodeWithSelector(reg.OP_GUARDIAN(), carol));
        _unlock();
        reg.execute();

        reg.schedule(abi.encodeWithSelector(reg.OP_FEE(), uint256(10)));
        vm.prank(carol);
        reg.cancelPending();
        assertEq(reg.pendingEta(), 0);

        reg.schedule(abi.encodeWithSelector(reg.OP_BEACON(), address(new WalletMarketV3())));
        vm.prank(carol);
        reg.cancelPending();
        assertEq(reg.pendingEta(), 0);

        NextOwner next = new NextOwner();
        reg.schedule(abi.encodeWithSelector(reg.OP_OWNER(), address(next)));
        vm.prank(carol);
        reg.cancelPending();
        assertEq(reg.pendingEta(), 0);
        assertEq(reg.owner(), address(this));
    }

    function test_ownerWhoIsAlsoGuardianCanStillCancelAGuardianChange() public {
        assertEq(reg.owner(), reg.guardian());
        reg.schedule(abi.encodeWithSelector(reg.OP_GUARDIAN(), carol));
        reg.cancelPending();
        assertEq(reg.pendingEta(), 0);
        assertEq(reg.guardian(), address(this));
    }

    function test_strangerCannotCancel() public {
        reg.schedule(abi.encodeWithSelector(reg.OP_FEE(), uint256(10)));
        vm.prank(bob);
        vm.expectRevert(WalletRegistryV3.NotGuardian.selector);
        reg.cancelPending();
        assertGt(reg.pendingEta(), 0);
    }

    function test_zeroOwnerRevertsAndLeavesTheChangePending() public {
        bytes memory op = abi.encodeWithSelector(reg.OP_OWNER(), address(0));
        reg.schedule(op);
        _unlock();
        vm.expectRevert(WalletRegistryV3.BadAddress.selector);
        reg.execute();
        assertGt(reg.pendingEta(), 0);
        assertEq(reg.owner(), address(this));
    }

    function test_scheduleRevertsWhileAChangeIsPending() public {
        bytes memory first = abi.encodeWithSelector(reg.OP_FEE(), uint256(10));
        bytes memory second = abi.encodeWithSelector(reg.OP_FEE(), uint256(20));
        reg.schedule(first);
        uint256 eta = reg.pendingEta();
        vm.expectRevert(WalletRegistryV3.ChangePending.selector);
        reg.schedule(second);
        assertEq(reg.pendingEta(), eta);

        reg.cancelPending();
        reg.schedule(second);
        assertGt(reg.pendingEta(), 0);
    }

    function test_testnetRegistryKeepsTheSameAdminRules() public {
        MockUSDC token = new MockUSDC();
        WalletMarketV3 impl = new WalletMarketV3();
        WalletRegistryV3Testnet logic = new WalletRegistryV3Testnet();
        RegistryProxy proxy = new RegistryProxy(
            address(logic),
            abi.encodeWithSelector(
                WalletRegistryV3.initialize.selector, address(this), carol, address(this), address(token), address(impl)
            )
        );
        WalletRegistryV3Testnet t = WalletRegistryV3Testnet(address(proxy));
        assertEq(t.OP_OWNER(), reg.OP_OWNER());

        vm.expectRevert(WalletRegistryV3Testnet.TestnetOnly.selector);
        t.testnetList(whale, new address[](0), "DEMO2", "Demo", _dex0(), _weight(1), 0);

        bytes memory fee = abi.encodeWithSelector(t.OP_FEE(), uint256(10));
        bytes memory ownerOp = abi.encodeWithSelector(t.OP_OWNER(), address(impl));
        t.schedule(fee);
        vm.expectRevert(WalletRegistryV3.ChangePending.selector);
        t.schedule(ownerOp);

        vm.prank(carol);
        t.cancelPending();
        assertEq(t.pendingEta(), 0);

        t.schedule(abi.encodeWithSelector(t.OP_GUARDIAN(), bob));
        vm.prank(carol);
        vm.expectRevert(WalletRegistryV3.GuardianCannotCancelOwnReplacement.selector);
        t.cancelPending();

        vm.warp(t.pendingEta());
        t.execute();
        assertEq(t.guardian(), bob);

        NextOwner next = new NextOwner();
        t.schedule(abi.encodeWithSelector(t.OP_OWNER(), address(next)));
        vm.warp(t.pendingEta());
        t.execute();
        assertEq(t.owner(), address(next));
        assertEq(t.feeBps(), Config.FEE_BPS);
    }
}
