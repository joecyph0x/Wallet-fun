// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title CoreReader
/// @notice Read-only HyperCore precompiles for v3. Same encodings as HyperCoreReader,
///         plus spotBalance at 0x0801 (hyper-evm-lib). A failed read reverts.
///         Gas is capped so a bad index cannot burn the rest of the transaction.
library CoreReader {
    address internal constant POSITION2 = 0x0000000000000000000000000000000000000813;
    address internal constant MARK_PX = 0x0000000000000000000000000000000000000806;
    address internal constant L1_BLOCK_NUMBER = 0x0000000000000000000000000000000000000809;
    address internal constant ACCOUNT_MARGIN_SUMMARY = 0x000000000000000000000000000000000000080F;
    address internal constant CORE_USER_EXISTS = 0x0000000000000000000000000000000000000810;
    address internal constant SPOT_BALANCE = 0x0000000000000000000000000000000000000801;

    uint256 internal constant READ_GAS = 100_000;

    struct Position {
        int64 szi;
        uint64 entryNtl;
        int64 isolatedRawUsd;
        uint32 leverage;
        bool isIsolated;
    }

    struct AccountMarginSummary {
        int64 accountValue;
        uint64 marginUsed;
        uint64 ntlPos;
        int64 rawUsd;
    }

    struct SpotBalance {
        uint64 total;
        uint64 hold;
        uint64 entryNtl;
    }

    struct CoreUserExists {
        bool exists;
    }

    error PrecompileReadFailed(address target);

    function position(address user, uint32 perp) internal view returns (Position memory) {
        return abi.decode(_read(POSITION2, abi.encode(user, perp)), (Position));
    }

    function markPx(uint32 perp) internal view returns (uint64) {
        return abi.decode(_read(MARK_PX, abi.encode(perp)), (uint64));
    }

    function accountMarginSummary(uint32 dex, address user) internal view returns (AccountMarginSummary memory) {
        return abi.decode(_read(ACCOUNT_MARGIN_SUMMARY, abi.encode(dex, user)), (AccountMarginSummary));
    }

    function spotBalance(address user, uint64 token) internal view returns (SpotBalance memory) {
        return abi.decode(_read(SPOT_BALANCE, abi.encode(user, token)), (SpotBalance));
    }

    function coreUserExists(address user) internal view returns (bool) {
        return abi.decode(_read(CORE_USER_EXISTS, abi.encode(user)), (CoreUserExists)).exists;
    }

    function l1BlockNumber() internal view returns (uint64) {
        return abi.decode(_read(L1_BLOCK_NUMBER, abi.encode()), (uint64));
    }

    function _read(address target, bytes memory payload) private view returns (bytes memory) {
        (bool ok, bytes memory ret) = target.staticcall{gas: READ_GAS}(payload);
        if (!ok || ret.length == 0) revert PrecompileReadFailed(target);
        return ret;
    }
}
