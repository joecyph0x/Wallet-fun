// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ECDSA} from "../ECDSA.sol";
import {Config} from "./Config.sol";
import {CoreReader} from "./CoreReader.sol";
import {IERC20Min} from "./IERC20Min.sol";
import {MarketBeacon, MarketProxy} from "./BeaconProxy.sol";
import {WalletMarketV3} from "./WalletMarketV3.sol";

/// @title WalletRegistryV3
/// @notice USDC ledger, curator, and keeper entry point for whalewallet.fun v3.
///
///         Tokens stay here. Markets pull and credit balances; they do not call transfer.
///         Fees accrue in `protocolFees` and the fee wallet withdraws them.
///         A house seed is USDC the owner deposited, never a mint.
///
///         `settleMany` samples every due market in one transaction. A market that is not
///         due returns false and is skipped. A market whose book is incomplete reverts
///         inside the call and does not roll back the rest of the batch.
///
///         Tracking and parameter changes wait `Config.TIMELOCK` (24h). The guardian can
///         pause new buys immediately, and can only tighten the optional pot cap.
///         Sells, claims, cancels, and withdrawals stay open while buys are paused.
///
///         The registry is an ERC-1967 proxy. Markets share one beacon. Both upgrades
///         wait out the same timelock. Storage layout is append-only.
contract WalletRegistryV3 {
    struct Listing {
        address market;
        address whale;
        bool active;
    }

    error NotOwner();
    error NotGuardian();
    error NotMarket();
    error NotSelf();
    error Timelocked();
    error NothingPending();
    error TooEarly(uint256 ready);
    error BadAddress();
    error BadTicker();
    error AlreadyListed();
    error OptedOutAddress();
    error UnknownListing();
    error BadSignature();
    error NoCoreUser();
    error TransferFailed();
    error BadAmount();
    error CapDirection();
    error Reentered();
    error Batch();

    event WalletListed(address indexed whale, address indexed market, string ticker, string name, address[] members);
    event OptedOut(address indexed whale, address indexed submitter);
    event Deposited(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event FeesClaimed(address indexed feeWallet, uint256 amount);
    event HouseWithdrawn(address indexed to, uint256 amount);
    event ProtocolFeeTaken(address indexed market, uint256 amount);
    event BuysPausedSet(bool on, uint256 pauseSince);
    event CapTightened(uint256 cap);
    event Scheduled(bytes4 indexed op, uint256 eta);
    event Executed(bytes4 indexed op);
    event PendingCleared();
    event OwnershipTransferred(address indexed owner);
    event GuardianUpdated(address indexed guardian);
    event FeeWalletUpdated(address indexed feeWallet);

    bytes32 public constant OPT_OUT_TYPEHASH = keccak256("OptOut(address wallet)");
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant REGISTRY_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    bytes4 public constant OP_WEIGHTED = bytes4(keccak256("opSetWeighted(address,uint32,bool)"));
    bytes4 public constant OP_DEX = bytes4(keccak256("opSetDex(address,uint32,bool)"));
    bytes4 public constant OP_MEMBER = bytes4(keccak256("opAddMember(address,address)"));
    bytes4 public constant OP_EPS = bytes4(keccak256("opSetEps(address,uint256)"));
    bytes4 public constant OP_FEE = bytes4(keccak256("opSetFee(uint256)"));
    bytes4 public constant OP_CAP = bytes4(keccak256("opSetCap(uint256)"));
    bytes4 public constant OP_BEACON = bytes4(keccak256("opUpgradeBeacon(address)"));
    bytes4 public constant OP_REGISTRY = bytes4(keccak256("opUpgradeRegistry(address)"));
    bytes4 public constant OP_LIST = bytes4(keccak256("opAddWallet(address,address[],string,string,uint32[],uint32[],uint256)"));
    bytes4 public constant OP_GUARDIAN = bytes4(keccak256("opSetGuardian(address)"));
    bytes4 public constant OP_FEE_WALLET = bytes4(keccak256("opSetFeeWallet(address)"));
    bytes4 public constant OP_HOUSE_SELL = bytes4(keccak256("opHouseSell(address,uint8,uint256)"));

    string public constant VERSION = "3";

    address public owner;
    address public guardian;
    address public feeWallet;
    IERC20Min public usdc;
    MarketBeacon public beacon;

    bool public buysPaused;
    uint256 public pauseSince;
    /// @dev 0 means no cap. Joe's default. A non-zero value is a per-side ceiling the guardian can only lower.
    uint256 public maxPotPerSide;
    uint256 public feeBps;

    mapping(address => uint256) public balanceOf;
    uint256 public totalBalances;
    uint256 public protocolFees;
    uint256 public houseBalance;

    mapping(address => Listing) public listings;
    mapping(address => bool) public optedOut;
    mapping(address => bool) public isMarket;
    mapping(bytes32 => address) public tickerToWhale;
    address[] public whales;
    address[] internal _markets;

    bytes public pendingData;
    uint256 public pendingEta;

    bool public initialized;
    uint256 internal _lock;

    modifier nonReentrant() {
        if (_lock == 1) revert Reentered();
        _lock = 1;
        _;
        _lock = 0;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyGuardian() {
        if (msg.sender != owner && msg.sender != guardian) revert NotGuardian();
        _;
    }

    modifier onlyMarket() {
        if (!isMarket[msg.sender]) revert NotMarket();
        _;
    }

    /// @dev Implementation is unusable. The proxy delegatecalls `initialize`.
    constructor() {
        initialized = true;
    }

    function initialize(address owner_, address guardian_, address feeWallet_, address usdc_, address marketImpl)
        external
    {
        if (initialized) revert BadAddress();
        if (
            owner_ == address(0) || guardian_ == address(0) || feeWallet_ == address(0) || usdc_ == address(0)
                || marketImpl == address(0)
        ) revert BadAddress();
        initialized = true;
        owner = owner_;
        guardian = guardian_;
        feeWallet = feeWallet_;
        usdc = IERC20Min(usdc_);
        feeBps = Config.FEE_BPS;
        beacon = new MarketBeacon(marketImpl, address(this));
        emit OwnershipTransferred(owner_);
        emit GuardianUpdated(guardian_);
        emit FeeWalletUpdated(feeWallet_);
    }

    // ---------------------------------------------------------------- USDC

    function deposit(uint256 amount) external nonReentrant {
        if (amount == 0) revert BadAmount();
        uint256 beforeBal = usdc.balanceOf(address(this));
        _transferFrom(msg.sender, address(this), amount);
        uint256 got = usdc.balanceOf(address(this)) - beforeBal;
        if (got == 0) revert BadAmount();
        balanceOf[msg.sender] += got;
        totalBalances += got;
        emit Deposited(msg.sender, got);
    }

    function withdraw(uint256 amount) external nonReentrant {
        if (amount == 0) revert BadAmount();
        balanceOf[msg.sender] -= amount;
        totalBalances -= amount;
        _transfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    /// @notice Open while buys are paused. Sends the accrued fee balance to the fee wallet.
    function claimFees() external nonReentrant {
        uint256 amount = protocolFees;
        if (amount == 0) revert BadAmount();
        protocolFees = 0;
        _transfer(feeWallet, amount);
        emit FeesClaimed(feeWallet, amount);
    }

    /// @notice USDC already realised from house shares. Pulling the seed out of a pot is timelocked.
    function withdrawHouse(uint256 amount) external onlyOwner nonReentrant {
        if (amount == 0) revert BadAmount();
        houseBalance -= amount;
        _transfer(owner, amount);
        emit HouseWithdrawn(owner, amount);
    }

    function pull(address user, uint256 amount) external onlyMarket {
        balanceOf[user] -= amount;
        totalBalances -= amount;
    }

    function credit(address user, uint256 amount) external onlyMarket {
        balanceOf[user] += amount;
        totalBalances += amount;
    }

    function creditHouse(uint256 amount) external onlyMarket {
        houseBalance += amount;
    }

    function takeFee(uint256 amount) external onlyMarket {
        protocolFees += amount;
        emit ProtocolFeeTaken(msg.sender, amount);
    }

    // ---------------------------------------------------------------- keeper

    /// @notice Sample every market whose epoch has elapsed. Not-due markets return false.
    ///         One bad book does not revert the batch. There is no "skip the read" flag:
    ///         a due market still reads the precompiles inside its own call.
    function settleMany(address[] calldata markets_, WalletMarketV3.Asset[][] calldata books)
        external
        returns (bool[] memory settled)
    {
        uint256 n = markets_.length;
        if (n != books.length || n == 0 || n > Config.MAX_MARKETS_PER_BATCH) revert Batch();
        settled = new bool[](n);
        for (uint256 i; i < n; ++i) {
            if (!isMarket[markets_[i]]) continue;
            (bool ok, bytes memory ret) = markets_[i]
                .call(abi.encodeWithSelector(WalletMarketV3.settleIfDue.selector, books[i]));
            if (ok && ret.length >= 32) settled[i] = abi.decode(ret, (bool));
        }
    }

    // ---------------------------------------------------------------- emergency

    /// @notice Blocks `buy` only. Sells, claims, cancels, and withdrawals stay open.
    function setBuysPaused(bool on) external onlyGuardian {
        buysPaused = on;
        if (on) {
            if (pauseSince == 0) pauseSince = block.timestamp;
        } else {
            pauseSince = 0;
        }
        emit BuysPausedSet(on, pauseSince);
    }

    /// @notice Immediate. Can turn an unlimited pot (0) into a finite cap, and can only lower a finite cap.
    function tightenCap(uint256 next) external onlyGuardian {
        if (next == 0) revert CapDirection();
        if (maxPotPerSide != 0 && next >= maxPotPerSide) revert CapDirection();
        maxPotPerSide = next;
        emit CapTightened(next);
    }

    // ---------------------------------------------------------------- timelock

    /// @dev These selectors exist so a v2-style immediate call reverts instead of moving the book.
    function setWeighted(address, uint32, bool) external pure {
        revert Timelocked();
    }

    function setDexEnabled(address, uint32, bool) external pure {
        revert Timelocked();
    }

    function addMember(address, address) external pure {
        revert Timelocked();
    }

    function setEpsBps(address, uint256) external pure {
        revert Timelocked();
    }

    function setFeeBps(uint256) external pure {
        revert Timelocked();
    }

    function raiseCap(uint256) external pure {
        revert Timelocked();
    }

    function schedule(bytes calldata data) external onlyOwner {
        if (data.length < 4 || !_allowed(bytes4(data))) revert Timelocked();
        pendingData = data;
        pendingEta = block.timestamp + Config.TIMELOCK;
        emit Scheduled(bytes4(data), pendingEta);
    }

    function cancelPending() external onlyOwner {
        delete pendingData;
        pendingEta = 0;
        emit PendingCleared();
    }

    function execute() external nonReentrant {
        if (pendingEta == 0) revert NothingPending();
        if (block.timestamp < pendingEta) revert TooEarly(pendingEta);
        bytes memory data = pendingData;
        delete pendingData;
        pendingEta = 0;
        (bool ok, bytes memory err) = address(this).call(abi.encodeWithSelector(this.dispatch.selector, data));
        if (!ok) _bubble(err);
        emit Executed(bytes4(data));
    }

    /// @dev Only `execute` may call this. `msg.sender` is the proxy.
    function dispatch(bytes calldata data) external {
        if (msg.sender != address(this)) revert NotSelf();
        bytes4 sel = bytes4(data);
        if (sel == OP_WEIGHTED) {
            (address whale, uint32 perp, bool on) = abi.decode(data[4:], (address, uint32, bool));
            _market(whale).applyWeighted(perp, on);
        } else if (sel == OP_DEX) {
            (address whale, uint32 dex, bool on) = abi.decode(data[4:], (address, uint32, bool));
            _market(whale).applyDex(dex, on);
        } else if (sel == OP_MEMBER) {
            (address whale, address member) = abi.decode(data[4:], (address, address));
            if (!CoreReader.coreUserExists(member)) revert NoCoreUser();
            _market(whale).addMember(member);
        } else if (sel == OP_EPS) {
            (address whale, uint256 eps) = abi.decode(data[4:], (address, uint256));
            _market(whale).applyEps(eps);
        } else if (sel == OP_FEE) {
            uint256 next = abi.decode(data[4:], (uint256));
            if (next > Config.MAX_FEE_BPS) revert BadAmount();
            feeBps = next;
        } else if (sel == OP_CAP) {
            uint256 next = abi.decode(data[4:], (uint256));
            if (maxPotPerSide != 0 && next != 0 && next <= maxPotPerSide) revert CapDirection();
            maxPotPerSide = next;
        } else if (sel == OP_BEACON) {
            address next = abi.decode(data[4:], (address));
            if (next == address(0)) revert BadAddress();
            beacon.upgrade(next);
        } else if (sel == OP_REGISTRY) {
            address next = abi.decode(data[4:], (address));
            if (next == address(0)) revert BadAddress();
            assembly {
                sstore(REGISTRY_SLOT, next)
            }
        } else if (sel == OP_LIST) {
            (
                address whale,
                address[] memory members,
                string memory ticker,
                string memory name_,
                uint32[] memory dexes,
                uint32[] memory weightedPerps,
                uint256 seedPerSide
            ) = abi.decode(data[4:], (address, address[], string, string, uint32[], uint32[], uint256));
            _addWallet(whale, members, ticker, name_, dexes, weightedPerps, seedPerSide);
        } else if (sel == OP_GUARDIAN) {
            address next = abi.decode(data[4:], (address));
            if (next == address(0)) revert BadAddress();
            guardian = next;
            emit GuardianUpdated(next);
        } else if (sel == OP_FEE_WALLET) {
            address next = abi.decode(data[4:], (address));
            if (next == address(0)) revert BadAddress();
            feeWallet = next;
            emit FeeWalletUpdated(next);
        } else if (sel == OP_HOUSE_SELL) {
            (address whale, uint8 side, uint256 shares) = abi.decode(data[4:], (address, uint8, uint256));
            _market(whale).commitHouseSell(WalletMarketV3.Side(side), shares);
        } else {
            revert Timelocked();
        }
    }

    /// @notice Realise house fills. Sampling itself is permissionless; this only credits the house.
    function claimHouse(address whale, WalletMarketV3.Asset[] calldata assets) external onlyOwner nonReentrant {
        _market(whale).materializeHouse(assets);
    }

    function whaleCount() external view returns (uint256) {
        return whales.length;
    }

    function marketCount() external view returns (uint256) {
        return _markets.length;
    }

    function marketAt(uint256 i) external view returns (address) {
        return _markets[i];
    }

    /// @notice Token balance covers user balances, fees, realised house USDC, and every market's pots.
    function liabilities() public view returns (uint256 owed) {
        owed = totalBalances + protocolFees + houseBalance;
        uint256 n = _markets.length;
        for (uint256 i; i < n; ++i) {
            owed += WalletMarketV3(_markets[i]).usdcHeld();
        }
    }

    function solvent() external view returns (bool) {
        return usdc.balanceOf(address(this)) >= liabilities();
    }

    function optOut(address whale, bytes calldata sig) external {
        if (optedOut[whale]) revert OptedOutAddress();
        if (ECDSA.recover(hashOptOut(whale), sig) != whale) revert BadSignature();
        optedOut[whale] = true;
        Listing memory listing = listings[whale];
        if (listing.market != address(0) && listing.active) {
            listings[whale].active = false;
            WalletMarketV3(listing.market).beginOptOut();
        }
        emit OptedOut(whale, msg.sender);
    }

    function hashOptOut(address whale) public view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), keccak256(abi.encode(OPT_OUT_TYPEHASH, whale))));
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                DOMAIN_TYPEHASH,
                keccak256(bytes("whalewallet.fun")),
                keccak256(bytes("3")),
                block.chainid,
                address(this)
            )
        );
    }

    // ---------------------------------------------------------------- internal

    function _addWallet(
        address whale,
        address[] memory members,
        string memory ticker,
        string memory name_,
        uint32[] memory dexes,
        uint32[] memory weightedPerps,
        uint256 seedPerSide
    ) internal returns (address market) {
        if (optedOut[whale]) revert OptedOutAddress();
        if (whale == address(0) || listings[whale].market != address(0)) revert AlreadyListed();
        uint256 tickLen = bytes(ticker).length;
        if (tickLen < 2 || tickLen > 12) revert BadTicker();
        bytes32 tick = keccak256(bytes(ticker));
        if (tickerToWhale[tick] != address(0)) revert BadTicker();
        if (!CoreReader.coreUserExists(whale)) revert NoCoreUser();
        uint256 n = members.length;
        for (uint256 i; i < n; ++i) {
            if (!CoreReader.coreUserExists(members[i])) revert NoCoreUser();
        }
        if (seedPerSide != 0) _transferFrom(owner, address(this), seedPerSide * 2);

        market = address(new MarketProxy(address(beacon)));
        isMarket[market] = true;
        _markets.push(market);
        WalletMarketV3(market).initialize(whale, members, ticker, dexes, weightedPerps, seedPerSide);
        listings[whale] = Listing({market: market, whale: whale, active: true});
        tickerToWhale[tick] = whale;
        whales.push(whale);
        emit WalletListed(whale, market, ticker, name_, _membersOf(market));
    }

    function _market(address whale) internal view returns (WalletMarketV3) {
        address m = listings[whale].market;
        if (m == address(0)) revert UnknownListing();
        return WalletMarketV3(m);
    }

    function _membersOf(address market) internal view returns (address[] memory out) {
        uint256 n = WalletMarketV3(market).memberCount();
        out = new address[](n);
        for (uint256 i; i < n; ++i) {
            out[i] = WalletMarketV3(market).members(i);
        }
    }

    function _allowed(bytes4 sel) internal pure returns (bool) {
        return sel == OP_WEIGHTED || sel == OP_DEX || sel == OP_MEMBER || sel == OP_EPS || sel == OP_FEE || sel == OP_CAP
            || sel == OP_BEACON || sel == OP_REGISTRY || sel == OP_LIST || sel == OP_GUARDIAN || sel == OP_FEE_WALLET
            || sel == OP_HOUSE_SELL;
    }

    function _transfer(address to, uint256 amount) internal {
        (bool ok, bytes memory ret) = address(usdc).call(abi.encodeWithSelector(IERC20Min.transfer.selector, to, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    function _transferFrom(address from, address to, uint256 amount) internal {
        (bool ok, bytes memory ret) =
            address(usdc).call(abi.encodeWithSelector(IERC20Min.transferFrom.selector, from, to, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    function _bubble(bytes memory err) internal pure {
        assembly {
            revert(add(err, 32), mload(err))
        }
    }
}
