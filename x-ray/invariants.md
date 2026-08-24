# Invariant Map

> COTI PoD Inbox | 14 guards | 12 inferred | 6 not enforced on-chain

---

## 1. Enforced Guards (Reference)

Per-call preconditions. Heading IDs below (`G-N`) are anchor targets from x-ray.md attack surfaces.

#### G-1
`require(!_initialized, "Inbox: initialized")` · `InboxBase.sol:99` · One-time base initializer guard — prevents `chainId`/owner reconfiguration after deploy.

#### G-2
`require(msg.sender == incomingRequest.targetContract, "Inbox: only target can reply")` · `InboxBase.sol:153` (and `:192` for `raise`) · Ensures only the dApp that was the actual call target of the active incoming request can send a response/error leg back to the source chain.

#### G-3
`require(inboxResponses[incomingRequestId].responseRequestId == bytes32(0), "Inbox: reply already sent")` · `InboxBase.sol:149` (and `:188`) · One-shot reply guard — prevents a target from sending two responses for the same incoming request.

#### G-4
`require(minedNonce == allowedNonce, "Inbox: mined nonces must be contiguous")` · `InboxMiner.sol:60` · Enforces strict per-source-chain contiguous nonce ingestion so the miner cannot skip or reorder incoming requests.

#### G-5
`require(incomingRequest.requestId == bytes32(0), "Inbox: request already processed")` · `InboxMiner.sol:65` · Prevents the miner from re-submitting/duplicating an already-processed incoming request id.

#### G-6
`if (!incomingRequest.executed || errorCode != ERROR_CODE_EXECUTION_FAILED) revert RetryFailedRequestNotAFailedRequest()` · `InboxMiner.sol:168` · Restricts `retryFailedRequest` to requests that failed with a live execution-failure code.

#### G-7
`require(_miners[msg.sender], "MinerBase: caller is not a miner")` · `MinerBase.sol:19` (`onlyMiner`) · Gates all inbound batch ingestion to the owner-registered miner set — the entire authenticity root of the bridge.

#### G-8
`require(targetChainId != chainId, "Inbox: cannot send to same chain")` · `InboxBase.sol:424` · Prevents self-targeted (same-chain) cross-chain requests.

#### G-9
`if (totalFeeLocalWei == 0) revert TotalFeeTooLow(...)` / `if (callbackFeeLocalWei > totalFeeLocalWei) revert CallbackFeeTooLow(...)` · `InboxFeeManager.sol:184-192` · Ensures a two-way send always prepays a non-zero fee and the callback slice never exceeds the total.

#### G-10
`if (callerGasLocalUnits < expectedMinFee(...)) revert CallbackFeeTooLow(...)` / `if (targetGasRemoteUnits < expectedMinFee(...)) revert TargetFeeTooLow(...)` · `InboxFeeManager.sol:202,206` · Floors both fee legs against a payload-size-based minimum so a request cannot be sent underfunded.

#### G-11
`if (minGasPriceWei_ == 0) revert GasPriceBoundsInvalid(...)` / `if (maxGasPriceWei_ != 0 && maxGasPriceWei_ < minGasPriceWei_) revert GasPriceBoundsInvalid(...)` · `InboxFeeManager.sol:109-113` · Keeps the reference-gas-price bounds internally consistent (non-zero floor, ceiling ≥ floor when set).

#### G-12
`require(sourceChainId <= type(uint64).max, ...)` / `require(targetChainId <= type(uint64).max, ...)` / `require(nonce <= type(uint128).max, ...)` · `InboxBase.sol:544-546` · Bounds the fields packed into a `requestId` so packing/unpacking round-trips without truncation collisions.

#### G-13
`if (feed == address(0) || feed.code.length == 0) return (false, 0)` — no revert · `ChainlinkFeedLib.sol:19` (and equivalent in `BandFeedLib.sol:21`) · Oracle adapters fail closed to `(false, 0)` instead of reverting, so a misconfigured/unset feed cannot brick fee validation upstream — see [X-1](#x-1) for what happens to that `(false, 0)` one layer up.

#### G-14
`require(!_miners[miner], "MinerBase: already a miner")` (`addMiner`) / `require(_miners[miner], "MinerBase: not a miner")` (`removeMiner`) · `MinerBase.sol:27,35` · Idempotency guard on the miner registry, not a security boundary.

---

## 2. Inferred Invariants (Single-Contract)

Each block cites a Δ-pair, guard-lift, state-machine edge, temporal predicate, or NatSpec quote. Category definitions at the end of §2.

---

#### I-1

`StateMachine` · On-chain: **Yes**

> For each `sourceChainId`, `incomingRequests` can only be created with `nonce = allowedNonce` (the previous max + 1) — the sequence never skips or goes backward.

**Derivation** — guard-lift of [G-4](#g-4) (`require(minedNonce == allowedNonce)`, `InboxMiner.sol:60`). The sole write site of `lastIncomingRequestId[sourceChainId]` is `InboxMiner.sol:123`, executed only after every element in the batch has already passed G-4 in the same loop. Single write site, guard enforced there → Yes.

**If violated** — a gap would permanently stall ingestion from that source chain, since contiguity can never be satisfied again without an explicit skip/reset mechanism (none exists).

---

#### I-2

`Bound` · On-chain: **Yes**

> `retryFailedRequest` cannot degrade `errors[requestId].errorCode` from `EXECUTION_FAILED(1)` to `ENCODE_FAILED(2)` — a retry-time encode failure reverts the whole transaction instead of overwriting the code.

**Derivation** — guard-lift: the only writer of `errors[requestId].errorCode = 2` is `_recordEncodeError` (`InboxBase.sol:605-615`), called from exactly one site — `_executeIncomingRequest` (`InboxMiner.sol:215-217`), which runs only during initial `batchProcessRequests` ingestion. The retry path's own encode-failure branch (`InboxMiner.sol:182-187`) explicitly reverts (`RetryFailedRequestEncodeFailed`) without calling `_recordEncodeError`, per the inline comment citing the fix. All write sites of `errors[requestId].errorCode` accounted for → Yes.

**If violated** — N/A; this is a hardened finding. Note: the historical version of this gap (an earlier tree where retry-time encode failure *did* overwrite the code, permanently disabling recovery) is documented in `audit/POD_INBOX_AUDIT.md` (POD-04) and is confirmed fixed here by direct source comparison (commit `3ef4663`).

---

#### I-3

`Conservation` · On-chain: **No**

> Inbox native balance has no per-request escrow accounting — there is no running total distinguishing consumed fee from unspent/over-funded prepayment.

**Derivation** — negative-conservation finding: every `sendTwoWayMessage`/`sendOneWayMessage` receives `msg.value` (a Δ+ on the EVM balance) but `_createRequest` (`InboxBase.sol:412-471`) writes no matching storage accumulator. `_collectFees` (`InboxFeeManager.sol:71-79`) reads `address(this).balance` directly rather than any per-request tracked sum.

**If violated** — unspent/over-funded/censored prepayments cannot be distinguished from earned revenue; `collectFees` cannot leave refundable amounts behind for affected users.

---

#### I-4

`Bound` · On-chain: **Yes**

> When `messageProcessingPaused` is true, both `batchProcessRequests` and `retryFailedRequest` revert.

**Derivation** — guard-lift: `InboxMiner.sol:37-39` and `:159-161` both check the same storage bool with the same revert (`MessageProcessingPaused()`); the only writer is `setMessageProcessingPaused` (`onlyOwner`). Both read-guard sites covered → Yes.

**If violated** — N/A; positive coverage finding for the two functions checked. Note `respond`/`raise` are **not** gated by this flag — see [X-2](#x-2).

---

#### I-5

`Bound` · On-chain: **No**

> `onlyMiner` is the sole authentication for `batchProcessRequests`, with no additional payload-authenticity check tying an incoming request to a real source-chain event.

**Derivation** — guard-lift: the only guard at `InboxMiner.sol:32-35` is `onlyMiner` (G-7). Every field of `MinedRequest` (`sourceContract`, `targetContract`, `methodCall`, both fee budgets) is miner-supplied with no signature, merkle proof, or light-client check anywhere in scope.

**If violated** — a single compromised or malicious registered miner can forge arbitrary incoming messages. Documented as by-design in `audit/POD_INBOX_AUDIT.md` (POD-01); included here as the codebase's dominant structural invariant gap because every downstream trust assumption (see [X-3](#x-3)) reduces to it.

---

#### I-6

`Temporal` · On-chain: **Yes**

> `refreshCache()` cannot write `cachedPriceUSD`/`lastFetchTimestamp` more than once per `fetchInterval` seconds (when `fetchInterval != 0`).

**Derivation** — temporal guard `PriceOracle.sol:157` (`block.timestamp - lastFetchTimestamp < fetchInterval` → early return) gates the only automatic writer of `lastFetchTimestamp`, inside `_refreshInboxCache` (`PriceOracle.sol:87`). `setLocalTokenPriceUSD`/`setRemoteTokenPriceUSD` (a separate `onlyPriceAdmin` writer) intentionally bypass the interval — documented admin override, not a violation.

**If violated** — N/A; holds structurally. The residual concern is the *shared single timestamp* covering both legs together — see [X-1](#x-1).

---

#### I-7

`Ratio` · On-chain: **Yes**

> `targetGasRemoteUnits = (feeWei / gasPrice) * localPriceUSD / remotePriceUSD` (via `Math.mulDiv`).

**Derivation** — `InboxFeeManager.sol:200,226`. Snapshot ordering check: `_referenceGasPrice()` and `_validatedOraclePrices()` are both read fresh within the same call, before the ratio is applied, with no intervening state-changing call — the snapshot is internally consistent within one transaction.

**If violated** — N/A; structural confirmation. The ratio's *inputs* (gas-price reference, cached USD prices) are independently scrutinized in [X-1](#x-1) and the Key Attack Surfaces in x-ray.md.

**Categories:**
- **Conservation**: two or more storage variables change by equal-and-opposite amounts in the same function body.
- **Bound**: a guard on a storage variable, lifted to a global property, checked across every write site of that variable.
- **Ratio**: a storage variable defined as a formula of other storage variables.
- **StateMachine**: a storage variable transitions through discrete values with guards preventing reversal.
- **Temporal**: a condition depends on `block.timestamp`/`block.number`/a duration variable.

---

## 3. Inferred Invariants (Cross-Contract)

Trust assumptions that span contract boundaries. Each block cites both caller-side and callee-side code.

---

#### X-1

On-chain: **No**

> `InboxFeeManager` assumes `PriceOracle.getPricesUSD()` returns a fresh, meaningful price — but the cache has no maximum-age check, and a broken live adapter is masked by silent fallback to the last good value.

**Caller side** — `InboxFeeManager.sol:136-144` (`_validatedOraclePrices`) reverts only when `localPrice == 0 || remotePrice == 0`; it never checks `lastFetchTimestamp` age.

**Callee side** — `PoDPriceOracle._pullCachedPrice` (`PoDPriceOracle.sol:106-112`) calls `_livePrice(token)`; if the live read returns `0` (adapter unset, feed removed, or `(false, 0)` per [G-13](#g-13)), it silently falls back to `cachedPriceUSD[token]` — the last successfully cached number, however old.

**If violated** — fee budgets are computed from an arbitrarily stale USD ratio, silently mis-sizing remote execution gas, with no on-chain signal that the live feed has been broken for an extended period.

---

#### X-2

On-chain: **No**

> `respond`/`raise` are assumed to be covered by the same emergency pause as inbound processing, but are not.

**Caller side** — the documented intent (`InboxMiner.sol` NatSpec on `messageProcessingPaused`: "halts inbound message processing") implies the pause should stop the whole request lifecycle.

**Callee side** — `messageProcessingPaused` is declared and checked only in `InboxMiner.sol:37,159`; `InboxBase.respond`/`raise` (`InboxBase.sol:143,182`) have no such check.

**If violated** — the owner's emergency stop does not prevent a currently-executing target contract from completing its response/error leg mid-pause. Narrow window (only reachable from within an already in-flight `batchProcessRequests`/`retryFailedRequest` call frame), but the pause's actual coverage is narrower than its documented scope.

---

#### X-3

On-chain: **No**

> Downstream target dApp contracts trust `inboxMsgSender()` to reflect a real source-chain contract, but the value is fully miner-supplied.

**Caller side** — any target dApp (out of scope here — e.g. `PodERC20`/`PrivacyPortal` in `@coti-io/coti-contracts`) reading `inboxMsgSender()` to authenticate its cross-chain peer.

**Callee side** — `InboxBase.sol:285-290` returns `_currentContext.remoteContract`, set from `incomingRequest.originalSender` = `minedRequest.sourceContract` (`InboxMiner.sol:75`) — entirely miner-controlled, with no proof (see [I-5](#i-5)).

**If violated** — restates the miner-trust root (I-5) at the integration boundary: every downstream peer check in the ecosystem inherits it.

---

## 4. Economic Invariants

Higher-order properties derived from combinations of §2 and §3 invariants.

---

#### E-1

On-chain: **No**

> "A registered miner cannot cause fund loss beyond griefing" does not hold structurally.

**Follows from** — [I-5](#i-5) + [X-3](#x-3): since ingestion authenticity is fully miner-controlled and downstream peer identity derives from it with no independent check, any economic safety property in a downstream application that trusts `inboxMsgSender()` for authorization reduces entirely to "the miner set is honest."

**If violated** — unbounded value extraction in any downstream application that authorizes actions based on `inboxMsgSender()` (matches the blast radius documented in `audit/POD_INBOX_AUDIT.md` POD-01: forged mints, broken portal solvency, forged system errors).

---

#### E-2

On-chain: **No**

> "Every accepted request eventually settles with a correctly-funded callback" does not hold for miner-supplied one-way requests carrying a non-zero `errorSelector`.

**Follows from** — [I-3](#i-3) (no per-request escrow accounting) + the fee-budget derivation in [I-7](#i-7): the *public* `sendOneWayMessage` now rejects any non-zero `errorSelector` outright (`InboxBase.sol:130-132`, `OneWayErrorSelectorNotSupported`), closing the historical zero-gas-callback gap (`audit/POD_INBOX_AUDIT.md` POD-06) for user-initiated sends. But `batchProcessRequests` never re-applies that check to miner-supplied `MinedRequest.errorSelector`/`isTwoWay`/`callerFee` combinations — a miner can still construct an incoming request with `isTwoWay = false`, `errorSelector != 0`, `callerFee = 0`, reopening the same zero-gas outcome for that path.

**If violated** — a silently-dropped, unexecutable error callback. Severity is bounded by [I-5](#i-5)/[E-1](#e-1): a miner with this capability already has far larger blast radius, so this is a narrower restatement of the same trust boundary rather than an independent bug.
