# Verification of external findings #54–#74 (all claimed Informational)

Sources: Scope A `/home/user/coti-pod-inbox-contracts/contracts` (HEAD = 89121ad), Scope B `/home/user/coti-contracts/contracts` (= 8a0c492). Line numbers below are HEAD line numbers. "Finding line" = the line the finding cites.

---

### #54 — A deposit escrow status is declared but unreachable (claimed: Informational)
- Verdict: CONFIRMED
- Evidence:
  - `IPrivacyPortal.sol:23-32` `enum DepositEscrowStatus { None, Pending, Failed, Refunded }`; `:28-29` doc "Mint request hit an Inbox system error; collateral is eligible for refund." (finding line 23 accurate)
  - Escrow writes: `PrivacyPortal.sol:420-425` and `:468-473` both `status: DepositEscrowStatus.Pending`; `:597` and `:638` both `escrow.status = DepositEscrowStatus.Refunded;`.
  - Only other use: `PrivacyPortal.sol:586` `if (status != DepositEscrowStatus.Pending && status != DepositEscrowStatus.Failed) {` — a comparison. `grep -rn 'DepositEscrowStatus.Failed' coti-contracts/contracts` returns only this line (finding line 586 accurate). No assembly/delegatecall in PrivacyPortal.sol; clone is non-upgradeable (`initializer` at `:247`).
  - Both refund paths consult the pToken: `:589` / `:626` `pToken.requests(requestId).status`; `:627-629` rejects `Success`; `:632-634` invalidates a `Pending` mint before release.
- Overstates: nothing. Recommendation (keep the member, do not renumber) is sound — `depositEscrows()` returns the ordinal (`IPrivacyPortal.sol:174-177`).
- Severity: agree Informational (no behavioural effect).
- Gist PoC: none.
- Overlap: none (our #8 concerns `IPodERC20.RequestStatus.Failed`, a different enum).

### #55 — Native coin sent to a portal is unattributable and cannot be returned (claimed: Informational)
- Verdict: CONFIRMED
- Evidence:
  - `PrivacyPortal.sol:238-239` `/// @notice Accept native funds for portal fees or accidental recovery.` / `receive() external payable {}` (finding line 239 accurate). Nothing credits `accumulatedPortalFees` there; it is only incremented at `:896`.
  - Only exit: `:748` `function rescueNative(uint256 amount) external onlyFactoryAdmin nonReentrant whenPaused {` → `:752` `_controllerFactory().rescueRecipient()` (line 748 accurate).
  - Native genuinely needed only for unwrap: `:868-870` `IWrappedNative(address(underlyingToken)).withdraw(withdrawal.amount); (bool ok,) = payable(withdrawal.recipient).call{value: ...}` (line 869 accurate); `IWrappedNative.sol:9-10` withdraw "sends native to `msg.sender`".
  - Masking: `:761-764` `uint256 bal = address(this).balance; if (accumulatedPortalFees > bal) { accumulatedPortalFees = bal; }`; withdrawals bounded at `:731`.
- Overstates: nothing. Recommended fix is sound with one caveat: WETH9/WAVAX `withdraw` pays via `transfer` (2300 gas); the proposed `receive()` guard reads `nativeWrappedUnderlying` and `underlyingToken`, both already warmed at `:868-869` in the same tx, so it should fit the stipend but must be tested against the real wrapper.
- Severity: agree Informational.
- Gist PoC: none.
- Overlap: none.

### #56 — A fee parameter named for basis points is denominated in parts per million (claimed: Informational)
- Verdict: CONFIRMED
- Evidence: `PrivacyPortalFeeLib.sol:12` `uint256 internal constant FEE_DIVISOR = 1_000_000;`; `:14` `MAX_FEE_UNITS = 100_000;` (=10%); `:24` `function packFeeConfig(uint256 fixedFee, uint256 percentageBps, uint256 maxFee)`; `:93` `uint256 percentageFeeUsd = Math.mulDiv(txValueUsd, percentageBps, FEE_DIVISOR);` (finding lines 12/14/24/93 all accurate).
- Overstates slightly: the scale *is* documented in two places the finding does not mention — `IPrivacyPortalFactory.sol:6` "`percentageBps` / 1_000_000" and `PrivacyPortalFactory.sol:169,172` "(FEE_DIVISOR scale)". It is undocumented on the setters an operator actually calls (`IPrivacyPortal.sol:193-196`, `IPrivacyPortalFactoryAdmin.sol:29-30`, `PrivacyPortalFactory.sol:452-470`). Recommendation (rename, never change the divisor) is sound; the packed slot stores the raw value (`:36`), so re-scaling the divisor would silently ×100 every deployment.
- Severity: agree Informational (misconfiguration path under-charges only; cross-checked by `MAX_FEE_UNITS`).
- Gist PoC: none.
- Overlap: none.

### #57 — Two cases where a cross-chain round trip is paid for and cannot succeed (claimed: Informational)
- Verdict: CONFIRMED
- Evidence:
  - Encrypted zero/insolvent transfer reports success: `PodErc20CotiMother.sol:371-373` "Encrypted amounts: `mux` effective amount to zero when balance/allowance is insufficient and always `respond` Success"; `:401` zero-amount raise applies only `if (amountIsPublic && publicAmount == 0)`; `:446-448` `effectiveAmount = MpcCore.mux(ok, zeroAmount, amount);` then `:482` `inbox.respond(...)`.
  - Zero recipient checked only on COTI: `:392-394` `if (!burning && to == address(0)) { _sendTransferFailureToPod(id, from, to, bytes("PodErc20CotiMother: zero to")); return; }` (finding lines 388-393 accurate) and `:542-544` mint `"PodErc20CotiMother: mint zero to"` (line 542 accurate).
  - Source side: `PodERC20.sol:772-800` `_transfer` checks only `from == to` (`:780`); `:913-944` `_transferPublic` checks `amount == 0` and `from == to`; `:889-910` `_mint` no `to` check. `grep 'address(0)' PodERC20.sol` shows no `to == address(0)` revert anywhere (hits at 347/355 are callback decodes, 766/909/1071/1099 are event args). Note `PrivacyPortal` itself rejects a zero recipient before calling `mint` (`PrivacyPortal.sol:397-399`, `:445-447`).
- Overstates: nothing; "burn" has no recipient, so only transfer/mint apply. Recommendation sound.
- Severity: agree Informational (caller pays fees for an honest failure signal).
- Gist PoC: none.
- Overlap: none.

### #58 — The routing setter does not apply a code check the factory applies elsewhere (claimed: Informational)
- Verdict: PARTIALLY CONFIRMED (inconsistency real; stated impact wrong)
- Evidence:
  - `PrivacyPortalFactory.sol:361-367` `configureRouting` → `if (inbox_ == address(0) || cotiChainId_ == 0 || cotiMotherContract_ == address(0)) { revert InvalidAddress(); }` only (line 361 accurate).
  - Code checks elsewhere: `:334-335` (setPortalImplementation), `:351-352` (setPodTokenImplementation), `:474-475` (setPriceOracle) `revert ImplementationHasNoCode(...)` (finding lines 335/352/475 accurate).
  - Also missing on two other inbox-setting paths the finding omits: the constructor `:192-199` (zero checks only) and `configurePToken` `:375-382` → `PodERC20.configure :156-166` → `InboxUser.setInbox :73-80` (non-zero only).
- What it gets wrong: "a call to an address with no code returns success, so messages would appear dispatched while going nowhere" does not hold here. Every consumer uses a high-level Solidity call with a `bytes32` return: `PrivacyPortalFactory.sol:744-746` `IInbox(inbox).sendOneWayMessage{value: msg.value}(...)` and `PodERC20.sol:618-625` `IInbox(inbox).sendTwoWayMessage{value: ...}(...)`; the ABI decoder reverts when returndata is empty, so a codeless inbox fails **closed** (loud revert on `createPortal` and on every pToken op), not silently. Silent success is specific to the Inbox's raw `call` (`InboxBase.sol:799`), i.e. finding A1, not this setter. Recommendation (add the code-size check) is still sound and cheap.
- Severity: agree Informational (admin misconfiguration; fails closed).
- Gist PoC: none.
- Overlap: none in the 14; our Leads list "Constructor skips the code-existence checks the setters enforce".

### #59 — The capped-returndata fix discards the value that would show a reason was truncated (claimed: Informational)
- Verdict: CONFIRMED
- Evidence:
  - `InboxBase.sol:801-803` `let fullLength := returndatasize()` / `let copyLen := fullLength` / `if gt(fullLength, maxLen) { copyLen := maxLen }`; `fullLength` is not used afterwards (`:804-812`). Function spans `:791-819` (finding "795 to 814" ≈ the body; accurate enough).
  - Stored/emitted without size: `InboxMiner.sol:387-393` `errors[rid] = Error({... errorMessage: returnData})` / `emit ErrorReceived(rid, ERROR_CODE_EXECUTION_FAILED, returnData)`; `InboxBase.sol:293-294` NatSpec of `getOutboxError` says only "first ≤{MAX_ERROR_RETURN_DATA} bytes".
  - Prior recommendation exists as claimed: `audit/POD_INBOX_AUDIT.md:117` "retain only a capped prefix plus `keccak256(returndata)` and total length". The finding's critique is correct: `keccak256` needs the full bytes in memory, i.e. an unbounded `returndatacopy`, which is what commit 89121ad's design avoids (`InboxBase.sol:787-790`).
- Overstates: nothing. Recommendation (emit `fullLength`; hash only the capped prefix) is sound; note `ErrorReceived` would need a new parameter or a new event (indexer ABI change).
- Severity: agree Informational.
- Gist PoC: none.
- Overlap: none.

### #60 — One execution-context slot is protected by two mechanisms, and by neither where it is read (claimed: Informational)
- Verdict: PARTIALLY CONFIRMED
- Evidence:
  - `InboxBase.sol:29` `ExecutionContext internal _currentContext;`; `:230-238` `respond`/`raise` → `_reply` with no reentrancy modifier (lines 29/230/236 accurate).
  - Populating paths: `InboxMiner.sol:34-38` `batchProcessRequests ... onlyMiner nonReentrant` (line 37 accurate), `:294` `retryFailedRequest(bytes32 requestId) external nonReentrant`, and the estimate path `InboxEstimateGas.sol:79-81` `if (_isEstimating() || _currentContext.requestId != bytes32(0)) revert IInboxMiner.EstimateBusy();` (accurate); `estimateExecutionGasForMiner` itself (`InboxMiner.sol:275-281`) carries no `nonReentrant`.
  - Four exits clear the context: `InboxMiner.sol:342`, `:347`, `:368`, `:382` `_clearExecutionContext()`.
- What it overstates: "respond and raise ... assert nothing locally" — `_reply` does assert a non-empty context (`InboxBase.sol:243-245` `NoActiveMessage`), caller identity (`:254` `if (msg.sender != incomingRequest.targetContract) revert OnlyTargetCanReply();`), two-way-ness and single reply (`:248-258`). What is absent is only a reentrancy guard. One real asymmetry it does not mention: a target executing under an estimate can enter `retryFailedRequest` (the estimate never took the `ReentrancyGuard` lock), overwriting the context mid-estimate — harmless because `_estimateExecutionGasForMiner` always reverts (`InboxEstimateGas.sol:140`). Recommendation caveat: EIP-1153 transient storage needs Cancun; `hardhat.config.ts:93` states target chains are pinned below Cancun ("stay below Cancun unless transient storage is required"), so that option is not deployable as documented.
- Severity: agree Informational.
- Gist PoC: none.
- Overlap: none.

### #61 — Four structural invariants are enforced by convention rather than by the compiler (claimed: Informational)
- Verdict: CONFIRMED (one sub-claim unverifiable)
- Evidence:
  - (1) `LibFeeStorage.sol:14-24` `struct FeeConfig` (9 fields); `FeeManagerStubBase.sol:16-26` identical 9 fields in the same order; `InboxFeeQuoter.sol:10-20` identical; `FeeManagerStubBase.sol:274-285` `_toLib`/`_fromLib` `assembly ("memory-safe") { r := c }` (finding lines 14/16/274-284/10 accurate). "within 91 bytes of EIP-170": unverifiable (cannot compile; only `scripts/check-bytecode-size.mjs` exists).
  - (2) `MpcAbiReEncode.sol:14-33` and `MpcAbiCodec.sol:12-31`: both 18 members, identical order (compared member by member). `MpcAbiCodec.sol:169` `datatypes[...] = bytes8(uint64(uint8(dataType)));`; the receiver range-checks and rejects high-byte aliases (`MpcAbiReEncode.sol:62-65`) but has no version/checksum.
  - (3) Three independent 7-field encodings: `PodErc20CotiMother.sol:499-511` `_encodePodTransferCallback` (transfer), `:461-471` burn `abi.encode(from, ..., address(0), zeroCiphertext, zeroCiphertext, burnNonce)`, `:557-567` mint `abi.encode(address(0), zeroCiphertext, zeroCiphertext, to, ...)`; single decoder `PodERC20.sol:337-345` `abi.decode(data, (address, ctUint256, ctUint256, address, ctUint256, ctUint256, uint256))`; nonce gating at `:348-352`.
  - (4) `PrivacyPortalFeeLib.sol:16` `PRICE_SCALE = 1e18`; `:94` `percentageFeeNative = Math.mulDiv(percentageFeeUsd, PRICE_SCALE, nativeUsdRate);` (doubles as wei-per-native); `ChainlinkFeedLib.sol:98-114` `_normalizeTo18`; decimals bound `PrivacyPortalFactory.sol:556-558` and equality check `:559-562` (finding "line 559" is the read, compare is 560).
- Overstates: minor — the oracle interface already states the scale in NatSpec (`IPodPriceOracle.sol:5` "18-decimal USD per whole token"), just not as a queryable constant. Recommendations are sound.
- Severity: agree Informational.
- Gist PoC: none (PBT_MpcReEncodeOracle / PBT_FeeQuote exercise the packing but do not assert cross-repo agreement).
- Overlap: none.

### #62 — Clearing a manual price takes the whole fee lane offline in a single transaction (claimed: Informational)
- Verdict: PARTIALLY CONFIRMED (mechanism real; "no way to force" recovery is wrong)
- Evidence:
  - `PoDPriceOracle.sol:150-159` `_livePrice`: manual → adapter → `return 0` (line 150 accurate). `:38-53` `getCachedPrice` falls back to the peg (line 38 accurate) but the fee path reads `PriceOracle.sol:160-162` `function getPricesUSD() ... return (cachedPriceUSD[localToken], cachedPriceUSD[remoteToken]);` (line 160 accurate; not `virtual`, so the recommended override needs a base-contract change).
  - `PoDPriceOracle.sol:100-108` `clearTokenPriceUSD` deletes `manualPrices`, `cachedPriceUSD`, `priceUpdatedAt`; does not touch `lastFetchTimestamp` (line 100 accurate). `:86-95` `setTokenPriceUSD` writes `manualPrices` only.
  - Zero cache halts sends/quotes: `FeeManager.sol:253-256` `revert OraclePriceZero()`; `FeeManagerStubBase.sol:161-162` same on the quote view. Refresh gate: `PriceOracle.sol:129-131` / `:251-256`.
- What it gets wrong: "no way to force it" — the same `priceAdmin` can write the cache directly in one call via `PriceOracle.sol:221-228` `setLocalTokenPriceUSD` / `setRemoteTokenPriceUSD` → `:238-249` `_setCachedPrice` (writes `cachedPriceUSD`, does not need the interval). The repo's own deploy tooling uses exactly these (`scripts/deploy-utils.ts:557-572`). The outage is therefore recoverable immediately; the finding's "two-step, wait for interval" recovery is only true if the operator insists on `setTokenPriceUSD` + `refreshCache`. Recommendation to refuse a clear that leaves the leg unpriceable is reasonable; the `getPricesUSD` override requires making it `virtual`.
- Severity: agree Informational (priceAdmin-only trigger, one-call recovery exists).
- Gist PoC: none directly; `P6_OracleFailClosed_ScopeA.t.sol` covers the same `OraclePriceZero` fail-closed behaviour.
- Overlap: none.

### #63 — The reject ingest path skips the caps the normal ingest path applies, and meets one of them later (claimed: Informational)
- Verdict: CONFIRMED
- Evidence:
  - Normal path checks: `InboxMiner.sol:93-102` `weight > maxMethodCallBytes → MethodCallTooLarge`, `targetFee > maxLocalExecutionGas → FeeGasTooHigh`, `callerFee > maxRemoteExecutionGas → FeeGasTooHigh` (finding "92-100" ≈ accurate).
  - Reject path `:80-91` → `_ingestMinerReject` (`:167`, accurate) stores `targetFee: minedRequest.targetFee, callerFee: minedRequest.callerFee` verbatim (`:195-196`) with no cap check; payload is the 34-byte sentinel (`MinerRejectLib.sol:12,32-36`) so the size cap is moot.
  - Late check: `:208-210` two-way → `_sendSystemErrorCallbackWithCode` → `_sendOneWayMessage(..., incomingRequest.callerFee, 0, SYSTEM_SENDER)` (`InboxBase.sol:601-610`) → `_createRequest :497-499` `if (targetFeeGas > remoteMax.maxExecutionGas) revert FeeGasTooHigh(...)` (finding lines 497-498 accurate) — same bound as the ingest check at `InboxMiner.sol:100`, reverting the whole batch.
- Overstates: nothing; one nuance: for one-way rejects, or two-way rejects with `errorSelector == 0` / `callerFee == 0` (`InboxBase.sol:570-575, 585-590`), the out-of-range fee is never checked at all — but it is also never used. Recommendation (apply the three checks at ingest) is sound.
- Severity: agree Informational (miner-only, self-inflicted revert).
- Gist PoC: none.
- Overlap: none.

### #64 — The non-reverting decoder's bounds check is an unchecked addition, and it wraps (claimed: Informational)
- Verdict: CONFIRMED
- Evidence:
  - `InboxBase.sol:721-739` `_tryDecodeAbiBytes`: outer guard `:725` `if gt(retLen, 0x3f)`, `:729` `let len := mload(add(dataPtr, 0x20))`, `:731-734` `if iszero(gt(add(0x40, len), retLen)) { ok := 1 ... decoded := add(dataPtr, 0x20) }`. Yul `add` wraps mod 2^256: `0x40 + (2^256-1) = 0x3f`; `gt(0x3f, retLen≥0x40)` = 0 → `iszero` = 1 → `ok`. Confirmed by reading.
  - Caller chain: `:712` `_tryDecodeAbiBytes(ret)` in `_safeEncodeMethodCall`; `InboxMiner.sol:336-337, 363-364` → `_callWithCappedReturnData` → `InboxBase.sol:798-799` `let dataLen := mload(callData)` / `call(gasBudget, target, 0, dataPtr, dataLen, 0, 0)` — memory expansion to 2^256-1 → OOG → whole batch reverts (denial, not corruption).
  - Precondition: `mpcAbiReEncode` is assigned only at `InboxBase.sol:176` inside `_initInboxBase` (grep: single assignment), called from `Inbox.sol:28-37` `init ... initializer`. Write-once as claimed; a benign `reEncodeWithGt` returns a well-formed `abi.encode(bytes)` (`MpcAbiReEncode.sol:43,108`).
- Overstates: nothing. Recommended fix (`len <= retLen - 0x40`, no underflow since `retLen > 0x3f`) is sound.
- Severity: agree Informational. Security consequence check: reaching it requires the owner-deployed re-encode module to be hostile/buggy; even if modules became owner-replaceable, the actor is the owner, so at most Low then. Keep Informational now.
- Gist PoC: `B11_TryDecodeWrap.t.sol` — but it imports `./harness/B11Harness.sol` (`B11Harness`, `EvilEchoModule`) which is **absent from the gist** (`ls gist/harness` fails), so the shipped PoC is not runnable as delivered; the arithmetic claim is nonetheless verifiable by reading.
- Overlap: none.

### #65 — A target can be forwarded less gas than paid for; the settlement event reports the budget (claimed: Informational)
- Verdict: PARTIALLY CONFIRMED (mechanism confirmed; magnitudes unverifiable)
- Evidence:
  - `InboxMiner.sol:403-420` `_computeUserCallGas`: `gasForCall = gasleft()`; `-= outerReserve` (`POST_CALL_GAS_RESERVE = 200_000`, `:20`); `if (targetGasBudget < gasForCall) gasForCall = targetGasBudget;` `maxUserGas` cap (line 403 accurate).
  - Forwarding: `InboxBase.sol:799` `call(gasBudget, ...)` — EIP-150 forwards `min(requested, 63/64 of remaining)`; nothing in the code compensates.
  - Event: `InboxMiner.sol:377` `uint256 gasRemainingApprox = targetGasBudget > gasUsed ? targetGasBudget - gasUsed : 0;` / `:379` `emit FeeExecutionSettled(...)` (quoted line accurate) — computed from the budget, not the granted gas.
  - Retry uses `gasleft()`: `:354-356`.
- Unverifiable: the measured figures (78,751 / 39,376 / 0 at 0/40k/80k headroom) come from running `GasFidelity.t.sol` under the miner's off-chain gas-limit formula (`est + Σ targetFee + 200k·n`, `GasFidelity.t.sol:109-110`), which lives in neither repo; they are internally consistent with `shortfall = budget − 63/64·G` (each unit of headroom removes 63/64), but the phrase "a sixty-fourth of the budget" is loose (24,000,000/64 = 375,000 ≠ 78,751).
- Recommendation partly sound: computing the event from `gasForCall` fixes the budget/frame/`maxUserGas` clamps but still overstates in the very case targeted, since the 63/64 truncation happens inside `CALL`; use `min(gasForCall, 63/64·(gasBeforeSubcall − call cost))` if the event is meant to be honest there.
- Severity: agree Informational for the audited contracts (miner is a trusted role; provisioning is off-chain). If the miner tooling does provision exactly `est + Σbudget + 200k·n`, treat as Low: a correctly paid near-`maxExecutionGas` request fails its first mine and its ~24M-gas retry cost shifts to a third party (bounded, retryable, TTL-terminalised).
- Gist PoC: `GasFidelity.t.sol` ("Hardening note 14" in the README; output not included).
- Overlap: none.

### #66 — Collateral is measured on the way in and taken on trust on the way out (claimed: Informational)
- Verdict: CONFIRMED
- Evidence:
  - Entry: `PrivacyPortal.sol:412-417` `balanceBefore ... safeTransferFrom ... received = ... - balanceBefore; if (received == 0) revert NoUnderlyingReceived();` (line 412 accurate); `:460-465` depositNative (line 460 accurate); stores `amount: received` (`:423`, `:471`); error doc `:230`.
  - Exit: `:596-599` `uint256 amount = escrow.amount; ... underlyingToken.safeTransfer(escrow.user, amount);` (finding 596 = the read, transfer at 599); `:636-640` admin refund (636 read / 640 transfer); `:875` `underlyingToken.safeTransfer(withdrawal.recipient, withdrawal.amount);` (accurate). No re-measurement.
  - Swallowed release: `PodERC20.sol:336` `_setRequestStatus(..., Success)` before `:367` `(bool success, ) = address(to).call(callbackData);` / `:371` emits only.
  - No token-type guard: `PrivacyPortalFactory.sol:550-565` checks decimals and native-wrap only. "Client has confirmed elastic-supply tokens will not be admitted": unverifiable.
- Overstates: nothing; the "do not apply the symmetric fix" reasoning (rescue path would pay partial and mark complete) is correct given `rescueERC20 :769-782` has no reserve. Sound.
- Severity: agree Informational as a standalone note — its live consequences are already scored (our #1 Medium, #10 Low) and the trigger is an admin-admitted asset class.
- Gist PoC: indirect — `P22_PortalRebasingReleaseSwallow.t.sol` (rebase-down bricks release and, per README, the deposit refund path).
- Overlap: our #1 (reverting release recorded `Success`), our #10 (`rescueERC20` no reserve); Leads "Outbound legs are unmeasured".

### #67 — One of the three payload caps is bounded by nothing (claimed: Informational)
- Verdict: CONFIRMED
- Evidence: `FeeManager.sol:259-268` `_requireValidFeeConfig` rejects `maxMethodCallBytes == 0` and `> PROTOCOL_MAX_METHOD_CALL_BYTES` (`:25` = 32_768) (line 259 accurate); `:142-148` `setMaxReplyMethodCallBytes(uint32 maxBytes) ... if (maxBytes == 0) revert MaxReplyMethodCallBytesInvalid(maxBytes);` — no ceiling (finding "143" = the `if`); owner-only wrapper `InboxMiner.sol:248-250`; default 8192 via `:66-67` `ensureDefaults` and getter fallback `FeeManagerStubBase.sol:125`. Downstream bounds still hold: reply → `InboxBase.sol:267` `_requireReplyMethodCallBounded` then `_createRequest :493-496` `MethodCallTooLarge` (reverts inside the target's `respond`, recorded as execution failure), and peer ingest `InboxMiner.sol:93-96`.
- Overstates: nothing. Recommendation (bound by `PROTOCOL_MAX_METHOD_CALL_BYTES`) sound; the stricter "≤ local maxMethodCallBytes" indeed introduces a setter-ordering dependency.
- Severity: agree Informational (owner-only; bounded downstream).
- Gist PoC: none.
- Overlap: none.

### #68 — One fee has two quote surfaces, and the general-looking one cannot see per-portal overrides (claimed: Informational)
- Verdict: CONFIRMED
- Evidence: enforcement `PrivacyPortal.sol:905` `_effectiveFeePacked(isDeposit)` → `:967-974` override-first (line 967 accurate); portal estimate `:926-942` override-aware, delegating to the factory only when unset. Factory surface `PrivacyPortalFactory.sol:483-489` `estimateDepositPortalFee(address underlying, uint256 amount, uint8 decimals)` → `_estimatePortalFee(defaultDepositFeePacked, ...)`; siblings `:492` (`defaultWithdrawFeePacked`), `:501` (`getDepositPortalFeeFloor`, finding says 503), `:510` (`getWithdrawPortalFeeFloor`, finding says 512) — all hard-wired to defaults, no portal argument. Interface NatSpec `IPrivacyPortalFactory.sol:59-81` gives no "default-only" hint. Overpayment is kept: `PrivacyPortal.sol:888-897` (`portalFee ≤ maxFee` accepted, `accumulatedPortalFees += portalFee`).
- Overstates: nothing. Recommendation (add a portal parameter) sound.
- Severity: agree Informational (integration footgun; on-chain enforcement correct).
- Gist PoC: none.
- Overlap: none.

### #69 — Lanes are per-chain in the request bookkeeping and global in the fee configuration (claimed: Informational)
- Verdict: CONFIRMED — and the topology the finding asks the client to confirm is already documented in the repos
- Evidence:
  - Per-lane bookkeeping: `InboxBase.sol:27` `mapping(uint256 => bytes32) public lastIncomingRequestId;`, `:33` `mapping(uint256 => uint256) internal _requestNonce;`. Global fee config: `LibFeeStorage.sol:29-30` `FeeConfig localMinFeeConfig; FeeConfig remoteMinFeeConfig;` (line 27 = Layout; accurate). `_createRequest` `InboxBase.sol:492` `FeeConfig memory remoteMax = _remoteMinFeeConfigMem();` ignores `targetChainId` (accurate); not allowlisted `:183`, `:208` (accurate); ingest caps read once `InboxMiner.sol:48-52` (line 50 accurate). Single oracle pair: `PriceOracle.sol:23-26` `localToken`/`remoteToken`, used at `FeeManager.sol:181,207` `mulDiv(remoteGasWei / gasPrice, localPrice, remotePrice)`.
  - Topology (Scope B + Scope A docs/scripts): `PodNetworkConstants.sol:10` "Same value on Sepolia, COTI testnet, and Avalanche Fuji"; `:16-20` Fuji "paired with COTI testnet"; `PodUserFuji.sol:11-12` and `PodUserSepolia.sol:10-11` both point at `COTI_TESTNET_MPC_EXECUTOR`/`COTI_TESTNET_CHAIN_ID`. `scripts/oracle-tokens.ts:24` COTI-side oracle: `remoteToken: SEPOLIA_WETH` (one remote leg, priced as ETH: `scripts/deploy-utils.ts:167-169`), while Fuji uses WAVAX. `docs/ESTIMATE_EXECUTION_GAS.md:102-109` lane table: "COTI mainnet → L1 `1/10` — Covers ETH~5 and AVAX~13 with margin" — i.e. one COTI-side remote skew knowingly serves two L1 lanes.
- Overstates: nothing; it under-claims — the multi-lane COTI Inbox is not hypothetical. Consequence on the COTI→Fuji lane: remote gas units are derived from the ETH USD price and the ETH-tuned skew, so grants are mispriced (docs accept over-collection "with margin"). Recommendation (key fee config, and the oracle remote leg, by chain id) sound.
- Severity: propose Low — confirmed structural mispricing/one-size caps on a documented multi-lane deployment (economic drift, no fund loss), rather than a topology question.
- Gist PoC: none.
- Overlap: none.

### #70 — A remount carries the collateral and the token, and silently drops the portal's own configuration (claimed: Informational)
- Verdict: CONFIRMED
- Evidence:
  - `PrivacyPortalFactory.sol:668-671` `portal = Clones.clone(portalImplementation); IPrivacyPortal(portal).initialize(underlying, existingPToken, decimals, nativeWrappedUnderlying, address(this));` (line 668 accurate); `:673` `pauseByFactory()`; `:674` `setMinter(portal)`. Nothing copies limits/blacklist/overrides.
  - `PrivacyPortal.sol:255-259` `isDepositEnabled = true; maxDepositAmount = type(uint256).max; maxWithdrawAmount = type(uint256).max; minDepositAmount = 1; minWithdrawAmount = 1;` (line 241 accurate); fresh clone → `blacklisted` empty, `depositFeeOverridePacked`/`withdrawFeeOverridePacked` zero.
  - Old portal: `:292-300` `retireDepositsForUpgrade` sets `factory = address(0)`; `_activeFactory :977-983` reverts on zero and is reached only via `_checkDepositsNotPaused :1016`, `_checkWithdrawalsNotPaused :1010`, `_checkNotBlacklistedAccount :1032` (deposit/depositNative/requestWithdrawWithPermit); everything else uses `_controllerFactory :986-992` (`bindingFactory`). Release `:853-886`, cancel `:646-664`, finalize `:703-724`, refunds, `withdrawPortalFees :735`, rescues `:752,:776` all still work; burn via `PodERC20.burn :292-294` has no minter check; ids include `address(this)` (`:534`).
  - Blacklist: `:1032` ORs portal mapping with `_activeFactory().blacklisted(account)`.
- Overstates: nothing. Recommendation (carry config forward, or emit the retired state) sound.
- Severity: propose Low — every remount silently resets `min/max` caps to unbounded, empties the portal blacklist and drops fee overrides while the admin believes the controls persist; the clone is created paused (`:673`) so the window opens at unpause, but nothing enumerates what must be restored.
- Gist PoC: none directly; `P17_RemountMinterRotation.t.sol` Part 4 covers what survives retirement, not the reset.
- Overlap: our remount family #3/#4/#6 (context), our #12 (limits); Leads "Per-portal risk controls reset on remount".

### #71 — A native deposit is refunded in wrapped form, though a native withdrawal is unwrapped (claimed: Informational)
- Verdict: CONFIRMED
- Evidence: `PrivacyPortal.sol:599` `underlyingToken.safeTransfer(escrow.user, amount);` and `:640` `underlyingToken.safeTransfer(user, amount);` — no `nativeWrappedUnderlying` branch (lines 599/640 accurate); `:867-876` release branches: `if (nativeWrappedUnderlying) { IWrappedNative(...).withdraw(...); (bool ok,) = payable(recipient).call{value: ...}(""); if (!ok) revert EthTransferFailed(); } else { safeTransfer }` (lines 867-876 accurate). `depositNative :461` wraps in-contract, so the escrow holds WETH/WAVAX.
- Overstates: nothing; the robustness argument (wrapped transfer cannot revert on receipt, native `call` can) matches `:870-873`. Both recommended options are sound.
- Severity: agree Informational (1:1 redeemable; form mismatch only).
- Gist PoC: none.
- Overlap: Leads "refunds don't unwrap".

### #72 — pTokens transferred to a portal outside the withdrawal flow are stranded on COTI, unburnable (claimed: Informational)
- Verdict: CONFIRMED
- Evidence:
  - No recipient restriction: `PodERC20.sol:277-279` `transfer(address to, uint256 amount, ...)` → `_transferPublic :913-926` (only `amount == 0`, `from == to`); encrypted `:174-176` → `_transfer :780` (`from == to` only). Mother credits any `to` (`PodErc20CotiMother.sol:477-479`).
  - `pendingBurnAmount` written at exactly two sites (grep): `PrivacyPortal.sol:866` `pendingBurnAmount += withdrawal.amount;` (inside `_releaseWithdrawal`) and `:713` `pendingBurnAmount -= amount;`. Burn cap `:682-685` `available = pendingBurnAmount - burnInFlightTotal; if (amount > available) revert PendingBurnTooLow`.
  - Portal's only pToken-spending calls: `:419/:467` `pToken.mint`, `:539` `pToken.transferFromAndCallWithPermit`, `:692` `pToken.burn`, `:633` `invalidatePendingRequest`; `rescueERC20 :773-775` refuses the pToken; no setter for `pendingBurnAmount`.
- Overstates: nothing. Recommendation (bounded self-burn / reconciliation, or documentation) sound.
- Severity: propose Low — irreversible user-fund loss with no admin recovery path and permanently misleading supply/`pendingBurnAmount` figures; likelihood low-moderate (the portal is the natural "send here" address), no third-party harm.
- Gist PoC: none.
- Overlap: none of the 14; our "Additional observations" note "No on-chain record of pTokens actually held on COTI".

### #73 — transferAndCall lets any sender make the pToken issue an arbitrary call as itself, so onlyPToken is not a security boundary (claimed: Informational)
- Verdict: CONFIRMED (precondition is even weaker than stated)
- Evidence:
  - Sender-chosen calldata: `PodERC20.sol:200-209` `transferAndCall(...)` → `_requestCallbacks[requestId] = data;` (also `:212-229`, `:232-250`). Delivery: `:363-367` `bytes memory callbackData = _requestCallbacks[sourceRequestId]; ... (bool success, ) = address(to).call(callbackData);` — `to` is the decoded transfer recipient (`:341`), calldata unconstrained, `msg.sender == pToken`.
  - Portal gate: `PrivacyPortal.sol:575-579` `if (msg.sender != address(pToken)) revert OnlyPToken(msg.sender); _releaseWithdrawal(withdrawalId);`; re-validation `:855-864` (`TransferPending` + `pToken.requests(...).status == Success`); `triggerWithdrawalRelease :667-669` is permissionless anyway. `grep OnlyPToken|msg.sender == address(pToken)` in coti-contracts: only PrivacyPortal.
- What it gets wrong: "mounting it also requires the pToken stranding of note 21" — not required. The encrypted `transferAndCall` path muxes an insolvent amount to zero and still reports Success (`PodErc20CotiMother.sol:435-450`, `:482`), so a sender with zero balance gets the hook fired at the portal with `msg.sender == pToken` for the price of one inbox fee, stranding nothing. Impact unchanged (harmless today). Recommendation (never treat `msg.sender == pToken` as authentication; fixed-selector hook) sound.
- Severity: agree Informational today (no reachable effect; the only consumer re-validates). Flag for any future `onlyPToken`-style entry point.
- Gist PoC: none.
- Overlap: Leads "Forgeable `OnlyPToken` guard".

### #74 — transferPTokenOwnership leaves the factory's pToken mappings pointing at the old portal (claimed: Informational)
- Verdict: PARTIALLY CONFIRMED (stale mappings real; "inert" is not quite right)
- Evidence: `PrivacyPortalFactory.sol:385-391` `transferPTokenOwnership` → `_requireFactoryOwnedPToken(pToken_)`; `Ownable(pToken_).transferOwnership(newOwner_);` — no writes to `portalForPToken`/`pTokenForUnderlying`/`portalForUnderlying` (line 385 accurate). Forwarders then revert via `:412-420` `if (tokenOwner != address(this)) revert PTokenNotOwnedByFactory(...)`.
- What it gets wrong / omits: the stale records are consulted by `createPortal :553-555` (`PortalAlreadyExists` — the underlying slot stays occupied forever) and by the remount branch `:621-637`, so they are not inert; they block creating any new pair for that underlying. Also the old portal is neither retired nor paused by the handoff (its `factory`/`bindingFactory` are untouched and it remains `minter`, since `setMinter` is owner-only `PodErc20Mintable.sol:96`), so it keeps operating. Consequently the recommendation to *delete* the mappings is not clearly sound: it would let `createPortal` mint a second pToken for the same underlying while the handed-off portal keeps minting the first (an F6-shaped two-portal state); documenting the semantics is the safer option.
- Severity: agree Informational (admin-only; fails closed).
- Gist PoC: none.
- Overlap: none.

---

## Summary of severity disagreements
- #69 → Low (multi-lane COTI Inbox is documented in-repo; single fee config/oracle leg misprices the second lane).
- #70 → Low (remount silently resets caps/blacklist/overrides).
- #72 → Low (irrecoverable user-fund strand, no reconciliation).
- #65 → Informational as audited; Low only if the miner tooling provisions exactly `est + Σbudget + 200k·n` (unverifiable here).
- All others: Informational agreed.

## Corrections to the findings' facts
- #58: consumers use high-level calls (`PrivacyPortalFactory.sol:744`, `PodERC20.sol:618`), so a codeless inbox reverts rather than "appearing dispatched"; the missing check also exists in the constructor and `configurePToken`.
- #60: `_reply` does assert context/caller (`InboxBase.sol:243-258`); only a reentrancy guard is absent; EIP-1153 is not deployable on the documented pre-Cancun targets.
- #62: `setLocalTokenPriceUSD`/`setRemoteTokenPriceUSD` (`PriceOracle.sol:221-228`) restore the lane in one call — "no way to force it" is wrong; `getPricesUSD` is not `virtual`.
- #64: gist PoC depends on `harness/B11Harness.sol`, which is missing from the gist.
- #65: magnitudes unverifiable; "a sixty-fourth of the budget" is loose; `gasForCall` in the event still ignores 63/64 truncation.
- #73: no stranded pTokens needed (encrypted zero-mux Success path).
- #74: stale mappings block `createPortal` for that underlying; deleting them is not obviously safe.
