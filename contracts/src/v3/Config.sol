// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title Config
/// @notice v3 constants. Value is USDC (6 decimals). Pots use the same scale.
///         Returns use 1e18 fixed point, not whole basis points.
library Config {
    uint256 internal constant UNIT = 1e6;
    uint256 internal constant RAY = 1e18;
    uint256 internal constant BPS = 10_000;

    /// @dev At-risk capacity is at most 25% of reference equity.
    uint256 internal constant ALPHA = RAY / 4;
    /// @dev Per-settlement clamp on r = pricePnl / eRef.
    uint256 internal constant SAMPLE_CAP = RAY / 4;
    /// @dev Signed cumulative r over a UTC day.
    uint256 internal constant DAILY_CAP = RAY / 2;

    uint256 internal constant FEE_BPS = 50;
    uint256 internal constant MAX_FEE_BPS = 100;
    /// @dev Dust below this is rejected. 10 USDC.
    uint256 internal constant MIN_ORDER = 10 * UNIT;
    /// @dev Burned into a fresh side so the first buyer cannot set an arbitrary price.
    uint256 internal constant MIN_LIQUIDITY = UNIT;

    /// @dev One sample per window. The keeper runs on this cadence (10 minutes).
    uint256 internal constant EPOCH = 10 minutes;
    uint256 internal constant TIMELOCK = 24 hours;
    /// @dev If buys have been paused this long, holders can redeem pro-rata without a new sample.
    uint256 internal constant EXIT_DELAY = 72 hours;

    /// @dev House shares live here. Not a depositor and not a leaderboard wallet.
    address internal constant HOUSE = address(2);

    uint256 internal constant MAX_ASSETS = 32;
    uint256 internal constant MAX_MEMBERS = 8;
    uint256 internal constant MAX_DEXES = 8;
    uint256 internal constant MAX_MARKETS_PER_BATCH = 16;

    /// @dev HyperCore USDC spot token index. weiDecimals is 8, so divide by 100 to reach 6-decimal USD.
    uint64 internal constant USDC_SPOT = 0;
    uint256 internal constant SPOT_TO_USD = 100;

    uint32 internal constant DEX_STRIDE = 10_000;

    /// @dev Circle USDC on HyperEVM mainnet (chain 999).
    address internal constant MAINNET_USDC = 0xb88339CB7199b77E23DB6E890353E22632Ba630f;

    function dexOf(uint32 perp) internal pure returns (uint32) {
        return perp / DEX_STRIDE;
    }
}
