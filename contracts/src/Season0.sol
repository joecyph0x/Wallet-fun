// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title Season0
/// @notice Shared constants for whalewallet.fun Season 0.
///         Play points only: 1 point = 1e6 base units so pots share a scale with
///         HyperCore USD values (also 6 decimals). That scale is an accounting
///         choice for the sabotage cap. Points are not USDC and are not redeemable.
library Season0 {
    uint256 internal constant UNIT = 1e6;
    uint256 internal constant BPS = 10_000;

    /// @dev At-risk capacity is at most 25% of reference equity.
    uint256 internal constant ALPHA_BPS = 2_500;
    /// @dev Per-settlement clamp on r = pricePnl / eRef.
    uint256 internal constant SAMPLE_CAP_BPS = 2_500;
    /// @dev Signed cumulative r over a UTC day, after the per-settlement clamp.
    uint256 internal constant DAILY_CAP_BPS = 5_000;
    /// @dev Mint / redeem fee. Stays inside the points system.
    uint256 internal constant FEE_BPS = 50;

    uint256 internal constant HEARTBEAT = 60;
    uint256 internal constant START_POINTS = 10_000 * UNIT;
    /// @dev Play-point inventory minted to both sides at listing. Not a player balance.
    uint256 internal constant HOUSE_SEED = 10_000 * UNIT;
    /// @dev One top-up or a future listing cannot mint more than this on a side.
    uint256 internal constant MAX_HOUSE_POINTS = 1_000_000 * UNIT;
    /// @dev Holds house shares. It cannot claim, queue, or cancel. Not a leaderboard player.
    address internal constant HOUSE = address(2);
    /// @dev Burned into a side that is still empty so the share price cannot be inflated from nothing.
    ///      A seeded side never hits this path.
    uint256 internal constant MIN_LIQUIDITY = UNIT;

    uint256 internal constant MAX_ASSETS = 64;
    uint256 internal constant MAX_MEMBERS = 8;
    uint256 internal constant MAX_DEXES = 8;
    uint256 internal constant MAX_QUEUE = 64;

    /// @dev HIP-3 perp id = dexIndex * DEX_STRIDE + metaIndex. Validator perps are dex 0.
    uint32 internal constant DEX_STRIDE = 10_000;

    function dexOf(uint32 perp) internal pure returns (uint32) {
        return perp / DEX_STRIDE;
    }

    function perpIndex(uint32 dex, uint32 metaIndex) internal pure returns (uint32) {
        require(metaIndex < DEX_STRIDE, "meta");
        uint256 idx = uint256(dex) * uint256(DEX_STRIDE) + uint256(metaIndex);
        require(idx <= type(uint32).max, "idx");
        return uint32(idx);
    }
}
