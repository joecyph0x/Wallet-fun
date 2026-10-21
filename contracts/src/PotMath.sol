// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Season0} from "./Season0.sol";

/// @title PotMath
/// @notice Pure settlement maths.
///
///         pricePnl = szi_prev * (mark_now - mark_prev) using raw precompile integers.
///         That product is 6-decimal USD (see HyperCoreReader).
///         r = pricePnl / eRef, clamped to ±25% per settlement and to a signed ±50% per UTC day.
///         capacity C = min(tailPot, fadePot, 25% * eRef)
///         delta = r * C moves from the losing side to the winning side.
library PotMath {
    function pricePnl(int64 prevSzi, uint64 prevMark, uint64 newMark) internal pure returns (int256) {
        return int256(prevSzi) * (int256(uint256(newMark)) - int256(uint256(prevMark)));
    }

    function notional(int64 szi, uint64 mark) internal pure returns (uint256) {
        int256 n = int256(szi) * int256(uint256(mark));
        return n < 0 ? uint256(-n) : uint256(n);
    }

    /// @return appliedBps Clamped r in basis points (signed).
    /// @return nextDaily Signed cumulative r for the UTC day after this sample.
    function appliedReturnBps(int256 pnl, uint256 eRef, int256 dailyRBps)
        internal
        pure
        returns (int256 appliedBps, int256 nextDaily)
    {
        if (eRef == 0 || pnl == 0) return (0, dailyRBps);
        int256 r = pnl * int256(Season0.BPS) / int256(eRef);
        int256 sampleCap = int256(Season0.SAMPLE_CAP_BPS);
        if (r > sampleCap) r = sampleCap;
        if (r < -sampleCap) r = -sampleCap;
        int256 hi = int256(Season0.DAILY_CAP_BPS) - dailyRBps;
        int256 lo = -int256(Season0.DAILY_CAP_BPS) - dailyRBps;
        if (r > hi) r = hi;
        if (r < lo) r = lo;
        return (r, dailyRBps + r);
    }

    function capacity(uint256 tailPot, uint256 fadePot, uint256 eRef) internal pure returns (uint256) {
        uint256 equityCap = eRef * Season0.ALPHA_BPS / Season0.BPS;
        uint256 smaller = tailPot < fadePot ? tailPot : fadePot;
        return smaller < equityCap ? smaller : equityCap;
    }

    function deltaOf(int256 appliedBps, uint256 capAmount) internal pure returns (int256) {
        return appliedBps * int256(capAmount) / int256(Season0.BPS);
    }

    function nav(uint256 pot, uint256 supply) internal pure returns (uint256) {
        if (supply == 0) return Season0.UNIT;
        return pot * Season0.UNIT / supply;
    }
}
