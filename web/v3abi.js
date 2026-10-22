/**
 * Pure helpers for the v3 site: selectors, ABI encoding, config switch, geoblock.
 * No network. chain.js calls these. Safe to load in the browser or under node --test.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.V3 = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const ZERO = "0x0000000000000000000000000000000000000000";
  const UNIT = 1000000n;
  const FAUCET_CAP = 1000000000n;
  const SEASON = "Season 0 points accrue on real volume. They could count toward a possible future airdrop. No promises.";

  // GB/UK, US, UK overseas territories, crown dependencies, and US territories.
  const BLOCKED = new Set([
    "US", "AS", "GU", "MP", "PR", "VI", "UM",
    "GB", "UK",
    "AI", "BM", "IO", "VG", "KY", "FK", "GI", "MS", "PN", "SH", "GS", "TC",
    "GG", "IM", "JE",
  ]);

  const SEL = {
    deposit: "0xb6b55f25",
    withdraw: "0x2e1a7d4d",
    balanceOf: "0x70a08231",
    allowance: "0xdd62ed3e",
    approve: "0x095ea7b3",
    mint: "0x40c10f19",
    faucet: "0x57915897",
    buysPaused: "0x2319835c",
    pauseSince: "0x4bd45cc2",
    feeBps: "0x24a9d853",
    buy: "0x5af5ca3c",
    sell: "0x24ce8d5b",
    cancel: "0xea8a1af0",
    claim: "0x4852f54b",
    exitAtLastNav: "0x7b7ef60c",
    sharesOf: "0x233f6928",
    pending: "0x5eebea20",
    tailPot: "0x2b2dc7c8",
    fadePot: "0xe52d1e6d",
    tailSupply: "0xb5f88e82",
    fadeSupply: "0x801e66b7",
    status: "0x200d2ed2",
    lastSettleTs: "0xe89da2f3",
    epoch: "0x900cf0cf",
    lastPnl: "0x0acd92a2",
    lastApplied: "0x3a985443",
    lastDelta: "0x23ee6a9b",
    eRef: "0x7d36cfb7",
    memberCount: "0x11aee380",
    members: "0x5daf08ca",
    dexCount: "0xab304695",
    dexes: "0x6338a7c0",
    optOut: "0x55194ee5",
  };

  const ERRORS = {
    "0x4937bd5c": "Minimum order is 10 USDC.",
    "0xf7cdbb58": "Buys are paused. Sell and withdraw stay open.",
    "0xb01c5549": "That order is locked for the next settle.",
    "0x749b5939": "Amount must be greater than zero.",
    "0x07953e9a": "Pro-rata redeem is not open yet.",
    "0x1cdde67b": "This market is not open for that action.",
    "0xaf4694c1": "That buy would pass the pot cap.",
    "0x3afc7441": "The position book is incomplete, so the settle was not sent. Wait for the keeper, then claim.",
    "0x90b8ec18": "The USDC transfer failed. Approve the registry, then deposit.",
    "0xfb3a9d64": "The faucet pays at most 1,000 tUSDC per call.",
    "0xb5dfd9e5": "The contract is busy. Try that again.",
    "0x2678f6aa": "The house account cannot trade.",
  };

  function word(n) {
    const x = BigInt(n);
    if (x < 0n) throw new Error("word");
    return x.toString(16).padStart(64, "0");
  }

  function addrWord(a) {
    const h = String(a || "").toLowerCase().replace(/^0x/, "");
    if (!/^[0-9a-f]{40}$/.test(h)) throw new Error("address");
    return h.padStart(64, "0");
  }

  function isSet(a) {
    return typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a) && a.toLowerCase() !== ZERO;
  }

  function encodeAssets(assets) {
    const rows = assets || [];
    let hex = word(rows.length);
    for (const a of rows) {
      const member = Number(a.memberIndex);
      const perp = Number(a.perp);
      if (!Number.isInteger(member) || member < 0 || member > 255) throw new Error("memberIndex");
      if (!Number.isInteger(perp) || perp < 0 || perp > 0xffffffff) throw new Error("perp");
      hex += word(member) + word(perp);
    }
    return hex;
  }

  function encodeBuy(side, amount, assets) {
    return SEL.buy + word(side) + word(amount) + word(0x60) + encodeAssets(assets);
  }

  function encodeSell(side, shares, assets) {
    return SEL.sell + word(side) + word(shares) + word(0x60) + encodeAssets(assets);
  }

  function encodeClaim(assets) {
    return SEL.claim + word(0x20) + encodeAssets(assets);
  }

  function encodeUint(sel, amount) {
    return sel + word(amount);
  }

  function encodeAddrUint(sel, who, amount) {
    return sel + addrWord(who) + word(amount);
  }

  function encodeAddress(sel, who) {
    return sel + addrWord(who);
  }

  function encodeShares(who, side) {
    return SEL.sharesOf + addrWord(who) + word(side);
  }

  function encodeAllowance(owner, spender) {
    return SEL.allowance + addrWord(owner) + addrWord(spender);
  }

  /** Decimal USDC string to 6-decimal base units. Null when it is not a clean amount. */
  function parseUsdc(input) {
    const t = String(input == null ? "" : input).trim();
    if (!/^\d+(\.\d{1,6})?$/.test(t)) return null;
    const parts = t.split(".");
    const whole = parts[0];
    const frac = ((parts[1] || "") + "000000").slice(0, 6);
    return BigInt(whole) * UNIT + BigInt(frac);
  }

  function formatUnits(raw) {
    let x = BigInt(raw);
    const neg = x < 0n;
    if (neg) x = -x;
    const whole = x / UNIT;
    const frac = (x % UNIT).toString().padStart(6, "0").replace(/0+$/, "");
    return (neg ? "-" : "") + whole.toString() + (frac ? "." + frac : "");
  }

  function isDue(lastSettleTs, nowSec, epochSec) {
    const last = BigInt(lastSettleTs || 0);
    const now = BigInt(nowSec);
    const epoch = BigInt(epochSec || 0);
    if (epoch <= 0n) return false;
    if (last === 0n) return true;
    return now >= last + epoch;
  }

  /**
   * `network` is the only switch. Anything other than "mainnet" stays on testnet (998).
   * A mainnet profile must be chain 999. A bad file returns null.
   */
  function resolve(cfg) {
    if (!cfg || typeof cfg !== "object" || !cfg.networks) return null;
    const network = cfg.network === "mainnet" ? "mainnet" : "testnet";
    const net = cfg.networks[network];
    if (!net) return null;
    const chainId = Number(net.chainId);
    if (network === "mainnet" && chainId !== 999) return null;
    if (network === "testnet" && chainId !== 998) return null;
    if (!net.rpcUrl || !net.infoApi) return null;
    return {
      network: network,
      chainId: chainId,
      chainName: net.name || (network === "mainnet" ? "HyperEVM" : "HyperEVM Testnet"),
      rpcUrl: net.rpcUrl,
      infoApi: net.infoApi,
      explorer: net.explorer || "",
      nativeCurrency: net.nativeCurrency || { name: "HYPE", symbol: "HYPE", decimals: 18 },
      faucet: network === "testnet" && !!net.faucet,
      usdc: net.usdc || ZERO,
      registry: net.registry || ZERO,
      marketImplementation: net.marketImplementation || ZERO,
      beacon: net.beacon || ZERO,
      placeholders: net.placeholders || {},
      wallets: Array.isArray(net.wallets) ? net.wallets : [],
      builder: cfg.builder || {},
      minOrderUsdc: String(cfg.minOrderUsdc || "10"),
      cancelFeeBps: Number(cfg.cancelFeeBps == null ? 50 : cfg.cancelFeeBps),
      epochSec: Number(cfg.epochSec || 600),
      exitDelaySec: Number(cfg.exitDelaySec || 259200),
      faucetAmount: String(cfg.faucetAmount || FAUCET_CAP.toString()),
      dexNames: cfg.dexNames || { "0": "", "1": "xyz" },
    };
  }

  function parseTrace(text) {
    const m = String(text || "").match(/^loc=([A-Za-z]{2})\s*$/m);
    return m ? m[1].toUpperCase() : null;
  }

  function parseGeoJson(body) {
    if (!body || typeof body !== "object") return null;
    const code = body.country_code || body.country || body.countryCode;
    if (typeof code !== "string") return null;
    const c = code.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(c)) return null;
    if (c === "XX" || c === "T1") return null;
    return c;
  }

  function isBlocked(code) {
    if (!code) return false;
    return BLOCKED.has(String(code).trim().toUpperCase());
  }

  const TESTNET_GEO_NOTE = "Testnet is open in every region. Real-money play will not be available in the UK, the US, or their territories.";

  /** The lookup and the block run only when the config switch is mainnet. */
  function geoActive(network) {
    return network === "mainnet";
  }

  /** Missing country fails closed. Browsing is a separate decision in the page. */
  function decideGeo(code) {
    if (!code) return { blocked: true, reason: "unknown" };
    if (isBlocked(code)) return { blocked: true, reason: "region" };
    return { blocked: false, reason: "ok" };
  }

  /**
   * Testnet (and any non-mainnet value) is open with no country required.
   * Mainnet uses decideGeo and fails closed when the country is missing.
   */
  function gateGeo(network, code) {
    if (!geoActive(network)) return { blocked: false, reason: "testnet" };
    return decideGeo(code);
  }

  /** tUSDC faucet cap is 1,000 tokens (6 decimals) per call. Larger config values clamp. */
  function faucetRaw(amount) {
    let x;
    try { x = BigInt(amount); } catch (e) { return FAUCET_CAP; }
    if (x <= 0n || x > FAUCET_CAP) return FAUCET_CAP;
    return x;
  }

  function feeText(bps) {
    const n = Number(bps);
    const v = Number.isFinite(n) && n >= 0 ? n : 50;
    const pct = v / 100;
    const s = Number.isInteger(pct) ? String(pct) : String(Math.round(pct * 100) / 100);
    return s + "%";
  }

  return {
    ZERO: ZERO,
    UNIT: UNIT,
    FAUCET_CAP: FAUCET_CAP,
    SEASON: SEASON,
    TESTNET_GEO_NOTE: TESTNET_GEO_NOTE,
    BLOCKED: BLOCKED,
    SEL: SEL,
    ERRORS: ERRORS,
    word: word,
    addrWord: addrWord,
    isSet: isSet,
    encodeBuy: encodeBuy,
    encodeSell: encodeSell,
    encodeClaim: encodeClaim,
    encodeUint: encodeUint,
    encodeAddrUint: encodeAddrUint,
    encodeAddress: encodeAddress,
    encodeShares: encodeShares,
    encodeAllowance: encodeAllowance,
    parseUsdc: parseUsdc,
    formatUnits: formatUnits,
    faucetRaw: faucetRaw,
    isDue: isDue,
    resolve: resolve,
    parseTrace: parseTrace,
    parseGeoJson: parseGeoJson,
    isBlocked: isBlocked,
    decideGeo: decideGeo,
    geoActive: geoActive,
    gateGeo: gateGeo,
    feeText: feeText,
  };
});
