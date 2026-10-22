// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Config} from "./Config.sol";
import {CoreReader} from "./CoreReader.sol";
import {IRegistryV3} from "./IRegistryV3.sol";
import {PotMath} from "./PotMath.sol";

/// @title WalletMarketV3
/// @notice TAIL / FADE shares of one whale's PnL, denominated in USDC.
///
///         Settlement is lazy and O(1) in the number of orders. Buys and sells commit
///         into the open epoch and fill on the next epoch's NAV, in aggregate.
///         Each user pays to materialise their own fill. There is no shared queue.
///
///         A guardian pause blocks new buys. Sells, claims, cancels and withdrawals stay open.
///         Logic sits behind MarketBeacon. Storage layout is append-only.
contract WalletMarketV3 {
    enum Side {
        Tail,
        Fade
    }

    enum Status {
        None,
        Live,
        RedeemOnly
    }

    struct Asset {
        uint8 memberIndex;
        uint32 perp;
    }

    struct Lot {
        uint64 gen;
        uint256 shares;
    }

    /// @dev One open commit per user. Four legs: buy/sell × tail/fade.
    struct Pending {
        uint64 epoch;
        uint256 buyTail;
        uint256 buyFade;
        uint256 sellTail;
        uint256 sellFade;
    }

    struct Bucket {
        uint256 buyTail;
        uint256 buyFade;
        uint256 sellTail;
        uint256 sellFade;
    }

    /// @dev Conversion rate for one closed epoch. Users apply it themselves.
    struct Fill {
        bool set;
        bool voided;
        uint256 buyTail;
        uint256 buyFade;
        uint256 tailSharesOut;
        uint256 fadeSharesOut;
        uint256 sellTail;
        uint256 sellFade;
        uint256 tailUsdcOut;
        uint256 fadeUsdcOut;
        uint256 tailBuyFee;
        uint256 fadeBuyFee;
        uint256 tailSellFee;
        uint256 fadeSellFee;
        uint64 tailGen;
        uint64 fadeGen;
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
        int256 pnl;
        bool changed;
        uint64 l1Block;
        uint256 weightedNtl;
    }

    error Closed();
    error AlreadyInit();
    error BuysPaused();
    error MinOrder();
    error BadAmount();
    error PotCap();
    error TooEarly(uint256 nextAllowed);
    error TooManyAssets();
    error BadMember(uint8 index);
    error DexNotTracked(uint32 perp);
    error DuplicateAsset(uint32 perp);
    error IncompleteBook(uint256 covered, uint256 ntlPos);
    error EpochClosed();
    error NotEmergency();
    error HouseInert();
    error NotRegistry();
    error Reentered();

    event Settled(
        address indexed whale,
        address indexed caller,
        uint64 epoch,
        int256 pnl,
        int256 appliedRay,
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
    event OrderCommitted(
        address indexed user,
        address indexed whale,
        uint8 side,
        bool isBuy,
        uint256 amount,
        uint256 shares,
        uint64 epoch
    );
    event OrderCancelled(address indexed user, address indexed whale, uint64 epoch, uint256 fee);
    event FeePaid(
        address indexed user,
        address indexed whale,
        uint8 side,
        bool isBuy,
        uint256 fee,
        uint256 notional,
        uint64 epoch,
        uint64 heldEpochs
    );
    event Exposure(
        address indexed user, address indexed whale, uint8 side, uint256 sharesAfter, uint64 epoch, uint64 openedEpoch
    );
    event EmergencyExit(address indexed user, address indexed whale, uint8 side, uint256 shares, uint256 usdc);
    event HouseSeeded(address indexed whale, uint8 side, uint256 usdc, uint256 shares);

    address public registry;
    address public whale;
    string public ticker;

    address[] public members;
    uint32[] public dexes;
    mapping(uint32 => bool) public dexEnabled;
    mapping(uint32 => bool) public weighted;

    uint256 public tailPot;
    uint256 public fadePot;
    uint256 public tailSupply;
    uint256 public fadeSupply;
    uint64 public tailGen;
    uint64 public fadeGen;
    mapping(address => Lot) internal _tail;
    mapping(address => Lot) internal _fade;
    mapping(address => uint64) public tailOpened;
    mapping(address => uint64) public fadeOpened;

    Bucket public openBucket;
    mapping(address => Pending) public pending;
    mapping(uint64 => Fill) public fills;
    /// @dev USDC owed to users who have not materialised a fill yet, plus open-bucket buys.
    uint256 public reserved;

    uint256 public eRef;
    uint32 public eRefDay;
    int256 public dailyR;
    bool public eRefSet;

    uint256 public epsBps;
    Status public status;
    bool public initialized;
    uint256 public lastSettleTs;
    /// @dev Id of the epoch currently accepting commits. Fills are stored under the id that just closed.
    uint64 public epoch;
    uint256 public lastTailNav;
    uint256 public lastFadeNav;
    uint256 public lastEquity;
    uint256 public lastNtlPos;
    int256 public lastPnl;
    int256 public lastApplied;
    int256 public lastDelta;
    uint256 public lastWeightedNtl;
    bool public lastPositionChanged;
    uint64 public lastL1Block;

    mapping(bytes32 => Snap) internal _snap;
    bytes32[] internal _snapKeys;
    uint256 internal _readNonce;
    mapping(bytes32 => uint256) internal _seen;
    Snap[] internal _staged;
    uint256 internal _lock;

    constructor() {
        initialized = true;
    }

    modifier nonReentrant() {
        if (_lock == 1) revert Reentered();
        _lock = 1;
        _;
        _lock = 0;
    }

    modifier onlyRegistry() {
        if (msg.sender != registry) revert NotRegistry();
        _;
    }

    // ---------------------------------------------------------------- views

    function sharesOf(address user, Side side) public view returns (uint256) {
        Lot memory lot = side == Side.Tail ? _tail[user] : _fade[user];
        uint64 gen = side == Side.Tail ? tailGen : fadeGen;
        if (lot.gen != gen) return 0;
        return lot.shares;
    }

    /// @dev Pots + committed buys + USDC reserved for fills not yet claimed.
    function usdcHeld() public view returns (uint256) {
        return tailPot + fadePot + openBucket.buyTail + openBucket.buyFade + reserved;
    }

    function navOf(Side side) public view returns (uint256) {
        return side == Side.Tail ? PotMath.nav(tailPot, tailSupply) : PotMath.nav(fadePot, fadeSupply);
    }

    function memberCount() external view returns (uint256) {
        return members.length;
    }

    function dexCount() external view returns (uint256) {
        return dexes.length;
    }

    // ---------------------------------------------------------------- init

    function initialize(
        address whale_,
        address[] calldata extraMembers,
        string calldata ticker_,
        uint32[] calldata dexes_,
        uint32[] calldata weightedPerps,
        uint256 seedPerSide
    ) external {
        if (initialized) revert AlreadyInit();
        if (whale_ == address(0)) revert BadAmount();
        if (dexes_.length == 0 || dexes_.length > Config.MAX_DEXES) revert BadAmount();
        initialized = true;
        registry = msg.sender;
        whale = whale_;
        ticker = ticker_;
        epoch = 1;
        tailGen = 1;
        fadeGen = 1;
        epsBps = 100;
        status = Status.Live;
        lastTailNav = Config.UNIT;
        lastFadeNav = Config.UNIT;

        // Index 0 is always the listed wallet. Extra addresses are subaccounts.
        if (1 + extraMembers.length > Config.MAX_MEMBERS) revert BadAmount();
        members.push(whale_);
        for (uint256 i; i < extraMembers.length; ++i) {
            if (extraMembers[i] == address(0) || extraMembers[i] == whale_) revert BadAmount();
            members.push(extraMembers[i]);
        }
        bool sawDex0;
        for (uint256 i; i < dexes_.length; ++i) {
            dexes.push(dexes_[i]);
            dexEnabled[dexes_[i]] = true;
            if (dexes_[i] == 0) sawDex0 = true;
        }
        if (!sawDex0) revert BadAmount();
        for (uint256 i; i < weightedPerps.length; ++i) {
            weighted[weightedPerps[i]] = true;
        }
        if (seedPerSide != 0) {
            _mintHouse(Side.Tail, seedPerSide);
            _mintHouse(Side.Fade, seedPerSide);
        }
    }

    function applyWeighted(uint32 perp, bool on) external onlyRegistry {
        weighted[perp] = on;
    }

    function applyDex(uint32 dex, bool on) external onlyRegistry {
        if (dex == 0 && !on) revert BadAmount();
        dexEnabled[dex] = on;
    }

    function applyEps(uint256 eps) external onlyRegistry {
        if (eps > 500) revert BadAmount();
        epsBps = eps;
    }

    function addMember(address member) external onlyRegistry {
        if (members.length >= Config.MAX_MEMBERS) revert BadAmount();
        members.push(member);
    }

    // ---------------------------------------------------------------- trading

    function buy(Side side, uint256 amount, Asset[] calldata assets) external nonReentrant {
        if (msg.sender == Config.HOUSE) revert HouseInert();
        if (status != Status.Live) revert Closed();
        if (IRegistryV3(registry).buysPaused()) revert BuysPaused();
        if (amount < Config.MIN_ORDER) revert MinOrder();
        _enforceCap(side, amount);
        _settleIfDue(assets);
        _materialize(msg.sender);
        IRegistryV3(registry).pull(msg.sender, amount);
        Pending storage p = pending[msg.sender];
        if (p.epoch != 0 && p.epoch != epoch) revert EpochClosed();
        p.epoch = epoch;
        if (side == Side.Tail) {
            p.buyTail += amount;
            openBucket.buyTail += amount;
        } else {
            p.buyFade += amount;
            openBucket.buyFade += amount;
        }
        emit OrderCommitted(msg.sender, whale, uint8(side), true, amount, 0, epoch);
    }

    function sell(Side side, uint256 shares, Asset[] calldata assets) external nonReentrant {
        if (msg.sender == Config.HOUSE) revert HouseInert();
        if (status == Status.None) revert Closed();
        if (shares == 0) revert BadAmount();
        _settleIfDue(assets);
        _materialize(msg.sender);
        _escrowSell(msg.sender, side, shares);
    }

    /// @notice Cancel only before this epoch is sampled. The fee is kept, so the option is not free.
    function cancel() external nonReentrant {
        if (msg.sender == Config.HOUSE) revert HouseInert();
        _materialize(msg.sender);
        Pending memory p = pending[msg.sender];
        if (p.epoch == 0 || p.epoch != epoch) revert EpochClosed();
        // The sampling window and the cancel window close together. Once a settle
        // is allowed, the commit is locked and fills at that sample.
        if (lastSettleTs != 0 && block.timestamp >= lastSettleTs + Config.EPOCH) revert EpochClosed();
        uint256 feeBps = IRegistryV3(registry).feeBps();
        uint256 fee;
        if (p.buyTail != 0) fee += _refundBuy(msg.sender, p.buyTail, feeBps, true);
        if (p.buyFade != 0) fee += _refundBuy(msg.sender, p.buyFade, feeBps, false);
        if (p.sellTail != 0) fee += _refundSell(msg.sender, Side.Tail, p.sellTail, feeBps);
        if (p.sellFade != 0) fee += _refundSell(msg.sender, Side.Fade, p.sellFade, feeBps);
        delete pending[msg.sender];
        emit OrderCancelled(msg.sender, whale, epoch, fee);
    }

    /// @notice Apply an already-closed epoch to the caller. Also samples the book when the epoch is due.
    function claim(Asset[] calldata assets) external nonReentrant {
        _settleIfDue(assets);
        _materialize(msg.sender);
    }

    /// @dev Due once per EPOCH. A position-size change does not open the window early.
    function settleIfDue(Asset[] calldata assets) external nonReentrant returns (bool settled) {
        if (!_due()) return false;
        _settle(assets);
        return true;
    }

    /// @notice After a long pause, burn shares for a pro-rata slice of the pot. No new sample.
    function exitAtLastNav() external nonReentrant {
        IRegistryV3 reg = IRegistryV3(registry);
        if (!reg.buysPaused()) revert NotEmergency();
        uint256 since = reg.pauseSince();
        if (since == 0 || block.timestamp < since + Config.EXIT_DELAY) revert NotEmergency();
        _materialize(msg.sender);
        _refundOpen(msg.sender);
        _exitSide(Side.Tail);
        _exitSide(Side.Fade);
    }

    function beginOptOut() external onlyRegistry nonReentrant {
        if (status != Status.Live) revert Closed();
        status = Status.RedeemOnly;
        _voidOpenBucket();
    }

    function commitHouseSell(Side side, uint256 shares) external onlyRegistry nonReentrant {
        _escrowSell(Config.HOUSE, side, shares);
    }

    function materializeHouse(Asset[] calldata assets) external onlyRegistry nonReentrant {
        _settleIfDue(assets);
        _materialize(Config.HOUSE);
    }

    // ---------------------------------------------------------------- settle

    function _due() internal view returns (bool) {
        if (status == Status.None) return false;
        if (lastSettleTs == 0) return true;
        return block.timestamp >= lastSettleTs + Config.EPOCH;
    }

    function _settleIfDue(Asset[] calldata assets) internal {
        if (_due()) _settle(assets);
    }

    function _settle(Asset[] calldata assets) internal {
        if (assets.length > Config.MAX_ASSETS) revert TooManyAssets();
        Book memory book = _readBook(assets);
        (int256 applied, int256 delta) = _applyReturn(book);
        _commitSnaps();

        uint64 closing = epoch;
        Fill memory fill = _closeBucket();
        fills[closing] = fill;
        epoch = closing + 1;
        lastSettleTs = block.timestamp;
        lastTailNav = navOf(Side.Tail);
        lastFadeNav = navOf(Side.Fade);
        lastEquity = book.equity;
        lastNtlPos = book.ntlPos;
        lastPnl = book.pnl;
        lastApplied = applied;
        lastDelta = delta;
        lastWeightedNtl = book.weightedNtl;
        lastPositionChanged = book.changed;
        lastL1Block = book.l1Block;

        emit Settled(
            whale,
            msg.sender,
            closing,
            book.pnl,
            applied,
            delta,
            tailPot,
            fadePot,
            lastTailNav,
            lastFadeNav,
            book.equity,
            eRef,
            book.ntlPos,
            book.weightedNtl,
            book.l1Block,
            book.changed
        );
    }

    function _applyReturn(Book memory book) internal returns (int256 applied, int256 delta) {
        if (status == Status.RedeemOnly) return (0, 0);
        uint32 day = uint32(block.timestamp / 1 days);
        bool newDay = eRefSet && day != eRefDay;
        if (newDay) dailyR = 0;
        if (eRefSet && eRef == 0 && book.equity > 0) eRef = book.equity;

        if (!eRefSet) {
            eRef = book.equity;
            eRefDay = day;
            eRefSet = true;
            return (0, 0);
        }

        int256 nextDaily;
        (applied, nextDaily) = PotMath.appliedReturn(book.pnl, eRef, dailyR);
        uint256 capAmount = PotMath.capacity(tailPot, fadePot, eRef);
        delta = PotMath.deltaOf(applied, capAmount);
        dailyR = nextDaily;
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
        _wipeIfEmpty(Side.Tail);
        _wipeIfEmpty(Side.Fade);
    }

    /// @dev A side with shares and no USDC is dead. Bump the generation so a later deposit
    ///      is not donated to those shares. Their claim was already zero.
    function _wipeIfEmpty(Side side) internal {
        if (side == Side.Tail) {
            if (tailPot == 0 && tailSupply > 0) {
                tailSupply = 0;
                tailGen += 1;
            }
        } else if (fadePot == 0 && fadeSupply > 0) {
            fadeSupply = 0;
            fadeGen += 1;
        }
    }

    function _closeBucket() internal returns (Fill memory fill) {
        Bucket memory b = openBucket;
        delete openBucket;
        fill.set = true;
        fill.buyTail = b.buyTail;
        fill.buyFade = b.buyFade;
        fill.sellTail = b.sellTail;
        fill.sellFade = b.sellFade;
        _closeSide(true, b.buyTail, b.sellTail, fill);
        _closeSide(false, b.buyFade, b.sellFade, fill);
        fill.tailGen = tailGen;
        fill.fadeGen = fadeGen;
        uint256 claims = fill.tailUsdcOut + fill.fadeUsdcOut;
        // A buy that minted nothing is returned in full. No fee was taken on that path.
        if (b.buyTail != 0 && fill.tailSharesOut == 0) claims += b.buyTail;
        if (b.buyFade != 0 && fill.fadeSharesOut == 0) claims += b.buyFade;
        reserved += claims;
    }

    function _closeSide(bool tail, uint256 buyIn, uint256 sellShares, Fill memory fill) internal {
        uint256 pot = tail ? tailPot : fadePot;
        uint256 supply = tail ? tailSupply : fadeSupply;
        uint256 entitled = supply + sellShares;
        uint256 pot0 = pot;
        uint256 feeBps = IRegistryV3(registry).feeBps();

        uint256 sellGross;
        uint256 sellFee;
        uint256 sellNet;
        if (sellShares != 0 && entitled != 0 && pot0 != 0) {
            sellGross = sellShares * pot0 / entitled;
            if (sellGross > pot0) sellGross = pot0;
            sellFee = sellGross * feeBps / Config.BPS;
            sellNet = sellGross - sellFee;
            pot -= sellGross;
        }

        uint256 buyFee;
        uint256 sharesOut;
        if (buyIn != 0) {
            uint256 feeTry = buyIn * feeBps / Config.BPS;
            uint256 net = buyIn - feeTry;
            if (supply == 0 && pot == 0) {
                if (net > Config.MIN_LIQUIDITY) {
                    sharesOut = net - Config.MIN_LIQUIDITY;
                    supply = net;
                    pot = net;
                    buyFee = feeTry;
                }
            } else if (pot != 0 && supply != 0) {
                uint256 minted = net * supply / pot;
                if (minted != 0) {
                    sharesOut = minted;
                    pot += net;
                    supply += minted;
                    buyFee = feeTry;
                }
            } else if (pot != 0 && supply == 0) {
                sharesOut = net;
                supply = net;
                pot += net;
                buyFee = feeTry;
            }
        }

        if (tail) {
            tailPot = pot;
            tailSupply = supply;
            fill.tailSharesOut = sharesOut;
            fill.tailUsdcOut = sellNet;
            fill.tailBuyFee = buyFee;
            fill.tailSellFee = sellFee;
        } else {
            fadePot = pot;
            fadeSupply = supply;
            fill.fadeSharesOut = sharesOut;
            fill.fadeUsdcOut = sellNet;
            fill.fadeBuyFee = buyFee;
            fill.fadeSellFee = sellFee;
        }
        uint256 fee = buyFee + sellFee;
        if (fee != 0) IRegistryV3(registry).takeFee(fee);
        _wipeIfEmpty(tail ? Side.Tail : Side.Fade);
    }

    function _voidOpenBucket() internal {
        Bucket memory b = openBucket;
        delete openBucket;
        Fill memory fill;
        fill.set = true;
        fill.voided = true;
        fill.buyTail = b.buyTail;
        fill.buyFade = b.buyFade;
        fill.sellTail = b.sellTail;
        fill.sellFade = b.sellFade;
        fill.tailGen = tailGen;
        fill.fadeGen = fadeGen;
        fills[epoch] = fill;
        reserved += b.buyTail + b.buyFade;
        epoch += 1;
    }

    // ---------------------------------------------------------------- per user

    function _materialize(address user) internal {
        Pending memory p = pending[user];
        if (p.epoch == 0 || p.epoch == epoch) return;
        Fill memory f = fills[p.epoch];
        if (!f.set) return;
        delete pending[user];
        if (f.voided) {
            uint256 back = p.buyTail + p.buyFade;
            if (back != 0) {
                reserved -= back;
                _pay(user, back);
            }
            if (p.sellTail != 0) _restore(user, Side.Tail, p.sellTail, f.tailGen);
            if (p.sellFade != 0) _restore(user, Side.Fade, p.sellFade, f.fadeGen);
            return;
        }
        if (p.buyTail != 0) _fillBuy(user, Side.Tail, p.buyTail, f.buyTail, f.tailSharesOut, f.tailBuyFee, f.tailGen, p.epoch);
        if (p.buyFade != 0) _fillBuy(user, Side.Fade, p.buyFade, f.buyFade, f.fadeSharesOut, f.fadeBuyFee, f.fadeGen, p.epoch);
        if (p.sellTail != 0) _fillSell(user, Side.Tail, p.sellTail, f.sellTail, f.tailUsdcOut, f.tailSellFee, p.epoch);
        if (p.sellFade != 0) _fillSell(user, Side.Fade, p.sellFade, f.sellFade, f.fadeUsdcOut, f.fadeSellFee, p.epoch);
    }

    function _fillBuy(
        address user,
        Side side,
        uint256 mine,
        uint256 totalIn,
        uint256 sharesOut,
        uint256 feeTotal,
        uint64 gen,
        uint64 committed
    ) internal {
        if (totalIn == 0) return;
        uint256 fee = mine * feeTotal / totalIn;
        if (sharesOut == 0) {
            reserved -= mine;
            _pay(user, mine);
            return;
        }
        uint256 shares = mine * sharesOut / totalIn;
        _give(user, side, shares, gen);
        uint64 opened = side == Side.Tail ? tailOpened[user] : fadeOpened[user];
        emit FeePaid(user, whale, uint8(side), true, fee, mine, committed, 0);
        emit Exposure(user, whale, uint8(side), sharesOf(user, side), epoch, opened);
    }

    function _fillSell(
        address user,
        Side side,
        uint256 mine,
        uint256 totalShares,
        uint256 usdcOut,
        uint256 feeTotal,
        uint64 committed
    ) internal {
        if (totalShares == 0 || usdcOut == 0) return;
        uint256 out = mine * usdcOut / totalShares;
        uint256 fee = mine * feeTotal / totalShares;
        reserved -= out;
        _pay(user, out);
        uint64 opened = side == Side.Tail ? tailOpened[user] : fadeOpened[user];
        uint64 held = epoch > opened && opened != 0 ? epoch - opened : 0;
        emit FeePaid(user, whale, uint8(side), false, fee, out + fee, committed, held);
        emit Exposure(user, whale, uint8(side), sharesOf(user, side), epoch, opened);
    }

    function _escrowSell(address user, Side side, uint256 shares) internal {
        uint256 have = sharesOf(user, side);
        if (shares > have) revert BadAmount();
        uint256 price = navOf(side);
        if (shares * price / Config.UNIT < Config.MIN_ORDER && shares != have) revert MinOrder();
        _take(user, side, shares);
        if (side == Side.Tail) {
            tailSupply -= shares;
        } else {
            fadeSupply -= shares;
        }
        Pending storage p = pending[user];
        if (p.epoch != 0 && p.epoch != epoch) revert EpochClosed();
        p.epoch = epoch;
        if (side == Side.Tail) {
            p.sellTail += shares;
            openBucket.sellTail += shares;
        } else {
            p.sellFade += shares;
            openBucket.sellFade += shares;
        }
        emit OrderCommitted(user, whale, uint8(side), false, 0, shares, epoch);
    }

    function _refundBuy(address user, uint256 amount, uint256 feeBps, bool tail) internal returns (uint256 fee) {
        fee = amount * feeBps / Config.BPS;
        uint256 net = amount - fee;
        if (tail) openBucket.buyTail -= amount;
        else openBucket.buyFade -= amount;
        if (fee != 0) IRegistryV3(registry).takeFee(fee);
        _pay(user, net);
    }

    function _refundSell(address user, Side side, uint256 shares, uint256 feeBps) internal returns (uint256 fee) {
        uint256 feeShares = shares * feeBps / Config.BPS;
        uint256 back = shares - feeShares;
        if (side == Side.Tail) openBucket.sellTail -= shares;
        else openBucket.sellFade -= shares;
        // Fee shares stay out of supply. The pot is unchanged, so remaining holders keep that value.
        fee = feeShares;
        if (back != 0) _restore(user, side, back, side == Side.Tail ? tailGen : fadeGen);
    }

    function _refundOpen(address user) internal {
        Pending memory p = pending[user];
        if (p.epoch != epoch || p.epoch == 0) return;
        delete pending[user];
        uint256 back = p.buyTail + p.buyFade;
        if (p.buyTail != 0) openBucket.buyTail -= p.buyTail;
        if (p.buyFade != 0) openBucket.buyFade -= p.buyFade;
        if (back != 0) _pay(user, back);
        if (p.sellTail != 0) {
            openBucket.sellTail -= p.sellTail;
            _restore(user, Side.Tail, p.sellTail, tailGen);
        }
        if (p.sellFade != 0) {
            openBucket.sellFade -= p.sellFade;
            _restore(user, Side.Fade, p.sellFade, fadeGen);
        }
    }

    function _exitSide(Side side) internal {
        uint256 shares = sharesOf(msg.sender, side);
        if (shares == 0) return;
        uint256 supply = side == Side.Tail ? tailSupply : fadeSupply;
        uint256 pot = side == Side.Tail ? tailPot : fadePot;
        if (supply == 0 || pot == 0) {
            _take(msg.sender, side, shares);
            return;
        }
        uint256 pay = shares * pot / supply;
        _take(msg.sender, side, shares);
        if (side == Side.Tail) {
            tailSupply -= shares;
            tailPot -= pay;
        } else {
            fadeSupply -= shares;
            fadePot -= pay;
        }
        _pay(msg.sender, pay);
        emit EmergencyExit(msg.sender, whale, uint8(side), shares, pay);
    }

    function _give(address user, Side side, uint256 shares, uint64 gen) internal {
        if (shares == 0) return;
        if (side == Side.Tail) {
            if (_tail[user].gen != gen) _tail[user] = Lot(gen, 0);
            if (_tail[user].shares == 0) tailOpened[user] = epoch;
            _tail[user].shares += shares;
        } else {
            if (_fade[user].gen != gen) _fade[user] = Lot(gen, 0);
            if (_fade[user].shares == 0) fadeOpened[user] = epoch;
            _fade[user].shares += shares;
        }
    }

    function _take(address user, Side side, uint256 shares) internal {
        if (side == Side.Tail) {
            _tail[user].shares -= shares;
            if (_tail[user].shares == 0) tailOpened[user] = 0;
        } else {
            _fade[user].shares -= shares;
            if (_fade[user].shares == 0) fadeOpened[user] = 0;
        }
    }

    function _restore(address user, Side side, uint256 shares, uint64 gen) internal {
        _give(user, side, shares, gen);
        if (side == Side.Tail) tailSupply += shares;
        else fadeSupply += shares;
    }

    function _pay(address user, uint256 amount) internal {
        if (amount == 0) return;
        if (user == Config.HOUSE) IRegistryV3(registry).creditHouse(amount);
        else IRegistryV3(registry).credit(user, amount);
    }

    function _mintHouse(Side side, uint256 amount) internal {
        _give(Config.HOUSE, side, amount, side == Side.Tail ? tailGen : fadeGen);
        if (side == Side.Tail) {
            tailPot += amount;
            tailSupply += amount;
        } else {
            fadePot += amount;
            fadeSupply += amount;
        }
        emit HouseSeeded(whale, uint8(side), amount, amount);
    }

    function _enforceCap(Side side, uint256 amount) internal view {
        uint256 cap = IRegistryV3(registry).maxPotPerSide();
        if (cap == 0) return;
        uint256 have = side == Side.Tail ? tailPot + openBucket.buyTail : fadePot + openBucket.buyFade;
        if (have + amount > cap) revert PotCap();
    }

    // ---------------------------------------------------------------- book

    function _readBook(Asset[] calldata assets) internal returns (Book memory book) {
        _readNonce += 1;
        book.l1Block = CoreReader.l1BlockNumber();
        _loadMargins(book);
        uint256 n = assets.length;
        for (uint256 i; i < n; ++i) {
            _observe(assets[i].memberIndex, assets[i].perp, book);
        }
        uint256 m = _snapKeys.length;
        if (m > Config.MAX_ASSETS) revert TooManyAssets();
        for (uint256 i; i < m; ++i) {
            Snap memory prev = _snap[_snapKeys[i]];
            if (!prev.live) continue;
            bytes32 key = _key(prev.member, prev.perp);
            if (_seen[key] == _readNonce) continue;
            if (!dexEnabled[Config.dexOf(prev.perp)]) continue;
            _seen[key] = _readNonce;
            (int64 szi, uint64 mark) = _live(prev.member, prev.perp);
            _accumulate(prev.member, prev.perp, szi, mark, prev, book);
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
            equity += int256(uint256(CoreReader.spotBalance(member, Config.USDC_SPOT).total) / Config.SPOT_TO_USD);
            for (uint256 j; j < dc; ++j) {
                CoreReader.AccountMarginSummary memory a = CoreReader.accountMarginSummary(dexes[j], member);
                equity += int256(a.accountValue);
                ntl += uint256(a.ntlPos);
            }
        }
        book.equity = equity < 0 ? 0 : uint256(equity);
        book.ntlPos = ntl;
    }

    function _observe(uint8 memberIndex, uint32 perp, Book memory book) internal {
        if (memberIndex >= members.length) revert BadMember(memberIndex);
        if (!dexEnabled[Config.dexOf(perp)]) revert DexNotTracked(perp);
        address member = members[memberIndex];
        bytes32 key = _key(member, perp);
        if (_seen[key] == _readNonce) revert DuplicateAsset(perp);
        _seen[key] = _readNonce;
        (int64 szi, uint64 mark) = _live(member, perp);
        _accumulate(member, perp, szi, mark, _snap[key], book);
    }

    function _accumulate(address member, uint32 perp, int64 szi, uint64 mark, Snap memory prev, Book memory book) internal {
        uint256 notion = PotMath.notional(szi, mark);
        book.covered += notion;
        bool isWeighted = weighted[perp];
        if (isWeighted) book.weightedNtl += notion;
        if (prev.live && prev.szi != 0 && isWeighted) {
            book.pnl += PotMath.pricePnl(prev.szi, prev.mark, mark);
        }
        if (szi != prev.szi) book.changed = true;
        if (szi != 0) {
            _staged.push(Snap({member: member, perp: perp, szi: szi, mark: mark, live: true}));
        }
    }

    function _checkComplete(uint256 covered, uint256 ntlPos) internal view {
        if (ntlPos == 0) {
            if (covered != 0) revert IncompleteBook(covered, ntlPos);
            return;
        }
        uint256 lo = ntlPos * (Config.BPS - epsBps) / Config.BPS;
        uint256 hi = ntlPos * (Config.BPS + epsBps) / Config.BPS;
        if (covered < lo || covered > hi) revert IncompleteBook(covered, ntlPos);
    }

    function _live(address user, uint32 perp) internal view returns (int64 szi, uint64 mark) {
        szi = CoreReader.position(user, perp).szi;
        mark = CoreReader.markPx(perp);
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
}
