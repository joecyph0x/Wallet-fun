/**
 * whalewallet.fun v3 chain adapter.
 *
 * Addresses come from config/testnet-v3.json. `network` is the only switch:
 * testnet stays on HyperEVM 998 until that field is "mainnet" (999).
 * Bets are USDC. A commit fills at the next settle. There is no v2 points faucet.
 */
(function () {
  const V3 = window.V3;
  let cfg = null;
  let account = null;
  let onChain = false;
  let busy = false;
  let potsLive = false;
  let potsFailed = false;
  let attachPromise = null;
  let geoPromise = null;
  let geo = { blocked: false, pending: false, notice: "" };
  let withdrawable = 0n;
  let walletBal = 0n;
  let allowance = 0n;
  const known = { withdrawable: false, wallet: false, allowance: false };
  let floorWd = null;
  let floorWallet = null;
  let walletCeiling = null;
  let floorUntil = 0;
  let pausedFlag = false;
  let pauseSinceSec = 0;
  let feeBps = 25;
  let pauseAt = 0;
  let userGen = 0;
  let potGen = 0;
  let userTimer = null;
  let settleTimer = null;
  let settleSweepAt = 0;
  let shareScanAt = 0;
  const navCache = {};
  let basisMem = {};
  let basisNote = "";
  const shares = {};
  const shareKnown = {};
  const books = {};
  const lastSeen = {};
  const basis = {};
  const pendingRaw = {};
  let demoSnap = null;

  const view = {
    configured: false,
    faucet: false,
    wallet: "—",
    withdrawable: "—",
    allowance: "—",
    committed: "0",
    paused: false,
    feeText: "0.25%",
    holds: {},
    pending: {},
    status: {},
    stale: false,
    staleWallet: false,
    staleWithdrawable: false,
    staleAllowance: false,
    stalePending: false,
    staleShares: false,
  };

  function $(s) { return document.querySelector(s); }
  function toast(m) { if (window.toast) window.toast(m); }
  function short(a) { return a.slice(0, 6) + "…" + a.slice(-4); }
  function num6(x) {
    const n = typeof x === "bigint" ? x : BigInt(x || 0);
    const sign = n < 0n ? -1 : 1;
    const v = n < 0n ? -n : n;
    return sign * (Number(v) / 1e6);
  }
  function rayNum(x) {
    const n = typeof x === "bigint" ? x : BigInt(x || 0);
    const sign = n < 0n ? -1 : 1;
    const v = n < 0n ? -n : n;
    return sign * (Number(v / 1000000000n) / 1e9);
  }
  function wordsOf(result) {
    const h = String(result || "0x").replace(/^0x/, "");
    const out = [];
    for (let i = 0; i < h.length; i += 64) out.push(h.slice(i, i + 64));
    return out;
  }
  function u256(w) { return BigInt("0x" + (w || "0")); }
  function i256(w) {
    let x = u256(w);
    if (x >= 1n << 255n) x -= 1n << 256n;
    return x;
  }
  function configured() { return !!(cfg && V3.isSet(cfg.registry) && V3.isSet(cfg.usdc)); }
  function live() { return configured() && !!account && onChain; }
  function potsOk() { return potsLive; }
  function walletRow(tk) {
    if (!cfg || !cfg.wallets) return null;
    return cfg.wallets.find((w) => w.ticker === tk) || null;
  }
  function marketOf(tk) {
    const row = walletRow(tk);
    return row && V3.isSet(row.market) ? row.market : null;
  }
  function missing(key) {
    const name = (cfg && cfg.placeholders && cfg.placeholders[key]) || ("PLACEHOLDER_" + String(key).toUpperCase());
    return name + " is not filled in yet. It goes in config/testnet-v3.json after the testnet deploy.";
  }
  function missingMarket(tk) {
    const row = walletRow(tk);
    const name = (row && row.marketPlaceholder) || ("PLACEHOLDER_MARKET_" + tk);
    return name + " is not filled in yet. It goes in config/testnet-v3.json after the testnet deploy.";
  }
  function chainLabel() {
    if (!cfg) return "TESTNET · chain 998";
    return (cfg.network === "mainnet" ? "MAINNET" : "TESTNET") + " · chain " + cfg.chainId;
  }
  function chainHex() { return "0x" + Number(cfg.chainId).toString(16); }
  function remain(sec) {
    const s = Math.max(0, Math.floor(sec));
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d > 0) return d + "d " + h + "h";
    if (h > 0) return h + "h " + m + "m";
    return Math.max(1, m) + "m";
  }
  function pauseNote() {
    if (!pausedFlag) return "";
    if (!pauseSinceSec) return "Buys are paused. Sell and withdraw stay open.";
    const openAt = pauseSinceSec + (cfg ? cfg.exitDelaySec : 259200);
    const left = openAt - Math.floor(Date.now() / 1000);
    if (left <= 0) return "Pro-rata redeem is open. It pays your share of the pot at the last NAV, with no new sample.";
    return "Pro-rata redeem opens 72 hours after the pause (" + remain(left) + ").";
  }
  function redeemOpen() {
    if (!pausedFlag || !pauseSinceSec) return false;
    return Math.floor(Date.now() / 1000) >= pauseSinceSec + (cfg ? cfg.exitDelaySec : 259200);
  }
  function explain(e) {
    const m = (e && e.message) ? e.message : String(e);
    if (V3.isReject(e) || /4001|rejected|denied/i.test(m)) return "Wallet request rejected.";
    const data = e && (e.data || (e.error && e.error.data));
    const blob = (m + " " + (typeof data === "string" ? data : "")).toLowerCase();
    const keys = Object.keys(V3.ERRORS);
    for (let i = 0; i < keys.length; i++) {
      if (blob.indexOf(keys[i]) !== -1) return V3.ERRORS[keys[i]];
    }
    if (/minorder/.test(blob)) return V3.ERRORS["0x4937bd5c"];
    if (/buyspaused/.test(blob)) return V3.ERRORS["0xf7cdbb58"];
    if (/epochclosed/.test(blob)) return V3.ERRORS["0xb01c5549"];
    if (/notemergency/.test(blob)) return V3.ERRORS["0x07953e9a"];
    if (/incompletebook/.test(blob)) return V3.ERRORS["0x3afc7441"];
    const line = m.split("\n")[0];
    return line.length > 180 ? line.slice(0, 180) + "…" : line;
  }

  async function rpc(method, params) {
    const res = await fetch(cfg.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: method, params: params }),
    });
    const body = await res.json();
    if (body.error) throw new Error(body.error.message || "rpc error");
    return body.result;
  }

  function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

  function nowSec() { return Math.floor(Date.now() / 1000); }

  function viewedTicker() {
    const path = String((typeof location !== "undefined" && location.hash) || "").replace(/^#/, "").split("?")[0];
    const match = /^\/w\/([A-Za-z0-9]+)/.exec(path);
    return match ? match[1].toUpperCase() : "";
  }

  async function postRpc(payload) {
    const res = await fetch(cfg.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    let body = text;
    try { body = JSON.parse(text); } catch (e) { body = text; }
    return { status: res.status, body: body };
  }

  function readChain(calls) {
    return V3.readCalls({ calls: calls, send: postRpc, retries: 3, batchSize: 4, sleep: sleep });
  }

  async function ethCall(to, data) {
    const eth = window.ethereum;
    if (!eth || !eth.request) return { error: { message: "no wallet rpc" } };
    try {
      const result = await V3.withTimeout(
        eth.request({ method: "eth_call", params: [{ to: to, data: data }, "latest"] }),
        8000,
        "wallet rpc"
      );
      return typeof result === "string" ? { result: result } : { error: { message: "empty wallet rpc" } };
    } catch (e) {
      return { error: { message: (e && e.message) || "wallet rpc" } };
    }
  }

  async function fillFromWallet(calls, rows, indexes) {
    const next = rows.slice();
    for (let i = 0; i < indexes.length; i++) {
      const at = indexes[i];
      if (V3.callOk(next[at])) continue;
      const row = await ethCall(calls[at].to, calls[at].data);
      if (V3.callOk(row)) next[at] = row;
    }
    return next;
  }

  async function info(body) {
    const res = await fetch(cfg.infoApi, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error("info api " + res.status);
    return res.json();
  }

  function dexName(id) {
    const map = (cfg && cfg.dexNames) || { "0": "", "1": "xyz" };
    const key = String(id);
    if (Object.prototype.hasOwnProperty.call(map, key)) return map[key];
    return null;
  }

  function findIdx(byCoin, coin, name) {
    if (byCoin.has(coin)) return byCoin.get(coin);
    if (name && coin.indexOf(name + ":") === 0 && byCoin.has(coin.slice(name.length + 1))) return byCoin.get(coin.slice(name.length + 1));
    if (name && byCoin.has(name + ":" + coin)) return byCoin.get(name + ":" + coin);
    return null;
  }

  async function buildBook(market) {
    const nM = Number(u256(wordsOf(await rpc("eth_call", [{ to: market, data: V3.SEL.memberCount }, "latest"]))[0]));
    const nD = Number(u256(wordsOf(await rpc("eth_call", [{ to: market, data: V3.SEL.dexCount }, "latest"]))[0]));
    if (nM < 1 || nM > 8 || nD < 1 || nD > 8) return { ok: false, reason: "members" };
    const members = [];
    for (let i = 0; i < nM; i++) {
      const w = wordsOf(await rpc("eth_call", [{ to: market, data: V3.SEL.members + V3.word(i) }, "latest"]));
      members.push("0x" + w[0].slice(24));
    }
    const dexes = [];
    for (let i = 0; i < nD; i++) {
      const w = wordsOf(await rpc("eth_call", [{ to: market, data: V3.SEL.dexes + V3.word(i) }, "latest"]));
      dexes.push(Number(u256(w[0])));
    }
    const assets = [];
    const seen = new Set();
    for (let d = 0; d < dexes.length; d++) {
      const dex = dexes[d];
      const name = dexName(dex);
      if (name == null) return { ok: false, reason: "dex " + dex };
      const meta = await info(name ? { type: "meta", dex: name } : { type: "meta" });
      const universe = meta && meta.universe;
      if (!universe) return { ok: false, reason: "meta" };
      const byCoin = new Map(universe.map((a, i) => [a.name, i]));
      for (let mi = 0; mi < members.length; mi++) {
        const state = await info(name
          ? { type: "clearinghouseState", user: members[mi], dex: name }
          : { type: "clearinghouseState", user: members[mi] });
        const rows = (state && state.assetPositions) || [];
        for (let r = 0; r < rows.length; r++) {
          const p = (rows[r] && rows[r].position) || {};
          if (!p.szi || Number(p.szi) === 0) continue;
          const idx = findIdx(byCoin, p.coin, name);
          if (idx == null) return { ok: false, reason: p.coin || "coin" };
          const perp = dex * 10000 + idx;
          const key = mi + ":" + perp;
          if (seen.has(key)) continue;
          seen.add(key);
          assets.push({ memberIndex: mi, perp: perp });
        }
      }
    }
    if (assets.length > 32) return { ok: false, reason: "too many positions" };
    return { ok: true, assets: assets };
  }

  async function assetsFor(market) {
    const book = books[market.toLowerCase()] || { last: 0n };
    const due = V3.isDue(book.last || 0n, nowSec(), cfg.epochSec);
    let built;
    try { built = await buildBook(market); }
    catch (e) { built = { ok: false, reason: "info" }; }
    if (built.ok) return built.assets;
    if (!due) return [];
    throw new Error("This market is due for a settle and the book could not be built (" + (built.reason || "unknown") + "). Wait for the keeper, then claim.");
  }

  async function withTimeout(url, ms, asJson) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      const res = await fetch(url, { cache: "no-store", signal: ctrl.signal });
      if (!res.ok) return null;
      return asJson ? await res.json() : await res.text();
    } catch (e) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function countryCode() {
    const trace = await withTimeout("/cdn-cgi/trace", 4000, false);
    const fromTrace = trace && V3.parseTrace(trace);
    if (fromTrace) return fromTrace;
    const geojs = await withTimeout("https://get.geojs.io/v1/ip/country.json", 5000, true);
    const fromGeo = V3.parseGeoJson(geojs);
    if (fromGeo) return fromGeo;
    const alt = await withTimeout("https://api.country.is/", 5000, true);
    return V3.parseGeoJson(alt);
  }

  function ensureGeo() {
    if (!V3.geoActive(cfg && cfg.network)) {
      geo = { blocked: false, pending: false, notice: "" };
      return Promise.resolve(geo);
    }
    if (!geoPromise) geoPromise = lookupGeo();
    return geoPromise;
  }

  async function lookupGeo() {
    const code = await countryCode();
    const decision = V3.gateGeo("mainnet", code);
    if (!decision.blocked) geo = { blocked: false, pending: false, notice: "", country: code };
    else if (decision.reason === "region") {
      geo = { blocked: true, pending: false, notice: "Not offered in the UK, the US, or their territories. Browsing is fine. Connecting and betting stay off.", country: code };
    } else {
      geo = { blocked: true, pending: false, notice: "We couldn't confirm your region, so connecting and betting stay off." };
    }
    paint();
    if (window.softRender) window.softRender();
    return geo;
  }

  function chainSwitchError() {
    onChain = false;
    return new Error("Could not switch the wallet to " + cfg.chainName + " (chain " + cfg.chainId + ").");
  }

  async function readWalletChain(eth) {
    try {
      const got = await V3.withTimeout(eth.request({ method: "eth_chainId" }), 8000, "The wallet did not report its chain.");
      return Number.parseInt(got, 16);
    } catch (e) {
      if (V3.isReject(e)) throw e;
      throw chainSwitchError();
    }
  }

  async function ensureChain(eth) {
    const hex = chainHex();
    let current = await readWalletChain(eth);
    if (current !== cfg.chainId) {
      try {
        await V3.withTimeout(
          eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] }),
          20000,
          "The wallet did not confirm the chain switch."
        );
      } catch (e) {
        if (V3.isReject(e)) throw e;
        const code = e && (e.code != null ? e.code : (e.data && e.data.originalError && e.data.originalError.code));
        const unknown = code === 4902 || code === "4902" || /4902|unrecognized chain/i.test(String(e && e.message || ""));
        if (!unknown) throw chainSwitchError();
        try {
          await V3.withTimeout(eth.request({
            method: "wallet_addEthereumChain",
            params: [{
              chainId: hex,
              chainName: cfg.chainName,
              nativeCurrency: cfg.nativeCurrency,
              rpcUrls: [cfg.rpcUrl],
              blockExplorerUrls: cfg.explorer ? [cfg.explorer] : [],
            }],
          }), 20000, "The wallet did not add the chain.");
        } catch (addErr) {
          if (V3.isReject(addErr)) throw addErr;
          throw chainSwitchError();
        }
      }
      current = await readWalletChain(eth);
    }
    if (current !== cfg.chainId) throw chainSwitchError();
    onChain = true;
  }

  async function syncAccount(eth) {
    let accounts;
    try {
      accounts = await V3.withTimeout(eth.request({ method: "eth_accounts" }), 8000, "The wallet did not answer.");
    } catch (e) {
      if (V3.isReject(e)) throw e;
      throw new Error("The wallet did not answer. Unlock it and try again.");
    }
    const next = V3.pickAccount(accounts, account);
    if (!next) {
      account = null;
      onChain = false;
      throw new Error("Connect a wallet on " + chainLabel() + ".");
    }
    account = next;
    return next;
  }

  function snapshotDemo() {
    if (demoSnap || !window.U) return;
    demoSnap = JSON.parse(JSON.stringify(window.U));
  }
  function restoreDemo() {
    if (!demoSnap || !window.U) return;
    window.U.pts = demoSnap.pts;
    window.U.hold = demoSnap.hold;
    window.U.queue = demoSnap.queue;
    window.U.deposited = demoSnap.deposited;
    window.U.hist = demoSnap.hist;
    demoSnap = null;
  }

  function noticeText() {
    const where = cfg && cfg.network === "mainnet" ? "MAINNET — chain 999." : "TESTNET — chain 998.";
    const pause = pausedFlag ? " Buys are paused. Sell and withdraw stay open." : "";
    if (!cfg) return where + " config/testnet-v3.json did not load, so pots stay on the browser preview.";
    if (!configured()) return where + " v3 addresses are placeholders in config/testnet-v3.json, so these pots are a browser preview until the testnet deploy is filled in." + pause;
    if (live()) return where + " Withdrawable USDC sits in the registry. Minimum 10 USDC. One pending order per wallet." + pause;
    if (potsLive) return where + " Live v3 pots. Connect a wallet to deposit USDC and bet." + pause;
    if (potsFailed) return where + " This coin's pot did not load. The last good balance is still on screen." + pause;
    if (configured()) return where + " Open a coin to read its USDC pot. Connect a wallet to deposit and bet." + pause;
    return where + " Market addresses are still placeholders, so these pots are a browser preview." + pause;
  }

  function paint() {
    const btn = $("#connectBtn");
    if (btn) {
      if (geo.blocked) {
        btn.textContent = "Region blocked";
        btn.title = geo.notice;
      } else if (live()) {
        btn.textContent = short(account);
        btn.title = "Disconnect";
      } else {
        btn.textContent = "Connect wallet";
        btn.title = "Connect a wallet on " + (cfg ? cfg.chainName : "HyperEVM testnet");
      }
    }
    const banner = document.querySelector("#pocBanner");
    if (banner) banner.textContent = V3.SEASON;
    const notice = document.getElementById("testnetNotice");
    if (notice) notice.textContent = noticeText();
    const geoEl = document.getElementById("geoNotice");
    const geoWrap = document.getElementById("geoWrap");
    if (geoWrap && geoEl) {
      if (geo.blocked) {
        geoWrap.style.display = "";
        geoEl.textContent = geo.notice;
      } else if (cfg && !V3.geoActive(cfg.network)) {
        geoWrap.style.display = "";
        geoEl.textContent = V3.TESTNET_GEO_NOTE;
      } else geoWrap.style.display = "none";
    }
    view.paused = pausedFlag;
    view.feeText = V3.feeText(feeBps);
    view.configured = configured();
    view.faucet = !!(cfg && cfg.faucet);
  }

  async function doAttach() {
    if (!V3) return;
    try {
      const res = await fetch("./config/testnet-v3.json", { cache: "no-store" });
      if (res.ok) cfg = V3.resolve(await res.json());
    } catch (e) { cfg = null; }
    const hdr = document.querySelector(".hdr-r");
    if (hdr && !$("#connectBtn")) {
      const btn = document.createElement("button");
      btn.id = "connectBtn";
      btn.className = "mini bg";
      btn.type = "button";
      btn.textContent = "Connect wallet";
      btn.onclick = () => connect();
      hdr.prepend(btn);
    }
    const eth = window.ethereum;
    if (eth && eth.on) {
      eth.on("accountsChanged", (xs) => {
        if (!xs || !xs.length) disconnect();
        else if (live() && !geo.blocked) {
          const next = xs[0];
          if (!account || next.toLowerCase() !== account.toLowerCase()) resetMoney();
          account = next;
          refresh().catch((e) => toast(explain(e)));
        }
      });
      eth.on("chainChanged", () => {
        if (!account || geo.blocked) return;
        ensureChain(eth).then(() => refresh()).catch((e) => { disconnect(); toast(explain(e)); });
      });
    }
    ensureGeo();
    paint();
    if (!userTimer) {
      userTimer = setInterval(() => {
        if (!live() || busy) return;
        refreshUser().then(async () => {
          if (onPositions()) {
            await refreshShares(false);
            await refreshBooksForPending();
            await refreshNavs();
          }
          paint();
          if (window.softRender) window.softRender();
        }).catch((e) => console.warn(e));
      }, 15000);
    }
    if (!settleTimer) {
      settleTimer = setInterval(() => {
        if (!onHome()) return;
        refreshSettleTimes().then(() => {
          if (typeof window.paintFills === "function") window.paintFills();
        }).catch((e) => console.warn(e));
      }, 30000);
    }
    window.addEventListener("hashchange", () => {
      refresh(false).catch((e) => console.warn(e));
    });
    // boot() may have refreshed before this config finished loading.
    refresh(false).catch((e) => console.warn(e));
  }

  function attach() {
    if (!attachPromise) attachPromise = doAttach();
    return attachPromise;
  }

  async function connect() {
    if (live()) return disconnect();
    const g = await ensureGeo();
    if (g.blocked) { paint(); if (window.softRender) window.softRender(); return toast(g.notice); }
    const eth = window.ethereum;
    if (!eth) return toast("No injected wallet in this browser.");
    if (!cfg) return toast("config/testnet-v3.json did not load.");
    if (!configured()) return toast(missing("registry"));
    try {
      const accounts = await eth.request({ method: "eth_requestAccounts" });
      await ensureChain(eth);
      snapshotDemo();
      account = accounts[0];
      toast("Connected " + short(account) + " on " + cfg.chainName + ".");
      await refresh();
    } catch (e) {
      onChain = false;
      account = null;
      toast(explain(e));
      paint();
    }
  }

  function resetMoney() {
    withdrawable = 0n;
    walletBal = 0n;
    allowance = 0n;
    known.withdrawable = false;
    known.wallet = false;
    known.allowance = false;
    floorWd = null;
    floorWallet = null;
    walletCeiling = null;
    floorUntil = 0;
    Object.keys(shares).forEach((k) => { delete shares[k]; delete shareKnown[k]; });
    Object.keys(pendingRaw).forEach((k) => delete pendingRaw[k]);
    view.wallet = "—";
    view.withdrawable = "—";
    view.allowance = "—";
    view.committed = "0";
    view.holds = {};
    view.pending = {};
    view.stale = false;
    view.staleWallet = false;
    view.staleWithdrawable = false;
    view.staleAllowance = false;
    view.stalePending = false;
    view.staleShares = false;
    shareScanAt = 0;
    Object.keys(navCache).forEach((k) => delete navCache[k]);
    basisMem = {};
    basisNote = "";
  }

  function disconnect() {
    account = null;
    onChain = false;
    resetMoney();
    restoreDemo();
    toast(potsLive ? "Disconnected. Pots stay on the v3 read." : "Back to the browser preview.");
    paint();
    if (window.softRender) window.softRender();
  }

  const POT_CALLS = ["tailPot", "fadePot", "tailSupply", "fadeSupply", "eRef", "status", "lastSettleTs", "epoch", "lastPnl", "lastApplied", "lastDelta"];
  const STATUS = ["uninitialized", "live", "redeem-only"];

  function applyPause(rows) {
    if (!rows[0] || !rows[1] || !rows[2] || !V3.callOk(rows[0]) || !V3.callOk(rows[1]) || !V3.callOk(rows[2])) return false;
    pausedFlag = u256(wordsOf(rows[0].result)[0]) !== 0n;
    pauseSinceSec = Number(u256(wordsOf(rows[1].result)[0]));
    feeBps = Number(u256(wordsOf(rows[2].result)[0]));
    view.paused = pausedFlag;
    view.feeText = V3.feeText(feeBps);
    pauseAt = nowSec();
    return true;
  }

  function touchSettleClock() {
    if (!window.S || !cfg) return;
    let next = null;
    const keys = Object.keys(books);
    for (let i = 0; i < keys.length; i++) {
      const last = books[keys[i]].last;
      if (!last || last === 0n) continue;
      const dueAt = (Number(last) + cfg.epochSec) * 1000;
      if (next == null || dueAt < next) next = dueAt;
    }
    if (next == null) return;
    if (next > Date.now() + 1000) window.S.nextSettle = next;
    else if (!window.S.nextSettle || window.S.nextSettle < Date.now()) window.S.nextSettle = Date.now() + 20000;
  }

  function applyPot(tk, market, rows) {
    const x = window.S && window.S.w[tk];
    if (!x || !rows.every(V3.callOk)) return false;
    const take = (k) => wordsOf(rows[k].result);
    const tailPot = u256(take(0)[0]);
    const fadePot = u256(take(1)[0]);
    const tailSup = u256(take(2)[0]);
    const fadeSup = u256(take(3)[0]);
    const eRef = u256(take(4)[0]);
    const status = Number(u256(take(5)[0] || "0"));
    const last = u256(take(6)[0] || "0");
    const epoch = u256(take(7)[0] || "0");
    const pnl = i256(take(8)[0] || "0");
    const applied = i256(take(9)[0] || "0");
    const delta = i256(take(10)[0] || "0");
    x.T = num6(tailPot);
    x.F = num6(fadePot);
    x.supT = num6(tailSup);
    x.supF = num6(fadeSup);
    if (eRef > 0n) x.eRef = num6(eRef);
    x.chainStatus = STATUS[status] || "unknown";
    x.chainPaused = pausedFlag;
    x.lastR = rayNum(applied);
    x.chainPots = true;
    x.potStale = false;
    view.status[tk] = x.chainStatus;
    books[market.toLowerCase()] = {
      last: last, epoch: epoch, tailPot: tailPot, fadePot: fadePot, tailSup: tailSup, fadeSup: fadeSup, fetchedAt: nowSec(),
    };
    const seen = x.chainSeen || 0;
    const ep = Number(epoch);
    if (last > 0n && ep > seen) {
      x.settle.unshift({ t: Number(last) * 1000, pnl: num6(pnl), r: x.lastR, rc: x.lastR, d: num6(delta) });
      if (x.settle.length > 100) x.settle.pop();
      x.chainSeen = ep;
    }
    if (window.WALLETS) {
      const counts = window.WALLETS.map((w) => (window.S.w[w.tk] && window.S.w[w.tk].chainSeen) || 0);
      window.S.settleN = counts.reduce((a, b) => a + b, 0);
    }
    touchSettleClock();
    potsLive = true;
    potsFailed = false;
    return true;
  }

  async function refreshPause() {
    if (!cfg || !V3.isSet(cfg.registry)) return false;
    if (pauseAt && nowSec() < pauseAt + (cfg.epochSec || 600)) return true;
    const rows = await readChain([
      { to: cfg.registry, data: V3.SEL.buysPaused },
      { to: cfg.registry, data: V3.SEL.pauseSince },
      { to: cfg.registry, data: V3.SEL.feeBps },
    ]);
    return applyPause(rows);
  }

  async function refreshViewedPot() {
    if (!cfg || !window.S) return false;
    const tk = viewedTicker();
    const market = tk && marketOf(tk);
    const x = tk && window.S.w[tk];
    if (!market || !x) return false;
    const book = books[market.toLowerCase()];
    if (V3.potFresh(book, nowSec(), cfg.epochSec)) {
      x.potStale = false;
      return true;
    }
    const mine = ++potGen;
    const rows = await readChain(POT_CALLS.map((name) => ({ to: market, data: V3.SEL[name] })));
    if (mine !== potGen) return false;
    if (applyPot(tk, market, rows)) return true;
    if (x.chainPots) x.potStale = true;
    else if (!potsLive) potsFailed = true;
    return false;
  }

  function trackBasis(tk, side, raw) {
    const tok = num6(raw);
    const key = tk + ":" + side;
    const x = window.S.w[tk];
    const pot = side === "T" ? x.T : x.F;
    const sup = side === "T" ? x.supT : x.supF;
    const px = sup ? pot / sup : 1;
    const prev = basis[key];
    if (!prev || prev.tok !== tok) {
      const added = prev ? Math.max(tok - prev.tok, 0) : tok;
      const removed = prev ? Math.max(prev.tok - tok, 0) : 0;
      const cost0 = prev ? prev.cost : 0;
      const cost = cost0 + added * px - (prev && prev.tok ? cost0 * (removed / prev.tok) : 0);
      basis[key] = { tok: tok, cost: cost };
    }
    const worth = tok * px;
    const b = basis[key];
    let text = V3.formatUnits(raw) + " tok · worth " + (sup ? (worth).toFixed(2) : V3.formatUnits(0n)) + " USDC";
    if (b && b.cost > 0) {
      const r = worth / b.cost - 1;
      text += " (" + (r >= 0 ? "+" : "") + (r * 100).toFixed(1) + "%)";
    }
    return { has: raw > 0n, text: text, basis: basis[key] };
  }

  function applyMoney(kind, row) {
    const prev = known[kind] ? (kind === "wallet" ? walletBal : kind === "allowance" ? allowance : withdrawable) : null;
    const read = V3.acceptRead(row, prev);
    const textKey = kind === "wallet" ? "wallet" : kind;
    const staleKey = kind === "wallet" ? "staleWallet" : kind === "allowance" ? "staleAllowance" : "staleWithdrawable";
    const floor = kind === "wallet" ? floorWallet : kind === "withdrawable" ? floorWd : null;
    const laggingLow = read.ok && floor != null && Date.now() < floorUntil && read.use < floor;
    const laggingHigh = read.ok && kind === "wallet" && walletCeiling != null && Date.now() < floorUntil && read.use > walletCeiling;
    if (read.ok && (laggingLow || laggingHigh)) {
      view[staleKey] = true;
      return;
    }
    if (read.ok) {
      if (kind === "wallet") { walletBal = read.use; floorWallet = null; walletCeiling = null; }
      else if (kind === "allowance") allowance = read.use;
      else { withdrawable = read.use; floorWd = null; }
      known[kind] = true;
      view[staleKey] = false;
      view[textKey] = V3.formatUnits(read.use);
    } else {
      view[staleKey] = true;
      if (!known[kind]) view[textKey] = "—";
    }
  }

  function rememberShares(tk, tail, fade) {
    shares[tk + ":T"] = tail;
    shares[tk + ":F"] = fade;
    shareKnown[tk] = true;
    const x = window.S && window.S.w[tk];
    if (!x) return;
    view.holds[tk] = {
      T: trackBasis(tk, "T", tail),
      F: trackBasis(tk, "F", fade),
    };
  }

  function legsFrom(raw) {
    const legs = [];
    if (raw.buyTail > 0n) legs.push({ kind: "buy", side: "T", text: V3.formatUnits(raw.buyTail) });
    if (raw.buyFade > 0n) legs.push({ kind: "buy", side: "F", text: V3.formatUnits(raw.buyFade) });
    if (raw.sellTail > 0n) legs.push({ kind: "sell", side: "T", text: V3.formatUnits(raw.sellTail) });
    if (raw.sellFade > 0n) legs.push({ kind: "sell", side: "F", text: V3.formatUnits(raw.sellFade) });
    return legs;
  }

  function paintUserBooks() {
    if (!window.U) return;
    window.U.hold = {};
    window.U.queue = [];
    let committed = 0n;
    const now = nowSec();
    const tickers = {};
    Object.keys(shareKnown).forEach((tk) => { tickers[tk] = true; });
    Object.keys(pendingRaw).forEach((tk) => { tickers[tk] = true; });
    Object.keys(tickers).forEach((tk) => {
      if (shareKnown[tk]) {
        const tail = shares[tk + ":T"] || 0n;
        const fade = shares[tk + ":F"] || 0n;
        if (tail > 0n && basis[tk + ":T"]) window.U.hold[tk + ":T"] = basis[tk + ":T"];
        if (fade > 0n && basis[tk + ":F"]) window.U.hold[tk + ":F"] = basis[tk + ":F"];
      }
      const raw = pendingRaw[tk];
      if (!raw) {
        delete view.pending[tk];
        return;
      }
      committed += raw.buyTail + raw.buyFade;
      if (raw.buyTail > 0n) window.U.queue.push({ tk: tk, side: "T", kind: "buy", amt: num6(raw.buyTail), t: Date.now() });
      if (raw.buyFade > 0n) window.U.queue.push({ tk: tk, side: "F", kind: "buy", amt: num6(raw.buyFade), t: Date.now() });
      const market = marketOf(tk);
      const book = (market && books[market.toLowerCase()]) || {};
      const legs = legsFrom(raw);
      const due = V3.isDue(book.last || 0n, now, cfg.epochSec);
      const canCancel = legs.length > 0 && raw.epoch !== 0n && raw.epoch === (book.epoch || 0n) && !due;
      if (legs.length) view.pending[tk] = { legs: legs, canCancel: canCancel };
      else delete view.pending[tk];
    });
    view.committed = V3.formatUnits(committed);
    if (known.withdrawable) {
      window.U.pts = num6(withdrawable);
      window.U.deposited = window.U.deposited || num6(withdrawable);
    }
    view.stale = !!(view.staleWallet || view.staleWithdrawable || view.staleAllowance || view.stalePending);
  }

  function notePending(tk, row) {
    if (!V3.callOk(row)) return false;
    const pw = wordsOf(row.result);
    const raw = {
      epoch: pw.length ? u256(pw[0]) : 0n,
      buyTail: pw.length > 1 ? u256(pw[1]) : 0n,
      buyFade: pw.length > 2 ? u256(pw[2]) : 0n,
      sellTail: pw.length > 3 ? u256(pw[3]) : 0n,
      sellFade: pw.length > 4 ? u256(pw[4]) : 0n,
    };
    if (raw.buyTail === 0n && raw.buyFade === 0n && raw.sellTail === 0n && raw.sellFade === 0n) delete pendingRaw[tk];
    else pendingRaw[tk] = raw;
    return true;
  }

  let userBusy = false;
  let userAgain = false;
  let userWait = null;

  async function refreshUser() {
    if (!live() || !window.U || !window.WALLETS) return;
    if (userBusy) { userAgain = true; return userWait; }
    userBusy = true;
    userWait = (async () => {
      try {
        do {
          userAgain = false;
          await loadUser();
        } while (userAgain);
      } finally {
        userBusy = false;
        userWait = null;
      }
    })();
    return userWait;
  }

  async function loadUser() {
    const mine = ++userGen;
    const me = account;
    const jobs = [
      { to: cfg.registry, data: V3.encodeAddress(V3.SEL.balanceOf, me) },
      { to: cfg.usdc, data: V3.encodeAddress(V3.SEL.balanceOf, me) },
      { to: cfg.usdc, data: V3.encodeAllowance(me, cfg.registry) },
    ];
    const wantPause = !(pauseAt && nowSec() < pauseAt + (cfg.epochSec || 600));
    const pauseBase = jobs.length;
    if (wantPause && V3.isSet(cfg.registry)) {
      jobs.push(
        { to: cfg.registry, data: V3.SEL.buysPaused },
        { to: cfg.registry, data: V3.SEL.pauseSince },
        { to: cfg.registry, data: V3.SEL.feeBps },
      );
    }
    const tk = viewedTicker();
    const viewedMarket = tk && marketOf(tk);
    const shareAt = viewedMarket ? jobs.length : -1;
    if (viewedMarket) {
      jobs.push(
        { to: viewedMarket, data: V3.encodeShares(me, 0) },
        { to: viewedMarket, data: V3.encodeShares(me, 1) },
      );
    }
    const markets = [];
    for (const w of window.WALLETS) {
      const m = marketOf(w.tk);
      if (!m) continue;
      markets.push({ tk: w.tk, at: jobs.length });
      jobs.push({ to: m, data: V3.encodeAddress(V3.SEL.pending, me) });
    }
    let rows = await readChain(jobs);
    if (mine !== userGen || account !== me) return;
    if (V3.needsProviderFallback(rows, [0, 1, 2])) {
      rows = await fillFromWallet(jobs, rows, [0, 1, 2]);
      if (mine !== userGen || account !== me) return;
    }
    applyMoney("withdrawable", rows[0]);
    applyMoney("wallet", rows[1]);
    applyMoney("allowance", rows[2]);
    if (wantPause && V3.isSet(cfg.registry)) applyPause(rows.slice(pauseBase, pauseBase + 3));
    if (shareAt >= 0) {
      const tailRow = rows[shareAt];
      const fadeRow = rows[shareAt + 1];
      if (V3.callOk(tailRow) && V3.callOk(fadeRow)) {
        rememberShares(tk, u256(wordsOf(tailRow.result)[0]), u256(wordsOf(fadeRow.result)[0]));
      }
    }
    let pendingStale = false;
    for (let i = 0; i < markets.length; i++) {
      if (!notePending(markets[i].tk, rows[markets[i].at])) pendingStale = true;
    }
    view.stalePending = pendingStale;
    paintUserBooks();
  }

  function hashPath() {
    return String((typeof location !== "undefined" && location.hash) || "").replace(/^#/, "").split("?")[0];
  }

  function onPositions() { return hashPath() === "/positions"; }

  function onHome() {
    const path = hashPath();
    return path === "" || path === "/";
  }

  async function refreshSettleTimes() {
    if (!cfg || !window.WALLETS) return;
    if (settleSweepAt && nowSec() < settleSweepAt + 30) return;
    const jobs = [];
    const keys = [];
    for (const w of window.WALLETS) {
      const market = marketOf(w.tk);
      if (!market) continue;
      keys.push(market.toLowerCase());
      jobs.push({ to: market, data: V3.SEL.lastSettleTs });
    }
    if (!jobs.length) return;
    settleSweepAt = nowSec();
    const rows = await readChain(jobs);
    for (let i = 0; i < keys.length; i++) {
      if (!V3.callOk(rows[i])) continue;
      const word = wordsOf(rows[i].result)[0];
      if (word == null) continue;
      lastSeen[keys[i]] = u256(word);
    }
  }

  function nextFill() {
    if (!cfg || !window.V3) return { known: false, deadline: null, due: null };
    const seen = {};
    Object.keys(books).forEach((key) => {
      const book = books[key];
      if (book && book.last != null) seen[key] = book.last;
    });
    Object.keys(lastSeen).forEach((key) => { seen[key] = lastSeen[key]; });
    return V3.soonestFill(Object.keys(seen).map((key) => seen[key]), cfg.epochSec);
  }

  async function rpcRetry(method, params) {
    let reason = "rpc failed";
    for (let attempt = 0; attempt <= 3; attempt++) {
      if (attempt > 0) await sleep(V3.retryWaitMs(attempt - 1));
      try {
        const res = await fetch(cfg.rpcUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: method, params: params }),
        });
        const text = await res.text();
        let body = text;
        try { body = JSON.parse(text); } catch (e) { body = { error: { message: text.slice(0, 180) } }; }
        const msg = body && body.error ? (body.error.message || JSON.stringify(body.error)) : "";
        if (res.status === 429 || res.status >= 500 || V3.isRateLimit(res.status, msg) || (body && body.error && V3.isRateLimit(res.status, msg))) {
          reason = msg || ("rpc " + res.status);
          continue;
        }
        if (body && body.error) throw new Error(body.error.message || "rpc error");
        return body.result;
      } catch (e) {
        reason = (e && e.message) || reason;
        if (attempt === 3) throw e;
      }
    }
    throw new Error(reason);
  }

  async function refreshShares(force) {
    if (!live() || !window.WALLETS) return;
    if (!force && shareScanAt && nowSec() < shareScanAt + (cfg.epochSec || 600)) return;
    const jobs = [];
    const meta = [];
    for (const w of window.WALLETS) {
      const market = marketOf(w.tk);
      if (!market) continue;
      meta.push(w.tk);
      jobs.push({ to: market, data: V3.encodeShares(account, 0) });
      jobs.push({ to: market, data: V3.encodeShares(account, 1) });
    }
    if (!jobs.length) return;
    const rows = await readChain(jobs);
    let okAll = true;
    for (let i = 0; i < meta.length; i++) {
      const tailRow = rows[i * 2];
      const fadeRow = rows[i * 2 + 1];
      if (!V3.callOk(tailRow) || !V3.callOk(fadeRow)) { okAll = false; continue; }
      rememberShares(meta[i], u256(wordsOf(tailRow.result)[0]), u256(wordsOf(fadeRow.result)[0]));
    }
    view.staleShares = !okAll;
    if (okAll) shareScanAt = nowSec();
  }

  async function refreshBooksForPending() {
    const jobs = [];
    const list = [];
    Object.keys(pendingRaw).forEach((tk) => {
      const market = marketOf(tk);
      if (!market) return;
      const key = market.toLowerCase();
      const book = books[key];
      if (book && book.epoch != null && book.last != null && V3.potFresh(book, nowSec(), cfg.epochSec)) return;
      list.push(key);
      jobs.push({ to: market, data: V3.SEL.epoch });
      jobs.push({ to: market, data: V3.SEL.lastSettleTs });
    });
    if (!jobs.length) return;
    const rows = await readChain(jobs);
    for (let i = 0; i < list.length; i++) {
      const epochRow = rows[i * 2];
      const lastRow = rows[i * 2 + 1];
      if (!V3.callOk(epochRow) || !V3.callOk(lastRow)) continue;
      const prev = books[list[i]] || {};
      books[list[i]] = Object.assign({}, prev, {
        epoch: u256(wordsOf(epochRow.result)[0]),
        last: u256(wordsOf(lastRow.result)[0]),
        fetchedAt: prev.fetchedAt || nowSec(),
      });
    }
    paintUserBooks();
  }

  async function refreshNavs() {
    const jobs = [];
    const meta = [];
    for (const w of window.WALLETS) {
      const market = marketOf(w.tk);
      if (!market || !shareKnown[w.tk]) continue;
      for (let side = 0; side < 2; side++) {
        const key = w.tk + ":" + (side ? "F" : "T");
        if ((shares[key] || 0n) === 0n) continue;
        const cached = navCache[key];
        if (cached && !cached.stale && nowSec() < cached.at + (cfg.epochSec || 600)) continue;
        meta.push(key);
        jobs.push({ to: market, data: V3.encodeUint(V3.SEL.navOf, side) });
      }
    }
    if (!jobs.length) return;
    const rows = await readChain(jobs);
    for (let i = 0; i < meta.length; i++) {
      const prev = navCache[meta[i]] ? navCache[meta[i]].nav : null;
      const read = V3.acceptRead(rows[i], prev);
      if (read.ok) navCache[meta[i]] = { nav: read.use, at: nowSec(), stale: false };
      else if (navCache[meta[i]]) navCache[meta[i]].stale = true;
    }
  }

  function basisKey() { return "ww_basis_v3_" + String(account || "").toLowerCase(); }

  function readBasisStore() {
    try {
      const raw = JSON.parse(localStorage.getItem(basisKey()) || "null");
      if (!raw || raw.user !== String(account || "").toLowerCase()) return null;
      return raw;
    } catch (e) { return null; }
  }

  function writeBasisStore(through, books) {
    const out = { user: String(account).toLowerCase(), through: through, books: {} };
    Object.keys(books).forEach((m) => {
      out.books[m] = {
        T: { cost: books[m].T.cost.toString(), shares: books[m].T.shares.toString(), partial: books[m].T.partial },
        F: { cost: books[m].F.cost.toString(), shares: books[m].F.shares.toString(), partial: books[m].F.partial },
      };
    });
    try { localStorage.setItem(basisKey(), JSON.stringify(out)); } catch (e) { /* private mode */ }
  }

  async function refreshBasis() {
    const held = [];
    for (const w of window.WALLETS) {
      const market = marketOf(w.tk);
      if (!market || !shareKnown[w.tk]) continue;
      if ((shares[w.tk + ":T"] || 0n) > 0n || (shares[w.tk + ":F"] || 0n) > 0n) held.push(market);
    }
    if (!held.length) { basisNote = ""; return; }
    const store = readBasisStore();
    let head;
    try { head = Number(await rpcRetry("eth_blockNumber", [])); }
    catch (e) { basisNote = "Value only. Cost basis didn't load."; return; }
    const from = store && store.through != null ? Number(store.through) + 1 : Math.max(0, head - 8000);
    const ranges = V3.logRanges(from, head, 1000).slice(0, 8);
    const userTopic = "0x" + V3.addrWord(account);
    const logs = [];
    try {
      for (let i = 0; i < held.length; i++) {
        for (let r = 0; r < ranges.length; r++) {
          const span = ranges[r];
          const part = await rpcRetry("eth_getLogs", [{
            address: held[i],
            fromBlock: "0x" + span[0].toString(16),
            toBlock: "0x" + span[1].toString(16),
            topics: [[V3.TOPICS.feePaid, V3.TOPICS.exposure, V3.TOPICS.emergencyExit], userTopic],
          }]);
          (part || []).forEach((log) => logs.push({
            topic: log.topics && log.topics[0],
            market: held[i],
            block: Number(log.blockNumber),
            index: Number(log.logIndex),
            data: log.data,
          }));
        }
      }
    } catch (e) {
      basisNote = "Value only. Cost basis didn't load.";
      return;
    }
    const seed = {};
    if (store && store.books) {
      Object.keys(store.books).forEach((m) => { seed[m] = store.books[m]; });
    }
    basisMem = V3.foldBasis(logs, seed);
    writeBasisStore(head, basisMem);
    basisNote = "";
  }

  function positions() {
    const out = {
      connected: live(),
      loading: false,
      ready: shareScanAt > 0,
      stale: !!(view.staleShares || view.stalePending),
      rows: [],
      value: "0",
      pnl: "—",
      pnlNote: "",
      pending: null,
      withdrawable: view.withdrawable,
      staleWithdrawable: !!view.staleWithdrawable,
    };
    if (!out.connected || !window.WALLETS) return out;
    let value = 0n;
    let pnl = 0n;
    let pnlCost = 0n;
    let anyValue = false;
    let anyPnl = false;
    let pnlGap = false;
    let pendingBuy = 0n;
    for (const w of window.WALLETS) {
      const raw = pendingRaw[w.tk];
      const book = books[(marketOf(w.tk) || "").toLowerCase()] || {};
      const pend = view.pending[w.tk];
      for (const side of ["T", "F"]) {
        const key = w.tk + ":" + side;
        const have = shareKnown[w.tk] ? (shares[key] || 0n) : null;
        const buy = raw ? (side === "T" ? raw.buyTail : raw.buyFade) : 0n;
        const sell = raw ? (side === "T" ? raw.sellTail : raw.sellFade) : 0n;
        if ((have == null || have === 0n) && buy === 0n && sell === 0n) continue;
        const nav = navCache[key];
        const worth = have != null && have > 0n && nav ? V3.positionValue(have, nav.nav) : null;
        const market = (marketOf(w.tk) || "").toLowerCase();
        const lot = basisMem[market] && basisMem[market][side];
        const costOk = !!(lot && worth != null && lot.shares === have && !lot.partial);
        if (worth != null) { value += worth; anyValue = true; }
        if (costOk) { pnl += worth - lot.cost; pnlCost += lot.cost; anyPnl = true; }
        else if (have != null && have > 0n) pnlGap = true;
        const bits = [];
        if (buy > 0n) { pendingBuy += buy; bits.push(V3.formatUnits(buy) + " USDC → " + (side === "T" ? "TAIL" : "FADE")); }
        if (sell > 0n) bits.push("sell " + V3.formatUnits(sell) + " " + (side === "T" ? "TAIL" : "FADE"));
        const canCancel = !!(pend && pend.canCancel && (buy > 0n || sell > 0n));
        const closedPending = raw && (buy > 0n || sell > 0n);
        const fill = book.last != null && cfg ? V3.orderFillDeadline(book.last, cfg.epochSec, closedPending ? raw.epoch : null, book.epoch) : null;
        out.rows.push({
          tk: w.tk,
          side: side,
          shares: have == null ? "—" : V3.formatUnits(have),
          value: have == null || (have > 0n && worth == null) ? "—" : V3.formatUnits(worth == null ? 0n : worth),
          cost: costOk ? V3.formatUnits(lot.cost) : null,
          pnl: costOk ? V3.formatUnits(worth - lot.cost) : null,
          pnlPct: costOk && lot.cost > 0n ? Number((worth - lot.cost) * 10000n / lot.cost) / 100 : null,
          pendingText: bits.join(", "),
          canCancel: canCancel,
          showClaim: !!(pend && pend.legs && pend.legs.length && (buy > 0n || sell > 0n)),
          navStale: !!(nav && nav.stale),
          bookReady: book.epoch != null,
          fillDeadline: fill ? fill.deadline : null,
          fillDue: fill ? fill.due : null,
        });
      }
    }
    out.loading = !out.ready && !out.rows.length;
    out.value = anyValue || out.ready ? V3.formatUnits(value) : "—";
    if (pendingBuy > 0n) out.pending = V3.formatUnits(pendingBuy);
    if (anyPnl && !pnlGap) {
      out.pnl = V3.formatUnits(pnl);
      out.pnlPct = pnlCost > 0n ? Number(pnl * 10000n / pnlCost) / 100 : null;
    } else if (pnlGap || basisNote) {
      out.pnl = "—";
      out.pnlNote = basisNote || "Value only. Cost basis wasn't in the recent log window.";
    } else if (out.rows.length && !anyValue) {
      out.pnlNote = "P&L starts once a fill is in your shares.";
    }
    if (view.staleShares) out.value = out.ready ? out.value : "—";
    return out;
  }

  async function refresh(force) {
    if (!window.S || !window.WALLETS) return;
    try {
      if (live()) await refreshUser();
      else await refreshPause();
      if (live() && onPositions()) {
        await refreshShares(!!force);
        await refreshBooksForPending();
        await refreshNavs();
      } else await refreshViewedPot();
      if (onHome()) await refreshSettleTimes();
    } catch (e) {
      console.warn(e);
    }
    paint();
    if (force && typeof window.render === "function") window.render();
    else if (window.softRender) window.softRender();
    if (typeof window.paintFills === "function") window.paintFills();
    if (live() && onPositions()) {
      refreshBasis().then(() => {
        paint();
        if (window.softRender) window.softRender();
      }).catch((e) => console.warn(e));
    }
  }

  function bump(kind, next) {
    floorUntil = Date.now() + 20000;
    if (kind === "wallet") {
      if (!known.wallet || next > walletBal) { floorWallet = next; walletCeiling = null; }
      else { floorWallet = null; walletCeiling = next; }
      walletBal = next; known.wallet = true; view.wallet = V3.formatUnits(next); view.staleWallet = false;
    } else if (kind === "allowance") {
      allowance = next; known.allowance = true; view.allowance = V3.formatUnits(next); view.staleAllowance = false;
    } else {
      floorWd = !known.withdrawable || next > withdrawable ? next : null;
      withdrawable = next; known.withdrawable = true; view.withdrawable = V3.formatUnits(next); view.staleWithdrawable = false;
    }
    view.stale = !!(view.staleWallet || view.staleWithdrawable || view.staleAllowance || view.stalePending);
  }

  async function send(to, data) {
    const eth = window.ethereum;
    if (!eth) throw new Error("No injected wallet in this browser.");
    await syncAccount(eth);
    await ensureChain(eth);
    toast("Confirm this in your wallet.");
    const tx = { from: account, to: to, data: data };
    const result = await V3.driveSend({
      tx: tx,
      request: (params) => eth.request(params),
      receipt: (hash) => rpc("eth_getTransactionReceipt", [hash]),
      wait: () => new Promise((r) => setTimeout(r, 2000)),
      onSubmitted: (hash) => toast("Submitted " + short(hash) + ". Waiting for the receipt."),
    });
    return result.hash;
  }

  async function ready(action) {
    if (busy) { toast(V3.BUSY_TOAST); return false; }
    const g = await ensureGeo();
    if (g.blocked) { toast(g.notice); paint(); if (window.softRender) window.softRender(); return false; }
    const gate = V3.readyCheck({
      busy: false,
      geoBlocked: false,
      cfg: !!cfg,
      configured: configured(),
      missing: missing(action === "faucet" ? "usdc" : "registry"),
      hasEth: !!window.ethereum,
      live: true,
      chainLabel: chainLabel(),
    });
    if (!gate.ok) { toast(gate.toast); return false; }
    try {
      await syncAccount(window.ethereum);
      await ensureChain(window.ethereum);
    } catch (e) {
      toast(explain(e));
      paint();
      if (window.softRender) window.softRender();
      return false;
    }
    if (!live()) { toast("Connect a wallet on " + chainLabel() + "."); return false; }
    return true;
  }

  async function withBusy(fn) {
    busy = true;
    try {
      await fn();
    } catch (e) {
      toast(explain(e));
    } finally {
      busy = false;
      try { await refresh(true); } catch (e) { console.warn(e); }
    }
  }

  function fillState(tk) {
    const pend = view.pending[tk];
    const has = !!(pend && pend.legs && pend.legs.length);
    const base = { kind: has ? "pending" : "order", hint: has, known: false, deadline: null, due: null };
    const market = marketOf(tk);
    const book = (market && books[market.toLowerCase()]) || null;
    if (!book || book.last == null || !cfg) return base;
    const raw = pendingRaw[tk];
    const times = V3.orderFillDeadline(book.last, cfg.epochSec, has && raw ? raw.epoch : null, book.epoch);
    if (!times) return base;
    return { deadline: times.deadline, due: times.due, kind: base.kind, hint: has, known: true };
  }

  function fillPhrase(tk, kind) {
    const st = fillState(tk);
    if (!st || !st.known || !(st.deadline > nowSec())) return "Your order fills on the next epoch.";
    return V3.formatFill(kind, st.deadline, nowSec());
  }

  function amountFrom(id) {
    const el = document.getElementById(id);
    return V3.parseUsdc(el && el.value);
  }

  async function order(tk, side, kind) {
    if (!(await ready("bet"))) return;
    const market = marketOf(tk);
    if (!market) return toast(missingMarket(tk));
    const pend = view.pending[tk];
    if (pend && pend.legs && pend.legs.length) {
      return toast(pend.canCancel
        ? "One pending order per wallet. Cancel it (the " + view.feeText + " fee is kept) or wait for it to fill."
        : "One pending order per wallet. Claim it so it can fill, then place the next one.");
    }
    const st = view.status[tk];
    const sideN = side === "T" ? 0 : 1;
    if (kind === "buy") {
      if (pausedFlag) return toast("Buys are paused. Sell and withdraw stay open.");
      if (st && st !== "live") return toast("Buys are closed on this market.");
      const raw = amountFrom("amt");
      const min = V3.parseUsdc(cfg.minOrderUsdc) || (10n * V3.UNIT);
      if (raw == null || raw === 0n) return toast("Enter a USDC amount.");
      if (raw < min) return toast("Minimum order is " + V3.formatUnits(min) + " USDC.");
      if (raw > withdrawable) return toast("Not enough withdrawable USDC. Deposit on the balance screen.");
      return withBusy(async () => {
        const assets = await assetsFor(market);
        await send(market, V3.encodeBuy(sideN, raw, assets));
        toast("Committed " + V3.formatUnits(raw) + " USDC → " + (side === "T" ? "TAIL" : "FADE") + ". " + fillPhrase(tk, "pending"));
      });
    }
    const raw = shares[tk + ":" + side] || 0n;
    if (raw === 0n) return toast("Nothing to sell.");
    if (st === "uninitialized") return toast("This market is not open.");
    return withBusy(async () => {
      const assets = await assetsFor(market);
      await send(market, V3.encodeSell(sideN, raw, assets));
      toast("Committed a sell. " + fillPhrase(tk, "pending") + " USDC returns to your withdrawable balance.");
    });
  }

  async function cancel(tk) {
    if (!(await ready("bet"))) return;
    const market = marketOf(tk);
    if (!market) return toast(missingMarket(tk));
    const pend = view.pending[tk];
    if (!pend || !pend.legs.length) return toast("No pending order on this coin.");
    if (!pend.canCancel) return toast("The settle window is open, so this order can no longer be cancelled. Claim it to fill.");
    const ok = window.confirm("Cancel this order? A " + view.feeText + " fee is kept. The rest comes back to your withdrawable balance.");
    if (!ok) return toast("Cancel dismissed. The order is still pending.");
    return withBusy(async () => {
      await send(market, V3.SEL.cancel);
      toast("Cancelled. The " + view.feeText + " fee was kept.");
    });
  }

  async function claim(tk) {
    if (!(await ready("bet"))) return;
    const market = marketOf(tk);
    if (!market) return toast(missingMarket(tk));
    return withBusy(async () => {
      const assets = await assetsFor(market);
      await send(market, V3.encodeClaim(assets));
      toast("Claimed. A due market was sampled, and your fill was applied.");
    });
  }

  async function exit(tk) {
    if (!(await ready("bet"))) return;
    const market = marketOf(tk);
    if (!market) return toast(missingMarket(tk));
    if (!redeemOpen()) return toast(pauseNote() || "Pro-rata redeem is not open yet.");
    return withBusy(async () => {
      await send(market, V3.SEL.exitAtLastNav);
      toast("Redeemed pro-rata into your withdrawable balance.");
    });
  }

  async function approve() {
    if (!(await ready("deposit"))) return;
    const raw = amountFrom("depAmt");
    if (raw == null || raw === 0n) return toast("Enter a USDC amount to approve.");
    if (allowance >= raw) return toast("USDC is already approved for this amount. You can deposit.");
    return withBusy(async () => {
      await send(cfg.usdc, V3.encodeAddrUint(V3.SEL.approve, cfg.registry, raw));
      bump("allowance", raw > allowance ? raw : allowance);
      toast("Approved " + V3.formatUnits(raw) + " USDC for the registry. Deposit is the next step.");
    });
  }

  async function deposit() {
    if (!(await ready("deposit"))) return;
    const raw = amountFrom("depAmt");
    if (raw == null || raw === 0n) return toast("Enter a USDC amount to deposit.");
    if (allowance < raw) return toast("Approve USDC for the registry first.");
    if (raw > walletBal) return toast("Not enough USDC in the wallet.");
    return withBusy(async () => {
      await send(cfg.registry, V3.encodeUint(V3.SEL.deposit, raw));
      bump("withdrawable", (known.withdrawable ? withdrawable : 0n) + raw);
      if (known.wallet) bump("wallet", walletBal > raw ? walletBal - raw : 0n);
      toast("Deposited " + V3.formatUnits(raw) + " USDC. It is now withdrawable, and you can bet it.");
    });
  }

  async function approveAndDeposit() {
    if (!(await ready("deposit"))) return;
    const raw = amountFrom("depAmt");
    if (raw == null || raw === 0n) return toast("Enter a USDC amount to deposit.");
    if (raw > walletBal) return toast("Not enough USDC in the wallet.");
    return withBusy(async () => {
      if (allowance < raw) {
        await send(cfg.usdc, V3.encodeAddrUint(V3.SEL.approve, cfg.registry, raw));
        bump("allowance", raw);
        toast("Approved " + V3.formatUnits(raw) + " USDC. Depositing it next.");
        await refresh(true);
      }
      if (allowance < raw) throw new Error("Approval did not cover this deposit yet. Press Deposit to finish.");
      if (raw > walletBal) throw new Error("Not enough USDC in the wallet.");
      await send(cfg.registry, V3.encodeUint(V3.SEL.deposit, raw));
      bump("withdrawable", (known.withdrawable ? withdrawable : 0n) + raw);
      if (known.wallet) bump("wallet", walletBal > raw ? walletBal - raw : 0n);
      toast("Deposited " + V3.formatUnits(raw) + " USDC. It is now withdrawable, and you can bet it.");
    });
  }

  async function withdraw() {
    if (!(await ready("withdraw"))) return;
    const raw = amountFrom("wdAmt");
    if (raw == null || raw === 0n) return toast("Enter a USDC amount to withdraw.");
    if (raw > withdrawable) return toast("That is more than your withdrawable balance.");
    return withBusy(async () => {
      await send(cfg.registry, V3.encodeUint(V3.SEL.withdraw, raw));
      bump("withdrawable", withdrawable > raw ? withdrawable - raw : 0n);
      if (known.wallet) bump("wallet", walletBal + raw);
      toast("Withdrew " + V3.formatUnits(raw) + " USDC to your wallet.");
    });
  }

  async function faucet() {
    if (!(await ready("faucet"))) return;
    if (!cfg.faucet) return toast("The faucet is only on testnet.");
    if (!V3.isSet(cfg.usdc)) return toast(missing("usdc"));
    const amt = V3.faucetRaw(cfg.faucetAmount);
    return withBusy(async () => {
      await send(cfg.usdc, V3.encodeUint(V3.SEL.faucet, amt));
      bump("wallet", (known.wallet ? walletBal : 0n) + amt);
      toast("Sent " + V3.formatUnits(amt) + " tUSDC to your wallet. At most 1,000 per call. It is not mainnet USDC.");
    });
  }

  async function optOut(whale) {
    if (busy) return toast(V3.BUSY_TOAST);
    const g = await ensureGeo();
    if (g.blocked) return toast(g.notice);
    if (!window.ethereum) return toast("No injected wallet in this browser.");
    try {
      await syncAccount(window.ethereum);
      await ensureChain(window.ethereum);
    } catch (e) { return toast(explain(e)); }
    if (!live()) return toast("Connect the whale's own wallet on " + (cfg ? cfg.chainName : "HyperEVM testnet") + " to opt out.");
    const eth = window.ethereum;
    const typed = {
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
        OptOut: [{ name: "wallet", type: "address" }],
      },
      primaryType: "OptOut",
      domain: { name: "whalewallet.fun", version: "3", chainId: cfg.chainId, verifyingContract: cfg.registry },
      message: { wallet: whale },
    };
    return withBusy(async () => {
      const sig = await V3.withTimeout(
        eth.request({ method: "eth_signTypedData_v4", params: [account, JSON.stringify(typed)] }),
        120000,
        "The wallet did not respond. Check Rabby and try again."
      );
      const hex = String(sig || "").replace(/^0x/, "");
      if (!/^[0-9a-fA-F]+$/.test(hex)) throw new Error("The wallet did not return a signature.");
      const data = V3.SEL.optOut + V3.addrWord(whale) + V3.word(64) + V3.word(hex.length / 2) + hex.padEnd(Math.ceil(hex.length / 64) * 64, "0");
      await send(cfg.registry, data);
      toast("Opt-out submitted. Buys refund. Sells still fill at the frozen NAV.");
    });
  }

  window.WW = {
    live: live,
    potsLive: potsOk,
    potsFailed: function () { return potsFailed; },
    attach: attach,
    connect: connect,
    refresh: refresh,
    order: order,
    cancel: cancel,
    claim: claim,
    exit: exit,
    approve: approve,
    deposit: deposit,
    approveAndDeposit: approveAndDeposit,
    withdraw: withdraw,
    faucet: faucet,
    optOut: optOut,
    paint: paint,
    registryShort: function () { return V3.isSet(cfg && cfg.registry) ? short(cfg.registry) : "not deployed"; },
    config: function () { return cfg; },
    chainLabel: chainLabel,
    buysPaused: function () { return pausedFlag; },
    redeemOpen: redeemOpen,
    pauseNote: pauseNote,
    geoBlocked: function () { return geo.blocked; },
    view: function () { return view; },
    holdText: function (tk, side) {
      const h = view.holds[tk];
      if (!h || !h[side] || !h[side].has) return null;
      return h[side].text;
    },
    canSell: function (tk, side) { return (shares[tk + ":" + side] || 0n) > 0n; },
    pending: function (tk) { return view.pending[tk] || null; },
    positions: positions,
    fillState: fillState,
    nextFill: nextFill,
  };
  window.optOutWhale = (whale) => optOut(whale);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => attach());
  else attach();
})();
