// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Points ledger surface used by a wallet market. Points never leave this system.
interface IRegistry {
    function pullPoints(address user, uint256 amount) external;
    function pushPoints(address user, uint256 amount) external;
    function takeFee(uint256 amount) external;
    function globalPaused() external view returns (bool);
}
