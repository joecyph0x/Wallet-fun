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
  let pausedFlag = false;
  let pauseSinceSec = 0;
  let feeBps = 50;
  const shares = {};
  const books = {};
  const basis = {};
  let demoSnap = null;

  const view = {
    configured: false,
    faucet: false,
    wallet: "—",
    withdrawable: "—",
    allowance: "—",
    committed: "0",
    paused: false,
    feeText: "0.5%",
    holds: {},
    pending: {},
    status: {},
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
    if (/4001|rejected|denied/i.test(m)) return "Wallet request rejected.";
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

  async function batch(items) {
    const out = new Array(items.length);
    for (let i = 0; i < items.length; i += 20) {
      const slice = items.slice(i, i + 20);
      const payload = slice.map((it, j) => ({
        jsonrpc: "2.0", id: j, method: "eth_call", params: [{ to: it.to, data: it.data }, "latest"],
      }));
      const res = await fetch(cfg.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json();
      const rows = Array.isArray(body) ? body : [body];
      const byId = new Map(rows.map((row) => [row.id, row]));
      slice.forEach((_, j) => { out[i + j] = byId.get(j); });
    }
    return out;
  }

  async function chainNow() {
    const block = await rpc("eth_getBlockByNumber", ["latest", false]);
    return Number.parseInt(block.timestamp, 16);
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
    const now = await chainNow();
    const due = V3.isDue(book.last || 0n, now, cfg.epochSec);
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
    if (!geoPromise) geoPromise = lookupGeo();
    return geoPromise;
  }

  async function lookupGeo() {
    const code = await countryCode();
    const decision = V3.decideGeo(code);
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

  async function ensureChain(eth) {
    const hex = chainHex();
    try {
      await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
    } catch (e) {
      const code = e && (e.code || (e.data && e.data.originalError && e.data.originalError.code));
      if (code !== 4902 && !/4902|unrecognized chain/i.test(String(e && e.message))) throw e;
      await eth.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: hex,
          chainName: cfg.chainName,
          nativeCurrency: cfg.nativeCurrency,
          rpcUrls: [cfg.rpcUrl],
          blockExplorerUrls: cfg.explorer ? [cfg.explorer] : [],
        }],
      });
    }
    const got = await eth.request({ method: "eth_chainId" });
    if (Number.parseInt(got, 16) !== cfg.chainId) throw new Error("Wallet is not on " + cfg.chainName + " (chain " + cfg.chainId + ").");
    onChain = true;
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
    if (potsFailed && !potsLive) return "Could not read the v3 pots, so this page is a browser preview." + pause;
    if (live()) return where + " Withdrawable USDC sits in the registry. Fills at next settle (~10–20 min). Minimum 10 USDC. One pending order per wallet." + pause;
    if (potsLive) return where + " Live v3 pots. Connect a wallet to deposit USDC and bet. Fills at next settle (~10–20 min)." + pause;
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
        else if (live() && !geo.blocked) { account = xs[0]; refresh().catch((e) => toast(explain(e))); }
      });
      eth.on("chainChanged", () => {
        if (!account || geo.blocked) return;
        ensureChain(eth).then(() => refresh()).catch((e) => { disconnect(); toast(explain(e)); });
      });
    }
    ensureGeo();
    paint();
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

  function disconnect() {
    account = null;
    onChain = false;
    withdrawable = 0n;
    walletBal = 0n;
    allowance = 0n;
    Object.keys(shares).forEach((k) => delete shares[k]);
    view.wallet = "—";
    view.withdrawable = "—";
    view.allowance = "—";
    view.committed = "0";
    view.holds = {};
    view.pending = {};
    restoreDemo();
    toast(potsLive ? "Disconnected. Pots stay on the v3 read." : "Back to the browser preview.");
    paint();
    if (window.softRender) window.softRender();
  }

  const POT_CALLS = ["tailPot", "fadePot", "tailSupply", "fadeSupply", "eRef", "status", "lastSettleTs", "epoch", "lastPnl", "lastApplied", "lastDelta"];
  const STATUS = ["uninitialized", "live", "redeem-only"];

  function applyPause(rows) {
    const paused = rows[0] && !rows[0].error ? u256(wordsOf(rows[0].result)[0]) !== 0n : pausedFlag;
    const since = rows[1] && !rows[1].error ? Number(u256(wordsOf(rows[1].result)[0])) : pauseSinceSec;
    const fee = rows[2] && !rows[2].error ? Number(u256(wordsOf(rows[2].result)[0])) : feeBps;
    pausedFlag = paused;
    pauseSinceSec = since;
    feeBps = fee;
    view.paused = pausedFlag;
    view.feeText = V3.feeText(feeBps);
  }

  async function refreshPots() {
    if (!cfg || !window.S || !window.WALLETS) { potsLive = false; return false; }
    const jobs = [];
    if (V3.isSet(cfg.registry)) {
      jobs.push(
        { to: cfg.registry, data: V3.SEL.buysPaused },
        { to: cfg.registry, data: V3.SEL.pauseSince },
        { to: cfg.registry, data: V3.SEL.feeBps },
      );
    }
    const head = jobs.length;
    const tks = [];
    for (const w of window.WALLETS) {
      const m = marketOf(w.tk);
      if (!m) continue;
      tks.push(w.tk);
      for (let i = 0; i < POT_CALLS.length; i++) jobs.push({ to: m, data: V3.SEL[POT_CALLS[i]] });
    }
    if (!tks.length) {
      potsLive = false;
      if (jobs.length) {
        try { applyPause(await batch(jobs)); } catch (e) { /* registry unread */ }
      }
      return false;
    }
    try {
      const chainId = await rpc("eth_chainId", []);
      if (Number.parseInt(chainId, 16) !== cfg.chainId) throw new Error("refusing chain id " + chainId);
      const rows = await batch(jobs);
      if (head) applyPause(rows.slice(0, head));
      const per = POT_CALLS.length;
      for (let i = 0; i < tks.length; i++) {
        const b = head + i * per;
        for (let k = 0; k < per; k++) {
          const row = rows[b + k];
          if (!row || row.error || row.result == null) throw new Error((row && row.error && row.error.message) || "pot read failed");
        }
        const take = (k) => wordsOf(rows[b + k].result);
        const tk = tks[i];
        const x = window.S.w[tk];
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
        if (!x) continue;
        x.T = num6(tailPot);
        x.F = num6(fadePot);
        x.supT = num6(tailSup);
        x.supF = num6(fadeSup);
        if (eRef > 0n) x.eRef = num6(eRef);
        x.chainStatus = STATUS[status] || "unknown";
        x.chainPaused = pausedFlag;
        x.lastR = rayNum(applied);
        view.status[tk] = x.chainStatus;
        const market = marketOf(tk);
        books[market.toLowerCase()] = { last: last, epoch: epoch, tailPot: tailPot, fadePot: fadePot, tailSup: tailSup, fadeSup: fadeSup };
        const seen = x.chainSeen || 0;
        const ep = Number(epoch);
        if (last > 0n && ep > seen) {
          x.settle.unshift({ t: Number(last) * 1000, pnl: num6(pnl), r: x.lastR, rc: x.lastR, d: num6(delta) });
          if (x.settle.length > 100) x.settle.pop();
          x.chainSeen = ep;
        }
      }
      let next = null;
      const keys = Object.keys(books);
      for (let i = 0; i < keys.length; i++) {
        const last = books[keys[i]].last;
        if (!last || last === 0n) continue;
        const dueAt = (Number(last) + cfg.epochSec) * 1000;
        if (next == null || dueAt < next) next = dueAt;
      }
      if (next != null) {
        if (next > Date.now() + 1000) window.S.nextSettle = next;
        else if (!window.S.nextSettle || window.S.nextSettle < Date.now()) window.S.nextSettle = Date.now() + 20000;
      }
      const counts = window.WALLETS.map((w) => (window.S.w[w.tk] && window.S.w[w.tk].chainSeen) || 0);
      window.S.settleN = counts.reduce((a, b) => a + b, 0);
      potsLive = true;
      potsFailed = false;
      return true;
    } catch (e) {
      console.warn(e);
      if (!potsLive) potsFailed = true;
      return false;
    }
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

  async function refreshUser() {
    if (!live() || !window.U) return;
    const me = account;
    const jobs = [
      { to: cfg.registry, data: V3.encodeAddress(V3.SEL.balanceOf, me) },
      { to: cfg.usdc, data: V3.encodeAddress(V3.SEL.balanceOf, me) },
      { to: cfg.usdc, data: V3.encodeAllowance(me, cfg.registry) },
    ];
    const markets = [];
    for (const w of window.WALLETS) {
      const m = marketOf(w.tk);
      if (!m) continue;
      markets.push({ tk: w.tk, market: m, base: jobs.length });
      jobs.push(
        { to: m, data: V3.encodeShares(me, 0) },
        { to: m, data: V3.encodeShares(me, 1) },
        { to: m, data: V3.encodeAddress(V3.SEL.pending, me) },
      );
    }
    const rows = await batch(jobs);
    const take0 = (i) => wordsOf(rows[i] && rows[i].result);
    withdrawable = take0(0).length ? u256(take0(0)[0]) : 0n;
    walletBal = take0(1).length ? u256(take0(1)[0]) : 0n;
    allowance = take0(2).length ? u256(take0(2)[0]) : 0n;
    view.withdrawable = V3.formatUnits(withdrawable);
    view.wallet = V3.formatUnits(walletBal);
    view.allowance = V3.formatUnits(allowance);
    window.U.pts = num6(withdrawable);
    window.U.hold = {};
    window.U.queue = [];
    view.holds = {};
    view.pending = {};
    let committed = 0n;
    const now = await chainNow();
    for (const row of markets) {
      const tw = wordsOf(rows[row.base] && rows[row.base].result);
      const fw = wordsOf(rows[row.base + 1] && rows[row.base + 1].result);
      const pw = wordsOf(rows[row.base + 2] && rows[row.base + 2].result);
      const tail = tw.length ? u256(tw[0]) : 0n;
      const fade = fw.length ? u256(fw[0]) : 0n;
      shares[row.tk + ":T"] = tail;
      shares[row.tk + ":F"] = fade;
      const book = books[row.market.toLowerCase()] || {};
      view.holds[row.tk] = {
        T: trackBasis(row.tk, "T", tail),
        F: trackBasis(row.tk, "F", fade),
      };
      if (tail > 0n) window.U.hold[row.tk + ":T"] = basis[row.tk + ":T"];
      if (fade > 0n) window.U.hold[row.tk + ":F"] = basis[row.tk + ":F"];
      const epoch = pw.length ? u256(pw[0]) : 0n;
      const buyTail = pw.length > 1 ? u256(pw[1]) : 0n;
      const buyFade = pw.length > 2 ? u256(pw[2]) : 0n;
      const sellTail = pw.length > 3 ? u256(pw[3]) : 0n;
      const sellFade = pw.length > 4 ? u256(pw[4]) : 0n;
      const legs = [];
      if (buyTail > 0n) legs.push({ kind: "buy", side: "T", text: V3.formatUnits(buyTail) });
      if (buyFade > 0n) legs.push({ kind: "buy", side: "F", text: V3.formatUnits(buyFade) });
      if (sellTail > 0n) legs.push({ kind: "sell", side: "T", text: V3.formatUnits(sellTail) });
      if (sellFade > 0n) legs.push({ kind: "sell", side: "F", text: V3.formatUnits(sellFade) });
      committed += buyTail + buyFade;
      if (buyTail > 0n) window.U.queue.push({ tk: row.tk, side: "T", kind: "buy", amt: num6(buyTail), t: Date.now() });
      if (buyFade > 0n) window.U.queue.push({ tk: row.tk, side: "F", kind: "buy", amt: num6(buyFade), t: Date.now() });
      const current = book.epoch || 0n;
      const due = V3.isDue(book.last || 0n, now, cfg.epochSec);
      const canCancel = legs.length > 0 && epoch !== 0n && epoch === current && !due;
      if (legs.length) view.pending[row.tk] = { legs: legs, canCancel: canCancel };
    }
    view.committed = V3.formatUnits(committed);
    window.U.deposited = window.U.deposited || num6(withdrawable);
  }

  async function refresh() {
    if (!window.S || !window.WALLETS) return;
    try {
      const ok = await refreshPots();
      if (ok && live()) await refreshUser();
      else if (live()) await refreshUser();
    } catch (e) {
      console.warn(e);
    }
    paint();
    if (window.softRender) window.softRender();
  }

  async function send(to, data) {
    const eth = window.ethereum;
    const tx = { from: account, to: to, data: data };
    await eth.request({ method: "eth_estimateGas", params: [tx] });
    const hash = await eth.request({ method: "eth_sendTransaction", params: [tx] });
    toast("Submitted " + short(hash) + ". Waiting for the receipt.");
    for (let i = 0; i < 45; i++) {
      const rec = await rpc("eth_getTransactionReceipt", [hash]);
      if (rec) {
        if (rec.status === "0x0") throw new Error("Transaction reverted.");
        return hash;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error("Still pending. Hash " + hash);
  }

  async function ready(action) {
    if (busy) return false;
    const g = await ensureGeo();
    if (g.blocked) { toast(g.notice); paint(); if (window.softRender) window.softRender(); return false; }
    if (!cfg) { toast("config/testnet-v3.json did not load."); return false; }
    if (!configured()) { toast(missing(action === "faucet" ? "usdc" : "registry")); return false; }
    if (!window.ethereum) { toast("No injected wallet in this browser."); return false; }
    if (!live()) { toast("Connect a wallet on " + chainLabel() + "."); return false; }
    return true;
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
        ? "One pending order per wallet. Cancel it (the " + view.feeText + " fee is kept) or wait for the next settle."
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
      busy = true;
      try {
        const assets = await assetsFor(market);
        await send(market, V3.encodeBuy(sideN, raw, assets));
        toast("Committed " + V3.formatUnits(raw) + " USDC → " + (side === "T" ? "TAIL" : "FADE") + ". Fills at next settle (~10–20 min).");
        await refresh();
      } catch (e) { toast(explain(e)); }
      finally { busy = false; }
      return;
    }
    const raw = shares[tk + ":" + side] || 0n;
    if (raw === 0n) return toast("Nothing to sell.");
    if (st === "uninitialized") return toast("This market is not open.");
    busy = true;
    try {
      const assets = await assetsFor(market);
      await send(market, V3.encodeSell(sideN, raw, assets));
      toast("Committed a sell. Fills at next settle (~10–20 min). USDC returns to your withdrawable balance.");
      await refresh();
    } catch (e) { toast(explain(e)); }
    finally { busy = false; }
  }

  async function cancel(tk) {
    if (!(await ready("bet"))) return;
    const market = marketOf(tk);
    if (!market) return toast(missingMarket(tk));
    const pend = view.pending[tk];
    if (!pend || !pend.legs.length) return toast("No pending order on this coin.");
    if (!pend.canCancel) return toast("The settle window is open, so this order can no longer be cancelled. Claim it to fill.");
    const ok = window.confirm("Cancel this order? A " + view.feeText + " fee is kept. The rest comes back to your withdrawable balance.");
    if (!ok) return;
    busy = true;
    try {
      await send(market, V3.SEL.cancel);
      toast("Cancelled. The " + view.feeText + " fee was kept.");
      await refresh();
    } catch (e) { toast(explain(e)); }
    finally { busy = false; }
  }

  async function claim(tk) {
    if (!(await ready("bet"))) return;
    const market = marketOf(tk);
    if (!market) return toast(missingMarket(tk));
    busy = true;
    try {
      const assets = await assetsFor(market);
      await send(market, V3.encodeClaim(assets));
      toast("Claimed. A due market was sampled, and your fill was applied.");
      await refresh();
    } catch (e) { toast(explain(e)); }
    finally { busy = false; }
  }

  async function exit(tk) {
    if (!(await ready("bet"))) return;
    const market = marketOf(tk);
    if (!market) return toast(missingMarket(tk));
    if (!redeemOpen()) return toast(pauseNote() || "Pro-rata redeem is not open yet.");
    busy = true;
    try {
      await send(market, V3.SEL.exitAtLastNav);
      toast("Redeemed pro-rata into your withdrawable balance.");
      await refresh();
    } catch (e) { toast(explain(e)); }
    finally { busy = false; }
  }

  async function approve() {
    if (!(await ready("deposit"))) return;
    const raw = amountFrom("depAmt");
    if (raw == null || raw === 0n) return toast("Enter a USDC amount to approve.");
    if (allowance >= raw) return toast("USDC is already approved for this amount. You can deposit.");
    busy = true;
    try {
      await send(cfg.usdc, V3.encodeAddrUint(V3.SEL.approve, cfg.registry, raw));
      toast("Approved " + V3.formatUnits(raw) + " USDC for the registry. Deposit is the next step.");
      await refresh();
    } catch (e) { toast(explain(e)); }
    finally { busy = false; }
  }

  async function deposit() {
    if (!(await ready("deposit"))) return;
    const raw = amountFrom("depAmt");
    if (raw == null || raw === 0n) return toast("Enter a USDC amount to deposit.");
    if (allowance < raw) return toast("Approve USDC for the registry first.");
    if (raw > walletBal) return toast("Not enough USDC in the wallet.");
    busy = true;
    try {
      await send(cfg.registry, V3.encodeUint(V3.SEL.deposit, raw));
      toast("Deposited " + V3.formatUnits(raw) + " USDC. It is now withdrawable, and you can bet it.");
      await refresh();
    } catch (e) { toast(explain(e)); }
    finally { busy = false; }
  }

  async function withdraw() {
    if (!(await ready("withdraw"))) return;
    const raw = amountFrom("wdAmt");
    if (raw == null || raw === 0n) return toast("Enter a USDC amount to withdraw.");
    if (raw > withdrawable) return toast("That is more than your withdrawable balance.");
    busy = true;
    try {
      await send(cfg.registry, V3.encodeUint(V3.SEL.withdraw, raw));
      toast("Withdrew " + V3.formatUnits(raw) + " USDC to your wallet.");
      await refresh();
    } catch (e) { toast(explain(e)); }
    finally { busy = false; }
  }

  async function faucet() {
    if (!(await ready("faucet"))) return;
    if (!cfg.faucet) return toast("The faucet is only on testnet.");
    if (!V3.isSet(cfg.usdc)) return toast(missing("usdc"));
    const amt = V3.faucetRaw(cfg.faucetAmount);
    busy = true;
    try {
      await send(cfg.usdc, V3.encodeUint(V3.SEL.faucet, amt));
      toast("Sent " + V3.formatUnits(amt) + " tUSDC to your wallet. At most 1,000 per call. It is not mainnet USDC.");
      await refresh();
    } catch (e) { toast(explain(e)); }
    finally { busy = false; }
  }

  async function optOut(whale) {
    const g = await ensureGeo();
    if (g.blocked) return toast(g.notice);
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
    try {
      const sig = await eth.request({ method: "eth_signTypedData_v4", params: [account, JSON.stringify(typed)] });
      const hex = sig.replace(/^0x/, "");
      const data = V3.SEL.optOut + V3.addrWord(whale) + V3.word(64) + V3.word(hex.length / 2) + hex.padEnd(Math.ceil(hex.length / 64) * 64, "0");
      await send(cfg.registry, data);
      toast("Opt-out submitted. Buys refund. Sells still fill at the frozen NAV.");
      await refresh();
    } catch (e) { toast(explain(e)); }
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
  };
  window.optOutWhale = (whale) => optOut(whale);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => attach());
  else attach();
})();
