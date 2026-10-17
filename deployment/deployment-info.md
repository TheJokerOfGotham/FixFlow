# FixFlow – Deployment Guide & Record

The required deployment path is **Remix IDE → Ganache (local) via MetaMask**.
`npm run compile` / `npm test` are only local verification helpers; they do not replace the Remix deployment.

> **Status: DEPLOYED through Remix on 2026-10-17** to Ganache Local (chain ID 1337). Contract address: **`0xb8604a08d0402ceC11e48F2804F6FD37b6edBDDF`**. See the [deployment record](#deployment-record) at the bottom.
> Every Ganache restart (without a saved workspace) wipes the chain. After a restart you must redeploy, update `frontend/config.js` and this record.

---

## 1. Start Ganache

Choose **one** option.

**Option A – Ganache GUI (desktop app)**
1. *New Workspace → Ethereum*. Name it `FixFlow` and save it, so the chain survives restarts.
2. Server tab: host `127.0.0.1`, port **7545**. The GUI shows *Network ID 5777*, but the **chain ID is 1337**. MetaMask and the frontend use the chain ID.
3. Chain tab: set *Hardfork* to the newest option offered (`merge` or later).

**Option B – Ganache CLI (bundled in this repo)**
```bash
npm install
npm run ganache     # port 7545, chain ID 1337, deterministic accounts, hardfork "merge"
```
On newer Node versions Ganache prints `This version of µWS is not compatible…` and falls back to a Node implementation. That warning is harmless.

> The deterministic Ganache keys are **public test keys**. Never send real funds to them or use them on a public network.

## 2. Configure MetaMask

1. MetaMask → *Networks → Add network → Add a network manually*:
   | Field | Value |
   |---|---|
   | Network name | `Ganache Local` |
   | RPC URL | `http://127.0.0.1:7545` |
   | Chain ID | `1337` |
   | Currency symbol | `ETH` |
2. Import at least four Ganache accounts (*Account menu → Add account → Import account*, then paste the private key shown by Ganache: the key icon in the GUI, or the CLI start-up output):
   | Role | Suggested Ganache account |
   |---|---|
   | Admin (deployer) | Account 0 |
   | Tenant | Account 1 |
   | Technician | Account 2 |
   | Arbitrator | Account 4 |
   | Second tenant (for unauthorized tests) | Account 3 |
3. After restarting Ganache, reset MetaMask's nonce cache: *Settings → Advanced → Clear activity tab data*.

## 3. Compile in Remix

1. Open <https://remix.ethereum.org>, create `FixFlow.sol` and paste the contents of `contracts/FixFlow.sol`.
2. *Solidity Compiler* tab:
   - Compiler: **0.8.20** (e.g. `0.8.20+commit.a1b79de6`)
   - *Advanced Configurations* → **EVM version: `paris`**. Solidity 0.8.20 targets `shanghai` by default and emits the `PUSH0` opcode, which older Ganache builds (including some GUI versions) reject. `paris` works everywhere.
   - *Enable optimization* (200 runs) is recommended but optional. The unoptimized runtime code (≈21 KB) is under the 24 KB limit.
3. Click **Compile FixFlow.sol** and check for a green tick. 📸 *Screenshot: compilation.*
4. To get the ABI, click the **ABI** copy button at the bottom of the compiler tab.

Do **not** deploy `contracts/test/RejectingReceiver.sol`. It is a helper for the automated tests only.

## 4. Deploy from Remix

1. *Deploy & Run Transactions* tab → *Environment*: **Browser Extension → MetaMask** (called *Injected Provider – MetaMask* in older Remix versions).
   - MetaMask must be on **Ganache Local (1337)** with the **Admin** account selected. Remix labels chain 1337 as `Custom (1337)` or `Geth Testnet (1337)`, depending on the version.
   - Alternative: *Custom – External Http Provider* → `http://127.0.0.1:7545`. Remix then deploys from Ganache account 0.
2. Contract: `FixFlow`. Constructor arguments:
   | Parameter | Meaning | Demo value | Realistic value |
   |---|---|---|---|
   | `_reviewPeriod` | seconds the tenant has to approve/dispute after completion | `300` (5 min) | `259200` (3 days) |
   | `_disputeTimeout` | seconds an arbitrator has before the default 50/50 split | `600` (10 min) | `604800` (7 days) |
   Type into the field next to **Deploy**: `300,600`
3. Click **Deploy** and confirm in MetaMask. 📸 *Screenshot: deployment (Remix log + MetaMask).*
4. Copy the address from *Deployed Contracts*. Find the block number in the Remix log or the Ganache *Transactions* tab.

## 5. Configure the frontend

Edit `frontend/config.js`:
```js
CONTRACT_ADDRESS: "0x…address from Remix…",
CHAIN_ID: 1337,
READ_RPC_URL: "http://127.0.0.1:7545",
DEPLOYMENT_BLOCK: <block number of the deployment tx>,   // 0 also works locally
```
The ABI in `config.js` is generated from `contracts/FixFlow.sol` (`npm run sync-abi`). It is identical to Remix's ABI for the same source. If you change the contract, either run `npm run sync-abi` again or paste Remix's ABI between the `ABI-START` / `ABI-END` markers.

## 6. Set up roles (as Admin)

Run the frontend (`npm run serve` → <http://localhost:8080>), connect the **Admin** account, open the **Admin** tab, then:
1. Authorize the technician address (Account 2).
2. Authorize the arbitrator address (Account 4).

You can also do this in Remix by calling `authorizeTechnician` / `authorizeArbitrator`.

---

## Deployment record

Values taken from the Remix and FixFlow screenshots in the README (section 11). Hashes shown truncated in the UI are marked *(truncated)*. The full hashes can be read from Ganache's *Transactions* tab or Remix's terminal log.

| Item | Value | Evidence |
|---|---|---|
| Date | 2026-10-17 | Fig. 9 (block 2 timestamp) |
| Network | Ganache Local, chain ID **1337**, RPC `http://127.0.0.1:7545` | Fig. 6, 9 |
| Deployment tool | Remix IDE → Browser Extension (MetaMask) | Fig. 2, 4–6 |
| Compiler / EVM version / optimizer | 0.8.20+commit.a1b79de6 / paris / off | Fig. 1 |
| Constructor args | `_reviewPeriod = 300`, `_disputeTimeout = 600` (5 min / 10 min) | Fig. 3; dashboard shows 5 min / 10 min (Fig. 9) |
| **Contract address** | **`0xb8604a08d0402ceC11e48F2804F6FD37b6edBDDF`** | Fig. 7–8; `frontend/config.js` |
| Deployment block | 2 (the constructor's `AdminTransferred` event) | Fig. 9 |
| Deployment tx hash | `0xd5f0…14ac` *(truncated)* | Fig. 9 |
| Admin (deployer) address | `0x389Ca5357F84393eCCE995a7768a9780e1D20D88` | Fig. 7, 9 |
| Technician authorized | `0x4706D4888C0d867B8Fa5eb9aEFDe11d93A15D448`: block 4, tx `0x669d…0d7c` *(truncated)* | Fig. 9, 10 |
| Arbitrator authorized | `0xe49655813e995ED8418e51c30875150293D0e771`: block 5, tx `0x1e8f78bab8df1c72effcd04aa83edb97abfbf085d55c74ff62dc0bc39aafc9da` (status 1, 47,888 gas) | Fig. 7–8 |
| Ganache version | not recorded | – |
