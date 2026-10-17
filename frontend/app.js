/* =====================================================================
   FixFlow frontend - vanilla JS + ethers v6 (window.ethers, UMD build)
   - Read-only calls go through MetaMask when it is connected to the right
     chain, otherwise through config.READ_RPC_URL. Reads never ask for a
     signature.
   - State-changing calls are signed by the connected MetaMask account and
     are reported as successful only after the receipt confirms status 1.
   ===================================================================== */
(() => {
  "use strict";

  const { ethers } = window;
  const CONFIG = window.FIXFLOW_CONFIG || {};

  const STATUS = ["None", "Open", "Accepted", "Completed", "Disputed", "Released", "Cancelled", "Refunded", "Resolved"];
  const S = Object.fromEntries(STATUS.map((name, i) => [name, i]));
  const RESOLUTION = ["None", "Paid to technician", "Refunded to tenant", "50/50 split", "Default 50/50 split (timeout)"];
  const ACTIVE = new Set([S.Open, S.Accepted, S.Completed, S.Disputed]);
  const DONE = new Set([S.Released, S.Resolved]);

  // Friendly explanations for the contract's revert strings.
  const REVERT_HELP = {
    "caller is not the admin": "Only the contract administrator can manage roles.",
    "caller is not an arbitrator": "Only an authorized arbitrator can resolve disputes.",
    "caller is not the tenant": "Only the tenant who created this request can do this.",
    "caller is not the assigned technician": "Only the technician assigned to this request can do this.",
    "caller is not a party to this request": "Only the tenant or technician of this request can do this.",
    "arbitrator is a party to this request": "An arbitrator cannot resolve a dispute they are involved in.",
    "request id already exists": "That request ID is already used. Choose another ID.",
    "id must be non-zero": "The request ID must be 1 or higher.",
    "request does not exist": "This request does not exist on the contract.",
    "invalid request status": "This action is not allowed in the request's current state.",
    "deposit must equal the agreed amount": "The ETH sent must exactly equal the agreed amount.",
    "amount must be greater than zero": "The amount must be greater than zero.",
    "deadline must be in the future": "The deadline must be in the future.",
    "deadline too far in the future": "The deadline can be at most 365 days away.",
    "deadline has passed": "The deadline has already passed.",
    "deadline has not passed": "The deadline has not passed yet.",
    "technician is not authorized": "The selected address is not an authorized technician.",
    "technician authorization revoked": "Your technician authorization has been revoked by the admin.",
    "tenant cannot be the technician": "You cannot assign yourself as the technician.",
    "invalid description length": "The description must be 1-280 bytes.",
    "invalid reason length": "The dispute reason must be 1-280 bytes.",
    "review period has ended": "The review period is over; disputes are no longer possible.",
    "review period not over": "The tenant's review period has not ended yet.",
    "dispute timeout not reached": "The arbitrator still has time to resolve this dispute.",
    "invalid resolution": "Invalid resolution option.",
    "nothing to withdraw": "You have no funds to withdraw.",
    "ETH transfer failed": "The ETH transfer to your address failed. Your balance is unchanged.",
    "already a technician": "This address is already an authorized technician.",
    "not a technician": "This address is not an authorized technician.",
    "already an arbitrator": "This address is already an authorized arbitrator.",
    "not an arbitrator": "This address is not an authorized arbitrator.",
    "zero address": "The zero address is not allowed.",
  };

  // ------------------------------------------------------------------
  // State
  // ------------------------------------------------------------------
  const state = {
    browserProvider: null,
    signer: null,
    account: null,
    walletChainId: null,
    readProvider: null,
    readContract: null,
    dataSource: "",
    requests: [],
    histories: new Map(),
    logs: [],
    blockTimes: new Map(),
    stats: null,
    me: { isAdmin: false, isTechnician: false, isArbitrator: false, pending: 0n },
    technicians: [],
    arbitrators: [],
    filter: "all",
    search: "",
    openRequestId: null,
    busy: false,
    loading: null,
  };

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = (v) =>
    String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "–");
  const same = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
  const nowSec = () => Math.floor(Date.now() / 1000);
  const fmtEth = (wei) => {
    const s = ethers.formatEther(wei);
    const [i, d = ""] = s.split(".");
    const dec = d.replace(/0+$/, "").slice(0, 6);
    return `${i}${dec ? "." + dec : ""} ETH`;
  };
  const fmtDate = (sec) =>
    sec ? new Date(Number(sec) * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "–";
  const fmtDuration = (sec) => {
    sec = Math.abs(Number(sec));
    if (sec < 60) return `${sec}s`;
    if (sec < 3600) return `${Math.round(sec / 60)} min`;
    if (sec < 86400) return `${(sec / 3600).toFixed(1).replace(/\.0$/, "")} h`;
    return `${(sec / 86400).toFixed(1).replace(/\.0$/, "")} days`;
  };
  const relTime = (sec) => {
    const diff = Number(sec) - nowSec();
    return diff >= 0 ? `in ${fmtDuration(diff)}` : `${fmtDuration(diff)} ago`;
  };
  const badge = (status) => `<span class="badge badge-${STATUS[status].toLowerCase()}">${STATUS[status]}</span>`;
  const isConfigured = () => ethers.isAddress(CONFIG.CONTRACT_ADDRESS || "") && Array.isArray(CONFIG.CONTRACT_ABI) && CONFIG.CONTRACT_ABI.length > 0;
  const onRightChain = () => state.walletChainId === BigInt(CONFIG.CHAIN_ID);

  // ------------------------------------------------------------------
  // Toasts & banners
  // ------------------------------------------------------------------
  function toast(kind, title, body = "", { sticky = false, hash } = {}) {
    const el = document.createElement("div");
    el.className = `toast ${kind}`;
    el.setAttribute("role", kind === "error" ? "alert" : "status");
    el.innerHTML = `<strong>${esc(title)}</strong>${body ? `<div>${esc(body)}</div>` : ""}${
      hash ? `<div class="mono">Tx: ${esc(hash)}</div>` : ""
    }<button class="icon-btn toast-close" aria-label="Dismiss">✕</button>`;
    el.querySelector(".toast-close").onclick = () => el.remove();
    const box = $("#toasts");
    box.prepend(el);
    raiseToasts();
    if (!sticky) setTimeout(() => el.remove(), kind === "error" ? 12000 : 7000);
    return {
      update(kind2, title2, body2 = "", opts = {}) {
        el.remove();
        return toast(kind2, title2, body2, opts);
      },
      remove: () => el.remove(),
    };
  }

  // Re-open the toast popover so it is the topmost top-layer element (above an open <dialog>).
  function raiseToasts() {
    const box = $("#toasts");
    if (typeof box.showPopover !== "function") return;
    try {
      if (box.matches(":popover-open")) box.hidePopover();
      box.showPopover();
    } catch (_) { /* popover unsupported - falls back to fixed positioning */ }
  }

  function renderBanners() {
    const banners = [];
    if (!isConfigured()) {
      banners.push({
        kind: "warning",
        html: "<strong>Contract not configured.</strong> Deploy <code>FixFlow.sol</code> with Remix, then set <code>CONTRACT_ADDRESS</code> (and the ABI) in <code>frontend/config.js</code>. See <code>deployment/deployment-info.md</code>.",
      });
    }
    if (!window.ethereum) {
      banners.push({ kind: "warning", html: "<strong>MetaMask not detected.</strong> Install the MetaMask extension to send transactions. Data is shown read-only from the configured RPC." });
    } else if (!state.account) {
      banners.push({ kind: "info", html: "<strong>Wallet disconnected.</strong> Connect MetaMask to create requests or perform actions. Viewing is read-only." });
    } else if (!onRightChain()) {
      banners.push({
        kind: "error",
        html: `<strong>Wrong network.</strong> MetaMask is on chain ${esc(state.walletChainId)}, but FixFlow is deployed on <strong>${esc(CONFIG.NETWORK_NAME)}</strong> (chain ${esc(CONFIG.CHAIN_ID)}). Transactions are disabled.`,
        action: { label: "Switch network", fn: switchNetwork },
      });
    }
    if (state.loadError) banners.push({ kind: "error", html: esc(state.loadError) });

    const root = $("#banners");
    root.innerHTML = "";
    for (const b of banners) {
      const div = document.createElement("div");
      div.className = `banner banner-${b.kind}`;
      div.innerHTML = `<span>${b.html}</span>`;
      if (b.action) {
        const btn = document.createElement("button");
        btn.className = "btn btn-sm btn-ghost";
        btn.textContent = b.action.label;
        btn.onclick = b.action.fn;
        div.append(btn);
      }
      root.append(div);
    }
  }

  // ------------------------------------------------------------------
  // Error decoding
  // ------------------------------------------------------------------
  function collectStrings(err) {
    const out = [];
    const seen = new Set();
    (function walk(v, depth) {
      if (v == null || depth > 8) return;
      if (typeof v === "string") return void out.push(v);
      if (typeof v !== "object" || seen.has(v)) return;
      seen.add(v);
      for (const k of Object.keys(v)) walk(v[k], depth + 1);
    })(err, 0);
    if (err && err.message) out.push(err.message);
    return out;
  }

  function extractRevertReason(err) {
    if (err && err.reason && typeof err.reason === "string") return err.reason.replace(/^FixFlow: /, "");
    const strings = collectStrings(err);
    for (const s of strings) {
      const m = s.match(/FixFlow: ([^"\\|\n]+)/);
      if (m) return m[1].trim();
    }
    // ABI-encoded Error(string): 0x08c379a0...
    for (const s of strings) {
      const m = s.match(/0x08c379a0[0-9a-fA-F]+/);
      if (m) {
        try {
          const [reason] = ethers.AbiCoder.defaultAbiCoder().decode(["string"], "0x" + m[0].slice(10));
          return reason.replace(/^FixFlow: /, "");
        } catch (_) { /* ignore */ }
      }
    }
    return null;
  }

  function explainError(err) {
    const code = err?.code ?? err?.info?.error?.code ?? err?.error?.code;
    if (code === "ACTION_REJECTED" || code === 4001) {
      return { title: "Transaction rejected", body: "You rejected the request in MetaMask. Nothing was sent to the blockchain." };
    }
    const reason = extractRevertReason(err);
    if (reason) {
      return { title: "Transaction reverted by the contract", body: `${REVERT_HELP[reason] || reason} (FixFlow: ${reason})` };
    }
    const text = collectStrings(err).join(" ").toLowerCase();
    if (text.includes("insufficient funds")) return { title: "Insufficient funds", body: "Your account does not have enough ETH for the amount plus gas." };
    if (text.includes("nonce")) {
      return { title: "Nonce mismatch", body: "MetaMask's nonce is out of sync (common after restarting Ganache). In MetaMask: Settings → Advanced → Clear activity tab data, then retry." };
    }
    if (code === "CALL_EXCEPTION") return { title: "Transaction reverted", body: "The contract rejected this call (no reason string returned)." };
    if (code === "NETWORK_ERROR" || text.includes("failed to fetch")) {
      return { title: "Network error", body: "Cannot reach the blockchain node. Is Ganache running?" };
    }
    return { title: "Transaction failed", body: err?.shortMessage || err?.message || String(err) };
  }

  // ------------------------------------------------------------------
  // Providers & wallet
  // ------------------------------------------------------------------
  function makeReadProvider() {
    if (state.browserProvider && state.account && onRightChain()) {
      state.dataSource = "MetaMask";
      return state.browserProvider;
    }
    state.dataSource = `RPC ${CONFIG.READ_RPC_URL}`;
    const network = ethers.Network.from(Number(CONFIG.CHAIN_ID));
    return new ethers.JsonRpcProvider(CONFIG.READ_RPC_URL, network, { staticNetwork: network });
  }

  function setupContracts() {
    state.readProvider = makeReadProvider();
    $("#dataSource").textContent = state.dataSource;
    state.readContract = isConfigured()
      ? new ethers.Contract(CONFIG.CONTRACT_ADDRESS, CONFIG.CONTRACT_ABI, state.readProvider)
      : null;
  }

  async function syncWallet() {
    if (!window.ethereum) return;
    state.browserProvider = new ethers.BrowserProvider(window.ethereum, "any");
    const [accounts, chainHex] = await Promise.all([
      window.ethereum.request({ method: "eth_accounts" }),
      window.ethereum.request({ method: "eth_chainId" }),
    ]);
    state.walletChainId = BigInt(chainHex);
    state.account = accounts[0] ? ethers.getAddress(accounts[0]) : null;
    state.signer = state.account ? await state.browserProvider.getSigner(state.account) : null;
  }

  async function connectWallet() {
    if (!window.ethereum) {
      toast("error", "MetaMask not found", "Install MetaMask and reload this page.");
      return;
    }
    const btn = $("#connectBtn");
    btn.disabled = true;
    try {
      await window.ethereum.request({ method: "eth_requestAccounts" });
      await syncWallet();
      toast("success", "Wallet connected", short(state.account));
      await refresh();
    } catch (err) {
      const e = explainError(err);
      toast("error", err?.code === 4001 ? "Connection rejected" : e.title, err?.code === 4001 ? "You declined the MetaMask connection request." : e.body);
    } finally {
      btn.disabled = false;
      renderWallet();
    }
  }

  async function switchNetwork() {
    const chainId = "0x" + Number(CONFIG.CHAIN_ID).toString(16);
    try {
      await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
    } catch (err) {
      if (err?.code === 4902) {
        try {
          await window.ethereum.request({
            method: "wallet_addEthereumChain",
            params: [{ chainId, chainName: CONFIG.NETWORK_NAME, rpcUrls: [CONFIG.READ_RPC_URL], nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 } }],
          });
        } catch (e2) {
          toast("error", "Could not add network", explainError(e2).body);
        }
      } else {
        toast("error", "Could not switch network", explainError(err).body);
      }
    }
  }

  function renderWallet() {
    const net = $("#networkPill");
    const acct = $("#accountPill");
    const btn = $("#connectBtn");
    if (!window.ethereum) {
      net.className = "pill pill-muted";
      net.textContent = "No MetaMask";
    } else if (state.walletChainId != null) {
      const ok = onRightChain();
      net.className = `pill ${ok ? "pill-ok" : "pill-bad"}`;
      net.textContent = ok ? `${CONFIG.NETWORK_NAME} (${state.walletChainId})` : `Wrong network (${state.walletChainId})`;
    }
    if (state.account) {
      acct.hidden = false;
      acct.textContent = short(state.account);
      acct.title = state.account;
      btn.hidden = true;
    } else {
      acct.hidden = true;
      btn.hidden = false;
    }
    renderBanners();
  }

  // ------------------------------------------------------------------
  // Loading contract data
  // ------------------------------------------------------------------
  async function refresh() {
    // Coalesce concurrent refreshes.
    if (state.loading) return state.loading;
    state.loading = (async () => {
      setupContracts();
      renderWallet();
      try {
        await loadContractData();
        state.loadError = null;
      } catch (err) {
        console.error(err);
        state.loadError = err.userMessage || `Could not load contract data: ${err.shortMessage || err.message}`;
      }
      renderAll();
    })();
    try {
      await state.loading;
    } finally {
      state.loading = null;
    }
  }

  async function loadContractData() {
    const c = state.readContract;
    if (!c) {
      state.requests = [];
      state.logs = [];
      return;
    }
    const code = await state.readProvider.getCode(CONFIG.CONTRACT_ADDRESS);
    if (code === "0x") {
      const e = new Error("no contract");
      e.userMessage = `No contract found at ${CONFIG.CONTRACT_ADDRESS} on ${state.dataSource}. Check CONTRACT_ADDRESS / network, or redeploy if Ganache was restarted.`;
      throw e;
    }

    const [ids, totalEscrowed, totalPending, admin, reviewPeriod, disputeTimeout, balance] = await Promise.all([
      c.getAllRequestIds(),
      c.totalEscrowed(),
      c.totalPendingWithdrawals(),
      c.admin(),
      c.reviewPeriod(),
      c.disputeTimeout(),
      state.readProvider.getBalance(CONFIG.CONTRACT_ADDRESS),
    ]);
    state.stats = { totalEscrowed, totalPending, admin, reviewPeriod: Number(reviewPeriod), disputeTimeout: Number(disputeTimeout), balance };

    const [requests, histories] = await Promise.all([
      Promise.all(ids.map((id) => c.getRequest(id))),
      Promise.all(ids.map((id) => c.getHistory(id))),
    ]);
    state.requests = requests.map(normalizeRequest);
    state.histories = new Map(ids.map((id, i) => [id.toString(), histories[i].map((h) => ({ status: Number(h.status), actor: h.actor, timestamp: Number(h.timestamp) }))]));

    if (state.account) {
      const [pending, isTech, isArb] = await Promise.all([
        c.pendingWithdrawals(state.account),
        c.isTechnician(state.account),
        c.isArbitrator(state.account),
      ]);
      state.me = { isAdmin: same(admin, state.account), isTechnician: isTech, isArbitrator: isArb, pending };
    } else {
      state.me = { isAdmin: false, isTechnician: false, isArbitrator: false, pending: 0n };
    }

    await loadLogs();
    await loadRoleLists();
  }

  function normalizeRequest(r) {
    return {
      id: r.id,
      tenant: r.tenant,
      technician: r.technician,
      amount: r.amount,
      deadline: Number(r.deadline),
      createdAt: Number(r.createdAt),
      completedAt: Number(r.completedAt),
      disputedAt: Number(r.disputedAt),
      status: Number(r.status),
      resolution: Number(r.resolution),
      resolvedBy: r.resolvedBy,
      technicianPayout: r.technicianPayout,
      tenantRefund: r.tenantRefund,
      description: r.description,
      disputeReason: r.disputeReason,
    };
  }

  async function loadLogs() {
    const iface = state.readContract.interface;
    const raw = await state.readProvider.getLogs({
      address: CONFIG.CONTRACT_ADDRESS,
      fromBlock: Number(CONFIG.DEPLOYMENT_BLOCK) || 0,
      toBlock: "latest",
    });
    state.logs = raw
      .map((log) => {
        try {
          const parsed = iface.parseLog(log);
          return parsed && { name: parsed.name, args: parsed.args, txHash: log.transactionHash, blockNumber: log.blockNumber, index: log.index };
        } catch (_) {
          return null;
        }
      })
      .filter(Boolean);

    // Block timestamps for the most recent logs (activity feed).
    const blocks = [...new Set(state.logs.slice(-40).map((l) => l.blockNumber))].filter((b) => !state.blockTimes.has(b));
    const fetched = await Promise.all(blocks.map((b) => state.readProvider.getBlock(b)));
    fetched.forEach((blk) => blk && state.blockTimes.set(blk.number, blk.timestamp));
  }

  async function loadRoleLists() {
    const techs = new Set();
    const arbs = new Set();
    for (const l of state.logs) {
      if (l.name === "TechnicianAuthorized" || l.name === "TechnicianRevoked") techs.add(l.args.account);
      if (l.name === "ArbitratorAuthorized" || l.name === "ArbitratorRevoked") arbs.add(l.args.account);
    }
    const c = state.readContract;
    const [t, a] = await Promise.all([
      Promise.all([...techs].map(async (addr) => ({ addr, active: await c.isTechnician(addr) }))),
      Promise.all([...arbs].map(async (addr) => ({ addr, active: await c.isArbitrator(addr) }))),
    ]);
    state.technicians = t;
    state.arbitrators = a;
  }

  // ------------------------------------------------------------------
  // Transactions
  // ------------------------------------------------------------------
  async function sendTx(label, buildTx, { button } = {}) {
    if (!state.account || !state.signer) {
      toast("warning", "Connect your wallet", "Connect MetaMask to send transactions.");
      return false;
    }
    if (!onRightChain()) {
      toast("error", "Wrong network", `Switch MetaMask to ${CONFIG.NETWORK_NAME} (chain ${CONFIG.CHAIN_ID}).`);
      return false;
    }
    if (!isConfigured()) {
      toast("error", "Contract not configured", "Set CONTRACT_ADDRESS in frontend/config.js.");
      return false;
    }
    if (state.busy) {
      toast("warning", "Please wait", "Another transaction is still pending.");
      return false;
    }

    state.busy = true;
    setButtonsBusy(true, button);
    const contract = new ethers.Contract(CONFIG.CONTRACT_ADDRESS, CONFIG.CONTRACT_ABI, state.signer);
    // Demo mode: fixed gas limit skips eth_estimateGas, so a revert happens on-chain.
    const overrides = $("#skipPreflight").checked ? { gasLimit: 600000n } : {};
    let t = toast("pending", `${label}: confirm in MetaMask`, "Waiting for your signature…", { sticky: true });
    let tx;
    try {
      tx = await buildTx(contract, overrides);
      t = t.update("pending", `${label}: pending`, "Waiting for the transaction to be mined…", { sticky: true, hash: tx.hash });
      const receipt = await tx.wait();
      if (!receipt || receipt.status !== 1) throw Object.assign(new Error("Transaction reverted"), { code: "CALL_EXCEPTION", receipt });
      t.update("success", `${label}: confirmed`, `Mined in block ${receipt.blockNumber}.`, { hash: tx.hash });
      state.lastTx = { label, hash: tx.hash };
      await refresh();
      return true;
    } catch (err) {
      console.error(err);
      let info = explainError(err);
      // For transactions mined with status 0, replay the call to recover the revert reason.
      if (tx && !extractRevertReason(err)) {
        try {
          await state.browserProvider.call({ to: tx.to, from: tx.from, data: tx.data, value: tx.value, blockTag: (err.receipt?.blockNumber ?? tx.blockNumber ?? 1) - 1 });
        } catch (replayErr) {
          if (extractRevertReason(replayErr)) info = explainError(replayErr);
        }
      }
      t.update("error", `${label}: ${info.title}`, info.body, { hash: tx?.hash });
      if (tx) await refresh(); // an on-chain revert still changes balances (gas)
      return false;
    } finally {
      state.busy = false;
      setButtonsBusy(false, button);
    }
  }

  function setButtonsBusy(busy, button) {
    $$("[data-tx]").forEach((b) => (b.disabled = busy));
    if (button) button.classList.toggle("is-loading", busy);
  }

  // ------------------------------------------------------------------
  // Rendering
  // ------------------------------------------------------------------
  function renderAll() {
    renderWallet();
    renderDashboard();
    renderRequests();
    renderAdmin();
    renderTechSuggestions();
    if (state.openRequestId != null && $("#requestDialog").open) renderDialog(state.openRequestId);
    suggestNextId();
  }

  function renderDashboard() {
    const reqs = state.requests;
    const st = state.stats;
    $("#statTotal").textContent = st ? reqs.length : "–";
    $("#statOpen").textContent = st ? reqs.filter((r) => ACTIVE.has(r.status)).length : "–";
    $("#statDone").textContent = st ? reqs.filter((r) => DONE.has(r.status)).length : "–";
    $("#statEscrow").textContent = st ? fmtEth(st.totalEscrowed) : "–";
    $("#statPendingAll").textContent = st ? `${fmtEth(st.totalPending)} awaiting withdrawal` : "";

    $("#cAddress").textContent = isConfigured() ? CONFIG.CONTRACT_ADDRESS : "Not configured";
    $("#cAdmin").textContent = st ? st.admin : "–";
    $("#cReview").textContent = st ? fmtDuration(st.reviewPeriod) : "–";
    $("#cDispute").textContent = st ? fmtDuration(st.disputeTimeout) : "–";
    $("#cPending").textContent = st ? fmtEth(st.totalPending) : "–";
    $("#cBalance").textContent = st ? fmtEth(st.balance) : "–";

    $("#meAddress").textContent = state.account || "Not connected";
    const roles = [];
    if (state.me.isAdmin) roles.push("Admin");
    if (state.me.isTechnician) roles.push("Technician");
    if (state.me.isArbitrator) roles.push("Arbitrator");
    if (state.account && state.requests.some((r) => same(r.tenant, state.account))) roles.push("Tenant");
    $("#meRoles").innerHTML = state.account
      ? roles.length ? roles.map((r) => `<span class="badge badge-role">${r}</span>`).join("") : '<span class="muted">Tenant (no requests yet)</span>'
      : "–";
    $("#meBalance").textContent = state.account ? fmtEth(state.me.pending) : "–";
    $("#withdrawBtn").hidden = !(state.account && state.me.pending > 0n);

    renderActivity();
  }

  function describeLog(l) {
    const a = l.args;
    const id = a.id != null ? `#${a.id}` : "";
    switch (l.name) {
      case "RequestCreated": return { cls: "", text: `Request ${id} created by ${short(a.tenant)} · ${fmtEth(a.amount)} escrowed` };
      case "RequestAccepted": return { cls: "", text: `Request ${id} accepted by ${short(a.technician)}` };
      case "RequestDeclined": return { cls: "warn", text: `Request ${id} declined by ${short(a.technician)}` };
      case "RequestCancelled": return { cls: "warn", text: `Request ${id} cancelled by tenant` };
      case "WorkCompleted": return { cls: "", text: `Request ${id} marked completed` };
      case "WorkApproved": return { cls: "ok", text: `Request ${id} approved by tenant` };
      case "DisputeRaised": return { cls: "bad", text: `Dispute raised on ${id}: "${a.reason}"` };
      case "DisputeResolved": return { cls: "ok", text: `Dispute on ${id} resolved: ${RESOLUTION[Number(a.resolution)]}` };
      case "DeadlineRefund": return { cls: "warn", text: `Request ${id} refunded after missed deadline` };
      case "ReviewPeriodPayout": return { cls: "ok", text: `Request ${id} paid after review period` };
      case "PaymentReleased": return { cls: "ok", text: `${fmtEth(a.amount)} credited to technician ${short(a.technician)} (${id})` };
      case "RefundIssued": return { cls: "warn", text: `${fmtEth(a.amount)} credited to tenant ${short(a.tenant)} (${id})` };
      case "Withdrawal": return { cls: "ok", text: `${short(a.account)} withdrew ${fmtEth(a.amount)}` };
      case "TechnicianAuthorized": return { cls: "", text: `Technician authorized: ${short(a.account)}` };
      case "TechnicianRevoked": return { cls: "bad", text: `Technician revoked: ${short(a.account)}` };
      case "ArbitratorAuthorized": return { cls: "", text: `Arbitrator authorized: ${short(a.account)}` };
      case "ArbitratorRevoked": return { cls: "bad", text: `Arbitrator revoked: ${short(a.account)}` };
      case "AdminTransferred": return { cls: "", text: `Admin set to ${short(a.newAdmin)}` };
      default: return { cls: "", text: l.name };
    }
  }

  function renderActivity() {
    const list = $("#activityList");
    const recent = state.logs.slice(-25).reverse();
    if (!recent.length) {
      list.innerHTML = '<li class="empty">No activity yet.</li>';
      return;
    }
    list.innerHTML = recent
      .map((l) => {
        const d = describeLog(l);
        const ts = state.blockTimes.get(l.blockNumber);
        return `<li><span class="dot ${d.cls}"></span><div><div>${esc(d.text)}</div><div class="meta">Block ${l.blockNumber}${ts ? " · " + esc(fmtDate(ts)) : ""} · <span class="mono" title="${esc(l.txHash)}">${esc(short(l.txHash))}</span></div></div></li>`;
      })
      .join("");
  }

  // Which actions apply to the connected account for request r.
  function availableActions(r) {
    const me = state.account;
    if (!me) return [];
    const t = nowSec();
    const isTenant = same(me, r.tenant);
    const isTech = same(me, r.technician);
    const st = state.stats || { reviewPeriod: 0, disputeTimeout: 0 };
    const acts = [];
    switch (r.status) {
      case S.Open:
        if (isTech && t <= r.deadline) acts.push("accept");
        if (isTech) acts.push("decline");
        if (isTenant) acts.push("cancel");
        if (isTenant && t > r.deadline) acts.push("refund");
        break;
      case S.Accepted:
        if (isTech && t <= r.deadline) acts.push("complete");
        if (isTenant && t > r.deadline) acts.push("refund");
        break;
      case S.Completed:
        if (isTenant) acts.push("approve");
        if (isTenant && t <= r.completedAt + st.reviewPeriod) acts.push("dispute");
        if (isTech && t > r.completedAt + st.reviewPeriod) acts.push("claim");
        break;
      case S.Disputed:
        if (state.me.isArbitrator && !isTenant && !isTech) acts.push("resolve");
        if ((isTenant || isTech) && t > r.disputedAt + st.disputeTimeout) acts.push("defaultSplit");
        break;
    }
    return acts;
  }

  function filteredRequests() {
    const me = state.account;
    const q = state.search.trim().toLowerCase();
    return state.requests
      .filter((r) => {
        switch (state.filter) {
          case "mine": return same(r.tenant, me);
          case "assigned": return same(r.technician, me);
          case "active": return ACTIVE.has(r.status);
          case "disputed": return r.status === S.Disputed;
          case "action": return availableActions(r).length > 0;
          default: return true;
        }
      })
      .filter((r) => !q || r.id.toString() === q.replace(/^#/, "") || r.description.toLowerCase().includes(q) || r.tenant.toLowerCase().includes(q) || r.technician.toLowerCase().includes(q))
      .sort((a, b) => b.createdAt - a.createdAt || Number(b.id - a.id));
  }

  function renderRequests() {
    const rows = filteredRequests();
    const tbody = $("#requestRows");
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="8" class="empty">${state.requests.length ? "No requests match this filter." : "No requests on the contract yet."}</td></tr>`;
      return;
    }
    tbody.innerHTML = rows
      .map((r) => {
        const overdue = ACTIVE.has(r.status) && r.status !== S.Completed && r.status !== S.Disputed && nowSec() > r.deadline;
        const n = availableActions(r).length;
        return `<tr data-id="${r.id}" tabindex="0">
          <td class="mono">#${r.id}</td>
          <td class="desc" title="${esc(r.description)}">${esc(r.description)}</td>
          <td class="mono" title="${esc(r.tenant)}">${esc(short(r.tenant))}${same(r.tenant, state.account) ? " (you)" : ""}</td>
          <td class="mono" title="${esc(r.technician)}">${esc(short(r.technician))}${same(r.technician, state.account) ? " (you)" : ""}</td>
          <td class="num">${esc(fmtEth(r.amount))}</td>
          <td class="${overdue ? "overdue" : ""}" title="${esc(fmtDate(r.deadline))}">${esc(fmtDate(r.deadline))}</td>
          <td>${badge(r.status)}</td>
          <td><button class="btn btn-sm ${n ? "btn-primary" : "btn-ghost"}">${n ? `${n} action${n > 1 ? "s" : ""}` : "View"}</button></td>
        </tr>`;
      })
      .join("");
  }

  function escrowStatus(r) {
    switch (r.status) {
      case S.Open: case S.Accepted: case S.Completed: return "Held in escrow";
      case S.Disputed: return "Frozen (in dispute)";
      case S.Released: return "Released to technician";
      case S.Cancelled: case S.Refunded: return "Refunded to tenant";
      case S.Resolved: return "Settled by resolution";
      default: return "–";
    }
  }

  function renderDialog(idStr) {
    const r = state.requests.find((x) => x.id.toString() === idStr);
    const body = $("#dlgBody");
    if (!r) {
      body.innerHTML = '<p class="empty">Request not found.</p>';
      return;
    }
    const st = state.stats;
    $("#dlgTitle").innerHTML = `Request #${esc(r.id)} ${badge(r.status)}`;
    const history = state.histories.get(idStr) || [];
    const txs = state.logs.filter((l) => l.args.id != null && l.args.id.toString() === idStr);

    const completion = r.completedAt ? `Completed ${fmtDate(r.completedAt)}` : r.status === S.Accepted ? "In progress" : "Not completed";
    const payment = r.technicianPayout > 0n || r.tenantRefund > 0n
      ? [r.technicianPayout > 0n && `Tech ${fmtEth(r.technicianPayout)}`, r.tenantRefund > 0n && `Tenant ${fmtEth(r.tenantRefund)}`].filter(Boolean).join(" · ")
      : "Not settled";
    const dispute = r.status === S.Disputed ? "Open dispute" : r.resolution ? RESOLUTION[r.resolution] : "None";

    let reviewInfo = "";
    if (r.status === S.Completed && st) {
      const end = r.completedAt + st.reviewPeriod;
      reviewInfo = `<p class="note">Review period ends ${esc(fmtDate(end))} (${esc(relTime(end))}). After that the technician may claim payment and disputes are no longer possible.</p>`;
    }
    if (r.status === S.Disputed && st) {
      const end = r.disputedAt + st.disputeTimeout;
      reviewInfo = `<p class="note">Arbitrator deadline: ${esc(fmtDate(end))} (${esc(relTime(end))}). After that either party can apply the default 50/50 split.</p>`;
    }
    if ((r.status === S.Open || r.status === S.Accepted) && nowSec() > r.deadline) {
      reviewInfo = `<p class="note">The completion deadline has passed. The tenant can reclaim the full deposit.</p>`;
    }

    body.innerHTML = `
      <div>
        <div class="section-title">Details</div>
        <dl class="kv">
          <dt>Description</dt><dd>${esc(r.description)}</dd>
          <dt>Tenant</dt><dd class="mono">${esc(r.tenant)}${same(r.tenant, state.account) ? " (you)" : ""}</dd>
          <dt>Technician</dt><dd class="mono">${esc(r.technician)}${same(r.technician, state.account) ? " (you)" : ""}</dd>
          <dt>Escrow amount</dt><dd><strong>${esc(fmtEth(r.amount))}</strong></dd>
          <dt>Created</dt><dd>${esc(fmtDate(r.createdAt))}</dd>
          <dt>Deadline</dt><dd>${esc(fmtDate(r.deadline))} <span class="muted">(${esc(relTime(r.deadline))})</span></dd>
          ${r.disputeReason ? `<dt>Dispute reason</dt><dd>${esc(r.disputeReason)}</dd>` : ""}
          ${r.resolvedBy !== ethers.ZeroAddress ? `<dt>Resolved by</dt><dd class="mono">${esc(r.resolvedBy)}</dd>` : ""}
        </dl>
      </div>
      <div class="status-grid">
        <div class="status-tile"><span>Escrow</span><strong>${esc(escrowStatus(r))}</strong></div>
        <div class="status-tile"><span>Completion</span><strong>${esc(completion)}</strong></div>
        <div class="status-tile"><span>Payment / refund</span><strong>${esc(payment)}</strong></div>
        <div class="status-tile"><span>Dispute</span><strong>${esc(dispute)}</strong></div>
      </div>
      ${reviewInfo}
      <div>
        <div class="section-title">Your actions</div>
        ${renderActionControls(r)}
      </div>
      <div class="grid-2">
        <div>
          <div class="section-title">On-chain history</div>
          <ol class="timeline">${history.map((h) => `<li>${badge(h.status)} <span class="muted">by</span> <span class="mono" title="${esc(h.actor)}">${esc(short(h.actor))}</span><div class="muted small">${esc(fmtDate(h.timestamp))}</div></li>`).join("")}</ol>
        </div>
        <div>
          <div class="section-title">Transactions</div>
          <ul class="tx-list">${txs.length ? txs.map((l) => `<li><span>${esc(l.name)}</span><span class="mono" title="${esc(l.txHash)}">${esc(short(l.txHash))}</span></li>`).join("") : '<li class="muted">No events found.</li>'}</ul>
        </div>
      </div>`;
    bindActionControls(r);
    body.dataset.actionsKey = availableActions(r).join(","); // used by the periodic re-render check
  }

  function renderActionControls(r) {
    if (!state.account) return '<p class="note">Connect MetaMask to see the actions available to you.</p>';
    const acts = availableActions(r);
    if (!acts.length) return '<p class="note">No actions available for your account in the current state.</p>';
    const parts = [];
    const btn = (op, label, cls) => `<button class="btn ${cls}" data-tx data-op="${op}">${label}</button>`;
    const simple = [];
    if (acts.includes("accept")) simple.push(btn("accept", "Accept job", "btn-primary"));
    if (acts.includes("decline")) simple.push(btn("decline", "Decline job", "btn-ghost"));
    if (acts.includes("complete")) simple.push(btn("complete", "Mark as completed", "btn-primary"));
    if (acts.includes("approve")) simple.push(btn("approve", "Approve work & release payment", "btn-success"));
    if (acts.includes("cancel")) simple.push(btn("cancel", "Cancel request (full refund)", "btn-ghost"));
    if (acts.includes("refund")) simple.push(btn("refund", "Claim refund (deadline missed)", "btn-warning"));
    if (acts.includes("claim")) simple.push(btn("claim", "Claim payment (review period over)", "btn-success"));
    if (acts.includes("defaultSplit")) simple.push(btn("defaultSplit", "Apply default 50/50 split", "btn-warning"));
    if (simple.length) parts.push(`<div class="actions">${simple.join("")}</div>`);
    if (acts.includes("dispute")) {
      parts.push(`<div class="action-group">
        <label for="disputeReason">Dispute reason</label>
        <textarea id="disputeReason" rows="2" maxlength="280" placeholder="Describe what is wrong with the work"></textarea>
        <div class="actions">${btn("dispute", "Raise dispute (freeze funds)", "btn-danger")}</div>
      </div>`);
    }
    if (acts.includes("resolve")) {
      parts.push(`<div class="action-group">
        <p class="note">Arbitration outcomes are fixed by the contract: 100% to technician, 100% refund to tenant, or a 50/50 split (odd wei to tenant).</p>
        <div class="actions">
          ${btn("resolve-1", "Pay technician (100%)", "btn-success")}
          ${btn("resolve-2", "Refund tenant (100%)", "btn-warning")}
          ${btn("resolve-3", "Split 50/50", "btn-primary")}
        </div>
      </div>`);
    }
    return parts.join("");
  }

  function bindActionControls(r) {
    const id = r.id;
    const ops = {
      accept: ["Accept job", (c, o) => c.acceptRequest(id, o)],
      decline: ["Decline job", (c, o) => c.declineRequest(id, o)],
      complete: ["Mark completed", (c, o) => c.markCompleted(id, o)],
      approve: ["Approve work", (c, o) => c.approveWork(id, o)],
      cancel: ["Cancel request", (c, o) => c.cancelRequest(id, o)],
      refund: ["Claim refund", (c, o) => c.claimRefundAfterDeadline(id, o)],
      claim: ["Claim payment", (c, o) => c.claimPaymentAfterReview(id, o)],
      defaultSplit: ["Default split", (c, o) => c.resolveExpiredDispute(id, o)],
      "resolve-1": ["Resolve dispute", (c, o) => c.resolveDispute(id, 1, o)],
      "resolve-2": ["Resolve dispute", (c, o) => c.resolveDispute(id, 2, o)],
      "resolve-3": ["Resolve dispute", (c, o) => c.resolveDispute(id, 3, o)],
    };
    $$("#dlgBody [data-op]").forEach((b) => {
      b.addEventListener("click", async () => {
        const op = b.dataset.op;
        if (op === "dispute") {
          const reason = $("#disputeReason").value.trim();
          if (!reason) {
            toast("warning", "Reason required", "Describe why you are disputing the work.");
            $("#disputeReason").focus();
            return;
          }
          if (new TextEncoder().encode(reason).length > 280) {
            toast("warning", "Reason too long", "Maximum 280 bytes.");
            return;
          }
          await sendTx("Raise dispute", (c, o) => c.raiseDispute(id, reason, o), { button: b });
          return;
        }
        const [label, fn] = ops[op];
        await sendTx(label, fn, { button: b });
      });
    });
  }

  function openDialog(idStr) {
    state.openRequestId = idStr;
    renderDialog(idStr);
    const dlg = $("#requestDialog");
    if (!dlg.open) dlg.showModal();
    raiseToasts();
  }

  function renderAdmin() {
    const isAdmin = state.me.isAdmin;
    $("#adminNote").textContent = isAdmin
      ? "You are the contract administrator."
      : "Only the contract administrator can change roles. You can still try - the contract will reject unauthorized calls.";
    const list = (items, el) => {
      $(el).innerHTML = items.length
        ? items.map((i) => `<li><span class="mono">${esc(i.addr)}</span>${i.active ? '<span class="badge badge-released">Active</span>' : '<span class="badge badge-cancelled">Revoked</span>'}</li>`).join("")
        : '<li class="empty">None yet.</li>';
    };
    list(state.technicians, "#techListView");
    list(state.arbitrators, "#arbListView");
  }

  function renderTechSuggestions() {
    $("#techList").innerHTML = state.technicians
      .filter((t) => t.active)
      .map((t) => `<option value="${esc(t.addr)}"></option>`)
      .join("");
  }

  function suggestNextId() {
    const input = $("#fId");
    if (input.dataset.touched) return;
    const max = state.requests.reduce((m, r) => (r.id > m ? r.id : m), 0n);
    input.value = (max + 1n).toString();
  }

  // ------------------------------------------------------------------
  // Create request form
  // ------------------------------------------------------------------
  function validateCreateForm() {
    const errors = [];
    const f = {
      id: $("#fId").value.trim(),
      desc: $("#fDesc").value.trim(),
      amount: $("#fAmount").value.trim(),
      deadline: $("#fDeadline").value,
      tech: $("#fTech").value.trim(),
    };
    const mark = (sel, bad) => $(sel).setAttribute("aria-invalid", bad ? "true" : "false");
    const out = {};

    const idOk = /^\d+$/.test(f.id) && BigInt(f.id) > 0n;
    mark("#fId", !idOk);
    if (!idOk) errors.push("Request ID must be a whole number of at least 1.");
    else {
      out.id = BigInt(f.id);
      if (state.requests.some((r) => r.id === out.id)) errors.push(`Request ID ${f.id} already exists (the contract would reject it).`);
    }

    const descBytes = new TextEncoder().encode(f.desc).length;
    mark("#fDesc", !f.desc || descBytes > 280);
    if (!f.desc) errors.push("Enter a repair description.");
    else if (descBytes > 280) errors.push("Description is longer than 280 bytes.");
    out.desc = f.desc;

    try {
      out.amount = ethers.parseEther(f.amount);
      if (out.amount <= 0n) throw new Error();
      mark("#fAmount", false);
    } catch (_) {
      mark("#fAmount", true);
      errors.push("Enter a valid ETH amount greater than 0 (e.g. 0.5).");
    }

    const ts = f.deadline ? Math.floor(new Date(f.deadline).getTime() / 1000) : NaN;
    const dlBad = !Number.isFinite(ts) || ts <= nowSec() + 30 || ts > nowSec() + 365 * 86400;
    mark("#fDeadline", dlBad);
    if (dlBad) errors.push("Deadline must be in the future (and within 365 days).");
    out.deadline = ts;

    const techOk = ethers.isAddress(f.tech);
    mark("#fTech", !techOk);
    if (!techOk) errors.push("Technician must be a valid 0x address.");
    else {
      out.tech = ethers.getAddress(f.tech);
      if (same(out.tech, state.account)) errors.push("You cannot assign yourself as the technician.");
      const known = state.technicians.find((t) => same(t.addr, out.tech));
      if (!known || !known.active) errors.push("This address is not an authorized technician (the contract would reject it).");
    }
    return { errors, values: out };
  }

  async function onCreateSubmit(e) {
    e.preventDefault();
    const box = $("#formErrors");
    const { errors, values } = validateCreateForm();
    if (errors.length) {
      box.hidden = false;
      box.innerHTML = `<ul>${errors.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`;
      return;
    }
    box.hidden = true;
    const ok = await sendTx(
      `Create request #${values.id}`,
      (c, o) => c.createRequest(values.id, values.desc, values.amount, values.deadline, values.tech, { ...o, value: values.amount }),
      { button: $("#createBtn") }
    );
    if (ok) {
      $("#createForm").reset();
      delete $("#fId").dataset.touched;
      $("#descCount").textContent = "0";
      setDefaultDeadline();
      suggestNextId();
      showView("requests");
      openDialog(values.id.toString());
    }
  }

  function setDefaultDeadline() {
    const d = new Date(Date.now() + 24 * 3600 * 1000);
    d.setSeconds(0, 0);
    const pad = (n) => String(n).padStart(2, "0");
    $("#fDeadline").value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  // ------------------------------------------------------------------
  // Navigation & events
  // ------------------------------------------------------------------
  function showView(name) {
    $$(".tab").forEach((t) => {
      const on = t.dataset.view === name;
      t.classList.toggle("is-active", on);
      if (on) t.setAttribute("aria-current", "page");
      else t.removeAttribute("aria-current");
    });
    $$(".view").forEach((v) => v.classList.toggle("is-active", v.dataset.view === name));
  }

  function bindEvents() {
    $$(".tab").forEach((t) => t.addEventListener("click", () => showView(t.dataset.view)));
    $("#connectBtn").addEventListener("click", connectWallet);
    $("#refreshBtn").addEventListener("click", () => refresh());
    $("#withdrawBtn").addEventListener("click", (e) => sendTx("Withdraw funds", (c, o) => c.withdraw(o), { button: e.currentTarget }));

    $$(".chip").forEach((chip) =>
      chip.addEventListener("click", () => {
        $$(".chip").forEach((c) => c.classList.toggle("is-active", c === chip));
        state.filter = chip.dataset.filter;
        renderRequests();
      })
    );
    $("#searchInput").addEventListener("input", (e) => {
      state.search = e.target.value;
      renderRequests();
    });

    const rows = $("#requestRows");
    rows.addEventListener("click", (e) => {
      const tr = e.target.closest("tr[data-id]");
      if (tr) openDialog(tr.dataset.id);
    });
    rows.addEventListener("keydown", (e) => {
      const tr = e.target.closest("tr[data-id]");
      if (tr && (e.key === "Enter" || e.key === " ")) {
        e.preventDefault();
        openDialog(tr.dataset.id);
      }
    });

    $("#dlgClose").addEventListener("click", () => $("#requestDialog").close());
    $("#requestDialog").addEventListener("close", () => (state.openRequestId = null));
    $("#requestDialog").addEventListener("click", (e) => {
      if (e.target === e.currentTarget) e.currentTarget.close(); // backdrop click
    });

    $("#createForm").addEventListener("submit", onCreateSubmit);
    $("#fId").addEventListener("input", (e) => (e.target.dataset.touched = "1"));
    $("#fDesc").addEventListener("input", (e) => ($("#descCount").textContent = new TextEncoder().encode(e.target.value).length));

    $$(".inline-form").forEach((form) => {
      const role = form.dataset.role;
      const run = async (op, button) => {
        const input = form.querySelector("input");
        const addr = input.value.trim();
        if (!ethers.isAddress(addr)) {
          input.setAttribute("aria-invalid", "true");
          toast("warning", "Invalid address", "Enter a valid 0x address.");
          return;
        }
        input.setAttribute("aria-invalid", "false");
        const fnName = `${op}${role === "technician" ? "Technician" : "Arbitrator"}`;
        const label = `${op === "authorize" ? "Authorize" : "Revoke"} ${role}`;
        const ok = await sendTx(label, (c, o) => c[fnName](ethers.getAddress(addr), o), { button });
        if (ok) input.value = "";
      };
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        run("authorize", form.querySelector('[data-op="authorize"]'));
      });
      form.querySelector('[data-op="revoke"]').addEventListener("click", (e) => run("revoke", e.currentTarget));
      form.querySelectorAll("button").forEach((b) => b.setAttribute("data-tx", ""));
    });

    if (window.ethereum) {
      window.ethereum.on?.("accountsChanged", async (accounts) => {
        await syncWallet();
        if (!accounts.length) toast("warning", "Wallet disconnected", "MetaMask is no longer connected to FixFlow.");
        else toast("info", "Account changed", short(state.account));
        await refresh();
      });
      window.ethereum.on?.("chainChanged", async () => {
        await syncWallet();
        if (!onRightChain()) toast("warning", "Network changed", `Chain ${state.walletChainId} does not match ${CONFIG.NETWORK_NAME} (${CONFIG.CHAIN_ID}).`);
        else toast("success", "Network changed", `Connected to ${CONFIG.NETWORK_NAME}.`);
        await refresh();
      });
      window.ethereum.on?.("disconnect", async () => {
        state.account = null;
        state.signer = null;
        await refresh();
      });
    }

    // Keep relative times and time-based actions current.
    setInterval(() => {
      renderRequests();
      if (state.openRequestId != null && $("#requestDialog").open && !state.busy) {
        // Re-render only if the set of actions changed, so typed dispute reasons are not lost.
        const r = state.requests.find((x) => x.id.toString() === state.openRequestId);
        const key = r ? availableActions(r).join(",") : "";
        if (key !== $("#dlgBody").dataset.actionsKey) renderDialog(state.openRequestId);
      }
    }, 15000);
  }

  // ------------------------------------------------------------------
  // Boot
  // ------------------------------------------------------------------
  async function init() {
    if (!ethers) {
      document.body.insertAdjacentHTML("afterbegin", '<div class="banner banner-error">Ethers.js failed to load (frontend/vendor/ethers-6.13.4.umd.min.js).</div>');
      return;
    }
    $("#ethersVersion").textContent = ethers.version;
    if (location.protocol === "file:") {
      toast("warning", "Opened from file://", "MetaMask does not work on file:// pages. Run `npm run serve` and open http://localhost:8080.", { sticky: true });
    }
    bindEvents();
    setDefaultDeadline();
    try {
      await syncWallet(); // eth_accounts only - never prompts the user
    } catch (err) {
      console.warn("Wallet sync failed", err);
    }
    await refresh();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
