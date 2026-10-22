// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice The slice of ERC-20 v3 uses. No hooks. USDC on HyperEVM matches this.
interface IERC20Min {
    function balanceOf(address) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}
