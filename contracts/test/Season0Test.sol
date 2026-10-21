// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Season0} from "../src/Season0.sol";
import {HyperCoreReader} from "../src/HyperCoreReader.sol";
import {PotMath} from "../src/PotMath.sol";
import {WalletMarket} from "../src/WalletMarket.sol";
import {WalletRegistry} from "../src/WalletRegistry.sol";
import {HyperCoreStore, PrecompileMock} from "./mocks/MockHyperCore.sol";

/// @notice Shared fixture: etched precompile mock, one curated wallet, two players with a Season 0 claim.
contract Season0Test is Test {
    uint32 internal constant ETH_PERP = 1;

    HyperCoreStore internal store;
    WalletRegistry internal reg;
    WalletMarket internal market;

    uint256 internal whalePk = 0xA11CE;
    address internal whale;
    address internal alice;
    address internal bob;
    address internal carol;

    function setUp() public virtual {
        whale = vm.addr(whalePk);
        alice = makeAddr("alice");
        bob = makeAddr("bob");
        carol = makeAddr("carol");
        vm.warp(1_700_000_000);

        store = new HyperCoreStore();
        PrecompileMock mock = new PrecompileMock(store);
        bytes memory code = address(mock).code;
        vm.etch(HyperCoreReader.POSITION2, code);
        vm.etch(HyperCoreReader.MARK_PX, code);
        vm.etch(HyperCoreReader.ACCOUNT_MARGIN_SUMMARY, code);
        vm.etch(HyperCoreReader.L1_BLOCK_NUMBER, code);
        vm.etch(HyperCoreReader.CORE_USER_EXISTS, code);

        _setExists(whale, true);
        _setL1(100);
        _setMargin(whale, 0, 30_000e6, 0);

        reg = new WalletRegistry(address(this), address(this));
        market =
            WalletMarket(reg.addWallet(whale, new address[](0), "MACHI", "Machi Big Brother", _dex0(), _weightEth()));

        vm.prank(alice);
        reg.claimSeason0();
        vm.prank(bob);
        reg.claimSeason0();
    }

    function _dex0() internal pure returns (uint32[] memory dexes) {
        dexes = new uint32[](1);
        dexes[0] = 0;
    }

    function _weightEth() internal pure returns (uint32[] memory w) {
        w = new uint32[](1);
        w[0] = 1;
    }

    function _one() internal pure returns (WalletMarket.Asset[] memory a) {
        a = new WalletMarket.Asset[](1);
        a[0] = WalletMarket.Asset({memberIndex: 0, perp: 1});
    }

    function _legs(uint32 a, uint32 b) internal pure returns (WalletMarket.Asset[] memory xs) {
        xs = new WalletMarket.Asset[](2);
        xs[0] = WalletMarket.Asset({memberIndex: 0, perp: a});
        xs[1] = WalletMarket.Asset({memberIndex: 0, perp: b});
    }

    function _memberLeg(uint8 memberIndex, uint32 perp) internal pure returns (WalletMarket.Asset memory a) {
        a = WalletMarket.Asset({memberIndex: memberIndex, perp: perp});
    }

    function _setExists(address user, bool exists_) internal {
        HyperCoreReader.CoreUserExists memory c = HyperCoreReader.CoreUserExists({exists: exists_});
        store.set(HyperCoreReader.CORE_USER_EXISTS, abi.encode(user), abi.encode(c));
    }

    function _setL1(uint64 n) internal {
        store.set(HyperCoreReader.L1_BLOCK_NUMBER, "", abi.encode(n));
    }

    function _setMargin(address user, uint32 dex, int64 equity, uint64 ntl) internal {
        HyperCoreReader.AccountMarginSummary memory a =
            HyperCoreReader.AccountMarginSummary({accountValue: equity, marginUsed: 0, ntlPos: ntl, rawUsd: equity});
        store.set(HyperCoreReader.ACCOUNT_MARGIN_SUMMARY, abi.encode(dex, user), abi.encode(a));
    }

    function _setLeg(address user, uint32 perp, int64 szi, uint64 mark) internal {
        HyperCoreReader.Position memory p =
            HyperCoreReader.Position({szi: szi, entryNtl: 0, isolatedRawUsd: 0, leverage: 1, isIsolated: false});
        store.set(HyperCoreReader.POSITION2, abi.encode(user, perp), abi.encode(p));
        store.set(HyperCoreReader.MARK_PX, abi.encode(perp), abi.encode(mark));
    }

    function _ntl(int64 szi, uint64 mark) internal pure returns (uint64) {
        uint256 n = PotMath.notional(szi, mark);
        require(n <= type(uint64).max, "ntl");
        return uint64(n);
    }

    /// @dev One weighted leg on perp 1, dex 0, with ntlPos equal to |szi * mark|.
    function _book(int64 szi, uint64 mark, int64 equity) internal {
        _setLeg(whale, ETH_PERP, szi, mark);
        _setMargin(whale, 0, equity, szi == 0 ? 0 : _ntl(szi, mark));
    }

    function _settle() internal {
        market.settle(_one());
        _assertConserved();
    }

    function _settle(WalletMarket.Asset[] memory assets) internal {
        market.settle(assets);
        _assertConserved();
    }

    function _assertConserved() internal view {
        assertEq(reg.inWallets() + reg.protocolFees() + market.pointsHeld(), reg.totalMinted(), "points conserved");
    }

    function _optOutSig() internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(whalePk, reg.hashOptOut(whale));
        return abi.encodePacked(r, s, v);
    }
}
