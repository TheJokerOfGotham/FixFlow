// Automated contract tests: solc-js 0.8.20 + in-process Ganache + ethers v6, run with `node --test`.
// Complements the manual Remix/Ganache/MetaMask test plan in tests/test-cases.md.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const ganache = require("ganache");
const { ethers } = require("ethers");
const { compile } = require("../../scripts/compile");

const REVIEW_PERIOD = 300; // 5 minutes
const DISPUTE_TIMEOUT = 600; // 10 minutes
const ONE_ETH = ethers.parseEther("1");

const Status = { None: 0n, Open: 1n, Accepted: 2n, Completed: 3n, Disputed: 4n, Released: 5n, Cancelled: 6n, Refunded: 7n, Resolved: 8n };
const Resolution = { None: 0n, FavorTechnician: 1n, FavorTenant: 2n, Split: 3n, DefaultSplit: 4n };

let artifacts, ganacheProvider, provider, admin, tenant, tech, tech2, arbitrator, outsider, tenant2;
let ff; // FixFlow connected to admin
let nextId = 1;

before(async () => {
  artifacts = compile();
  const g = (ganacheProvider = ganache.provider({
    logging: { quiet: true },
    chain: { chainId: 1337, hardfork: "merge" },
    wallet: { deterministic: true, totalAccounts: 8 },
  }));
  provider = new ethers.BrowserProvider(g, undefined, { pollingInterval: 20, cacheTimeout: -1 });
  const signers = await Promise.all([0, 1, 2, 3, 4, 5, 6].map((i) => provider.getSigner(i)));
  [admin, tenant, tech, tech2, arbitrator, outsider, tenant2] = signers;
});

beforeEach(async () => {
  const factory = new ethers.ContractFactory(artifacts.FixFlow.abi, artifacts.FixFlow.bytecode, admin);
  ff = await factory.deploy(REVIEW_PERIOD, DISPUTE_TIMEOUT);
  await ff.waitForDeployment();
  await (await ff.authorizeTechnician(tech.address)).wait();
  await (await ff.authorizeTechnician(tech2.address)).wait();
  await (await ff.authorizeArbitrator(arbitrator.address)).wait();
});

after(async () => {
  provider.destroy();
  await ganacheProvider.disconnect();
});

// ---------- helpers ----------
const as = (signer) => ff.connect(signer);
async function now() {
  return BigInt((await provider.getBlock("latest")).timestamp);
}
async function timeTravel(seconds) {
  await provider.send("evm_increaseTime", [seconds]);
  await provider.send("evm_mine", []);
}
async function createRequest({ id = nextId++, amount = ONE_ETH, value, deadlineIn = 3600n, technician = tech.address, from = tenant } = {}) {
  const deadline = (await now()) + BigInt(deadlineIn);
  await (await as(from).createRequest(id, "Leaking kitchen tap", amount, deadline, technician, { value: value ?? amount })).wait();
  return id;
}
// Ganache reports the revert string under err.info.error.data.reason, which
// ethers' BrowserProvider does not decode, so search the whole error object.
function revertText(err) {
  const seen = new Set();
  const parts = [];
  (function walk(v) {
    if (v == null || seen.has(v)) return;
    if (typeof v === "string") return void parts.push(v);
    if (typeof v !== "object") return;
    seen.add(v);
    for (const k of Object.keys(v)) walk(v[k]);
  })(err);
  parts.push(err.message || "");
  return parts.join(" | ");
}
async function expectRevert(promise, reason) {
  await assert.rejects(promise, (err) => {
    const msg = revertText(err);
    assert.ok(msg.includes(reason), `expected revert "${reason}", got "${msg.slice(0, 300)}"`);
    return true;
  });
}
async function checkInvariant() {
  const balance = await provider.getBalance(await ff.getAddress());
  const escrowed = await ff.totalEscrowed();
  const pending = await ff.totalPendingWithdrawals();
  assert.equal(balance, escrowed + pending, "contract balance must equal escrow + pending withdrawals");
}
const status = async (id) => (await ff.getRequest(id)).status;

// ---------- 1. create & fund ----------
test("TC01 tenant creates and funds a request", async () => {
  const id = await createRequest();
  const r = await ff.getRequest(id);
  assert.equal(r.tenant, tenant.address);
  assert.equal(r.technician, tech.address);
  assert.equal(r.amount, ONE_ETH);
  assert.equal(r.status, Status.Open);
  assert.equal(await ff.totalEscrowed(), ONE_ETH);
  assert.equal(await ff.getRequestCount(), 1n);
  const history = await ff.getHistory(id);
  assert.equal(history.length, 1);
  assert.equal(history[0].status, Status.Open);
  assert.equal(history[0].actor, tenant.address);
  await checkInvariant();
});

test("TC02 duplicate request IDs are rejected", async () => {
  const id = await createRequest();
  await expectRevert(createRequest({ id, from: tenant2 }), "request id already exists");
  await expectRevert(createRequest({ id: 0 }), "id must be non-zero");
});

test("TC03 unauthorized role management is rejected", async () => {
  await expectRevert(as(outsider).authorizeTechnician(outsider.address), "caller is not the admin");
  await expectRevert(as(tenant).revokeTechnician(tech.address), "caller is not the admin");
  await expectRevert(as(outsider).authorizeArbitrator(outsider.address), "caller is not the admin");
  await expectRevert(as(arbitrator).revokeArbitrator(arbitrator.address), "caller is not the admin");
  await expectRevert(as(outsider).transferAdmin(outsider.address), "caller is not the admin");
  assert.equal(await ff.isTechnician(outsider.address), false);
});

test("TC04 unauthorized / unassigned technician cannot accept a job", async () => {
  const id = await createRequest();
  await expectRevert(as(tech2).acceptRequest(id), "caller is not the assigned technician");
  await expectRevert(as(outsider).acceptRequest(id), "caller is not the assigned technician");
  // assigned technician whose authorization was revoked
  await (await ff.revokeTechnician(tech.address)).wait();
  await expectRevert(as(tech).acceptRequest(id), "technician authorization revoked");
  // cannot assign an unauthorized technician at creation
  await expectRevert(createRequest({ technician: outsider.address }), "technician is not authorized");
});

test("TC05 unauthorized technician cannot complete a job", async () => {
  const id = await createRequest();
  await (await as(tech).acceptRequest(id)).wait();
  await expectRevert(as(tech2).markCompleted(id), "caller is not the assigned technician");
  await expectRevert(as(tenant).markCompleted(id), "caller is not the assigned technician");
});

test("TC06 a tenant cannot approve another tenant's request", async () => {
  const id = await createRequest();
  await (await as(tech).acceptRequest(id)).wait();
  await (await as(tech).markCompleted(id)).wait();
  await expectRevert(as(tenant2).approveWork(id), "caller is not the tenant");
  await expectRevert(as(tenant2).raiseDispute(id, "bad"), "caller is not the tenant");
  await expectRevert(as(tenant2).cancelRequest(id), "caller is not the tenant");
});

test("TC07 technician cannot impersonate the tenant", async () => {
  const id = await createRequest();
  await expectRevert(as(tech).cancelRequest(id), "caller is not the tenant");
  await (await as(tech).acceptRequest(id)).wait();
  await (await as(tech).markCompleted(id)).wait();
  await expectRevert(as(tech).approveWork(id), "caller is not the tenant");
  await expectRevert(as(tech).raiseDispute(id, "x"), "caller is not the tenant");
  await expectRevert(createRequest({ from: tech, technician: tech.address }), "tenant cannot be the technician");
});

test("TC08 job cannot be completed before acceptance; states cannot be skipped", async () => {
  const id = await createRequest();
  await expectRevert(as(tech).markCompleted(id), "invalid request status");
  await expectRevert(as(tenant).approveWork(id), "invalid request status");
  await expectRevert(as(tenant).raiseDispute(id, "x"), "invalid request status");
  await expectRevert(as(arbitrator).resolveDispute(id, Resolution.Split), "invalid request status");
  await expectRevert(as(tech).acceptRequest(999), "request does not exist");
});

test("TC09 invalid payment amounts are rejected", async () => {
  await expectRevert(createRequest({ amount: ONE_ETH, value: ONE_ETH - 1n }), "deposit must equal the agreed amount");
  await expectRevert(createRequest({ amount: ONE_ETH, value: ONE_ETH + 1n }), "deposit must equal the agreed amount");
  await expectRevert(createRequest({ amount: 0n, value: 0n }), "amount must be greater than zero");
  await expectRevert(createRequest({ deadlineIn: 0n }), "deadline must be in the future");
  await expectRevert(createRequest({ deadlineIn: 400n * 86400n }), "deadline too far in the future");
  // plain ETH transfers to the contract are refused (no receive function)
  await assert.rejects(tenant.sendTransaction({ to: await ff.getAddress(), value: ONE_ETH }));
  assert.equal(await ff.totalEscrowed(), 0n);
  await checkInvariant();
});

test("TC10 happy path: approval releases escrow once, withdrawal pays technician", async () => {
  const id = await createRequest();
  await (await as(tech).acceptRequest(id)).wait();
  await (await as(tech).markCompleted(id)).wait();
  await (await as(tenant).approveWork(id)).wait();
  assert.equal(await status(id), Status.Released);
  assert.equal(await ff.totalEscrowed(), 0n);
  assert.equal(await ff.pendingWithdrawals(tech.address), ONE_ETH);
  await checkInvariant();

  // second release attempts fail
  await expectRevert(as(tenant).approveWork(id), "invalid request status");
  await expectRevert(as(tech).claimPaymentAfterReview(id), "invalid request status");
  await expectRevert(as(tenant).cancelRequest(id), "invalid request status");

  const receipt = await (await as(tech).withdraw()).wait();
  const gas = receipt.gasUsed * receipt.gasPrice;
  const before = await provider.getBalance(tech.address, receipt.blockNumber - 1);
  assert.equal(await provider.getBalance(tech.address, receipt.blockNumber), before + ONE_ETH - gas);
  await expectRevert(as(tech).withdraw(), "nothing to withdraw");
  await checkInvariant();

  const history = (await ff.getHistory(id)).map((h) => h.status);
  assert.deepEqual(history, [Status.Open, Status.Accepted, Status.Completed, Status.Released]);
});

test("TC11 disputed job cannot use the normal approval path", async () => {
  const id = await createRequest();
  await (await as(tech).acceptRequest(id)).wait();
  await (await as(tech).markCompleted(id)).wait();
  await (await as(tenant).raiseDispute(id, "Tap still leaking")).wait();
  assert.equal(await status(id), Status.Disputed);
  await expectRevert(as(tenant).approveWork(id), "invalid request status");
  await timeTravel(REVIEW_PERIOD + 1);
  await expectRevert(as(tech).claimPaymentAfterReview(id), "invalid request status");
  await expectRevert(as(tenant).raiseDispute(id, "again"), "invalid request status");
  assert.equal(await ff.totalEscrowed(), ONE_ETH);
});

test("TC12 unauthorized dispute resolution is rejected; valid outcomes settle correctly", async () => {
  const mk = async () => {
    const id = await createRequest();
    await (await as(tech).acceptRequest(id)).wait();
    await (await as(tech).markCompleted(id)).wait();
    await (await as(tenant).raiseDispute(id, "Poor work")).wait();
    return id;
  };
  const id = await mk();
  await expectRevert(as(outsider).resolveDispute(id, Resolution.FavorTechnician), "caller is not an arbitrator");
  await expectRevert(as(tenant).resolveDispute(id, Resolution.FavorTenant), "caller is not an arbitrator");
  await expectRevert(ff.resolveDispute(id, Resolution.FavorTenant), "caller is not an arbitrator"); // admin is not an arbitrator
  await expectRevert(as(arbitrator).resolveDispute(id, Resolution.None), "invalid resolution");
  await expectRevert(as(arbitrator).resolveDispute(id, Resolution.DefaultSplit), "invalid resolution");
  await expectRevert(as(tenant).resolveExpiredDispute(id), "dispute timeout not reached");

  // arbitrator who is also a party is rejected
  await (await ff.authorizeArbitrator(tenant.address)).wait();
  await expectRevert(as(tenant).resolveDispute(id, Resolution.FavorTenant), "arbitrator is a party to this request");

  // Split with an odd amount: odd wei to tenant
  await (await as(arbitrator).resolveDispute(id, Resolution.Split)).wait();
  let r = await ff.getRequest(id);
  assert.equal(r.status, Status.Resolved);
  assert.equal(r.resolution, Resolution.Split);
  assert.equal(r.resolvedBy, arbitrator.address);
  assert.equal(r.technicianPayout + r.tenantRefund, ONE_ETH);
  await expectRevert(as(arbitrator).resolveDispute(id, Resolution.FavorTenant), "invalid request status");

  const id2 = await mk();
  await (await as(arbitrator).resolveDispute(id2, Resolution.FavorTenant)).wait();
  r = await ff.getRequest(id2);
  assert.equal(r.tenantRefund, ONE_ETH);
  assert.equal(r.technicianPayout, 0n);

  const id3 = await mk();
  await (await as(arbitrator).resolveDispute(id3, Resolution.FavorTechnician)).wait();
  r = await ff.getRequest(id3);
  assert.equal(r.technicianPayout, ONE_ETH);

  assert.equal(await ff.pendingWithdrawals(tenant.address), ONE_ETH + ONE_ETH / 2n);
  assert.equal(await ff.pendingWithdrawals(tech.address), ONE_ETH + ONE_ETH / 2n);
  await checkInvariant();
});

test("TC12b odd-wei split gives the extra wei to the tenant", async () => {
  const id = await createRequest({ amount: 3n });
  await (await as(tech).acceptRequest(id)).wait();
  await (await as(tech).markCompleted(id)).wait();
  await (await as(tenant).raiseDispute(id, "x")).wait();
  await (await as(arbitrator).resolveDispute(id, Resolution.Split)).wait();
  const r = await ff.getRequest(id);
  assert.equal(r.technicianPayout, 1n);
  assert.equal(r.tenantRefund, 2n);
  await checkInvariant();
});

test("TC13 cancellation and refund rules", async () => {
  // tenant cancels an open request
  const id = await createRequest();
  await (await as(tenant).cancelRequest(id)).wait();
  assert.equal(await status(id), Status.Cancelled);
  assert.equal(await ff.pendingWithdrawals(tenant.address), ONE_ETH);
  await expectRevert(as(tenant).cancelRequest(id), "invalid request status");

  // technician declines an open request
  const id2 = await createRequest();
  await (await as(tech).declineRequest(id2)).wait();
  assert.equal(await status(id2), Status.Cancelled);
  assert.equal(await ff.pendingWithdrawals(tenant.address), 2n * ONE_ETH);

  // accepted requests can no longer be cancelled unilaterally
  const id3 = await createRequest();
  await (await as(tech).acceptRequest(id3)).wait();
  await expectRevert(as(tenant).cancelRequest(id3), "invalid request status");
  await expectRevert(as(tech).declineRequest(id3), "invalid request status");

  const receipt = await (await as(tenant).withdraw()).wait();
  const before = await provider.getBalance(tenant.address, receipt.blockNumber - 1);
  const afterBal = await provider.getBalance(tenant.address, receipt.blockNumber);
  assert.equal(afterBal, before + 2n * ONE_ETH - receipt.gasUsed * receipt.gasPrice);
  await checkInvariant();
});

test("TC14 expired requests follow the timeout rules", async () => {
  // a) deadline passes while Accepted -> tenant refund; technician can no longer complete
  const id = await createRequest({ deadlineIn: 100n });
  await (await as(tech).acceptRequest(id)).wait();
  await expectRevert(as(tenant).claimRefundAfterDeadline(id), "deadline has not passed");
  await timeTravel(101);
  await expectRevert(as(tech).markCompleted(id), "deadline has passed");
  await expectRevert(as(outsider).claimRefundAfterDeadline(id), "caller is not the tenant");
  await (await as(tenant).claimRefundAfterDeadline(id)).wait();
  assert.equal(await status(id), Status.Refunded);

  // b) deadline passes while Open -> cannot accept; tenant refund
  const id2 = await createRequest({ deadlineIn: 100n });
  await timeTravel(101);
  await expectRevert(as(tech).acceptRequest(id2), "deadline has passed");
  await (await as(tenant).claimRefundAfterDeadline(id2)).wait();
  assert.equal(await status(id2), Status.Refunded);

  // c) completed, tenant silent past review period -> technician claims; late dispute rejected
  const id3 = await createRequest();
  await (await as(tech).acceptRequest(id3)).wait();
  await (await as(tech).markCompleted(id3)).wait();
  await expectRevert(as(tech).claimPaymentAfterReview(id3), "review period not over");
  await timeTravel(REVIEW_PERIOD + 1);
  await expectRevert(as(tenant).raiseDispute(id3, "late"), "review period has ended");
  await expectRevert(as(tenant).claimRefundAfterDeadline(id3), "invalid request status");
  await (await as(tech).claimPaymentAfterReview(id3)).wait();
  assert.equal(await status(id3), Status.Released);

  // d) dispute with no arbitrator action -> default 50/50 split by a party only
  const id4 = await createRequest({ amount: 2n * ONE_ETH });
  await (await as(tech).acceptRequest(id4)).wait();
  await (await as(tech).markCompleted(id4)).wait();
  await (await as(tenant).raiseDispute(id4, "x")).wait();
  await timeTravel(DISPUTE_TIMEOUT + 1);
  await expectRevert(as(outsider).resolveExpiredDispute(id4), "caller is not a party");
  await (await as(tech).resolveExpiredDispute(id4)).wait();
  const r = await ff.getRequest(id4);
  assert.equal(r.resolution, Resolution.DefaultSplit);
  assert.equal(r.technicianPayout, ONE_ETH);
  assert.equal(r.tenantRefund, ONE_ETH);
  assert.equal(await ff.totalEscrowed(), 0n);
  await checkInvariant();
});

test("TC15 external payment failures and reentrancy do not corrupt accounting", async () => {
  const rf = new ethers.ContractFactory(artifacts.RejectingReceiver.abi, artifacts.RejectingReceiver.bytecode, admin);
  const receiver = await rf.deploy(await ff.getAddress());
  await receiver.waitForDeployment();
  const id = nextId++;
  const deadline = (await now()) + 3600n;
  await (await receiver.create(id, deadline, tech.address, { value: ONE_ETH })).wait();

  // settlement succeeds even though the tenant contract refuses ETH (pull payments)
  await (await receiver.cancel(id)).wait();
  const addr = await receiver.getAddress();
  assert.equal(await ff.pendingWithdrawals(addr), ONE_ETH);

  // withdrawal to a refusing receiver reverts and leaves the credit intact
  await expectRevert(receiver.pull(), "ETH transfer failed");
  assert.equal(await ff.pendingWithdrawals(addr), ONE_ETH);
  assert.equal(await ff.totalPendingWithdrawals(), ONE_ETH);
  await checkInvariant();

  // reentrant withdraw attempt is blocked, credit stays intact
  await (await receiver.setMode(true, true)).wait();
  await expectRevert(receiver.pull(), "ETH transfer failed");
  assert.equal(await ff.pendingWithdrawals(addr), ONE_ETH);
  await checkInvariant();

  // once it accepts ETH normally, it can withdraw exactly once
  await (await receiver.setMode(true, false)).wait();
  await (await receiver.pull()).wait();
  assert.equal(await ff.pendingWithdrawals(addr), 0n);
  assert.equal(await provider.getBalance(addr), ONE_ETH);
  await expectRevert(receiver.pull(), "nothing to withdraw");
  await checkInvariant();
});

test("Admin cannot touch escrow; admin transfer works", async () => {
  await createRequest();
  // there is no admin withdrawal function in the ABI at all
  const fnNames = ff.interface.fragments.filter((f) => f.type === "function").map((f) => f.name);
  assert.ok(!fnNames.some((n) => /emergency|sweep|rescue|adminWithdraw/i.test(n)));
  await expectRevert(ff.withdraw(), "nothing to withdraw");
  await (await ff.transferAdmin(outsider.address)).wait();
  assert.equal(await ff.admin(), outsider.address);
  await expectRevert(ff.authorizeTechnician(tenant2.address), "caller is not the admin");
  await checkInvariant();
});

test("Events are emitted for lifecycle and payment changes", async () => {
  const id = await createRequest();
  const receipt = await (await as(tech).acceptRequest(id)).wait();
  assert.equal(ff.interface.parseLog(receipt.logs[0]).name, "RequestAccepted");
  await (await as(tech).markCompleted(id)).wait();
  const r2 = await (await as(tenant).approveWork(id)).wait();
  const names = r2.logs.map((l) => ff.interface.parseLog(l).name);
  assert.deepEqual(names, ["PaymentReleased", "WorkApproved"]);
  const created = await ff.queryFilter(ff.filters.RequestCreated(id));
  assert.equal(created.length, 1);
});
