# X-Ray Report

> COTI PoD Inbox | 1,502 nSLOC | `7e82677` (`HEAD`) | Hardhat | 17/08/26

---

## 1. Protocol Overview

**What it does:** A trusted-miner cross-chain message bridge — dApps prepay a native fee to queue a message, an off-chain miner relays it and delivers batches on the destination chain, and the inbox executes the target call and routes responses/errors back.

- **Users**: Source-chain dApps (e.g. `InboxUser`-based contracts) sending one-way/two-way cross-chain calls; destination-chain dApps (PodERC20, PrivacyPortal — in `@coti-io/coti-contracts`) receiving and replying to them.
- **Core flow**: `sendTwoWayMessage`/`sendOneWayMessage` (prepay + queue) → off-chain miner relays → `batchProcessRequests` (execute target) → `respond`/`raise` (reply leg).
- **Key mechanism**: No lock/mint accounting — the inbox is a pure message-passing relay. A single registered-miner set is the entire authenticity root; there is no payload proof linking an incoming request to a real source-chain event.
- **Token model**: No protocol token. Native coin is prepaid per-message as a **gas-unit budget** (converted via a pluggable USD price oracle), not escrowed value — the inbox's balance is undifferentiated protocol revenue.
- **Admin model**: Single `Ownable` owner — no timelock, no multisig evidence in-code. Owner also assigns a separate `priceAdmin` role (defaults to owner).

For a visual overview of the protocol's architecture, see the [architecture diagram](architecture.svg).

### Contracts in Scope

| Subsystem | Key Contracts | nSLOC | Role |
|-----------|--------------|------:|------|
| Inbox Core | `Inbox`, `InboxBase`, `InboxMiner`, `MinerBase` | 714 | Cross-chain send/receive, miner ingestion, owner/miner access control |
| Fee Management | `InboxFeeManager` | 181 | Converts prepaid native fee into gas-unit budgets for both legs |
| Price Oracle Core | `PriceOracle`, `PoDPriceOracle` | 194 | Cached USD price feed for fee conversion + live reads for the pod portal |
| Oracle Adapters | `BandLiveOracle`, `BandPriceReader`, `BandFeedLib`, `ChainlinkLiveOracle`, `ChainlinkPriceReader`, `ChainlinkFeedLib`, `UniswapPriceOracle` | 413 | Pluggable live price sources (Band StdReference / Chainlink / Uniswap V2 spot) |

Shared PoD interfaces (`IInbox`, `IInboxMiner`, `MpcAbiCodec`, `IPodPriceOracle`, `InboxUser`, `MpcCore`) are imported from the `@coti-io/coti-contracts` npm dependency (v1.3.5) and are out of scope here — see [coti-io/coti-contracts](https://github.com/coti-io/coti-contracts).

### How It Fits Together

**The core trick:** the inbox never verifies that an incoming message actually happened on the source chain — it trusts whatever a registered miner submits, and every downstream authentication (`inboxMsgSender()`, portal peer checks) reduces to that same trust.

### Cross-Chain Send

```
User/dApp → InboxBase.sendTwoWayMessage()
              ├─ InboxFeeManager.validateAndPrepareTwoWayFees()
              │    └─ PriceOracle.getPricesUSD()        *reverts if either cached leg price is 0*
              ├─ InboxBase._createRequest()              *writes requests[id], emits MessageSent*
              └─ PriceOracle.refreshCache()               *best-effort — swallowed on failure*
```

### Miner Ingestion → Target Execution

```
Off-chain Miner → InboxMiner.batchProcessRequests()
                     ├─ per-sourceChainId contiguous-nonce check
                     ├─ InboxMiner._executeIncomingRequest()
                     │    ├─ InboxBase._safeEncodeMethodCall() → MpcAbiCodec.reEncodeWithGt()
                     │    └─ InboxMiner._callWithCappedReturnData() → TargetContract.call{gas}()
                     │                                             *revert data capped at 256 bytes*
                     └─ incomingRequests[id].executed = true        *"return leg received", not "callback committed"*
```

### Target Reply

```
TargetContract (mid-execution) → InboxBase.respond() / .raise()
                                    └─ InboxBase._sendOneWayMessage() → _createRequest()
                                                                         *gated: msg.sender == active target only*
```

### Recovery Retry

```
Anyone → InboxMiner.retryFailedRequest()
           ├─ eligibility: errors[id].errorCode == EXECUTION_FAILED
           ├─ re-encode failure now reverts the whole retry tx     *POD-04 fix — code can no longer flip*
           └─ target.call() retried; success clears errors[id]
```

### Fee Price Refresh

```
Send path (best-effort) or Anyone → PriceOracle.refreshCache()
                                       └─ PoDPriceOracle._pullCachedPrice()
                                            └─ configuredOracle.getLivePrice()  [BandLiveOracle | ChainlinkLiveOracle]
                                                 *falls back to last cached value on a 0 read — no max-age check*
```

---

## 2. Threat & Trust Model

### Protocol Threat Profile

> Protocol classified as: **Bridge** (cross-chain message passing, relayer/miner set, message nonce, chain-ID checks)

No lock/mint token accounting exists in this repo — the bridge relays arbitrary calldata rather than value — so lending/AMM/vault threat classes do not apply. Adversary ranking below is Bridge-profile, reordered by git/audit evidence.

### Actors & Adversary Model

| Actor | Trust Level | Capabilities |
|-------|-------------|-------------|
| Owner | Trusted (no timelock) | Add/remove miners, wire price oracle, set gas-price bounds, update fee templates, pause inbound processing, sweep 100% of native balance (`collectFees`) — all instant. |
| Registered Miner | Bounded (owner-appointed; then fully trusted for message authenticity) | Submits arbitrary incoming batches — `sourceContract`, `targetContract`, payload, and both fee budgets are miner-supplied with no proof tying them to a real source-chain event. |
| Price Admin | Bounded (owner-appointed, defaults to owner) | Sets/clears manual USD pegs; overrides live oracle reads unconditionally. |
| Source-chain dApp | Untrusted | Sends prepaid one-way/two-way messages; chooses target, payload, fee split. |
| Target dApp | Bounded (own access control) | Receives inbox-routed calls; may call `respond()`/`raise()` only while it is the active target. |
| Permissionless caller | Untrusted | May call `refreshCache()` and `retryFailedRequest()` — both intentionally open. |

**Adversary Ranking** (ordered by threat level, adjusted by git/audit evidence — see [entry-points.md](entry-points.md) for the full permissionless entry point map):

1. **Compromised/malicious miner** — the dominant threat; the sole trust root for message authenticity, with no cryptographic link to a source-chain event.
2. **Compromised admin** — single owner, no timelock, can redirect the miner set or sweep the entire native balance instantly.
3. **Retry-path griefer** — `retryFailedRequest` is permissionless and caller-gas-controlled; historically could corrupt retry eligibility (now fixed — see Cross-Reference Synthesis).
4. **Oracle staleness/spot-manipulation actor** — the cached price feed has no max-age check, and the Uniswap adapter reads manipulable spot reserves.
5. **Griefing via oversized target revert data** — mitigated in this tree (see below).

### Trust Boundaries

- **Owner → entire protocol** — every admin function is instant, no timelock; the worst single action is `collectFees` sweeping the full native balance (`InboxFeeManager.sol:71-79`).

- **Miner → message authenticity** — `onlyMiner` (`MinerBase.sol:18-21`) is the only gate on `batchProcessRequests`; no payload proof exists anywhere downstream. *Git signal: `InboxMiner.sol` is the #1 churn file (10 commits) and carries this exact boundary.*

- **Active target → reply legs** — `respond`/`raise` are ungated by role but restricted to `msg.sender == incomingRequest.targetContract` while `_currentContext` is live (`InboxBase.sol:153,192`); this is the correct, narrow boundary and holds structurally.

### Key Attack Surfaces

- **Miner-supplied message authenticity** &nbsp;[I-5](invariants.md#i-5), [X-3](invariants.md#x-3) — `InboxMiner.sol:69-84` stores `originalSender`/`callerContract` verbatim from miner input with no proof; every downstream `inboxMsgSender()` peer check inherits this. Worth tracing how far a forged `sourceContract` value can reach in the destination-chain dApp stack.

- **`collectFees` has no per-request escrow accounting** &nbsp;[I-3](invariants.md#i-3) — `InboxFeeManager.sol:71-79` sweeps `address(this).balance` in full; no running total separates earned revenue from over-funded/censored prepayments. Worth checking whether integrators assume any refund path exists.

- **Cached price staleness has no max-age check** &nbsp;[X-1](invariants.md#x-1) — `_validatedOraclePrices` (`InboxFeeManager.sol:136-144`) only reverts on `price == 0`; `PoDPriceOracle._pullCachedPrice` (`PoDPriceOracle.sol:106-112`) silently falls back to the last cached value on a live-read failure. Worth confirming how long a broken adapter can go unnoticed.

- **Miner-supplied `errorSelector`/`isTwoWay`/`callerFee` are not cross-validated** &nbsp;[E-2](invariants.md#e-2) — the public `sendOneWayMessage` now rejects a non-zero `errorSelector` (`InboxBase.sol:130-132`), but `batchProcessRequests` never re-applies that check to miner-supplied `MinedRequest` fields. Worth checking whether a miner-crafted one-way incoming request can still produce a zero-gas system-callback.

- **Uniswap V2 spot adapter remains in the codebase** &nbsp;[UniswapPriceOracle.sol:62-88] — flash-loan-manipulable within a single block; its own NatSpec recommends against production use. Worth confirming deployment configs never wire this as the live `priceOracle` on mainnet.

- **`respond`/`raise` bypass `messageProcessingPaused`** &nbsp;[X-2](invariants.md#x-2) — the pause flag is checked only in `InboxMiner.sol:37,159`, not in `InboxBase.sol:143,182`. Narrow window (only reachable from an already in-flight ingestion call), but worth confirming the pause's documented scope matches its actual coverage.

### Upgrade Architecture Concerns

No proxy pattern in scope. `Inbox` uses a one-time `Initializable` guard behind a deterministic CreateX `deployCreate3AndInit` path — the constructor sets a placeholder owner (`address(1)`) specifically to remove the front-running window that a split deploy-then-initialize would otherwise create (`Inbox.sol:15-17`). This is a deliberate, documented mitigation, not a gap.

### Protocol-Type Concerns

**As a Bridge:**
- No replay protection beyond per-source nonce contiguity (`InboxMiner.sol:44-63`) — there is no chain-reset/redeploy epoch mixed into the nonce namespace, so a CreateX redeploy at the same address would in principle reuse ids (only reachable under an exceptional chain state-reset; documented as an operational footgun in `audit/POD_INBOX_AUDIT.md` POD-13).
- Finality assumption is implicit — the miner alone decides when a source-chain event is "final enough" to relay; no explicit chain-reorg handling in scope.

### Composability & Dependency Risks

**Dependency Risk Map:**

> **Registered Miner (off-chain)** — via `InboxMiner.batchProcessRequests()`
> - Assumes: every field of `MinedRequest` faithfully reflects a real source-chain `MessageSent` event.
> - Validates: only `onlyMiner` + per-source nonce contiguity + non-zero `sourceContract`/`targetContract`.
> - Mutability: fully miner-controlled per call; owner can add/remove miners at will.
> - On failure: no failure mode — a malicious miner's forged data is indistinguishable from real data on-chain.

> **Band StdReference / Chainlink Aggregator** — via `BandLiveOracle.getLivePrice()` / `ChainlinkLiveOracle.getLivePrice()`
> - Assumes: fresh, positive, non-zero price.
> - Validates: staleness (`maxStaleness`), non-zero rate, Chainlink round completeness (`answeredInRound >= roundId`) — both adapters never revert, fail closed to `(false, 0)`.
> - Mutability: immutable feed addresses per adapter deployment; owner can repoint via `setFeed`.
> - On failure: caller (`PriceOracle._pullCachedPrice`) falls back to the last cached value — fail-open at the caching layer, despite fail-closed adapters.

> **Uniswap V2 Pair** — via `UniswapPriceOracle._spotPrice()`
> - Assumes: reserves reflect fair market value.
> - Validates: only non-zero base reserve (reverts `UniswapPriceOracleZeroReserves`).
> - Mutability: fully manipulable within a block via flash loan.
> - On failure: reverts only on zero reserves; otherwise returns a manipulated price silently.

**Token Assumptions** *(unvalidated only)*:
- None in scope — the inbox moves only native coin as fee, no ERC20 token transfers occur in this repo.

---

## 3. Invariants

> ### 📋 Full invariant map: **[invariants.md](invariants.md)**
>
> A dedicated reference file contains the complete invariant analysis — do not look here for the catalog.
>
> - **14 Enforced Guards** (`G-1`…`G-14`) — per-call preconditions with `Check` / `Location` / `Purpose`
> - **7 Single-Contract Invariants** (`I-1`…`I-7`) — Conservation, Bound, Temporal, Ratio
> - **3 Cross-Contract Invariants** (`X-1`…`X-3`) — caller/callee pairs that cross scope boundaries
> - **2 Economic Invariants** (`E-1`…`E-2`) — higher-order properties deriving from `I-N`/`X-N`
>
> Every inferred block cites a concrete Δ-pair, guard-lift + write-sites, state edge, temporal predicate, or NatSpec quote. The **On-chain=No** blocks are the high-signal ones. Attack-surface bullets above cross-link directly into the relevant blocks.

---

## 4. Documentation Quality

| Aspect | Status | Notes |
|--------|--------|-------|
| README | Present | `README.md` — explains the split with `@coti-io/coti-contracts` and the `pod-ecosystem-integration` workspace |
| NatSpec | Thorough | `@notice`/`@dev`/`@param`/`@return` present on nearly every public/external function across all 14 in-scope files (verified by direct read) |
| Spec/Whitepaper | Present (informal) | `audit/POD_INBOX_AUDIT.md` — a prior internal security review with an architecture diagram and 14 tracked findings; not a spec, but the authoritative trust-model document |
| Inline Comments | Thorough | Extensive `@dev` rationale comments explaining non-obvious invariants (e.g. the POD-02/POD-04 fix rationale is documented inline at the fix site) |

---

## 5. Test Analysis

| Metric | Value | Source |
|--------|-------|--------|
| Test files | 18 | File scan (always reliable) |
| Test functions | 55 | File scan (always reliable) |
| Line coverage | Unavailable — dependencies not installed (`node_modules` empty; `npx` unavailable in this run) | Coverage tool (requires compilation) |
| Branch coverage | Unavailable — same reason | Coverage tool (requires compilation) |

### Test Depth

| Category | Count | Contracts Covered |
|----------|-------|-------------------|
| Unit | 55 | broad (per `package.json`: `test:inbox-events`, `test:inbox-fee` suites) |
| Stateless Fuzz | 0 | none |
| Stateful Fuzz (Foundry) | 0 | N/A — Hardhat project |
| Formal Verification | 0 | none |

### Gaps

No fuzz, property-based, or formal-verification tooling of any kind (Echidna/Medusa/Foundry-fuzz/Halmos/Certora all absent) despite math-heavy logic in scope: bit-packing (`_packRequestId`/`_unpackRequestId`), gas-budget conversion arithmetic (`InboxFeeManager`), and price normalization across decimals (`ChainlinkFeedLib._normalizeTo18`) — exactly the class of logic where unit tests miss edge cases. No fork tests despite the multi-chain design (`hardhat.config.ts` targets Sepolia, Fuji, and COTI testnet) — cross-chain nonce/id interactions are untested against real chain state.

---

## 6. Developer & Git History

> Repo shape: normal_dev — 22 commits over a 35-day window (2026-06-29 → 2026-08-03), 16 of which touch source files.

### Contributors

| Author | Commits | Source Lines (+/-) | % of Source Changes |
|--------|--------:|--------------------|--------------------:|
| Naiem | 22 | +3971 / -1203 | 100% |

Single-developer dominance (100%) — no second contributor visible on this branch.

### Review & Process Signals

| Signal | Value | Assessment |
|--------|-------|------------|
| Unique contributors | 1 | Single-dev |
| Merge commits | 0 of 22 (0%) | No merge commits — no PR-based review visible on this branch |
| Repo age | 2026-06-29 → 2026-08-03 | 35 days |
| Recent source activity (30d) | 13 commits | Active — includes a late dependency-migration commit |
| Test co-change rate | 81.2% | Most source-changing commits also touch tests |

### File Hotspots

| File | Modifications | Note |
|------|-------------:|------|
| `InboxMiner.sol` | 10 | Highest churn — also carries the miner-trust boundary (I-5) and retry-safety invariant (I-2) |
| `InboxBase.sol` | 9 | Core send/receive/response logic |
| `IInbox.sol`* | 7 | *Now lives in `@coti-io/coti-contracts` — moved out by commit `7c8a686` |
| `fee/uniswap/UniswapPriceOracle.sol` | 3 | Manipulable adapter (POD-08), unchanged since introduction |
| `fee/PriceOracle.sol` | 3 | Includes the POD-05 fix |
| `fee/PoDPriceOracle.sol` | 3 | — |
| `Inbox.sol` | 3 | — |

### Security-Relevant Commits

**Score** = weighted sum of fix-like signals (message keywords, diff patterns, access-control/accounting touches, change focus). **10+ warrants a manual diff.**

| SHA | Date | Subject | Score | Key Signal |
|-----|------|---------|------:|------------|
| `d94f2c0` | 2026-07-20 | fix(POD-02): cap inbox target returndata to protect nonce queue | 18 | bug fix, spans 4 security domains |
| `e08b402` | 2026-07-20 | docs(POD-09): clarify executed means return leg received | 13 | tightens access-control docs |
| `cf9b1c2` | 2026-07-20 | fix(POD-07): bound fee gas reference with basefee and floor/ceiling | 13 | bug fix, tightens access control |
| `8853abe` | 2026-07-20 | fix(POD-05): remove single-leg oracle refreshCache overload | 13 | bug fix, net code removal |
| `7c8a686` | 2026-08-03 | Depend on @coti-io/coti-contracts for shared PoD APIs | 12 | very large change (967 lines), removes guards locally (moved, not deleted) |
| `3ef4663` | 2026-07-20 | fix(POD-04): revert retry on encode failure without flipping error code | 12 | bug fix, focused change |
| `bd2b0e0` | 2026-06-30 | Fix further audit fixes | 12 | bug fix, rewrites access control |
| `e9a6c9d` | 2026-06-29 | Migration from pod-mpc-core | 11 | very large change (2446 lines) |
| `4ad640b` | 2026-07-22 | Fixing github found bugs | 10 | adds runtime guards |
| `68f166a` | 2026-07-20 | fix(POD-06): reject errorSelector on one-way sends | 10 | bug fix, focused change |

### Dangerous Area Evolution

| Security Area | Commits | Key Files |
|--------------|--------:|-----------|
| access_control | 14 | `InboxBase.sol`, `InboxMiner.sol`, `MinerBase.sol` |
| oracle_price | 14 | `InboxBase.sol`, `fee/PoDPriceOracle.sol`, `fee/PriceOracle.sol` |
| signatures | 13 | `InboxBase.sol`, `InboxMiner.sol` |
| state_machines | 10 | `InboxMiner.sol` |
| fund_flows | 3 | `fee/PoDPriceOracle.sol` |

### Technical Debt Markers

None found — no TODO/FIXME/HACK markers in scope.

### Security Observations

- **Single-developer dominance** — Naiem authored 100% of commits and 100% of source lines.
- **No peer-review signal** — 0 merge commits across 22 commits on this branch.
- **Highest-churn file is also the highest-trust file** — `InboxMiner.sol` (10 modifications) carries the miner-trust boundary (POD-01) and the retry-safety fix (POD-04).
- **Batch fix landing** — 5 of 6 POD-numbered fix commits landed on the same day (2026-07-20), then the repo was later split via dependency extraction (`7c8a686`, 2026-08-03).
- **fix_without_test_rate = 20%** — most fix commits included test changes, but 1 in 5 did not.

### Cross-Reference Synthesis

- **5 of the repo's own 6 fix-severity audit findings are resolved in this tree** — POD-02 (`d94f2c0`), POD-04 (`3ef4663`), POD-05 (`8853abe`), POD-06 (`68f166a`, residual narrow gap for miner-supplied data — see [E-2](invariants.md#e-2)), and POD-07 (`cf9b1c2`) were all verified fixed by direct source comparison against `audit/POD_INBOX_AUDIT.md`, matching the git fix-commit trail exactly → the accurate current risk surface is the **by-design** findings (POD-01 miner trust, POD-08 Uniswap spot, POD-10 no escrow, POD-11 no timelock), not the fixed items.
- **`InboxMiner.sol` churn (10 commits) concentrates exactly where the miner-trust (I-5) and retry-safety (I-2) invariants live** → highest-leverage file for any re-audit.
- **Zero merge commits + single developer** → the 2026-07-20 batch of 5 fixes has no visible second-reviewer signoff on this branch; the `audit/` document itself appears to be that external review record.

---

## X-Ray Verdict

**FRAGILE** — unit tests exist and documentation is thorough, but zero fuzz/formal-verification tooling and zero timelock/multisig on a single-owner, single-developer codebase pull the tier down.

**Structural facts:**
1. 1,502 nSLOC across 4 subsystems (inbox core, fee management, price oracle core, oracle adapters), 14 in-scope contracts.
2. 0 upgradeable/proxy contracts — `Inbox` uses a one-time `Initializable` guard behind deterministic CreateX deployment instead.
3. 1 developer authored 100% of 22 commits and 100% of source lines over a 35-day window; 0 merge commits.
4. 29 total entry points: 4 permissionless, 8 role-gated, 16 admin-only, 1 one-time initializer (see [entry-points.md](entry-points.md)).
5. 5 of 6 fix-severity findings from the repo's own prior internal audit are verified resolved in the current tree by direct source comparison.
