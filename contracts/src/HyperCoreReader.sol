// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title HyperCoreReader
/// @notice Read-only HyperCore precompile calls. Encodings match hyper-evm-lib PrecompileLib
///         (position2 at 0x0813, markPx at 0x0806, accountMarginSummary at 0x080F).
///
///         Scaling (verified against the design doc's mainnet reads):
///         - szi is size * 10^szDecimals
///         - markPx is price * 10^(6 - szDecimals)
///         - szi * markPx is USD notional in 6-decimal fixed point
///         - accountValue, ntlPos and entryNtl are 6-decimal USD
///
///         A failing or empty read reverts. Gas is capped so an invalid index, which burns
///         all gas forwarded to the precompile, cannot consume the rest of the transaction.
library HyperCoreReader {
    address internal constant POSITION2 = 0x0000000000000000000000000000000000000813;
    address internal constant MARK_PX = 0x0000000000000000000000000000000000000806;
    address internal constant ORACLE_PX = 0x0000000000000000000000000000000000000807;
    address internal constant L1_BLOCK_NUMBER = 0x0000000000000000000000000000000000000809;
    address internal constant ACCOUNT_MARGIN_SUMMARY = 0x000000000000000000000000000000000000080F;
    address internal constant CORE_USER_EXISTS = 0x0000000000000000000000000000000000000810;

    /// @dev Above the documented precompile cost 2000 + 65*(in+out) for these payloads, and bounded.
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

    struct CoreUserExists {
        bool exists;
    }

    error PrecompileReadFailed(address target);

    function position(address user, uint32 perp) internal view returns (Position memory) {
        bytes memory ret = _read(POSITION2, abi.encode(user, perp));
        return abi.decode(ret, (Position));
    }

    function markPx(uint32 perp) internal view returns (uint64) {
        bytes memory ret = _read(MARK_PX, abi.encode(perp));
        return abi.decode(ret, (uint64));
    }

    function accountMarginSummary(uint32 dex, address user) internal view returns (AccountMarginSummary memory) {
        bytes memory ret = _read(ACCOUNT_MARGIN_SUMMARY, abi.encode(dex, user));
        return abi.decode(ret, (AccountMarginSummary));
    }

    function coreUserExists(address user) internal view returns (bool) {
        bytes memory ret = _read(CORE_USER_EXISTS, abi.encode(user));
        return abi.decode(ret, (CoreUserExists)).exists;
    }

    function l1BlockNumber() internal view returns (uint64) {
        bytes memory ret = _read(L1_BLOCK_NUMBER, abi.encode());
        return abi.decode(ret, (uint64));
    }

    function _read(address target, bytes memory payload) private view returns (bytes memory) {
        (bool ok, bytes memory ret) = target.staticcall{gas: READ_GAS}(payload);
        if (!ok || ret.length == 0) revert PrecompileReadFailed(target);
        return ret;
    }
}
