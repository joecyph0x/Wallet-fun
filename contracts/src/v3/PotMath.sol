// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Config} from "./Config.sol";

/// @title PotMath
/// @notice v3 settlement maths. `r` is 1e18 fixed point, not basis points.
///         pricePnl = szi_prev * (mark_now - mark_prev) in 6-decimal USD.
///         capacity = min(tailPot, fadePot, 25% of eRef). A one-sided pot has capacity 0.
library PotMath {
    function pricePnl(int64 prevSzi, uint64 prevMark, uint64 newMark) internal pure returns (int256) {
        return int256(prevSzi) * (int256(uint256(newMark)) - int256(uint256(prevMark)));
    }

    function notional(int64 szi, uint64 mark) internal pure returns (uint256) {
        int256 n = int256(szi) * int256(uint256(mark));
        return n < 0 ? uint256(-n) : uint256(n);
    }

    /// @return applied Clamped r in 1e18 units.
    /// @return nextDaily Signed cumulative r for the UTC day after this sample.
    function appliedReturn(int256 pnl, uint256 eRef, int256 daily) internal pure returns (int256 applied, int256 nextDaily) {
        if (eRef == 0 || pnl == 0) return (0, daily);
        int256 r = pnl * int256(Config.RAY) / int256(eRef);
        int256 sampleCap = int256(Config.SAMPLE_CAP);
        if (r > sampleCap) r = sampleCap;
        if (r < -sampleCap) r = -sampleCap;
        int256 hi = int256(Config.DAILY_CAP) - daily;
        int256 lo = -int256(Config.DAILY_CAP) - daily;
        if (r > hi) r = hi;
        if (r < lo) r = lo;
        return (r, daily + r);
    }

    function capacity(uint256 tailPot, uint256 fadePot, uint256 eRef) internal pure returns (uint256) {
        uint256 equityCap = eRef * Config.ALPHA / Config.RAY;
        uint256 smaller = tailPot < fadePot ? tailPot : fadePot;
        return smaller < equityCap ? smaller : equityCap;
    }

    function deltaOf(int256 appliedRay, uint256 capAmount) internal pure returns (int256) {
        return appliedRay * int256(capAmount) / int256(Config.RAY);
    }

    function nav(uint256 pot, uint256 supply) internal pure returns (uint256) {
        if (supply == 0) return Config.UNIT;
        return pot * Config.UNIT / supply;
    }
}
