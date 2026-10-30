// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {WalletRegistryV3} from "../WalletRegistryV3.sol";

/// @title WalletRegistryV3Testnet
/// @notice HyperEVM TESTNET ONLY. WalletRegistryV3 plus one owner call that lists a
///         wallet without the 24h timelock, so a testnet soak can list twelve markets
///         in one sitting instead of twelve days. Every other path, including the
///         timelocked OP_LIST, is unchanged, including owner replacement, the
///         single pending change, and the guardian's inability to cancel its own
///         replacement. No new storage, so the proxy layout matches.
///         Not for mainnet: `testnetList` reverts on any chain other than 998.
contract WalletRegistryV3Testnet is WalletRegistryV3 {
    error TestnetOnly();

    function testnetList(
        address whale,
        address[] calldata members,
        string calldata ticker,
        string calldata name_,
        uint32[] calldata dexes,
        uint32[] calldata weightedPerps,
        uint256 seedPerSide
    ) external onlyOwner nonReentrant returns (address market) {
        if (block.chainid != 998) revert TestnetOnly();
        market = _addWallet(whale, members, ticker, name_, dexes, weightedPerps, seedPerSide);
    }
}
