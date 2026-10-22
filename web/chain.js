/**
 * whalewallet.fun Season 0 chain adapter.
 *
 * Pots are read from the public HyperEVM testnet RPC for everyone. A wallet
 * is required only to claim points and place orders. If that read fails, the
 * page keeps the in-browser demo and says so. Points are play points. There
 * is no cash withdraw. Chain id other than 998 is refused.
 */
(function () {
  const ZERO = "0x0000000000000000000000000000000000000000";
  const CHAIN_ID = 998;
  const CHAIN_HEX = "0x3e6";
  const UNIT = 1000000n;
  const SEL = {
    claimSeason0: "0x25a19018",
    points: "0x358b8166",
    claimed: "0xc884ef83",
    queueBuy: "0x529415df",
    queueSell: "0x31582f21",
    cancel: "0x40e58ee5",
    optOut: "0x55194ee5",
    tailPot: "0x2b2dc7c8",
    fadePot: "0xe52d1e6d",
    tailSupply: "0xb5f88e82",
    fadeSupply: "0x801e66b7",
    tailShares: "0x1071556e",
    fadeShares: "0x8fb6accf",
    eRef: "0x7d36cfb7",
    status: "0x200d2ed2",
    lastSettleTs: "0xe89da2f3",
    settleCount: "0xc577eca1",
    lastPnl: "0x0acd92a2",
    lastAppliedRBps: "0xbb51cdde",
    lastDelta: "0x23ee6a9b",
    paused: "0x5c975abb",
    orderCount: "0x2453ffa8",
    orders: "0xa85c38ef",
  };
  const STATUS = ["uninitialized", "sleeping", "active", "opt-out", "redeem"];

  let cfg = null;
  let account = null;
  let onTestnet = false;
  let claimed = false;
  let pointsRaw = 0n;
  let shares = {};
  let demoSnap = null;
  let basis = {};
  let busy = false;
  let potsLive = false;
  let potsFailed = false;

  function $(s) { return document.querySelector(s); }
  function toast(m) { if (window.toast) window.toast(m); }
  function configured() {
    return !!(cfg && cfg.registry && cfg.registry.toLowerCase() !== ZERO);
  }
  function live() { return configured() && !!account && onTestnet; }
  function potsOk() { return potsLive; }
  function marketOf(tk) {
    if (!cfg || !cfg.wallets) return null;
    const row = cfg.wallets.find((w) => w.ticker === tk);
    if (!row || !row.market || row.market.toLowerCase() === ZERO) return null;
    return row.market;
  }
  function whaleOf(tk) {
    const local = window.byTk && window.byTk[tk];
    return local ? local.addr : null;
  }

  function word(n) { return BigInt(n).toString(16).padStart(64, "0"); }
  function addr(a) { return a.toLowerCase().replace(/^0x/, "").padStart(64, "0"); }
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
  function num(x) { return Number(x); }
  function short(a) { return a.slice(0, 6) + "…" + a.slice(-4); }
  function explain(e) {
    const m = (e && e.message) ? e.message : String(e);
    if (/4001|rejected|denied/i.test(m)) return "Wallet request rejected.";
    const line = m.split("\n")[0];
    return line.length > 180 ? line.slice(0, 180) + "…" : line;
  }

  async function rpc(method, params) {
    const res = await fetch(cfg.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const body = await res.json();
    if (body.error) throw new Error(body.error.message || "rpc error");
    return body.result;
  }

  // The testnet RPC rejects a JSON-RPC batch above 20 ("Exceeded max limit of 20").
  async function batch(items) {
    const out = new Array(items.length);
    const limit = 20;
    for (let i = 0; i < items.length; i += limit) {
      const slice = items.slice(i, i + limit);
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

  function callData(sel, tail) { return sel + (tail || ""); }

  async function ensureChain(eth) {
    try {
      await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_HEX }] });
    } catch (e) {
      const code = e && (e.code || (e.data && e.data.originalError && e.data.originalError.code));
      if (code !== 4902 && !/4902|unrecognized chain/i.test(String(e && e.message))) throw e;
      await eth.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: CHAIN_HEX,
          chainName: cfg.name || "HyperEVM Testnet",
          nativeCurrency: cfg.nativeCurrency || { name: "HYPE", symbol: "HYPE", decimals: 18 },
          rpcUrls: [cfg.rpcUrl],
          blockExplorerUrls: cfg.explorer ? [cfg.explorer] : [],
        }],
      });
    }
    const hex = await eth.request({ method: "eth_chainId" });
    if (Number.parseInt(hex, 16) !== CHAIN_ID) throw new Error("Wallet is not on HyperEVM testnet (chain 998).");
    onTestnet = true;
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

  function paint() {
    const btn = $("#connectBtn");
    if (btn) {
      btn.textContent = live() ? short(account) : "Connect wallet";
      btn.title = live() ? "Disconnect" : "Connect an injected wallet on HyperEVM testnet to trade";
    }
    let claim = $("#claimBtn");
    if (live() && !claimed) {
      if (!claim) {
        claim = document.createElement("button");
        claim.id = "claimBtn";
        claim.className = "mini by";
        claim.textContent = "Claim 10,000 pts";
        claim.onclick = () => claimPts();
        $("#connectBtn").after(claim);
      }
    } else if (claim) claim.remove();
    const banner = document.querySelector(".poc div");
    if (banner) {
      banner.textContent = live()
        ? "SEASON 0 TESTNET — play points on HyperEVM chain 998. Sell returns points to your balance at the next settlement. No cash value."
        : potsLive
          ? "SEASON 0 TESTNET — live pots on HyperEVM chain 998. Connect a wallet to trade. Play points, no cash value."
          : potsFailed
            ? "Could not read the testnet pots, so this page is the browser simulation. Play points, not money."
            : "PROOF OF CONCEPT — play points, not money. No wallet connected: pots stay simulated in this browser.";
    }
    const notice = document.getElementById("testnetNotice");
    if (notice) {
      notice.textContent = live()
        ? "TESTNET — you are on the HyperEVM testnet pots. Curated cards still show mainnet positions, so those settlements stay at PnL 0. Testnet-only whales, such as DEMO, are read from the testnet book the keeper settles."
        : potsLive
          ? "TESTNET — these pots are the live HyperEVM testnet pots (chain 998). Connect a wallet to claim points and place orders. Curated cards still show Hyperliquid mainnet positions, so those settlements stay at PnL 0. A whale flagged testnet-only, such as DEMO, is read from the testnet book."
          : potsFailed
            ? "Could not read the testnet pots, so this page is the browser simulation. Curated cards still show Hyperliquid mainnet positions."
            : "TESTNET — curated cards show Hyperliquid mainnet positions. Those whales are flat on testnet, so their on-chain PnL is 0. A whale flagged testnet-only, such as DEMO, is read from the testnet book instead. Without a connected wallet the pots on this page are still the browser simulation.";
    }
  }

  async function attach() {
    try {
      const res = await fetch("./deployments.json", { cache: "no-store" });
      if (res.ok) cfg = await res.json();
    } catch (e) { /* demo mode */ }
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
        else if (live()) { account = xs[0]; refresh().catch((e) => toast(explain(e))); }
      });
      eth.on("chainChanged", () => {
        if (account) connect().catch((e) => toast(explain(e)));
      });
    }
    paint();
  }

  async function connect() {
    if (live()) return disconnect();
    const eth = window.ethereum;
    if (!eth) return toast("No injected wallet in this browser. Staying in the demo.");
    if (!configured()) return toast("No testnet deployment in deployments.json yet. Staying in the demo.");
    try {
      const accounts = await eth.request({ method: "eth_requestAccounts" });
      await ensureChain(eth);
      snapshotDemo();
      account = accounts[0];
      toast("Connected " + short(account) + " on HyperEVM testnet.");
      await refresh();
    } catch (e) {
      onTestnet = false;
      account = null;
      toast(explain(e) + " Staying in the demo.");
      paint();
    }
  }

  function disconnect() {
    account = null;
    onTestnet = false;
    claimed = false;
    pointsRaw = 0n;
    shares = {};
    basis = {};
    restoreDemo();
    if (window.S) window.S.w && Object.values(window.S.w).forEach((x) => { x.chainSeen = 0; });
    toast(potsLive ? "Disconnected. Pots stay on the HyperEVM testnet read." : "Back to the simulated demo.");
    paint();
    if (window.softRender) window.softRender();
  }

  const POT_CALLS = ["tailPot", "fadePot", "tailSupply", "fadeSupply", "eRef", "status", "lastSettleTs", "settleCount", "lastPnl", "lastAppliedRBps", "lastDelta", "paused"];

  async function refreshPots() {
    if (!configured() || !window.S || !window.WALLETS) {
      potsLive = false;
      return false;
    }
    const tks = [];
    const jobs = [];
    for (const w of window.WALLETS) {
      const m = marketOf(w.tk);
      if (!m) continue;
      tks.push(w.tk);
      for (const name of POT_CALLS) jobs.push({ to: m, data: SEL[name] });
    }
    if (!tks.length) {
      potsFailed = true;
      potsLive = false;
      return false;
    }
    try {
      const chainHex = await rpc("eth_chainId", []);
      if (Number.parseInt(chainHex, 16) !== CHAIN_ID) {
        throw new Error("refusing chain id " + chainHex + "; pots are HyperEVM testnet 998 only");
      }
      const rows = await batch(jobs);
      const per = POT_CALLS.length;
      const parsed = [];
      for (let i = 0; i < tks.length; i++) {
        const b = i * per;
        for (let k = 0; k < per; k++) {
          const row = rows[b + k];
          if (!row || row.error || row.result == null) {
            throw new Error((row && row.error && row.error.message) || "pot read failed");
          }
        }
        const take = (k) => wordsOf(rows[b + k].result);
        parsed.push({
          tk: tks[i],
          tailPot: u256(take(0)[0]),
          fadePot: u256(take(1)[0]),
          tailSup: u256(take(2)[0]),
          fadeSup: u256(take(3)[0]),
          eRef: u256(take(4)[0]),
          status: num(u256(take(5)[0] || "0")),
          lastTs: num(u256(take(6)[0] || "0")),
          count: num(u256(take(7)[0] || "0")),
          pnl: i256(take(8)[0] || "0"),
          bps: i256(take(9)[0] || "0"),
          delta: i256(take(10)[0] || "0"),
          paused: u256(take(11)[0] || "0") !== 0n,
        });
      }
      for (const p of parsed) {
        const x = window.S.w[p.tk];
        if (!x) continue;
        x.T = num(p.tailPot) / 1e6;
        x.F = num(p.fadePot) / 1e6;
        x.supT = num(p.tailSup) / 1e6;
        x.supF = num(p.fadeSup) / 1e6;
        if (p.eRef > 0n) x.eRef = num(p.eRef) / 1e6;
        x.chainStatus = STATUS[p.status] || "unknown";
        x.chainPaused = p.paused;
        x.lastR = num(p.bps) / 10000;
        if (p.count > (x.chainSeen || 0)) {
          x.settle.unshift({ t: (p.lastTs || Math.floor(Date.now() / 1000)) * 1000, pnl: num(p.pnl) / 1e6, r: x.lastR, rc: x.lastR, d: num(p.delta) / 1e6 });
          if (x.settle.length > 100) x.settle.pop();
          x.chainSeen = p.count;
        }
        const due = p.lastTs ? (p.lastTs + 60) * 1000 : 0;
        if (due > Date.now() + 1000) window.S.nextSettle = Math.min(window.S.nextSettle || due, due);
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

  async function refreshUser() {
    const reg = cfg.registry;
    const user = addr(account);
    const jobs = [
      { to: reg, data: callData(SEL.points, user) },
      { to: reg, data: callData(SEL.claimed, user) },
    ];
    const markets = [];
    for (const w of window.WALLETS) {
      const m = marketOf(w.tk);
      if (!m) continue;
      markets.push({ tk: w.tk, market: m, base: jobs.length });
      jobs.push(
        { to: m, data: callData(SEL.tailShares, user) },
        { to: m, data: callData(SEL.fadeShares, user) },
        { to: m, data: SEL.orderCount },
      );
    }
    const rows = await batch(jobs);
    const pw = wordsOf(rows[0] && rows[0].result);
    const cw = wordsOf(rows[1] && rows[1].result);
    pointsRaw = pw.length ? u256(pw[0]) : 0n;
    claimed = cw.length ? u256(cw[0]) !== 0n : false;
    window.U.pts = num(pointsRaw / UNIT);
    window.U.deposited = claimed ? 10000 : 0;
    window.U.hold = {};
    window.U.queue = [];
    shares = {};
    for (const row of markets) {
      const take = (k) => wordsOf(rows[row.base + k] && rows[row.base + k].result);
      const tailSh = u256(take(0)[0] || "0");
      const fadeSh = u256(take(1)[0] || "0");
      const nOrders = num(u256(take(2)[0] || "0"));
      shares[row.tk + ":T"] = tailSh;
      shares[row.tk + ":F"] = fadeSh;
      if (tailSh > 0n) window.U.hold[row.tk + ":T"] = hold(row.tk, "T", tailSh);
      if (fadeSh > 0n) window.U.hold[row.tk + ":F"] = hold(row.tk, "F", fadeSh);
      if (nOrders > 0 && nOrders <= 64) await loadOrders(row.market, row.tk, nOrders);
    }
  }

  async function refresh() {
    if (!window.S || !window.WALLETS) return;
    try {
      const ok = await refreshPots();
      if (ok && live() && window.U) await refreshUser();
    } catch (e) {
      console.warn(e);
    }
    paint();
    if (window.softRender) window.softRender();
  }

  function hold(tk, side, raw) {
    const tok = num(raw) / 1e6;
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
      basis[key] = { tok, cost };
    }
    return basis[key];
  }

  async function loadOrders(market, tk, n) {
    const jobs = [];
    for (let i = 0; i < n; i++) jobs.push({ to: market, data: callData(SEL.orders, word(i)) });
    const rows = await batch(jobs);
    const me = account.toLowerCase();
    rows.forEach((row, i) => {
      const wds = wordsOf(row && row.result);
      if (wds.length < 6) return;
      const user = "0x" + wds[0].slice(24);
      const open = u256(wds[5]) !== 0n;
      if (!open || user.toLowerCase() !== me) return;
      const side = u256(wds[1]) === 0n ? "T" : "F";
      const isBuy = u256(wds[2]) !== 0n;
      if (isBuy) window.U.queue.push({ tk, side, kind: "buy", amt: num(u256(wds[3]) / UNIT), id: i, t: Date.now() });
      else window.U.queue.push({ tk, side, kind: "sell", tok: num(u256(wds[4]) / UNIT), id: i, t: Date.now() });
    });
  }

  async function send(to, data) {
    const eth = window.ethereum;
    const tx = { from: account, to, data };
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

  async function claimPts() {
    if (!live() || busy) return;
    busy = true;
    try {
      await send(cfg.registry, SEL.claimSeason0);
      toast("Claimed 10,000 play points.");
      await refresh();
    } catch (e) { toast(explain(e)); }
    finally { busy = false; }
  }

  async function order(tk, side, kind) {
    if (!live() || busy) return;
    const market = marketOf(tk);
    if (!market) return toast("This wallet is not listed on the testnet deployment.");
    const x = window.S.w[tk];
    if (x.chainPaused) return toast("This market is paused.");
    const sideN = side === "T" ? 0 : 1;
    busy = true;
    try {
      if (kind === "buy") {
        if (x.chainStatus !== "active" && x.chainStatus !== "sleeping") return toast("Buys are closed on this market.");
        const input = document.getElementById("amt");
        const amt = BigInt(Math.floor(Number(input && input.value || "0")));
        if (amt <= 0n) return toast("Enter an amount.");
        const raw = amt * UNIT;
        if (raw > pointsRaw) return toast("Not enough play points.");
        await send(market, callData(SEL.queueBuy, word(sideN) + word(raw)));
        toast("Queued " + amt.toString() + " pts → " + (side === "T" ? "TAIL" : "FADE") + ". Fills at the next settlement.");
      } else {
        const raw = shares[tk + ":" + side] || 0n;
        if (raw === 0n) return toast("Nothing to sell.");
        await send(market, callData(SEL.queueSell, word(sideN) + word(raw)));
        toast("Queued a sell. Points return to your balance at the next settlement. There is no cash withdraw.");
      }
      await refresh();
    } catch (e) { toast(explain(e)); }
    finally { busy = false; }
  }

  async function cancel(id) {
    if (!live() || busy) return;
    const route = (location.hash || "").match(/#\/w\/([^?]+)/i);
    const tk = route ? route[1].toUpperCase() : null;
    const market = tk && marketOf(tk);
    if (!market) return toast("Open the coin to cancel its order.");
    busy = true;
    try {
      await send(market, callData(SEL.cancel, word(id)));
      toast("Cancelled. A buy's points are back in your balance.");
      await refresh();
    } catch (e) { toast(explain(e)); }
    finally { busy = false; }
  }

  async function optOut(whale) {
    if (!live()) return toast("Connect the whale's own wallet on HyperEVM testnet to opt out. In the demo this is disabled.");
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
      domain: { name: "whalewallet.fun", version: "1", chainId: CHAIN_ID, verifyingContract: cfg.registry },
      message: { wallet: whale },
    };
    try {
      const sig = await eth.request({ method: "eth_signTypedData_v4", params: [account, JSON.stringify(typed)] });
      const hex = sig.replace(/^0x/, "");
      const data = SEL.optOut + addr(whale) + word(64) + word(hex.length / 2) + hex.padEnd(Math.ceil(hex.length / 64) * 64, "0");
      await send(cfg.registry, data);
      toast("Opt-out submitted. Buys refund now. One more settlement, then sells only.");
      await refresh();
    } catch (e) { toast(explain(e)); }
  }

  window.WW = {
    live, potsLive: potsOk, potsFailed() { return potsFailed; }, attach, connect, refresh, order, cancel, optOut, paint,
    registryShort() { return configured() ? short(cfg.registry) : "not deployed"; },
    config() { return cfg; },
  };
  window.optOutWhale = (whale) => optOut(whale);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => attach());
  else attach();
})();
