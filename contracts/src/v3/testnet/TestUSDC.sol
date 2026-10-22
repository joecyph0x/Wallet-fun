// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title TestUSDC
/// @notice HyperEVM TESTNET ONLY. 6-decimal USDC stand-in with an open faucet.
///         Anyone can mint up to FAUCET_CAP (1,000 tUSDC) per call, to themselves or
///         to another address. It has no value and is not bridged from HyperCore.
contract TestUSDC {
    string public constant name = "whalewallet Test USDC";
    string public constant symbol = "tUSDC";
    uint8 public constant decimals = 6;
    uint256 public constant FAUCET_CAP = 1_000 * 1e6;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    error FaucetCap();
    error WrongChain();

    constructor() {
        if (block.chainid != 998) revert WrongChain();
    }

    /// @notice Mint `amount` (6 decimals, at most 1,000 tUSDC) to the caller.
    function faucet(uint256 amount) external {
        _mint(msg.sender, amount);
    }

    /// @notice Mint `amount` (at most 1,000 tUSDC per call) to `to`.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= amount, "allowance");
            allowance[from][msg.sender] = allowed - amount;
        }
        _move(from, to, amount);
        return true;
    }

    function _mint(address to, uint256 amount) internal {
        if (amount == 0 || amount > FAUCET_CAP) revert FaucetCap();
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function _move(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}
