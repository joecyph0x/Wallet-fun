// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Season0} from "./Season0.sol";
import {HyperCoreReader} from "./HyperCoreReader.sol";
import {PotMath} from "./PotMath.sol";
import {IRegistry} from "./IRegistry.sol";

/// @title WalletMarket
/// @notice One curated Hyperliquid wallet. TAIL and FADE are non-transferable point shares
///         of two pots. Settlement reads HyperCore, moves points from the losing side to the
///         winning side, then fills the queue at the post-settlement NAV.
///
///         There is no USDC, no ERC-20, and no CoreWriter. Shares cannot be transferred.
contract WalletMarket {
    enum Side {
        Tail,
        Fade
    }

    enum Status {
        Uninitialized,
        Sleeping,
        Active,
        OptOutPending,
        RedeemOnly
    }

    struct Asset {
        uint8 memberIndex;
        uint32 perp;
    }

    struct Order {
        address user;
        Side side;
        bool isBuy;
        uint256 pointsIn;
        uint256 sharesIn;
        bool open;
    }

    struct Snap {
        address member;
        uint32 perp;
        int64 szi;
        uint64 mark;
        bool live;
    }

    struct Book {
        uint256 equity;
        uint256 ntlPos;
        uint256 covered;
        uint256 weightedNtl;
        int256 pnl;
        bool changed;
        uint64 l1Block;
    }

    struct Quote {
        uint256 tailPot0;
        uint256 tailSup0;
        uint256 fadePot0;
        uint256 fadeSup0;
    }

    error TooEarly(uint256 nextAllowed);
    error IncompleteBook(uint256 covered, uint256 ntlPos);
    error DexNotTracked(uint32 perp);
    error DuplicateAsset(uint32 perp);
    error BadMember(uint8 index);
    error TooManyAssets();
    error Paused();
    error Closed();
    error BadAmount();
    error QueueFull();
    error NotYourOrder();
    error AlreadyInit();

    event PositionSampled(
        address indexed member, uint32 indexed perp, int64 szi, uint64 markPx, bool weighted, bool changed
    );
    event Settled(
        address indexed whale,
        address indexed caller,
        int256 pnl,
        int256 appliedRBps,
        int256 delta,
        uint256 tailPot,
        uint256 fadePot,
        uint256 tailNav,
        uint256 fadeNav,
        uint256 equity,
        uint256 eRef,
        uint256 ntlPos,
        uint256 weightedNtl,
        uint64 l1Block,
        bool positionChanged
    );
    event WhaleAwake(address indexed whale, uint256 ntlPos);
    event WhaleAsleep(address indexed whale);
    event OptOutStarted(address indexed whale);
    event FinalSettlement(address indexed whale);
    event OrderQueued(
        address indexed user,
        address indexed whale,
        uint8 side,
        bool isBuy,
        uint256 points,
        uint256 shares,
        uint256 indexed orderId
    );
    event OrderFilled(
        address indexed user, address indexed whale, uint8 side, bool isBuy, uint256 points, uint256 shares, uint256 nav
    );
    event OrderRefunded(
        address indexed user, address indexed whale, uint8 side, bool isBuy, uint256 points, uint256 shares
    );
    event OrderCancelled(address indexed user, uint256 indexed orderId);
    event TradingPaused(bool on);
    event DexUpdated(address indexed whale, uint32 dex, bool enabled);
    event WeightUpdated(address indexed whale, uint32 perp, bool weighted);
    event MemberAdded(address indexed whale, address indexed member);
    event EpsUpdated(uint256 epsBps);

    address public registry;
    address public whale;
    string public ticker;
    string public displayName;

    address[] public members;
    uint32[] public dexes;
    mapping(uint32 => bool) public dexEnabled;
    mapping(uint32 => bool) public weighted;

    uint256 public tailPot;
    uint256 public fadePot;
    uint256 public tailSupply;
    uint256 public fadeSupply;
    mapping(address => uint256) public tailShares;
    mapping(address => uint256) public fadeShares;

    uint256 public eRef;
    uint32 public eRefDay;
    int256 public dailyRBps;
    bool public seeded;

    uint256 public epsBps;
    Status public status;
    bool public paused;
    bool public initialized;

    uint256 public lastSettleTs;
    uint256 public settleCount;
    int256 public lastPnl;
    int256 public lastAppliedRBps;
    int256 public lastDelta;
    uint256 public lastEquity;
    uint256 public lastNtlPos;
    uint256 public lastWeightedNtl;
    bool public lastPositionChanged;
    uint64 public lastL1Block;

    Order[] public orders;
    uint256 public openOrders;

    function orderCount() external view returns (uint256) {
        return orders.length;
    }
    uint256 public queuedBuyPoints;

    mapping(bytes32 => Snap) internal _snap;
    bytes32[] internal _snapKeys;
    Snap[] internal _staged;
    mapping(bytes32 => uint256) internal _seen;
    uint256 internal _readNonce;
    uint256 private _lock;

    modifier nonReentrant() {
        require(_lock == 0, "reenter");
        _lock = 1;
        _;
        _lock = 0;
    }

    modifier onlyRegistry() {
        require(msg.sender == registry, "registry");
        _;
    }

    /// @dev Locks the implementation. Clones do not run this constructor.
    constructor() {
        registry = address(1);
        initialized = true;
        status = Status.RedeemOnly;
    }

    function initialize(
        address whale_,
        address[] calldata members_,
        string calldata ticker_,
        string calldata name_,
        uint32[] calldata dexes_,
        uint32[] calldata weightedPerps_
    ) external {
        if (initialized || registry != address(0)) revert AlreadyInit();
        if (whale_ == address(0)) revert BadAmount();
        uint256 nameLen = bytes(name_).length;
        uint256 tickLen = bytes(ticker_).length;
        require(nameLen > 0 && nameLen <= 64, "name");
        require(tickLen >= 2 && tickLen <= 12, "ticker");
        require(dexes_.length <= Season0.MAX_DEXES, "dexes");
        require(members_.length <= Season0.MAX_MEMBERS, "members");

        initialized = true;
        registry = msg.sender;
        whale = whale_;
        ticker = ticker_;
        displayName = name_;
        epsBps = 100;
        status = Status.Sleeping;

        if (members_.length == 0) {
            members.push(whale_);
        } else {
            require(members_[0] == whale_, "member0");
            for (uint256 i; i < members_.length; ++i) {
                require(members_[i] != address(0), "member");
                for (uint256 j; j < i; ++j) {
                    require(members_[j] != members_[i], "dup member");
                }
                members.push(members_[i]);
            }
        }

        if (dexes_.length == 0) {
            dexes.push(0);
            dexEnabled[0] = true;
        } else {
            for (uint256 i; i < dexes_.length; ++i) {
                require(!dexEnabled[dexes_[i]], "dex dup");
                dexEnabled[dexes_[i]] = true;
                dexes.push(dexes_[i]);
            }
        }

        for (uint256 i; i < weightedPerps_.length; ++i) {
            uint32 perp = weightedPerps_[i];
            require(dexEnabled[Season0.dexOf(perp)], "weight dex");
            weighted[perp] = true;
        }
    }

    // ---------------------------------------------------------------- config

    function setPaused(bool on) external onlyRegistry {
        paused = on;
        emit TradingPaused(on);
    }

    function setEpsBps(uint256 eps) external onlyRegistry {
        require(eps >= 10 && eps <= 500, "eps");
        epsBps = eps;
        emit EpsUpdated(eps);
    }

    function setDexEnabled(uint32 dex, bool enabled) external onlyRegistry {
        if (enabled) {
            if (dexEnabled[dex]) return;
            require(dexes.length < Season0.MAX_DEXES, "dexes");
            dexEnabled[dex] = true;
            dexes.push(dex);
        } else {
            require(dex != 0, "dex0");
            require(dexEnabled[dex], "dex");
            dexEnabled[dex] = false;
            for (uint256 i; i < dexes.length; ++i) {
                if (dexes[i] == dex) {
                    dexes[i] = dexes[dexes.length - 1];
                    dexes.pop();
                    break;
                }
            }
        }
        emit DexUpdated(whale, dex, enabled);
    }

    function setWeighted(uint32 perp, bool on) external onlyRegistry {
        if (on) require(dexEnabled[Season0.dexOf(perp)], "dex");
        weighted[perp] = on;
        emit WeightUpdated(whale, perp, on);
    }

    function addMember(address member) external onlyRegistry {
        require(member != address(0), "member");
        require(members.length < Season0.MAX_MEMBERS, "members");
        for (uint256 i; i < members.length; ++i) {
            require(members[i] != member, "dup member");
        }
        require(HyperCoreReader.coreUserExists(member), "core");
        members.push(member);
        emit MemberAdded(whale, member);
    }

    function beginOptOut() external onlyRegistry nonReentrant {
        if (status != Status.Active && status != Status.Sleeping) revert Closed();
        status = Status.OptOutPending;
        _refundOpenBuys();
        emit OptOutStarted(whale);
    }

    // ---------------------------------------------------------------- trading

    function queueBuy(Side side, uint256 pointsAmount) external nonReentrant returns (uint256 orderId) {
        _requireTradingOpen();
        if (status != Status.Active && status != Status.Sleeping) revert Closed();
        if (pointsAmount == 0) revert BadAmount();
        IRegistry(registry).pullPoints(msg.sender, pointsAmount);
        queuedBuyPoints += pointsAmount;
        orderId = _push(true, side, pointsAmount, 0);
    }

    function queueSell(Side side, uint256 shares) external nonReentrant returns (uint256 orderId) {
        _requireTradingOpen();
        if (status == Status.Uninitialized) revert Closed();
        if (shares == 0) revert BadAmount();
        if (side == Side.Tail) {
            if (tailShares[msg.sender] < shares) revert BadAmount();
            tailShares[msg.sender] -= shares;
        } else {
            if (fadeShares[msg.sender] < shares) revert BadAmount();
            fadeShares[msg.sender] -= shares;
        }
        orderId = _push(false, side, 0, shares);
    }

    function cancel(uint256 orderId) external nonReentrant {
        if (orderId >= orders.length) revert NotYourOrder();
        Order memory o = orders[orderId];
        if (!o.open || o.user != msg.sender) revert NotYourOrder();
        orders[orderId].open = false;
        openOrders -= 1;
        if (o.isBuy) {
            queuedBuyPoints -= o.pointsIn;
            IRegistry(registry).pushPoints(msg.sender, o.pointsIn);
        } else if (o.side == Side.Tail) {
            tailShares[msg.sender] += o.sharesIn;
        } else {
            fadeShares[msg.sender] += o.sharesIn;
        }
        emit OrderCancelled(msg.sender, orderId);
    }

    /// @notice Permissionless. Heartbeat is 60s. A change in position size may settle sooner.
    ///         Mark-only moves wait for the heartbeat. After opt-out wind-down, this only fills sells.
    function settle(Asset[] calldata assets) external nonReentrant {
        if (!initialized || registry == address(1)) revert Closed();
        if (paused || IRegistry(registry).globalPaused()) revert Paused();

        if (status == Status.RedeemOnly) {
            _fillQueue();
            return;
        }
        if (status != Status.Active && status != Status.Sleeping && status != Status.OptOutPending) revert Closed();
        if (assets.length > Season0.MAX_ASSETS) revert TooManyAssets();

        Book memory book = _readBook(assets);
        bool due = block.timestamp >= lastSettleTs + Season0.HEARTBEAT;
        if (lastSettleTs != 0 && !book.changed && !due) revert TooEarly(lastSettleTs + Season0.HEARTBEAT);

        (int256 applied, int256 delta) = _applyReturn(book);

        _commitSnaps();
        _updatePresence(book.ntlPos);

        if (status == Status.OptOutPending) {
            status = Status.RedeemOnly;
            emit FinalSettlement(whale);
        }

        lastSettleTs = block.timestamp;
        settleCount += 1;
        lastPnl = book.pnl;
        lastAppliedRBps = applied;
        lastDelta = delta;
        lastEquity = book.equity;
        lastNtlPos = book.ntlPos;
        lastWeightedNtl = book.weightedNtl;
        lastPositionChanged = book.changed;
        lastL1Block = book.l1Block;

        _fillQueue();
        _emitSettled(book);
    }

    // ---------------------------------------------------------------- views

    function navOf(Side side) public view returns (uint256) {
        return side == Side.Tail ? PotMath.nav(tailPot, tailSupply) : PotMath.nav(fadePot, fadeSupply);
    }

    function sharesOf(address user, Side side) external view returns (uint256) {
        return side == Side.Tail ? tailShares[user] : fadeShares[user];
    }

    /// @notice Points sitting in the two pots plus buys that have not filled yet.
    function pointsHeld() external view returns (uint256) {
        return tailPot + fadePot + queuedBuyPoints;
    }

    function snapOf(address member, uint32 perp) external view returns (Snap memory) {
        return _snap[_key(member, perp)];
    }

    function memberCount() external view returns (uint256) {
        return members.length;
    }

    function dexCount() external view returns (uint256) {
        return dexes.length;
    }

    // ---------------------------------------------------------------- internals

    function _emitSettled(Book memory book) internal {
        emit Settled(
            whale,
            msg.sender,
            book.pnl,
            lastAppliedRBps,
            lastDelta,
            tailPot,
            fadePot,
            navOf(Side.Tail),
            navOf(Side.Fade),
            book.equity,
            eRef,
            book.ntlPos,
            book.weightedNtl,
            book.l1Block,
            book.changed
        );
    }

    function _requireTradingOpen() internal view {
        if (!initialized || registry == address(1)) revert Closed();
        if (paused || IRegistry(registry).globalPaused()) revert Paused();
        if (openOrders >= Season0.MAX_QUEUE) revert QueueFull();
    }

    function _push(bool isBuy, Side side, uint256 pointsIn, uint256 sharesIn) internal returns (uint256 orderId) {
        orderId = orders.length;
        orders.push(
            Order({user: msg.sender, side: side, isBuy: isBuy, pointsIn: pointsIn, sharesIn: sharesIn, open: true})
        );
        openOrders += 1;
        emit OrderQueued(msg.sender, whale, uint8(side), isBuy, pointsIn, sharesIn, orderId);
    }

    function _applyReturn(Book memory book) internal returns (int256 applied, int256 delta) {
        uint32 day = uint32(block.timestamp / 1 days);
        bool newDay = seeded && day != eRefDay;
        // The crossing sample still uses yesterday's eRef, and starts a fresh daily budget.
        if (newDay) dailyRBps = 0;
        // A wallet that had no equity can start being measured the same day it is funded.
        // An already-positive eRef is not raised or lowered until the UTC roll below.
        if (seeded && eRef == 0 && book.equity > 0) eRef = book.equity;

        if (!seeded) {
            eRef = book.equity;
            eRefDay = day;
            seeded = true;
            return (0, 0);
        }

        int256 nextDaily;
        (applied, nextDaily) = PotMath.appliedReturnBps(book.pnl, eRef, dailyRBps);
        uint256 capAmount = PotMath.capacity(tailPot, fadePot, eRef);
        delta = PotMath.deltaOf(applied, capAmount);
        dailyRBps = nextDaily;
        _movePots(delta);
        if (newDay) {
            eRef = book.equity;
            eRefDay = day;
        }
    }

    function _movePots(int256 delta) internal {
        if (delta > 0) {
            uint256 u = uint256(delta);
            fadePot -= u;
            tailPot += u;
        } else if (delta < 0) {
            uint256 u = uint256(-delta);
            tailPot -= u;
            fadePot += u;
        }
    }

    function _updatePresence(uint256 ntlPos) internal {
        if (status == Status.Sleeping && ntlPos > 0) {
            status = Status.Active;
            emit WhaleAwake(whale, ntlPos);
        } else if (status == Status.Active && ntlPos == 0) {
            status = Status.Sleeping;
            emit WhaleAsleep(whale);
        }
    }

    function _readBook(Asset[] calldata assets) internal returns (Book memory book) {
        _readNonce += 1;
        book.l1Block = HyperCoreReader.l1BlockNumber();
        _loadMargins(book);

        uint256 n = assets.length;
        for (uint256 i; i < n; ++i) {
            _observeKeeper(assets[i].memberIndex, assets[i].perp, book);
        }
        uint256 m = _snapKeys.length;
        for (uint256 i; i < m; ++i) {
            _observeStored(_snap[_snapKeys[i]], book);
        }
        _checkComplete(book.covered, book.ntlPos);
    }

    function _loadMargins(Book memory book) internal view {
        int256 equity;
        uint256 ntl;
        uint256 mc = members.length;
        uint256 dc = dexes.length;
        for (uint256 i; i < mc; ++i) {
            address member = members[i];
            for (uint256 j; j < dc; ++j) {
                HyperCoreReader.AccountMarginSummary memory a = HyperCoreReader.accountMarginSummary(dexes[j], member);
                equity += int256(a.accountValue);
                ntl += uint256(a.ntlPos);
            }
        }
        book.equity = equity < 0 ? 0 : uint256(equity);
        book.ntlPos = ntl;
    }

    function _observeKeeper(uint8 memberIndex, uint32 perp, Book memory book) internal {
        if (memberIndex >= members.length) revert BadMember(memberIndex);
        if (!dexEnabled[Season0.dexOf(perp)]) revert DexNotTracked(perp);
        address member = members[memberIndex];
        bytes32 key = _key(member, perp);
        if (_seen[key] == _readNonce) revert DuplicateAsset(perp);
        _seen[key] = _readNonce;
        (int64 szi, uint64 mark) = _live(member, perp);
        _accumulate(member, perp, szi, mark, _snap[key], book);
    }

    function _observeStored(Snap memory prev, Book memory book) internal {
        if (!prev.live) return;
        bytes32 key = _key(prev.member, prev.perp);
        if (_seen[key] == _readNonce) return;
        // A dex the curator turned off is dropped. Dex 0 cannot be turned off.
        if (!dexEnabled[Season0.dexOf(prev.perp)]) return;
        _seen[key] = _readNonce;
        (int64 szi, uint64 mark) = _live(prev.member, prev.perp);
        _accumulate(prev.member, prev.perp, szi, mark, prev, book);
    }

    function _accumulate(address member, uint32 perp, int64 szi, uint64 mark, Snap memory prev, Book memory book)
        internal
    {
        uint256 notion = PotMath.notional(szi, mark);
        book.covered += notion;
        bool isWeighted = weighted[perp];
        if (isWeighted) book.weightedNtl += notion;
        if (prev.live && prev.szi != 0 && isWeighted) {
            book.pnl += PotMath.pricePnl(prev.szi, prev.mark, mark);
        }
        if (szi != prev.szi) book.changed = true;
        emit PositionSampled(member, perp, szi, mark, isWeighted, szi != prev.szi);
        if (szi != 0) {
            _staged.push(Snap({member: member, perp: perp, szi: szi, mark: mark, live: true}));
        }
    }

    function _checkComplete(uint256 covered, uint256 ntlPos) internal view {
        if (ntlPos == 0) {
            if (covered != 0) revert IncompleteBook(covered, ntlPos);
            return;
        }
        uint256 lo = ntlPos * (Season0.BPS - epsBps) / Season0.BPS;
        uint256 hi = ntlPos * (Season0.BPS + epsBps) / Season0.BPS;
        if (covered < lo || covered > hi) revert IncompleteBook(covered, ntlPos);
    }

    function _live(address user, uint32 perp) internal view returns (int64 szi, uint64 mark) {
        szi = HyperCoreReader.position(user, perp).szi;
        mark = HyperCoreReader.markPx(perp);
    }

    function _commitSnaps() internal {
        uint256 m = _snapKeys.length;
        for (uint256 i; i < m; ++i) {
            delete _snap[_snapKeys[i]];
        }
        delete _snapKeys;
        uint256 n = _staged.length;
        for (uint256 i; i < n; ++i) {
            Snap memory s = _staged[i];
            bytes32 key = _key(s.member, s.perp);
            _snap[key] = s;
            _snapKeys.push(key);
        }
        delete _staged;
    }

    function _key(address member, uint32 perp) internal pure returns (bytes32) {
        return keccak256(abi.encode(member, perp));
    }

    function _refundOpenBuys() internal {
        uint256 n = orders.length;
        for (uint256 i; i < n; ++i) {
            if (!orders[i].open || !orders[i].isBuy) continue;
            Order memory o = orders[i];
            orders[i].open = false;
            openOrders -= 1;
            queuedBuyPoints -= o.pointsIn;
            IRegistry(registry).pushPoints(o.user, o.pointsIn);
            emit OrderRefunded(o.user, whale, uint8(o.side), true, o.pointsIn, 0);
        }
    }

    function _fillQueue() internal {
        Quote memory q = Quote({tailPot0: tailPot, tailSup0: tailSupply, fadePot0: fadePot, fadeSup0: fadeSupply});
        uint256 n = orders.length;
        for (uint256 i; i < n; ++i) {
            if (!orders[i].open) continue;
            _fillOne(i, q);
        }
    }

    /// @dev Every order in the batch is priced off the pre-queue NAV, so queue position
    ///      inside one settlement does not matter. Dust orders are refunded instead of
    ///      reverting the whole settlement.
    function _fillOne(uint256 index, Quote memory q) internal {
        Order memory o = orders[index];
        orders[index].open = false;
        openOrders -= 1;

        uint256 pot0 = o.side == Side.Tail ? q.tailPot0 : q.fadePot0;
        uint256 sup0 = o.side == Side.Tail ? q.tailSup0 : q.fadeSup0;
        uint256 navPx = sup0 == 0 ? Season0.UNIT : pot0 * Season0.UNIT / sup0;

        if (o.isBuy) {
            if (status == Status.RedeemOnly || (sup0 != 0 && pot0 == 0)) {
                _releaseBuy(o);
                return;
            }
            uint256 fee = o.pointsIn * Season0.FEE_BPS / Season0.BPS;
            uint256 net = o.pointsIn - fee;
            uint256 liveSup = o.side == Side.Tail ? tailSupply : fadeSupply;
            uint256 userShares;
            uint256 minted;
            if (sup0 == 0) {
                if (net <= Season0.MIN_LIQUIDITY) {
                    _releaseBuy(o);
                    return;
                }
                minted = net;
                if (liveSup == 0) {
                    userShares = net - Season0.MIN_LIQUIDITY;
                    _addShares(o.side, address(1), Season0.MIN_LIQUIDITY);
                } else {
                    userShares = net;
                }
            } else {
                userShares = net * sup0 / pot0;
                if (userShares == 0) {
                    _releaseBuy(o);
                    return;
                }
                minted = userShares;
            }
            queuedBuyPoints -= o.pointsIn;
            _addPot(o.side, net, minted);
            _addShares(o.side, o.user, userShares);
            if (fee != 0) IRegistry(registry).takeFee(fee);
            emit OrderFilled(o.user, whale, uint8(o.side), true, net, userShares, navPx);
            return;
        }

        if (sup0 == 0 || pot0 == 0) {
            _giveSharesBack(o);
            return;
        }
        uint256 gross = o.sharesIn * pot0 / sup0;
        uint256 livePot = o.side == Side.Tail ? tailPot : fadePot;
        if (gross == 0 || gross > livePot) {
            _giveSharesBack(o);
            return;
        }
        uint256 sellFee = gross * Season0.FEE_BPS / Season0.BPS;
        uint256 netOut = gross - sellFee;
        _subPot(o.side, gross, o.sharesIn);
        IRegistry(registry).pushPoints(o.user, netOut);
        if (sellFee != 0) IRegistry(registry).takeFee(sellFee);
        emit OrderFilled(o.user, whale, uint8(o.side), false, netOut, o.sharesIn, navPx);
    }

    function _releaseBuy(Order memory o) internal {
        queuedBuyPoints -= o.pointsIn;
        IRegistry(registry).pushPoints(o.user, o.pointsIn);
        emit OrderRefunded(o.user, whale, uint8(o.side), true, o.pointsIn, 0);
    }

    function _giveSharesBack(Order memory o) internal {
        _addShares(o.side, o.user, o.sharesIn);
        emit OrderRefunded(o.user, whale, uint8(o.side), false, 0, o.sharesIn);
    }

    function _addPot(Side side, uint256 net, uint256 minted) internal {
        if (side == Side.Tail) {
            tailPot += net;
            tailSupply += minted;
        } else {
            fadePot += net;
            fadeSupply += minted;
        }
    }

    function _subPot(Side side, uint256 gross, uint256 shares) internal {
        if (side == Side.Tail) {
            tailPot -= gross;
            tailSupply -= shares;
        } else {
            fadePot -= gross;
            fadeSupply -= shares;
        }
    }

    function _addShares(Side side, address user, uint256 shares) internal {
        if (side == Side.Tail) tailShares[user] += shares;
        else fadeShares[user] += shares;
    }
}
