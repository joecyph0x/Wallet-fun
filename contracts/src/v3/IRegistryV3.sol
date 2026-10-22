// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice What a market is allowed to do to the USDC ledger. Tokens never move here.
interface IRegistryV3 {
    function pull(address user, uint256 amount) external;
    function credit(address user, uint256 amount) external;
    function creditHouse(uint256 amount) external;
    function takeFee(uint256 amount) external;
    function buysPaused() external view returns (bool);
    function pauseSince() external view returns (uint256);
    function maxPotPerSide() external view returns (uint256);
    function feeBps() external view returns (uint256);
}
