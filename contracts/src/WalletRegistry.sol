// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Season0} from "./Season0.sol";
import {ECDSA} from "./ECDSA.sol";
import {HyperCoreReader} from "./HyperCoreReader.sol";
import {WalletMarket} from "./WalletMarket.sol";

/// @title WalletRegistry
/// @notice whalewallet.fun Season 0 curator, points faucet, and opt-out registry.
///
///         Points enter through a one-time claim of 10,000 play points per address.
///         There is no other mint, no USDC, no withdraw, and no transferable token.
///         The 0.5% trading fee is accounted as `protocolFees` and cannot be taken out.
///
///         Opt-out is an EIP-712 signature from the HyperCore wallet itself:
///         OptOut(address wallet), domain name "whalewallet.fun", version "1".
contract WalletRegistry {
    struct Listing {
        address market;
        address whale;
        bool active;
    }

    error NotOwner();
    error NotGuardian();
    error AlreadyListed();
    error OptedOutAddress();
    error UnknownListing();
    error BadTicker();
    error AlreadyClaimed();
    error BadSignature();
    error NoCoreUser();

    event WalletListed(address indexed whale, address indexed market, string ticker, string name, address[] members);
    event OptedOut(address indexed whale, address indexed submitter);
    event PointsClaimed(address indexed user, uint256 amount);
    event PointsMoved(address indexed user, address indexed market, uint256 amount, bool credited);
    event ProtocolFeeTaken(address indexed market, uint256 amount);
    event GlobalPause(bool on);
    event OwnershipTransferStarted(address indexed next);
    event OwnershipTransferred(address indexed owner);
    event GuardianUpdated(address indexed guardian);

    bytes32 public constant OPT_OUT_TYPEHASH = keccak256("OptOut(address wallet)");
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    address public owner;
    address public pendingOwner;
    address public guardian;
    address public implementation;
    bool public globalPaused;

    mapping(address => uint256) public points;
    mapping(address => bool) public claimed;
    uint256 public totalMinted;
    uint256 public inWallets;
    uint256 public protocolFees;

    mapping(address => Listing) public listings;
    mapping(address => bool) public optedOut;
    mapping(address => bool) public isMarket;
    mapping(bytes32 => address) public tickerToWhale;
    address[] public whales;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyGuardian() {
        if (msg.sender != owner && msg.sender != guardian) revert NotGuardian();
        _;
    }

    modifier onlyMarket() {
        require(isMarket[msg.sender], "market");
        _;
    }

    constructor(address owner_, address guardian_) {
        if (owner_ == address(0) || guardian_ == address(0)) revert NotOwner();
        owner = owner_;
        guardian = guardian_;
        implementation = address(new WalletMarket());
        emit OwnershipTransferred(owner_);
        emit GuardianUpdated(guardian_);
    }

    // ---------------------------------------------------------------- points

    /// @notice One claim of play points per address. This is the only mint.
    function claimSeason0() external {
        if (claimed[msg.sender]) revert AlreadyClaimed();
        claimed[msg.sender] = true;
        points[msg.sender] += Season0.START_POINTS;
        inWallets += Season0.START_POINTS;
        totalMinted += Season0.START_POINTS;
        emit PointsClaimed(msg.sender, Season0.START_POINTS);
    }

    function pullPoints(address user, uint256 amount) external onlyMarket {
        points[user] -= amount;
        inWallets -= amount;
        emit PointsMoved(user, msg.sender, amount, false);
    }

    function pushPoints(address user, uint256 amount) external onlyMarket {
        points[user] += amount;
        inWallets += amount;
        emit PointsMoved(user, msg.sender, amount, true);
    }

    function takeFee(uint256 amount) external onlyMarket {
        protocolFees += amount;
        emit ProtocolFeeTaken(msg.sender, amount);
    }

    // ---------------------------------------------------------------- listings

    function addWallet(
        address whale,
        address[] calldata members,
        string calldata ticker,
        string calldata name_,
        uint32[] calldata dexes,
        uint32[] calldata weightedPerps
    ) external onlyOwner returns (address market) {
        if (optedOut[whale]) revert OptedOutAddress();
        if (whale == address(0) || listings[whale].market != address(0)) revert AlreadyListed();
        uint256 tickLen = bytes(ticker).length;
        if (tickLen < 2 || tickLen > 12) revert BadTicker();
        bytes32 tick = keccak256(bytes(ticker));
        if (tickerToWhale[tick] != address(0)) revert BadTicker();

        uint256 n = members.length == 0 ? 1 : members.length;
        for (uint256 i; i < n; ++i) {
            address who = members.length == 0 ? whale : members[i];
            if (!HyperCoreReader.coreUserExists(who)) revert NoCoreUser();
        }

        market = _clone(implementation);
        isMarket[market] = true;
        WalletMarket(market).initialize(whale, members, ticker, name_, dexes, weightedPerps);

        listings[whale] = Listing({market: market, whale: whale, active: true});
        tickerToWhale[tick] = whale;
        whales.push(whale);
        emit WalletListed(whale, market, ticker, name_, _membersOf(market));
    }

    function setDexEnabled(address whale, uint32 dex, bool enabled) external onlyOwner {
        _market(whale).setDexEnabled(dex, enabled);
    }

    function setWeighted(address whale, uint32 perp, bool on) external onlyOwner {
        _market(whale).setWeighted(perp, on);
    }

    function addMember(address whale, address member) external onlyOwner {
        _market(whale).addMember(member);
    }

    function setEpsBps(address whale, uint256 eps) external onlyOwner {
        _market(whale).setEpsBps(eps);
    }

    function setWalletPause(address whale, bool on) external onlyGuardian {
        _market(whale).setPaused(on);
    }

    function setGlobalPause(bool on) external onlyGuardian {
        globalPaused = on;
        emit GlobalPause(on);
    }

    function setGuardian(address next) external onlyOwner {
        if (next == address(0)) revert NotGuardian();
        guardian = next;
        emit GuardianUpdated(next);
    }

    function transferOwnership(address next) external onlyOwner {
        pendingOwner = next;
        emit OwnershipTransferStarted(next);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotOwner();
        owner = msg.sender;
        pendingOwner = address(0);
        emit OwnershipTransferred(msg.sender);
    }

    /// @notice Anyone can submit the wallet's signature. Queued buys refund immediately.
    ///         The next settlement is the last PnL sample. The address cannot be listed again.
    function optOut(address whale, bytes calldata sig) external {
        if (optedOut[whale]) revert OptedOutAddress();
        address signer = ECDSA.recover(hashOptOut(whale), sig);
        if (signer != whale) revert BadSignature();
        optedOut[whale] = true;
        Listing memory listing = listings[whale];
        if (listing.market != address(0) && listing.active) {
            listings[whale].active = false;
            WalletMarket(listing.market).beginOptOut();
        }
        emit OptedOut(whale, msg.sender);
    }

    function hashOptOut(address whale) public view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(OPT_OUT_TYPEHASH, whale));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                DOMAIN_TYPEHASH,
                keccak256(bytes("whalewallet.fun")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    function whaleCount() external view returns (uint256) {
        return whales.length;
    }

    function _market(address whale) internal view returns (WalletMarket) {
        address m = listings[whale].market;
        if (m == address(0)) revert UnknownListing();
        return WalletMarket(m);
    }

    function _membersOf(address market) internal view returns (address[] memory out) {
        uint256 n = WalletMarket(market).memberCount();
        out = new address[](n);
        for (uint256 i; i < n; ++i) {
            out[i] = WalletMarket(market).members(i);
        }
    }

    function _clone(address impl) internal returns (address instance) {
        assembly {
            let ptr := mload(0x40)
            mstore(ptr, 0x3d602d80600a3d3981f3363d3d373d3d3d363d73000000000000000000000000)
            mstore(add(ptr, 0x14), shl(0x60, impl))
            mstore(add(ptr, 0x28), 0x5af43d82803e903d91602b57fd5bf30000000000000000000000000000000000)
            instance := create(0, ptr, 0x37)
        }
        require(instance != address(0), "clone");
    }
}
