// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Shared response store for the etched HyperCore precompile mocks.
///         Keyed by (precompile address, keccak256(calldata)) so each precompile
///         can be etched with the same runtime and still return its own payload.
contract HyperCoreStore {
    mapping(bytes32 => bytes) public data;

    function set(address precompile, bytes calldata payload, bytes calldata response) external {
        data[_key(precompile, payload)] = response;
    }

    function get(bytes32 key) external view returns (bytes memory) {
        return data[key];
    }

    function _key(address precompile, bytes calldata payload) internal pure returns (bytes32) {
        return keccak256(abi.encode(precompile, keccak256(payload)));
    }
}

/// @dev Runtime is etched onto the real precompile addresses. The store address is an immutable,
///      so it survives `vm.etch`. Reads use staticcall and stay valid inside a static context.
contract PrecompileMock {
    HyperCoreStore public immutable store;

    constructor(HyperCoreStore s) {
        store = s;
    }

    fallback() external {
        bytes32 key = keccak256(abi.encode(address(this), keccak256(msg.data)));
        (bool ok, bytes memory ret) =
            address(store).staticcall(abi.encodeWithSelector(HyperCoreStore.get.selector, key));
        require(ok, "mock store");
        bytes memory decoded = abi.decode(ret, (bytes));
        require(decoded.length != 0, "mock miss");
        assembly {
            return(add(decoded, 32), mload(decoded))
        }
    }
}
