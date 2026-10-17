# FixFlow – Test Cases & Results

Three levels of testing, kept separate so it is always clear what has actually been verified:

| Level | What it is | How to run | Status |
|---|---|---|---|
| **A. Automated contract tests** | `tests/automated/fixflow.test.js`: solc 0.8.20 (EVM `paris`) + in-process Ganache 7.9.2 + ethers 6.13.4, Node's built-in test runner | `npm test` | **Executed 2026-10-16: 18/18 passed** |
| **B. Browser UI checks (mock wallet)** | Headless Firefox drove the real `frontend/` against a Ganache CLI node (127.0.0.1:7545, chain 1337). MetaMask was replaced by an injected EIP-1193 provider that forwards to Ganache's unlocked accounts and can simulate a user rejection (code 4001). The script was a one-off developer check and is not part of the repo. | – | **Executed 2026-10-16: 52/52 checks passed** |
| **C. Manual Remix + Ganache + MetaMask** | Required assignment workflow, with real MetaMask signatures and screenshots | Follow the steps below | **Executed 2026-10-17** on Ganache Local (chain 1337) with MetaMask – contract `0xb8604a08d0402ceC11e48F2804F6FD37b6edBDDF`. See column C for the evidence behind each row |

Level B checks the frontend code paths (reads, signing flow, error decoding, role-based UI). It does **not** prove MetaMask-specific behaviour such as popups, MetaMask's own error wrapping, or network switching. That is what level C covers.

Time-based rules (deadline, review period, dispute timeout) were verified at level A with `evm_increaseTime`. In level C, deploy with short periods (e.g. `300, 600`) and short deadlines, then wait.

Accounts used below: **Admin** = deployer, **T1** = tenant, **T2** = second tenant / outsider, **Tech** = authorized technician, **Tech2** = second technician, **Arb** = authorized arbitrator.

---

## Results by scenario

**Column C (manual, real MetaMask, 2026-10-17)**: *Observed* entries are backed by the screenshots in the README (section 11, figure numbers given). **"PASS (reported)"** means the tester recorded the case as passing, but no screenshot or transaction hash was kept for it.

| # | Scenario | Steps (manual, level C) | Expected result | A: automated | B: UI (mock wallet) | C: manual |
|---|---|---|---|---|---|---|
| 1 | Tenant creates and funds a request | T1 → *New request*: description, 0.5 ETH, a future deadline, Tech → *Create & fund* | Tx confirmed; status **Open**; escrow 0.5 ETH held; history shows `Open by T1` | PASS (TC01) | PASS – request created, on-chain amount/status checked, dashboard matched | PASS – *Observed:* request #2 "termite issue" funded with 0.5 ETH via MetaMask, mined in block 11, status **Open**, escrow "Held in escrow" (Fig. 12–14) |
| 2 | Duplicate request IDs rejected | Set the *Request ID* field to an existing ID and submit. To prove the contract check, call `createRequest` with the same ID from Remix | UI warns "already exists"; contract reverts `FixFlow: request id already exists`; ID `0` also rejected | PASS (TC02) | PASS – UI warning shown; contract revert confirmed | PASS (reported – no screenshot or tx hash recorded) |
| 3 | Unauthorized role management rejected | T1 → *Admin* → authorize an address | Reverts `caller is not the admin`; UI shows "Only the contract administrator can manage roles."; role unchanged | PASS (TC03) | PASS – revert explained in toast; role not granted on-chain | PASS – *Observed:* tenant `0x3238…3e5f` tried to **revoke** the technician; rejected with `FixFlow: caller is not the admin` ("Only the contract administrator can manage roles."), technician still *Active* (Fig. 22) |
| 4 | Unauthorized technician cannot accept | Tech2 or T2 opens T1's request (no Accept button). In Remix, call `acceptRequest(id)` from Tech2. Also revoke Tech and try to accept | Reverts `caller is not the assigned technician` / `technician authorization revoked`; creating a request for an unauthorized technician reverts `technician is not authorized` | PASS (TC04) | PASS – unrelated account sees no actions | PASS – *Observed (UI):* on the Open request the tenant is offered only *Cancel* and the assigned technician only *Accept/Decline* (Fig. 14–15). Direct calls from other accounts: reported, no screenshot |
| 5 | Unauthorized technician cannot complete | After Tech accepts, Tech2/T1 call `markCompleted(id)` | Reverts `caller is not the assigned technician` | PASS (TC05) | – | PASS (reported – no screenshot or tx hash recorded) |
| 6 | Tenant cannot approve another tenant's request | T2 calls `approveWork` / `raiseDispute` / `cancelRequest` on T1's request | Reverts `caller is not the tenant` | PASS (TC06) | – | PASS (reported – no screenshot or tx hash recorded) |
| 7 | Technician cannot impersonate tenant | Tech calls `approveWork(id)` (Remix, or UI in demo mode) | Reverts `caller is not the tenant`; Tech cannot create a request assigned to himself (`tenant cannot be the technician`) | PASS (TC07) | PASS – crafted `approveWork` tx from Tech mined with status 0 | PASS (reported – no screenshot or tx hash recorded) |
| 8 | Cannot complete before acceptance | Tech calls `markCompleted` on an **Open** request; T1 calls `approveWork` on an Open request | Reverts `invalid request status` | PASS (TC08) | – | PASS (reported – no screenshot or tx hash recorded) |
| 9 | Invalid payment amounts rejected | In Remix, call `createRequest` with `amount` = 1 ETH and *Value* = 0.9 ETH (and 1.1 ETH, and 0). In the UI, enter `abc` as the amount | Reverts `deposit must equal the agreed amount` / `amount must be greater than zero`; UI blocks non-numeric input; plain ETH transfers to the contract are refused | PASS (TC09) | PASS – UI validation lists the errors | PASS (reported – no screenshot or tx hash recorded) |
| 10 | Escrow cannot be released twice | Full happy path, then call `approveWork` / `claimPaymentAfterReview` / `cancelRequest` again; withdraw twice | Second calls revert `invalid request status`; second withdraw reverts `nothing to withdraw`; technician receives exactly the amount once | PASS (TC10) | PASS – approve → Released, payout 1.5 ETH; withdraw moved ≈1.5 ETH (minus gas) to Tech | PASS – *Observed:* request #1 approved by the tenant and 0.5 ETH credited to the technician (activity feed, Fig. 21). Repeated release attempts: reported, no screenshot |
| 11 | Disputed job cannot use normal approval | T1 disputes a completed job, then tries to approve; Tech tries `claimPaymentAfterReview` after the review period | Both revert `invalid request status`; funds stay in escrow (UI: "Frozen (in dispute)", no Approve button) | PASS (TC11) | PASS – Approve hidden; contract `approveWork` call reverts | PASS – *Observed:* after the dispute, request #2 shows **Disputed**, escrow "Frozen (in dispute)", dispute "Open dispute" (Fig. 20). Tenant's view after the dispute was not captured |
| 12 | Unauthorized dispute resolution rejected | T2 / Admin / Tech call `resolveDispute(id, 1)`; an arbitrator who is also the tenant tries; then Arb resolves | Reverts `caller is not an arbitrator` / `arbitrator is a party to this request` / `invalid resolution` (for 0 or 4). Arb's resolution settles exactly once with the predefined split (odd wei → tenant) | PASS (TC12, TC12b) | PASS – Tech sees no resolve buttons; Arb's 50/50 split → 0.5/0.5 ETH on-chain | PASS – *Observed:* the authorized arbitrator is offered only the three fixed outcomes and chose *Refund tenant (100%)*; afterwards escrow is 0 ETH and the tenant's withdrawable balance is 0.5 ETH (Fig. 20–21). Unauthorized resolution attempts: reported, no screenshot |
| 13 | Cancellation & refund rules | T1 cancels an Open request; Tech declines another; T1 tries to cancel an **Accepted** request | Open → **Cancelled**, 100 % credited to T1; cancel/decline after acceptance reverts `invalid request status`; T1's withdraw returns the full amount | PASS (TC13) | PASS (cancel button only shown to tenant; MetaMask-rejection case left state unchanged) | PASS (reported – no screenshot or tx hash recorded) |
| 14 | Expired requests follow timeout rules | (a) Accepted job passes the deadline → T1 *Claim refund*; (b) Open job passes the deadline; (c) Completed job, T1 silent past the review period → Tech *Claim payment*; (d) dispute not resolved within the timeout → *Apply default 50/50 split* | (a)(b) **Refunded**, 100 % to T1; Tech can no longer accept/complete (`deadline has passed`). (c) **Released** to Tech; a late dispute reverts `review period has ended`. (d) **Resolved / DefaultSplit**; outsiders rejected | PASS (TC14) | Not tested (needs waiting real time) | PASS (reported – no screenshot or tx hash recorded) (requires waiting for the 5/10-minute periods) |
| 15 | Payment failures do not corrupt accounting | Automated only: a tenant contract that refuses ETH (`contracts/test/RejectingReceiver.sol`) and one that re-enters `withdraw()` | Settlement still succeeds (pull payments); failed withdraw reverts and keeps the credit; re-entrancy blocked; invariant `balance == totalEscrowed + totalPendingWithdrawals` holds | PASS (TC15) | – | N/A (needs a helper contract) |
| 16 | MetaMask rejection handled | Click any action → **Reject** in MetaMask | Toast "Transaction rejected – nothing was sent"; no state change; UI unlocked | – | PASS (simulated code 4001) | PASS (reported – no screenshot or tx hash recorded) |
| 17 | Frontend retrieves real contract data | Compare UI values with Remix getters (`getRequest`, `totalEscrowed`, `getHistory`) | Values identical; data visible read-only without connecting (via `READ_RPC_URL`) | – | PASS – dashboard loaded via RPC before connecting, then via wallet | PASS – *Observed:* dashboard shows request counts, outstanding escrow and contract events with block numbers and tx hashes; request detail shows on-chain history (Fig. 9, 14, 17, 21) |
| 18 | Displayed escrow & status match contract | After each step, compare dashboard *Outstanding escrow* / request status with `totalEscrowed()` / `getRequest(id).status` | Always equal | Invariant checked after each settlement test | PASS – stats and status compared with on-chain values at each step; final balance = escrow + pending withdrawals | PASS – *Observed:* after settlement the dashboard shows 2 completed requests, 0 ETH outstanding escrow and 1 ETH awaiting withdrawal, consistent with both requests being settled (Fig. 21) |

Additional automated checks (level A): the admin has no function to move escrow and can transfer the admin role; events are emitted with the expected names and order.

Additional UI checks (level B): disconnected-wallet banner; wrong-network detection (chain 1 vs 1337) with a *Switch network* button; account-change detection; demo-mode on-chain revert, where the tx was mined with status 0 and the revert reason was recovered and shown with the tx hash; per-request transaction hash list; disputes require a reason; no uncaught page errors.

---

## Level A output (2026-10-16)

```
✔ TC01 tenant creates and funds a request
✔ TC02 duplicate request IDs are rejected
✔ TC03 unauthorized role management is rejected
✔ TC04 unauthorized / unassigned technician cannot accept a job
✔ TC05 unauthorized technician cannot complete a job
✔ TC06 a tenant cannot approve another tenant's request
✔ TC07 technician cannot impersonate the tenant
✔ TC08 job cannot be completed before acceptance; states cannot be skipped
✔ TC09 invalid payment amounts are rejected
✔ TC10 happy path: approval releases escrow once, withdrawal pays technician
✔ TC11 disputed job cannot use the normal approval path
✔ TC12 unauthorized dispute resolution is rejected; valid outcomes settle correctly
✔ TC12b odd-wei split gives the extra wei to the tenant
✔ TC13 cancellation and refund rules
✔ TC14 expired requests follow the timeout rules
✔ TC15 external payment failures and reentrancy do not corrupt accounting
✔ Admin cannot touch escrow; admin transfer works
✔ Events are emitted for lifecycle and payment changes
ℹ tests 18  pass 18  fail 0
```

