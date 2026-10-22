// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice One implementation shared by every market. The registry is the only upgrader,
///         and only after the registry timelock.
contract MarketBeacon {
    address public implementation;
    address public registry;

    error NotRegistry();

    constructor(address impl, address registry_) {
        if (impl == address(0) || registry_ == address(0)) revert NotRegistry();
        implementation = impl;
        registry = registry_;
    }

    function upgrade(address next) external {
        if (msg.sender != registry) revert NotRegistry();
        if (next == address(0)) revert NotRegistry();
        implementation = next;
    }
}

/// @dev Beacon address is immutable in the proxy bytecode, so market storage stays clean.
contract MarketProxy {
    address public immutable beacon;

    constructor(address beacon_) {
        beacon = beacon_;
    }

    receive() external payable {
        revert();
    }

    fallback() external payable {
        address impl = MarketBeacon(beacon).implementation();
        assembly {
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), impl, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch ok
            case 0 { revert(0, returndatasize()) }
            default { return(0, returndatasize()) }
        }
    }
}

/// @dev ERC-1967 implementation slot. Registry upgrades go through the 24h timelock.
contract RegistryProxy {
    bytes32 internal constant SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    constructor(address impl, bytes memory initData) {
        assembly {
            sstore(SLOT, impl)
        }
        (bool ok, bytes memory err) = impl.delegatecall(initData);
        if (!ok) {
            assembly {
                revert(add(err, 32), mload(err))
            }
        }
    }

    receive() external payable {
        revert();
    }

    fallback() external payable {
        assembly {
            let impl := sload(SLOT)
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), impl, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch ok
            case 0 { revert(0, returndatasize()) }
            default { return(0, returndatasize()) }
        }
    }
}
