# PoD Inbox & Message-Passing — Internal Security Review

**Scope:** `coti-pod-inbox-contracts/contracts/` — `InboxBase.sol`, `Inbox.sol`, `InboxMiner.sol`, `MinerBase.sol`, `InboxUser.sol`, `IInbox.sol`, `IInboxMiner.sol`, `MpcAbiReEncode.sol`, `fee/InboxFeeManager.sol`, `fee/PriceOracle.sol`, `fee/PoDPriceOracle.sol`, and the fee/oracle adapter stack (Chainlink, Band, Uniswap). Builder library `MpcAbiCodec` lives in coti-contracts. The vendored `utils/mpc/MpcCore.sol` was reviewed only at its integration surface (`validateCiphertext`, `onBoard`/`offBoard`), not line-by-line.

**Method:** full manual read of the in-scope contracts, tracing outbound send → mined ingestion → target execution → response/error return legs, including the staged system-error change-set. This is a read-and-report review; no contract code was modified.

**Working-tree state:** branch `naiem/audit_fix_1` at `0913c69`, with the system-error callback change-set staged (`SYSTEM_SENDER`, `inboxErrorType()`, `_sendSystemErrorCallback`, `ErrorData`/`InboxErrorType` in `IInbox`). `npx hardhat compile` succeeds ("No contracts to compile" — artifacts current) and the focused `InboxSystemErrorCallback` test compiles against this tree. The reconciled oracle/`Ownable` constructor issue seen on the older `naiem/fixes` branch is not present here (`Inbox` calls `Ownable(address(1))`, the two-token `PriceOracle` implements `refreshCache`).

---

## 1. Architecture & trust model

```
 Source chain (Sepolia / Fuji)                          COTI chain
 ┌────────────────────────────┐                   ┌────────────────────────────┐
 │ dApp (InboxUser)           │                   │ dApp / PodErc20CotiMother   │
 │   sendOneWay/TwoWayMessage │                   │   target.call{gas}(calldata)│
 │        │  msg.value (wei)   │                   │        │ respond()/raise()  │
 │        ▼                    │  MessageSent log  │        ▼                    │
 │  requests[id] ─────────────┼──────────────────▶│      off-chain MINER        │
 │  incomingRequests[id] ◀────┼─ batchProcess ────┼──  (relays payload)         │
 │        (onlyMiner)         │   Requests()      │                             │
 └────────────────────────────┘                   └────────────────────────────┘
```

**Ingestion is miner-trusted.** `batchProcessRequests` is the only inbound path. The only on-chain checks are (a) `onlyMiner`, (b) the request id encodes the batch `sourceChainId` as source and this chain as target, and (c) strict per-source nonce contiguity. Every semantic field — `sourceContract`, `targetContract`, `methodCall`, selectors, `isTwoWay`, `sourceRequestId`, and both fee budgets — is taken verbatim from miner input. There is no cryptographic link between an `incomingRequests[id]` entry and a real `MessageSent` event on the origin chain.

`**msg.value` does not cross chains.** The inbox keeps the native fee locally; remote execution gas is fronted by the miner. `Request.targetFee`/`callerFee` are *gas-unit budgets* (a `call{gas}` cap), not escrowed value.

**Downstream authentication resolves to miner-supplied data.** `inboxMsgSender()` returns `(_currentContext.remoteChainId, _currentContext.remoteContract)`, and `remoteContract` is set from the incoming request's `originalSender`, which is the miner-supplied `sourceContract`. Every peer check in the pERC20/portal stack therefore reduces to trusting the miner set.

**Owner powers.** A single owner (set atomically in `Inbox.init`) controls the miner set (`MinerBase`), the price oracle wiring, fee templates, the message-processing pause switch, and `collectFees` (sweeps the entire native balance). No timelock.

The dominant risk is trust in the miner set; it is treated as a By-Design item (§3) with concrete impact and alternatives.

---

## 2. Findings


| ID     | Title                                                                                    | Severity             |
| ------ | ---------------------------------------------------------------------------------------- | -------------------- |
| POD-01 | Fully trusted miner can forge or impersonate any cross-chain message                     | Critical (by design) |
| POD-02 | Unbounded target revert data can wedge a contiguous source-chain queue                   | High                 |
| POD-03 | Execution reverts deliberately remain pending and retryable                              | Informational (by design) |
| POD-04 | Permissionless retry can overwrite the error code and permanently disable retries        | Medium               |
| POD-05 | Public single-leg oracle refresh advances the shared timestamp and starves the other leg | Medium               |
| POD-06 | System-error / `raise` return leg carries a zero-gas budget for one-way requests         | Medium               |
| POD-07 | Fee budget is sized from caller-influenced `tx.gasprice`                                 | Medium               |
| POD-08 | Uniswap spot-reserve adapter is flash-loan manipulable (if used)                         | Medium (conditional) |
| POD-09 | Original one-way request is finalized before the return-leg callback is confirmed        | Low                  |
| POD-10 | `collectFees` sweeps everything, including unspent prepaid budgets                       | Low                  |
| POD-11 | Owner/miner centralization, no timelock; permissionless `retryFailedRequest`             | Low                  |
| POD-12 | Legacy peer-authenticated error handlers reject legitimate `SYSTEM_SENDER` callbacks     | Low (integration)    |
| POD-13 | Deterministic redeploy could reuse request ids (only under a chain state-reset)          | Informational        |
| POD-14 | `_currentContext` is a single shared slot; codec trailing-byte mask is latent            | Informational        |


---

### POD-01 — Fully trusted miner can forge or impersonate any message (Critical, by design)

`batchProcessRequests` accepts miner-supplied data wholesale and stores `originalSender`/`callerContract` from `minedRequest.sourceContract`:

```61:76:contracts/InboxMiner.sol
            Request memory newIncomingRequest = Request({
                requestId: requestId,
                targetChainId: sourceChainId,
                targetContract: minedRequest.targetContract,
                methodCall: minedRequest.methodCall,
                callerContract: minedRequest.sourceContract,
                originalSender: minedRequest.sourceContract,
                ...
```

Downstream authentication (`PodERC20.transferCallback` peer match, `PodErc20CotiMother.onlyRegisteredPTokenMessage`, and all `inboxMsgSender()` peer checks) resolves to this miner-controlled value. A single malicious or compromised miner can therefore:

- **Mint/move private balances arbitrarily.** Deliver a forged incoming request with `sourceContract` = a registered pToken/factory and `methodCall` = `mint(...)` / `registerToken(...)`; the mother's `onlyRegisteredPTokenMessage` / `onlyRegisteredFactoryMessage` gates pass.
- **Break portal solvency.** Deliver a forged `transferCallback` marking a withdrawal's `transferRequestId` as `Success` with no real pToken burn; the portal then releases underlying collateral (see PP-01 in the PrivacyPortal report).
- **Forge system errors** by asserting `sourceContract = SYSTEM_SENDER` (see POD-12), driving spurious `SystemFailed` refunds.
- **Censor or stall** any request; there is no liveness guarantee.

Non-miner callers cannot reach any of this: `onlyMiner` + nonce contiguity fully gate ingestion, and `SYSTEM_SENDER` is unreachable on the send path because `_createRequest` always stamps `requestSender = msg.sender` for public sends. So the blast radius is precisely "trust in the miner set," not an open exploit.

**Safer alternatives (increasing cost/robustness):**

1. **Payload commitment + receipt/light-client proof** — require the miner to prove `MessageSent(requestId, …)` was emitted by the canonical inbox on the source chain, verified against a source-chain header/state root. Eliminates payload forgery.
2. **M-of-N miner attestation** — require `k` independent signatures over `keccak256(requestId, sourceContract, targetContract, methodCallHash, fees, selectors)` before acceptance. Cheap, large robustness gain vs. a single relayer.
3. **Optimistic fraud window** — accept a batch but delay settlement by a challenge period during which a watcher can submit a fraud proof that slashes a bonded miner.

Ship at least (2) before mainnet and document the trust assumption prominently for integrators.

---

### POD-02 — Unbounded target revert data can wedge a contiguous source-chain queue (High)

The target subcall uses Solidity's high-level `call`, which copies the entire return/revert payload into memory; on failure the inbox stores and emits it in full:

```210:230:contracts/InboxMiner.sol
        bool success;
        bytes memory returnData;
        (success, returnData) = targetContract.call{gas: targetGasBudget}(callData);
        ...
        if (!success) {
            bytes32 rid = incomingRequest.requestId;
            errors[rid] = Error({
                requestId: rid,
                errorCode: ERROR_CODE_EXECUTION_FAILED,
                errorMessage: returnData
            });
            emit ErrorReceived(rid, ERROR_CODE_EXECUTION_FAILED, returnData);
        }
```

A source-chain user can legitimately target a contract that reverts with a very large payload (or returns a huge blob that is copied on failure). Copying, storing, and logging that payload can exhaust the destination transaction's post-call gas and revert the whole `batchProcessRequests`. Because incoming nonces must be contiguous and `lastIncomingRequestId` only advances after the batch completes, the miner cannot skip the offending request — all later traffic from that source chain is blocked.

**Recommendation:** make the target call in assembly with a bounded `returndatacopy`; retain only a capped prefix plus `keccak256(returndata)` and total length, and reserve enough post-call gas to commit the failed-request state so the queue always progresses.

---

### POD-03 — Execution reverts deliberately remain pending and retryable (Informational, by design)

The auto system-error return leg is only produced on MPC **encode** failure:

```196:204:contracts/InboxMiner.sol
        if (!encodedOk) {
            _recordEncodeError(incomingRequest.requestId, encodeErr);
            _sendSystemErrorCallback(incomingRequest, encodeErr);
            ...
```

A target **execution** revert only writes `errors[requestId]` and emits `ErrorReceived`; it deliberately creates no return leg. The request remains eligible for `retryFailedRequest`, allowing transient failures such as insufficient execution gas to be retried. A source application (e.g. `PodERC20`) therefore remains `Pending` until a retry succeeds. By contrast, an application that determines the failure is terminal must call `inbox.raise()`, which delivers the source `errorSelector`.

These outcomes must remain mutually exclusive: automatically invoking `errorSelector` for an execution revert would terminally settle source state while the destination request remained retryable, allowing a later successful retry to conflict with the prior failure callback.

**Recommendation:** document and test the protocol rule: `revert` means retryable/non-terminal; `raise` means terminal/application failure; encode/system failure means terminal/non-retryable. If indefinite retries are undesirable, add an explicit cancellation/finality transition that atomically disables retry before notifying the source.

---

### POD-04 — Permissionless retry can overwrite the error code and permanently disable retries (Medium)

`retryFailedRequest` is permissionless and only starts for `ERROR_CODE_EXECUTION_FAILED`. If `_safeEncodeMethodCall` fails during the retry, it overwrites the error with code 2 and returns:

```146:167:contracts/InboxMiner.sol
        uint256 errorCode = errors[requestId].errorCode;
        if (!incomingRequest.executed || errorCode != ERROR_CODE_EXECUTION_FAILED) {
            revert RetryFailedRequestNotAFailedRequest();
        }
        ...
        if (!encodedOk) {
            _recordEncodeError(requestId, encodeErr);
            _currentContext = ExecutionContext({remoteChainId: 0, remoteContract: address(0), requestId: bytes32(0)});
            return;
        }
```

Because retry is permissionless and the caller controls gas, an attacker can drive a gas-constrained retry against expensive MPC encoding. If the inner self-call to `_encodeMethodCallExternal` runs out of gas while enough EIP-150-reserved gas remains to execute `_recordEncodeError`, the stored error flips from code 1 to code 2. Every later `retryFailedRequest` then fails the code-1 guard (`RetryFailedRequestNotAFailedRequest`), permanently disabling recovery for that request. The retry path also never emits a system callback, so the source is not notified.

**Recommendation:** revert the whole retry on encode failure (preserving the original execution error), or explicitly permit retrying both codes while preventing duplicate/again-failing state; either way, keep retry eligibility stable.

---

### POD-05 — Public single-leg oracle refresh starves the other price leg (Medium)

Anyone may call `refreshCache(address token)`; it updates only one leg but advances the single shared `lastFetchTimestamp`:

```83:108:contracts/fee/PriceOracle.sol
    function refreshCache(address token) external {
        if (token != localToken && token != remoteToken) {
            revert UnknownToken(token);
        }
        if (!_fetchIntervalsElapsed()) {
            return;
        }
        lastFetchTimestamp = block.timestamp;
        cachedPriceUSD[token] = _pullCachedPrice(token);
        _afterRefreshCache();
    }

    function _refreshInboxCache() internal {
        if (!_fetchIntervalsElapsed()) {
            return;
        }
        ...
```

An attacker who calls `refreshCache(localToken)` once per interval keeps `lastFetchTimestamp` fresh, so every full two-leg `_refreshInboxCache()` (invoked at the end of `sendOneWayMessage`/`sendTwoWayMessage`) returns early and the other leg stays stale. Fee validation also reads the cache *before* the send path refreshes it, and `PoDPriceOracle._pullCachedPrice` retains the old cached value when a live read returns zero. There is no maximum cache-age check, so a favorable stale local/remote ratio can be pinned indefinitely, causing under-funded remote execution or a miner subsidy.

**Recommendation:** use per-token timestamps (or remove the public single-leg refresh), refresh both prices before fee validation, and reject cache entries older than a configured maximum.

---

### POD-06 — One-way return legs get a zero system-callback / `raise` budget (Medium)

`_sendSystemErrorCallback` (and `raise`/`respond`) reuse the incoming request's `callerFee` as the return-leg `targetFee`:

```491:501:contracts/InboxBase.sol
        bytes32 outboundRequestId = _sendOneWayMessage(
            incomingRequest.targetChainId,
            sourceApp,
            errorMethodCall,
            incomingRequest.errorSelector,
            incomingRequest.requestId,
            incomingRequest.callerFee,
            0,
            SYSTEM_SENDER
        );
```

Public one-way messages store `callerFee = 0` (`sendOneWayMessage` passes `callerFeeGas = 0`). When the source chain later executes that return leg, `_localRequestExecutionBudget(0)` yields `0`, so the source `errorSelector` handler is invoked with `call{gas: 0}` and OOGs for any non-trivial handler — the system error/`raise` is silently dropped and the request lingers. Two-way flows (the portal's mint/transfer requests) always fund `callerFee > 0`, so the primary product paths are unaffected; hence Medium.

**Recommendation:** if `callerFee == 0`, either skip emitting a return leg that cannot execute (rely on `errors[requestId]` + `ErrorReceived`/`SystemErrorRaised`), or require and reserve a minimum system-callback budget so the source handler can run.

---

### POD-07 — Fee budget depends on caller-influenced `tx.gasprice` (Medium)

Both fee validators convert prepaid wei into gas-unit budgets by dividing by `tx.gasprice`:

```146:149:contracts/fee/InboxFeeManager.sol
        uint256 gasPrice = tx.gasprice != 0 ? tx.gasprice : DEFAULT_GAS_PRICE;
        callerGasLocalUnits = callbackFeeLocalWei / gasPrice;
        uint256 remoteGasWei = totalFeeLocalWei - callbackFeeLocalWei;
        targetGasRemoteUnits = Math.mulDiv(remoteGasWei / gasPrice, localPrice, remotePrice);
```

The stored gas budget (the miner's `call{gas}` cap) scales inversely with the caller-chosen `tx.gasprice`. A low `tx.gasprice` buys a larger gas-unit budget for the same wei (miner contracted to spend more than the fee covers); a high one can trip the `TargetFeeTooLow`/`CallbackFeeTooLow` floors. The abuse is bounded because a transaction must still pay at least the network base fee to be included, but coupling *fee sizing* to a *caller-chosen field* — and using the source-chain gas price as a proxy for destination execution cost — is fragile across chains with different fee markets.

**Recommendation:** size budgets from an oracle-driven or governance-set reference gas price with an explicit floor/ceiling; if `tx.gasprice` must be used, document the over/under-charge envelope.

---

### POD-08 — Uniswap spot-reserve adapter is manipulable (Medium, conditional)

`UniswapPriceOracle._spotPrice` reads instantaneous V2 reserves:

```62:76:contracts/fee/uniswap/UniswapPriceOracle.sol
    function _spotPrice(IUniswapV2Pair pair, bool baseIsToken0) private view returns (uint256) {
        (uint112 r0, uint112 r1,) = pair.getReserves();
        ...
        return Math.mulDiv(quote, PRICE_SCALE, base);
    }
```

Spot reserves are flash-loan manipulable within a block; if this adapter feeds fee conversion, an attacker can distort the local/remote ratio to mis-size fee budgets. The adapter's own NatSpec acknowledges this ("prefer TWAP or trusted feeds in production"). The Chainlink adapter (`ChainlinkFeedLib.tryReadPrice`) correctly guards staleness, non-positive answers, and incomplete rounds, and is the right production choice.

**Recommendation:** do not use the raw Uniswap spot adapter on mainnet; if kept for testnets, gate it behind config and prefer the feed adapters.

---

### POD-09 — Original one-way request finalized before return-leg delivery is confirmed (Low)

After processing a linked one-way response/error leg, the batch marks the *original* outbound request `executed = true` without checking that the return-leg target call succeeded:

```99:108:contracts/InboxMiner.sol
            if (incomingRequest.requestId != bytes32(0) && incomingRequest.sourceRequestId != bytes32(0)
                && !incomingRequest.isTwoWay) {
                bytes32 originalRequestId = incomingRequest.sourceRequestId;
                Request storage originalRequest = requests[originalRequestId];

                if (originalRequest.requestId != bytes32(0) && !originalRequest.executed) {
                    originalRequest.executed = true;
                    emit IncomingResponseReceived(originalRequestId, incomingRequest.requestId);
                }
            }
```

This can report completion while the application callback actually reverted and remains pending. The failed return leg is itself eligible for permissionless `retryFailedRequest`, so it is not necessarily permanent; severity is Low. Off-chain consumers must not treat `originalRequest.executed` or `IncomingResponseReceived` as proof that the callback committed.

**Recommendation:** set the flag only after successful return-leg execution, or rename/document it as "return leg received," not "application handled."

**Resolution:** `Request.executed` / `IncomingResponseReceived` remain “return leg received” (indexers unchanged). Additive `ReturnLegCallbackSucceeded` fires only when the return-leg target call did not record an execution/encode error.
---

### POD-10 — `collectFees` sweeps everything, including unspent prepaid budgets (Low)

```55:60:contracts/fee/InboxFeeManager.sol
        uint256 amount = address(this).balance;
        if (amount == 0) {
            return;
        }
        (bool ok,) = to.call{value: amount}("");
```

The inbox holds every caller's prepaid `msg.value` with no per-request accounting of consumed-vs-prepaid budget, so `collectFees` cannot leave behind refunds for over-funded or censored requests. This is consistent with the documented "prepay, non-refundable" revenue model (the native balance is protocol revenue, not a segregated escrow), so it is informational rather than a defect — but there is no path to return an unspent budget to a censored/over-funded user.

**Recommendation:** document explicitly, or track consumed-vs-prepaid per request to enable a refund path.

---

### POD-11 — Centralization and permissionless retry (Low)

Single-owner control of the miner set, oracle wiring, fee templates, pause, and full-balance `collectFees`, with no timelock. Standard for a launch but should be a multisig + timelock before mainnet. `retryFailedRequest` is intentionally permissionless (caller pays gas) and shares the `nonReentrant` guard with ingestion; the original failed call reverted and committed no state, so success-path re-execution is safe (aside from the griefing path in POD-04). Acceptable; noting for completeness.

---

### POD-12 — Error-handler migration hazard for `SYSTEM_SENDER` (Low, integration)

System callbacks intentionally expose `inboxMsgSender() == SYSTEM_SENDER` rather than the real COTI peer:

```37:43:contracts/InboxBase.sol
    /// @notice Placeholder `originalSender` for Inbox-generated system-error return legs (not a real contract).
    ...
    address public constant SYSTEM_SENDER = address(uint160(uint256(keccak256("POD_INBOX_SYSTEM_SENDER"))));
```

Older source handlers that require the configured COTI peer will reject valid system errors and leave source state `Pending`. `PodERC20` has migrated to `onlyInbox` + `inboxErrorType()` + non-zero `inboxSourceRequestId()` (`_errorCallbackContext`), which is correct, but external integrations may not have. The new `inboxErrorType()` logic itself is sound: it returns `SystemError` only when `originalSender == SYSTEM_SENDER`, `Exception` only for a linked leg whose original request registered an `errorSelector`, and `NotErrorContext` otherwise.

**Recommendation:** publish a mandatory migration note and provide a reusable `InboxUser` error-context helper.

---

### POD-13 — Deterministic redeploy id reuse (Informational)

Request ids pack `sourceChainId(64) | targetChainId(64) | nonce(128)` with per-target nonces (`++_requestNonce[targetChainId]` in `_createRequest`). A redeploy at the same CreateX address would reset nonces and `lastIncomingRequestId` to zero, in principle reusing ids and replaying stale batches. In practice CREATE3 cannot overwrite an address that still holds code, and this inbox has no `selfdestruct` or proxy-upgrade path, so this is only reachable under an exceptional chain state-reset/deletion. Documented as an operational footgun, not a live risk.

**Recommendation:** if a redeploy is ever contemplated, mix a deployment epoch/version into the nonce namespace and write a drain-and-bump runbook.

---

### POD-14 — Shared context slot and latent codec mask (Informational)

`_currentContext` is a single storage struct set before a target call and reset to zero on every exit (success, encode-failure, retry). Because ingestion is `nonReentrant`, nested inbound execution cannot interleave, so one slot is sufficient and never leaks stale context; `respond`/`raise` are correctly gated on `msg.sender == incomingRequest.targetContract` plus a non-zero context.

Separately, `MpcAbiCodec._copyBytes` masks the trailing partial word from the low-order bytes, which is the wrong end for big-endian `bytes` layout. This is latent only: every caller copies word-aligned lengths (ABI tails are padded to 32; static args are `words * 32`), so `remaining` is always zero and the partial branch is dead code for well-formed input. Worth a comment or an assertion that lengths are word-aligned.

---

## 3. By-design trade-offs


| Trade-off                                                       | Risk carried                                                                                                       | Safer alternative                                                                                |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| **Trusted miner, no payload proof** (POD-01)                    | A compromised miner can forge messages → mint private balances, break portal solvency, forge system errors, censor | Receipt/light-client proof, or M-of-N attestation, or optimistic fraud window with bonded miners |
| **Prepay, non-refundable fee budgets** (POD-10)                 | Users cannot recover unspent/censored budgets; owner sweeps all balance                                            | Track consumed-vs-prepaid per request; add a user refund path                                    |
| `**tx.gasprice`-based budget sizing** (POD-07)                  | Fee/gas mismatch across fee markets; caller can nudge budget                                                       | Oracle/governance reference gas price with floor/ceiling                                         |
| **Permissionless `retryFailedRequest`** (POD-11)                | Anyone can re-drive a failed target call                                                                           | Safe on the success path (failures commit no state); fix the encode-flip griefing (POD-04)       |
| **Execution revert is retryable; `raise` is terminal** (POD-03) | A permanently reverting request leaves the source `Pending` until retry succeeds or explicit finality is added     | Document/test the distinction; cancellation must disable retry before notifying the source       |


---

## 4. Checklist


| Category                                    | Result           | Notes                                                                                                                                                 |
| ------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reentrancy (single/cross-fn/cross-contract) | Pass             | `batchProcessRequests`/`retryFailedRequest` share `nonReentrant`; `respond`/`raise` gated on target + context; `_currentContext` cleared on all exits |
| Read-only reentrancy                        | Pass             | No price/balance reads gate value transfer inside the inbox                                                                                           |
| Access control / modifiers                  | Pass             | `onlyMiner`, `onlyOwner`, `initializer` present; `_encodeMethodCallExternal` self-call-gated                                                          |
| Unprotected initializer                     | Pass             | `Inbox.init` is `initializer`; safe only via atomic CreateX deploy-and-init (documented)                                                              |
| `tx.origin` auth                            | Pass             | Not used                                                                                                                                              |
| Integer overflow/underflow                  | Pass             | 0.8 checked math; `_packRequestId` bounds source/target/nonce widths                                                                                  |
| Unchecked casts / bit truncation            | Warn             | Log counts truncate to `uint16` (cosmetic); codec trailing-byte mask latently wrong but unreachable (POD-14)                                          |
| Rounding / precision loss                   | Warn             | wei→gas integer division truncates budgets (POD-07); floors catch zero                                                                                |
| Unchecked external call returns             | Pass             | Target `call` success captured; `collectFees` transfer `require`d                                                                                     |
| Gas forwarding / 63-64 rule                 | Warn             | One-way system/`raise` callback can carry 0 gas (POD-06); retry gas griefing (POD-04)                                                                 |
| Unbounded returndata / loops                | **Fail**         | Full revert payload copied/stored/logged can wedge the contiguous queue (POD-02)                                                                      |
| Tx ordering / MEV                           | Pass             | Ingestion is miner-serialized by nonce; no user-facing ordering value                                                                                 |
| Signature / tx reuse                        | N/A              | No signatures in the inbox layer                                                                                                                      |
| Oracle robustness                           | Warn             | Uniswap spot manipulable (POD-08); single-leg refresh starvation (POD-05); feed adapters guard staleness/zero/negative                                |
| Uninitialized proxy / clone ordering        | Pass             | `Initializable` + `_disableInitializers` pattern                                                                                                      |
| `delegatecall` / selfdestruct               | Pass             | None used                                                                                                                                             |
| Unexpected ETH / `msg.value` accounting     | Warn             | No per-request refund accounting (POD-10)                                                                                                             |
| Centralization / timelock                   | Warn             | Single-owner, no timelock (POD-11)                                                                                                                    |
| Event / accounting integrity                | Warn             | Rich events, but `executed`/`IncomingResponseReceived` can precede callback commit (POD-09)                                                           |
| Pragma / opcodes                            | Pass             | `^0.8.20`, Paris-compatible (no PUSH0) per project constraint                                                                                         |
| **Source-chain authenticity / replay**      | **Fail**         | No payload proof; all peer auth reduces to miner trust (POD-01)                                                                                       |
| Nonce reordering / skipping                 | Pass             | Strict per-source contiguity enforced                                                                                                                 |
| RequestId packing collisions                | Pass             | Width-checked; reuse only under exceptional chain reset (POD-13)                                                                                      |
| Relayer censorship / selective execution    | Fail (by design) | Trusted miner may censor/stall; no liveness guarantee (POD-01)                                                                                        |
| Response/`raise`/system context integrity   | Pass             | Context checks + `SYSTEM_SENDER` attribution correct; system errors not retryable                                                                     |
| System-error authenticity / duplicates      | Warn             | Duplicate-guarded via `inboxResponses`; miner-forgeable (POD-01); undeliverable for one-way (POD-06); execution reverts intentionally remain retryable |
| Fee budget sensitivity                      | Warn             | POD-05 / POD-07 / POD-10                                                                                                                              |


**Legend:** Pass = no issue found; Warn = works but carries a documented risk; Fail = action required; N/A = not applicable.

---

## 5. Priority actions before launch

1. **POD-01** — implement at least M-of-N miner attestation (or receipt proofs) and document the trust model for integrators.
2. **POD-02** — cap copied returndata and guarantee the contiguous queue always progresses.
3. **POD-06** — ensure every advertised error callback carries an executable gas budget; document and test the retryable-`revert` vs terminal-`raise` rule from POD-03.
4. **POD-04** — preserve retry eligibility on a retry-time encode failure.
5. **POD-05 / POD-07** — decouple fee sizing from `tx.gasprice`, use per-token oracle timestamps, and enforce cache freshness.
6. **POD-08 / POD-11** — keep the Uniswap spot adapter off mainnet; move `owner` to a multisig + timelock.

