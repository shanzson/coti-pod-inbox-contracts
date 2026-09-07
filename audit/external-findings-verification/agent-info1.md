# Verification of external audit findings #33–#53 (all claimed Informational)

Scope A = /home/user/coti-pod-inbox-contracts/contracts (HEAD differs from audited 89121ad only by an `// @audit` comment at InboxBase.sol:13 and a .DS_Store — verified with `git diff 89121ad HEAD -- contracts`). Scope B = /home/user/coti-contracts/contracts (byte-identical to 8a0c492). Line numbers below are from the files as they stand now. "Unverifiable" marks claims that rest on client statements, deployment wiring, git history, or compiler output that I did not (and was not allowed to) run.

---

### #33 — The portal fee oracle records when each price was written, and no consumer reads it (claimed: Informational)
- Verdict: CONFIRMED (code claims); the "client confirmed fallback-only" statement is unverifiable.
- Evidence:
  - PortalFeeOracle.sol:31 `function setTokenPriceUSD(address token, uint256 priceUsd) external onlyOwner {` … :39 `tokenPriceUpdatedAt[token] = uint64(block.timestamp);` — cited line accurate.
  - PortalFeeOracle.sol:53-54 `/// @notice Price plus last-write timestamp for ops / health bots.` / `function getTokenPriceMeta(address token) external view returns (uint256 priceUsd, uint64 updatedAt) {` — accurate. grep across both `contracts/` trees: `tokenPriceUpdatedAt`/`getTokenPriceMeta` appear only inside PortalFeeOracle.sol (no on-chain reader).
  - PortalFeeOracle.sol:59-61 `function getLivePrice(address token) … { return tokenPriceUSD[token]; }`, :64-70 `getLivePrices` returns the two mapping reads; :8 `/// @notice Testnet/manual oracle: all live reads return admin-set pegs (no external feeds).` — "plain mapping reads / misleading name" accurate.
  - PortalFeeOracle.sol:43-51 `clearTokenPriceUSD` deletes price and timestamp; NatSpec :43 "dynamic fees fall back to fixed fee for that leg" — deliberate control, accurate.
  - PrivacyPortalFeeLib.sol:88-90 `if (percentageBps == 0 || collateralUsdRate == 0 || nativeUsdRate == 0) { return (fixedFee, false); }` — non-zero is the only check; cited line accurate.
  - PrivacyPortal.sol:888-895 `_validateAndCollectPortalFee`: `if (portalFee < floor) revert …; if (portalFee > maxFee) revert …` — floor/cap only, accurate.
  - Cross-reference to Scope A: PoDPriceOracle.sol:86-95 `setTokenPriceUSD` writes `manualPrices[token] = priceUsd;` and emits — no `priceUpdatedAt` write (contrast PriceOracle.sol:238-249 `_setCachedPrice`, which does write `priceUpdatedAt[token] = block.timestamp;` for the two inbox legs). PoDPriceOracle.sol:150-154 `_livePrice`: `uint256 manual = manualPrices[token]; if (manual != 0) return manual;` and :67-78 `getLivePrices` prefer manual over `configuredOracle` — "manual peg takes precedence and carries no timestamp" accurate.
  - Unverifiable: which oracle the factory is wired to in production; the client statement.
- Wrong/overstated: nothing material. Recommended fix (max-age in `resolvePortalFee`/portal, falling back to `fixedFee`) is sound and preserves the documented fail-open design (IPodPriceOracle.sol:9-10).
- Severity: agree Informational for PortalFeeOracle. The staleness exposure on the production path belongs to the D12 family (outside this range).
- Gist PoC: none.
- Overlap: adjacent to our #11 (fee floor collapses to fixedFee on zero oracle rate) — same fail-open branch, different concern (staleness vs zero); not a duplicate.

### #34 — The blacklist deliberately does not reach a withdrawal already in flight, and the contracts do not say so (claimed: Informational)
- Verdict: CONFIRMED (code); "policy is intended" is a client statement (unverifiable).
- Evidence:
  - PrivacyPortal.sol:1031-1035 `function _checkNotBlacklistedAccount(address account) private view { if (blacklisted[account] || _activeFactory().blacklisted(account)) { revert AddressBlacklisted(account); } }` — per-portal + factory lists; cited line accurate.
  - :515 `_checkNotBlacklisted();` (→ :1024-1026, msg.sender) and :519 `_checkNotBlacklistedAccount(recipient);` in `requestWithdrawWithPermit` — accurate.
  - :853-886 `_releaseWithdrawal`: :858 `if (withdrawal.status != WithdrawalStatus.TransferPending) { revert …`, :861-864 requires pToken request `Success`, :870 `payable(withdrawal.recipient).call{value: withdrawal.amount}("")` / :875 `underlyingToken.safeTransfer(withdrawal.recipient, withdrawal.amount);` — no blacklist call; accurate.
  - :575-580 `onPTokenTransferred`: `if (msg.sender != address(pToken)) revert OnlyPToken(msg.sender); _releaseWithdrawal(withdrawalId);` — automatic, accurate. :667-669 `triggerWithdrawalRelease` is permissionless.
  - Function-signature grep: no `whenPaused`/`whenNotPaused`/`_checkWithdrawalsNotPaused` on :575, :667 or :853 — "pausing does not gate the release leg" accurate.
  - Stranding argument: :646-660 `cancelFailedWithdrawal` requires `TransferPending` and pToken status `Failed`/`SystemFailed`; PodERC20.sol:590-605 `killStaleRequest` requires `Pending` (:628-637 `_setRequestStatus`). A `Success` transfer therefore has no cancel path — accurate.
- Wrong/overstated: nothing in the mechanics. Its "no code change" recommendation is a policy stance; note our validated fix for #2 added recipient+payer checks at release together with #1's `retargetStuckWithdrawal`, which is exactly the "strand" mitigation this finding says is missing if a release-time check were added alone.
- Severity: Informational only if the policy is formally accepted and documented. As a control gap (a recipient listed after request is still paid; no operator intervention point) our validated review rated it Low — I would keep Low absent that acceptance.
- Gist PoC: none for this item (F6_PortalExitPaths.t.sol carries P10 "blacklist absent from the asset", a different issue).
- Overlap: duplicates our #2 (Blacklist not enforced on the release leg); touches our #1.

### #35 — Only amounts are confidential; the transaction graph is public and indexed (claimed: Informational)
- Verdict: CONFIRMED.
- Evidence:
  - PodERC20.sol:174 `function transfer(address to, itUint256 calldata value, uint256 callbackFeeLocalWei)`, :185 `transferFrom(address from, address to, itUint256 calldata value, …)`, :253/:258 `approve(address spender, itUint256 …)`, :269 `mint(address to, itUint256 calldata amount, …)` — plaintext counterparties; :277-297 public-amount overloads — cited lines accurate.
  - PodERC20.sol:72 `event TransferRequestSubmitted(address indexed from, address indexed to, bytes32 requestId);`, :74 `event ApprovalRequestSubmitted(address indexed owner, address indexed spender, bytes32 requestId);` — accurate. Also IPodERC20.sol:70-72 `event Transfer(address indexed from, address indexed to, …)`, :84-86 `Approval(address indexed owner, address indexed spender, …)`, and on COTI PodErc20CotiMother.sol:54-63 `TransferCompleted(bytes32 indexed tokenId, address indexed spender, address indexed from, address to, …)` — graph is indexed on both chains (stronger than the finding states).
  - PodERC20.sol:16 `… Public-amount methods expose amounts in calldata and logs; use encrypted `itUint256` entry points for privacy-sensitive flows.` — quoted line accurate.
- Wrong/overstated: nothing; "external material" claim unverifiable. Documentation-only recommendation is sound.
- Severity: agree Informational (protocol design property).
- Gist PoC: none.
- Overlap: none.

### #36 — Retry success is reported by a different event (claimed: Informational)
- Verdict: CONFIRMED, but it restates existing in-code documentation.
- Evidence:
  - InboxMiner.sol:367-375 (retry branch): `delete errors[incomingRequest.requestId]; emit RetryFailedRequestSuccess(incomingRequest.requestId); return gasUsed;` — `ReturnLegCallbackSucceeded` is emitted only in `batchProcessRequests` :150-152, on the initial mine. Accurate.
  - InboxBase.sol:150-153 NatSpec on the event: `Not emitted on a later successful {retryFailedRequest} — that path clears the error and emits {RetryFailedRequestSuccess} instead. Indexers that need recovered return legs must also watch that event (or empty `errors`).` Same guidance at InboxBase.sol:145-146 and IInbox.sol:72-76.
- Wrong/overstated: the finding presents as a discovered gotcha what the NatSpec states verbatim in three places; its recommendation is the NatSpec's own advice. No inaccuracy.
- Severity: agree Informational.
- Gist PoC: none.
- Overlap: none.

### #37 — inboxErrorType() must never be called from a success callback (claimed: Informational)
- Verdict: CONFIRMED (behaviour is real and already documented); the first recommended fix is unsound as phrased and conflicts with #50's fix.
- Evidence:
  - InboxBase.sol:375-404 — cited range accurate. :387-389 `if (incoming.originalSender == SYSTEM_SENDER) { return InboxErrorType.SystemError; }`; :396-403 `Request storage original = requests[sourceRequestId]; if (original.requestId == bytes32(0) || original.errorSelector == bytes4(0)) { return InboxErrorType.NotErrorContext; } … return InboxErrorType.Exception;` — every linked leg with a non-SYSTEM sender classifies Exception. :194 `if (callbackSelector == bytes4(0) || errorSelector == bytes4(0) || callbackSelector == errorSelector) revert InvalidTwoWaySelectors();` — non-zero by construction, accurate.
  - IInbox.sol:12 `Call only from `errorSelector` entrypoints — linked success `respond` legs can also report {Exception}.` and :225-227 — the rule is documented, accurate.
  - PodERC20.sol:704-709 `_errorCallbackContext … errType = inbox.inboxErrorType();` called only from :430-431 `transferError … onlyInboxReturnLeg`, :444-445 `approveError`, :458-459 `syncBalancesError`; :334 `transferCallback(bytes memory data) external onlyInboxPeer` (body :334-374 never calls it) — accurate. InboxUser.sol:61-69 `onlyInboxReturnLeg` checks inbox + non-zero `inboxSourceRequestId`.
  - InboxMiner.sol:76 `if (minedRequest.sourceContract == address(0)) revert InvalidSourceContract();` and :110 `originalSender: minedRequest.sourceContract,` — "only check is non-zero" accurate.
- Wrong/overstated: (1) "Have inboxErrorType() resolve the return leg's own error selector" cannot separate respond from raise: `_reply` stamps the same `incomingRequest.errorSelector` on both legs (InboxBase.sol:277) — only the payload selector differs (:260/:263 `abi.encodeWithSelector(replySelector, data)`). Worse, if #50's fix (bytes4(0) on reply legs) is also applied, every reply leg becomes NotErrorContext and PodERC20's error handlers revert `UnexpectedErrorContext` (PodERC20.sol:710-711). A workable discriminator is the first 4 bytes of the leg's `methodCall.data` vs `original.callbackSelector`/`original.errorSelector`. (2) The SYSTEM_SENDER spoof needs a miner to supply `sourceContract = SYSTEM_SENDER`; on a real source chain `requestSender` is `msg.sender` (InboxBase.sol:222, :444) and SYSTEM_SENDER is keccak-derived (:106) — so this sits inside the already-acknowledged miner trust model, not a user-reachable path.
- Severity: agree Informational (documented; in-scope integrator observes the rule).
- Gist PoC: B1_InboxErrorTypeMisclass.t.sol (README: "Informational (integration note)", 1 test). Note its "success leg" is a hand-built mined request with `sourceRequestId` set, not an Inbox-minted respond leg — structurally equivalent for the classifier.
- Overlap: none.

### #38 — Only three of the four terminal outcomes notify the source chain, and the fourth is the common one (claimed: Informational)
- Verdict: CONFIRMED.
- Evidence:
  - InboxBase.sol:90-95 the four codes (`ERROR_CODE_EXECUTION_FAILED = 1` … `ERROR_CODE_EXPIRED = 4`) — accurate.
  - InboxMiner.sol:208-210 `if (minedRequest.isTwoWay) { _sendSystemErrorCallbackWithCode(incomingRequest, ERROR_CODE_MINER_REJECTED, reasonBytes); }`; :308-311 `errors[requestId].errorCode = ERROR_CODE_EXPIRED; _sendSystemErrorCallbackWithCode(incomingRequest, ERROR_CODE_EXPIRED, "ttl"); return;`; InboxBase.sol:556-561 `_sendSystemErrorCallback` → :560 `_sendSystemErrorCallbackWithCode(incomingRequest, ERROR_CODE_ENCODE_FAILED, errorMessage);` — all three cited lines accurate.
  - InboxMiner.sol:385-395 execution failure: `errors[rid] = Error({… errorCode: ERROR_CODE_EXECUTION_FAILED …}); … emit ErrorReceived(rid, ERROR_CODE_EXECUTION_FAILED, returnData);` — no outbound; accurate. Retry gate :304 `if (!incomingRequest.executed || errorCode != ERROR_CODE_EXECUTION_FAILED) revert …`.
  - FeeManager.sol:22 `uint32 public constant DEFAULT_MAX_MESSAGE_LIFE = 172_800;` — 48h accurate.
- Wrong/overstated: "notification is deferred to the expiry path" understates: expiry notification is not automatic — it happens only when someone calls the permissionless `retryFailedRequest` after TTL (:294-312), and only when `errorSelector != 0` and `callerFee != 0` (InboxBase.sol:570, :585); the miner-reject leg is sent only for two-way (:208). So the source may never be notified. Recommendation (watch `ErrorReceived` on the destination) is sound.
- Severity: agree Informational (design), with the doc gap above worth recording.
- Gist PoC: none.
- Overlap: none.

### #39 — A documented pre-funding flow does not exist, and the balance it would have spent cannot be recovered (claimed: Informational)
- Verdict: CONFIRMED.
- Evidence:
  - PodERC20.sol:615-618 `require(callbackFeeLocalWei >= 1, …); require(callbackFeeLocalWei <= totalValueWei, …); require(address(this).balance >= totalValueWei, "PodERC20: inbox fee"); return IInbox(inbox).sendTwoWayMessage{value: totalValueWei}(` — cited line 617 accurate; the third `require` is a tautology when `totalValueWei == msg.value` (already credited) and exactly `msg.value` is forwarded.
  - Every external entry point passes `msg.value`: PodERC20.sol:175, 181, 186, 192, 206, 225, 246, 254, 260, 265, 271, 278, 283, 288, 293, 299, 315 — that is 17 entry points (the finding says sixteen; immaterial).
  - PodERC20.sol:142-144 `/// @dev `_sendPodTwoWay` may spend existing contract balance, so operational tooling can pre-fund this token for auto-fee flows.` / `receive() external payable {}` — quoted doc accurate.
  - grep of `contracts/pod/token/perc20` and `erc7984`: no `rescue`, `sweep`, `withdraw`, `selfdestruct` or `.call{value` in code (only NatSpec mentions). PrivacyPortalFactory.sol:375-409 forwarders (`configurePToken`, `transferPTokenOwnership`, `setPTokenMinter`, `setPTokenRequestKillMinAge`, `killPTokenStaleRequest`) are non-payable pass-throughs; `rescueNative`/`rescueERC20` are PrivacyPortal.sol:748/:769 — accurate.
- Wrong/overstated: nothing. Fix options are sound; dropping the check is safe because FeeManager.sol:163-171 validates payment.
- Severity: propose Low. The contract's own NatSpec directs operators to send native that becomes permanently unrecoverable (open `receive()`, no sweep) — a definite, irreversible loss, though self-inflicted, operator-only and not exploitable by third parties (the pre-funded balance can never be spent because exactly `msg.value` is forwarded).
- Gist PoC: none.
- Overlap: none.

### #40 — Four transfer selectors resolve to two implementations, and one has no caller (claimed: Informational)
- Verdict: CONFIRMED.
- Evidence:
  - PodErc20CotiMother.sol:232-234 `transfer … { _moveOrBurn(_activeTokenId(), from, to, value, false, false, 0); }`, :242-248 `transferOwner` — identical body; :237-239 `transferPublic … _moveOrBurn(_activeTokenId(), from, to, MpcCore.setPublic256(value), false, true, value);`, :251-257 `transferOwnerPublic` — identical. Cited lines accurate; all four `onlyRegisteredPTokenMessage` (:113-124).
  - grep both repos (`transferOwner\b`): only IPodErc20CotiSide.sol:51 and the mother :242; no `.selector` use. At the audited commits, `git grep` of both `test/` trees finds no `transferOwner` call (a later PoC, test/mother-poc/access.ts:242, was added after 89121ad).
  - PodERC20.sol:998-1001 `MpcAbiCodec.create(IPodErc20CotiSide.transferOwnerPublic.selector, 3).addArgument(from).addArgument(to).addArgument(amount)` — one caller, permit consumed locally at :996; accurate.
- Wrong/overstated: omits that IPodErc20CotiSide.sol:47-51 already labels `transferOwner` "Legacy same MPC move as {transfer}; renamed so accidental ABI wiring fails" — the duplication is deliberate legacy retention, not drift. Delegation fix is sound; deletion changes the interface.
- Severity: agree Informational.
- Gist PoC: none.
- Overlap: none.

### #41 — The burn path writes its nonce after an external call (claimed: Informational)
- Verdict: CONFIRMED (no reentrancy path exists); the finding undercounts sites.
- Evidence:
  - PodErc20CotiMother.sol:460-473 `uint256 burnNonce = _tokenNonce[id]; inbox.respond(abi.encode(… burnNonce)); emit BurnCompleted(… burnNonce); _tokenNonce[id] = burnNonce + 1;` — accurate. Mint :556-569 same pattern (finding's "557" is the `respond` line). The same pattern also exists at :225-228 (`syncBalances`) and :481-488 (transfer) — four sites, not two.
  - `respond` → InboxBase.sol:230-232 → `_reply` :241-290: storage reads, `_requireReplyMethodCallBounded` (:620-626, local `maxReplyMethodCallBytes()` read), `_sendOneWayMessage` → `_createRequest` :476-552 (fee caps via `_remoteMinFeeConfigMem()`/`_localMinFeeConfigMem()` = local ERC-7201 reads, FeeManagerStubBase.sol:256-262; no delegatecall, no oracle call). No external call leaves the Inbox — accurate. PodERC20.sol:62-63 nonce doc accurate.
- Wrong/overstated: "two sites" — four. Impact is entirely hypothetical (would need a future external call inside `_reply`). Moving the nonce write above `respond` is sound at all four sites.
- Severity: agree Informational.
- Gist PoC: none.
- Overlap: none.

### #42 — Every burn and mint computes an encrypted zero that is never read (claimed: Informational)
- Verdict: PARTIALLY CONFIRMED — unused for balance state, but one of the two fields is read and emitted.
- Evidence:
  - PodErc20CotiMother.sol:338-340 `function _ciphertextPlainZero() private returns (ctUint256 memory) { return MpcCore.offBoard(MpcCore.setPublic256(uint256(0))); }` — accurate; called :459 and :555 (also :349, :494 where it is consumed via `onBoard` — outside the claim).
  - Burn payload :461-471 uses `zeroCiphertext` as `newBalanceTo` and `receiverValue`; mint :557-567 as `newBalanceFrom` and `senderValue`.
  - PodERC20.sol:347 `if (from != address(0)) {` / :355 `if (to != address(0)) {` guard the balance writes — accurate for `newBalanceFrom`/`newBalanceTo`.
  - BUT PodERC20.sol:364-365 `emit Transfer(from, to, senderValue, receiverValue); _emitConfidentialTransfer(from, to, senderValue, receiverValue);` → PodErc7984Mixin.sol:115-116 `bytes32 handle = Erc7984Pointers.transferAmountHandle(from, to, senderValue, receiverValue); emit ConfidentialTransfer(from, to, handle);` — the zero ciphertext for the absent party IS read: it goes into the ERC-20 `Transfer` event and into the ERC-7984 handle. IPodERC20.sol:68 documents "either may be zero in edge cases".
- Wrong: "neither is read" / "its result is discarded by construction" — one field per op is emitted on-chain and hashed into the ERC-7984 handle. Passing an empty `ctUint256` changes event payloads and handles; the recommendation's "confirm no off-chain consumer" caveat is therefore load-bearing. Gas figure unverifiable (precompile is a local stub).
- Severity: agree Informational.
- Gist PoC: none.
- Overlap: none.

### #43 — Two request fields documented as different are assigned the same value everywhere (claimed: Informational)
- Verdict: CONFIRMED.
- Evidence:
  - IInbox.sol:52-55 `/// @notice Immediate caller that submitted the request. address callerContract; /// @notice Application contract that should receive responses/errors. address originalSender;` — accurate.
  - InboxBase.sol:516-517 `callerContract: requestSender, originalSender: requestSender,`; InboxMiner.sol:109-110 and :187-188 `callerContract: minedRequest.sourceContract, originalSender: minedRequest.sourceContract,`; InboxEstimateGas.sol:123-124 `callerContract: mined.sourceContract, originalSender: mined.sourceContract,` — all four sites accurate.
  - grep both repos: `callerContract` occurs only at those assignments and IInbox.sol:53 — no reader. InboxBase.sol:19 `mapping(bytes32 => Request) public requests;`, :25 `… public incomingRequests;` — public getters, accurate.
  - Storage: `callerContract` follows the `MpcMethodCall` struct member (always a new slot) and precedes `originalSender` (20+20 > 32 bytes → cannot pack) — a dedicated slot; fresh SSTORE 20,000 + cold 2,100 = 22,100; four `Request` writes per two-way exchange (InboxBase.sol:528 source outbound, InboxMiner.sol:121 dest incoming, dest reply outbound, source reply incoming) — accurate.
- Wrong/overstated: nothing. InboxBase.sol:449 NatSpec already says `requestSender` is "stored as `originalSender` / `callerContract`". Recommendation sound; note removal would change IInbox storage/ABI in Scope B.
- Severity: agree Informational.
- Gist PoC: none.
- Overlap: none.

### #44 — The mined batch is copied into memory before any item is validated (claimed: Informational)
- Verdict: PARTIALLY CONFIRMED — the core point holds; one stated mechanism is wrong.
- Evidence:
  - InboxMiner.sol:34-38 `function batchProcessRequests(uint256 sourceChainId, MinedRequest[] memory mined) external onlyMiner nonReentrant` — memory parameter (ABI-decoded copy on entry); accurate. Size cap :93-95 inside the loop — accurate. Miner-only (:36; MinerBase.sol:23-26).
  - Calldata siblings: InboxEstimateGas.sol:76 `IInboxMiner.MinedRequest calldata mined,`; InboxMiner.sol:277 `MinedRequest calldata mined,` — accurate.
- Wrong: ":61 each survivor is copied again by the assignment" — :61 `MinedRequest memory minedRequest = mined[i];` is a memory-to-memory assignment, which binds a reference and does not copy; likewise :108 `methodCall: minedRequest.methodCall` aliases. The only copies are the entry ABI decode and the storage write at :121. Also IInboxMiner.sol:47 declares `batchProcessRequests(uint256 sourceChainId, MinedRequest[] memory mined) external;`, so the change reaches Scope B's interface, not just "the helpers". Cost not measured (unverifiable).
- Severity: agree Informational (the miner pays its own gas).
- Gist PoC: none.
- Overlap: none.

### #45 — Event fields narrow array lengths without checking, and the bound that prevents overflow is declared elsewhere (claimed: Informational)
- Verdict: CONFIRMED.
- Evidence:
  - InboxBase.sol:643-644 `datatypeCount = uint16(methodCall.datatypes.length); datalenCount = uint16(methodCall.datalens.length);` (finding cites 642-643 — off by one; :642 is `dataLength`). Event fields :132-133 `uint16 datatypeCount, uint16 datalenCount` (MessageReceived) and :117-118 (MessageSent).
  - Caps before logging: InboxMiner.sol:93-95 `uint256 weight = MinerRejectLib.structuralSize(minedRequest.methodCall); if (weight > maxMethodCallBytes) revert …`; InboxBase.sol:493-496 `weight > remoteMax.maxMethodCallBytes`; InboxEstimateGas.sol:105-108. MinerRejectLib.sol:48 `data.length + (datatypes.length * 32) + (datalens.length * 32)`.
  - FeeManager.sol:25 `uint32 public constant PROTOCOL_MAX_METHOD_CALL_BYTES = 32_768;`, enforced :263-268 — 32,768/32 = 1,024 entries max; truncation threshold 65,536×32 = 2,097,152 bytes ("roughly two million") — accurate. Reply/system legs use empty arrays (InboxBase.sol:264-265, :595-596).
  - "a prior review recorded it as cosmetic": audit/POD_INBOX_AUDIT.md:354 (present in the 89121ad tree) `Log counts truncate to `uint16` (cosmetic)` — verifiable and accurate. "reachable in an earlier revision" — git history, unverifiable here.
- Wrong/overstated: nothing. Widening to `uint32` is sound; note it changes the event signatures (topic0), so indexers must update.
- Severity: agree Informational.
- Gist PoC: none.
- Overlap: none.

### #46 — Two naming conventions with different frames of reference are used together (claimed: Informational)
- Verdict: CONFIRMED (naming only).
- Evidence: InboxBase.sol:492 `FeeConfig memory remoteMax = _remoteMinFeeConfigMem();` :497 `if (targetFeeGas > remoteMax.maxExecutionGas)`; InboxMiner.sol:97 `if (minedRequest.targetFee > maxLocalExecutionGas)`, :100 `minedRequest.callerFee > maxRemoteExecutionGas`, :106 `targetChainId: sourceChainId,` — cited lines accurate. The inversion is already commented at InboxMiner.sol:46-47 `// Ingest caps invert create-time peer roles: targetFee executes here (local), callerFee funds the return leg on the peer (remote).` and InboxEstimateGas.sol:102. `git grep FeeGasTooHigh 89121ad -- test` returns nothing, consistent with "no test asserts which configuration each fee is checked against".
- Wrong/overstated: nothing; the code already documents the frame switch. Rename is sound but touches `IInbox.Request` fields (Scope B); the test-pinning alternative is the cheaper option.
- Severity: agree Informational.
- Gist PoC: none.
- Overlap: none.

### #47 — Code that cannot run, and two pieces that run but do not do what they appear to (claimed: Informational)
- Verdict: CONFIRMED on all seven items, with two caveats (b, g).
- Evidence:
  - (a) MpcAbiReEncode.sol:62-64 `uint64 rawType = uint64(data.datatypes[i]); require(rawType <= uint64(uint8(type(MpcDataType).max)), "MpcAbiReEncode: bad datatype"); require(data.datatypes[i] == bytes8(rawType), "MpcAbiReEncode: datatype alias");` — `bytes8`↔`uint64` is a bijection, so :64 always holds; :63 is the effective check. Confirmed.
  - (b) ModuleCallBase.sol:27 `function _staticModule(address module, bytes memory callData) internal view` — grep: no callers in either repo. Caveat: :26 already warns `Do not use for Inbox fee-state getters — STATICCALL runs in the module's storage context.`, and the helper is not "unusable" for pure targets (e.g. FeeManager.sol:214 `expectedMinFee … public pure`); the "message lifetime, minimum gas price" scenario has no FeeManager getter to hit (those getters are FeeManagerStubBase.sol:128-143 reading Inbox storage locally).
  - (c) FeeManagerStubBase.sol:168-173: remote guard first, then `if (localMin.gasPriceMul == 0 || localMin.gasPriceDiv == 0) { revert FeeConfigInvalid(_toLib(localMin)); }`. FeeManager.sol:130-139 writes both templates only after `_requireValidFeeConfig` on both, and :269-271 `if (feeConfig.gasPriceMul == 0 || feeConfig.gasPriceDiv == 0) revert FeeConfigInvalid` — so local is never invalid while remote is valid. Confirmed. The parenthetical about the "unbounded-skew-ratio validator" is a cross-reference to C1, not the cause.
  - (d) InboxEstimateGas.sol:139-140 `_exitEstimateMode(); revert IInboxMiner.ExecutionGasEstimate(gasUsed, responseDataSize, errorDataSize);` — the clear is undone by the revert. Confirmed (harmless).
  - (e) PrivacyPortalFactory.sol:647-649 `if (nativeWrappedUnderlying != (underlying == nativeToken)) revert NativeUnderlyingMismatch` with `nativeToken` immutable (:56); :621-637 require `portalForPToken[existingPToken] == portalForUnderlying[underlying]`, and that old portal received its flag under the same check at :563-564 → `oldNative == nativeWrappedUnderlying` always; :659-664 unreachable. Confirmed (a foreign-factory portal is not found at :622, so the block is skipped, not entered).
  - (f) PodErc20Mintable.sol:54-63 six-arg `_initializePodErc20Mintable` defaulting `18`; grep: the only external caller of the family is PodErc20MintableInitializable.sol:46 using the 7-arg form. Confirmed.
  - (g) InboxMiner.sol:63-68 force `minedChainId == sourceChainId` and `minedTargetChainId == chainId`; :70 `if (minedNonce != allowedNonce) revert NoncesNotContiguous();`; :74-75 `Request storage incomingRequest = incomingRequests[requestId]; if (incomingRequest.requestId != bytes32(0)) revert RequestAlreadyProcessed();`. `incomingRequests` is written only at :121/:182 (inside the batch that also advances :162 `lastIncomingRequestId[sourceChainId] = mined[mined.length - 1].requestId;`) and InboxEstimateGas.sol:118 (always reverts :140); `lastIncomingRequestId` has no other writer. So any stored id has nonce < allowedNonce and :75 cannot fire. Confirmed. Caveat: the "project's invariant documentation" wording exists at x-ray/invariants.md:24 (`Prevents the miner from re-submitting/duplicating an already-processed incoming request id`), but that file is not in the 89121ad tree and cites pre-custom-error line numbers — its status as project documentation is unverifiable.
- Wrong/overstated: (b) as above. Removing dead fragments is sound; for (g), keeping the check as defence-in-depth with a comment is equally reasonable — deletion is not required for safety.
- Severity: agree Informational.
- Gist PoC: none.
- Overlap: none.

### #48 — A superseded encode function remains beside its replacement, and it is the unsafe one (claimed: Informational)
- Verdict: CONFIRMED (bytecode claim unverifiable).
- Evidence: InboxBase.sol:677-684 `_encodeMethodCall` — `revert RawCallHasDatatypes()` / `RawCallHasDatalens()` (:679-680) then :683 `return _delegateReEncodeWithGt(methodCall);`; :741-753 `_delegateReEncodeWithGt` bubbles revert (:748-750) and `abi.decode(ret, (bytes))` (:752). :687-717 `_safeEncodeMethodCall` returns `(ok, callData, err)`. grep both repos: only the two definitions and the one call at :683 (three references, as stated). Live ingest path InboxMiner.sol:336-337 uses `_safeEncodeMethodCall`. Batch atomicity: single loop in one tx (:60-159). "Confirmed against the compiler's record of the deployed bytecode" — would require compiling; unverifiable here (plausible for an uncalled internal function, not asserted).
- Wrong/overstated: nothing. Deleting the pair is sound.
- Severity: agree Informational.
- Gist PoC: none.
- Overlap: none.

### #49 — A storage pointer is taken before its slot is written and read after, across a function boundary (claimed: Informational)
- Verdict: CONFIRMED (behaviour correct; readability hazard real); the recommended fix as phrased would not compile.
- Evidence: InboxMiner.sol:74 `Request storage incomingRequest = incomingRequests[requestId];`, :75 emptiness check, :84-91 pointer passed to `_ingestMinerReject` (:167-174 param `Request storage incomingRequest`), :182-197 `incomingRequests[requestId] = Request({ … isTwoWay: minedRequest.isTwoWay, … sourceRequestId: minedRequest.sourceRequestId, …});`, :209 `_sendSystemErrorCallbackWithCode(incomingRequest, ERROR_CODE_MINER_REJECTED, reasonBytes);`, :212 `if (incomingRequest.sourceRequestId != bytes32(0) && !incomingRequest.isTwoWay) {` — all cited lines accurate; pointer and mapping entry alias the same slots. The described hazard is real: a memory copy would zero `isTwoWay`/`sourceRequestId`/`errorSelector`/`callerFee`, and InboxBase.sol:570 `if (incomingRequest.errorSelector == bytes4(0)) return;` would silently drop the return leg.
- Wrong/overstated: "Write through the parameter rather than through the mapping key" — Solidity does not permit assigning a memory struct to a `storage` pointer variable (`incomingRequest = Request({…})` is a type error), so the fix must be field-wise writes through the pointer or the comment alternative. Otherwise accurate.
- Severity: agree Informational.
- Gist PoC: none.
- Overlap: none.

### #50 — A reply leg carries an error selector belonging to a different contract's ABI (claimed: Informational)
- Verdict: CONFIRMED; the fix interacts with #37's fix.
- Evidence:
  - InboxBase.sol:273-282 `_sendOneWayMessage(currentContext.remoteChainId, originalSenderContract, replyMethodCall, incomingRequest.errorSelector, incomingRequestId, incomingRequest.callerFee, 0, msg.sender)` — reply leg's `errorSelector` = original app's (e.g. `PodERC20.transferError`), `callerFeeGas = 0`, `requestSender = msg.sender` which :254 forces to be `incomingRequest.targetContract` (the mother). Accurate.
  - `_sendSystemErrorCallbackWithCode` :565-617: 1st check :570 `errorSelector == bytes4(0)` → return; 2nd :573 already replied; 3rd :578 zero sender; 4th :585 `if (incomingRequest.callerFee == 0) { … emit SystemErrorRaised …; return; }` — "returns at its fourth check" accurate; delivery target :577 `address sourceApp = incomingRequest.originalSender;` → the mother; grep: PodErc20CotiMother.sol contains no `transferError` → such a leg would fail on arrival. Accurate.
- Wrong/overstated: mechanism accurate. Fix (`bytes4(0)` for reply legs) is sound in isolation: the source-side classifier reads the ORIGINAL request's selector (InboxBase.sol:396-397), not the leg's, so PodERC20 is unaffected — but it directly conflicts with #37's proposed "resolve the return leg's own error selector"; applied together, every reply leg classifies NotErrorContext. Side effect: `MessageSent` (:548) would log `errorSelector = 0` for reply legs (indexer impact unverifiable).
- Severity: agree Informational.
- Gist PoC: none.
- Overlap: none.

### #51 — A gas budget is passed and named as a fee (claimed: Informational)
- Verdict: CONFIRMED.
- Evidence: FeeManager.sol:90-98 `/// @notice Execution gas budget available to an incoming target call …` / `function localRequestExecutionBudget(uint256 totalFee) external payable returns (uint256 budget) { … uint256 errorBuffer = uint256(localMin.errorLength) * uint256(localMin.gasPerByte); return totalFee > errorBuffer ? totalFee - errorBuffer : 0; }` — cited line 92 accurate; gas arithmetic. Sole call chain: FeeManagerStubBase.sol:245-249 `_localRequestExecutionBudget(uint256 totalFee)` ← InboxMiner.sol:353 `uint256 targetGasBudget = _localRequestExecutionBudget(incomingRequest.targetFee);` — accurate; ingest bound :97-99. IInbox.sol:80-81 `/// @dev Gas unit budget for the remote execution leg … Not wei. uint256 targetFee;`. Wei-suffixed siblings: FeeManager.sol:158 `totalFeeLocalWei`, LibFeeStorage.sol:33-35 `minPriorityFeeWei/minGasPriceWei/maxGasPriceWei`.
- Wrong/overstated: nothing. Rename sound; `targetFee`/`callerFee` are `IInbox.Request` fields (Scope B ABI) — the NatSpec at IInbox.sol:6 and :80-83 already says "gas unit budgets, not wei".
- Severity: agree Informational.
- Gist PoC: none.
- Overlap: none.

### #52 — Return data is bounded for the untrusted call target and unbounded for every trusted one (claimed: Informational)
- Verdict: CONFIRMED.
- Evidence:
  - InboxBase.sol:791-819 `_callWithCappedReturnData`: :799 `success := call(gasBudget, target, 0, dataPtr, dataLen, 0, 0)`, :801-803 cap to `maxLen` (`MAX_ERROR_RETURN_DATA = 256`, :99), :810 zero trailing word; :778 NatSpec "Execution failures must use {_callWithCappedReturnData} so returndata is never fully materialized." — accurate.
  - (a) InboxBase.sol:704-706 `(bool success, bytes memory ret) = target.delegatecall(abi.encodeWithSelector(MpcAbiReEncode.reEncodeWithGt.selector, methodCall));` — high-level; reached from InboxMiner.sol:336-337. (b) ChainlinkFeedLib.sol:23 `try AggregatorV3Interface(feed).latestRoundData() returns (` — `view` interface (AggregatorV3Interface.sol:8-10) → STATICCALL. (c) ModuleCallBase.sol:18 `module.delegatecall(callData)`, :29 `module.staticcall(callData)`. All cited lines accurate.
  - Owner-configured: `mpcAbiReEncode`/`feeManager` assigned only in `_initInboxBase` (InboxBase.sol:176, :178); feed via ChainlinkLiveOracle.sol:36 `setFeed … onlyOwner`; adapter via PoDPriceOracle.sol:32 `setConfiguredOracle … onlyOwner`; oracle via FeeManager.sol:102 behind InboxMiner.sol:224 `onlyOwner`.
- Wrong/overstated: none of substance. Note the feed is reached from the user-triggered `refreshCache` inside try/catch (InboxBase.sol:204, :225), so a hostile feed's memory cost lands on the sending user — but only after the owner installs it (trust-model consistent, as the finding says). The full-returndata-copy codegen detail is compiler behaviour I did not verify by compiling.
- Severity: agree Informational.
- Gist PoC: none.
- Overlap: none.

### #53 — The never-reverts contract on the feed library describes less than its wording implies (claimed: Informational)
- Verdict: CONFIRMED.
- Evidence: ChainlinkFeedLib.sol:10 `/// @dev Never reverts: stale, incomplete rounds, non-positive answers, and failed calls return `(false, 0)`.` — quoted accurately; :23-52 try/catch around `latestRoundData`, :41-49 nested try around `decimals()`. InboxBase.sol:203 and :224 `// Best-effort: must not revert a paid send (EIP-150 63/64 can OOG nested refresh under tight gas).` — quoted accurately (these annotate the `refreshCache` calls, not the feed lib). EVM semantics: try/catch contains the callee's revert but not its gas consumption; a callee that burns its 63/64 forward leaves the caller 1/64. Hostile feed requires the owner (ChainlinkLiveOracle.sol:36).
- Wrong/overstated: the library's statement is literally true (the library itself never reverts); the note concerns an inference about gas. Doc fix is sound; a `{gas: …}` bound on the two feed calls is the code-level alternative.
- Severity: agree Informational.
- Gist PoC: none.
- Overlap: none.

---

## Summary of deviations from the auditor's text
- Severity upgrades proposed: #39 → Low (in-code docs direct operators to irrecoverably lock native). #34 → Low unless the "blacklist governs new withdrawals only" policy is formally accepted (matches our validated #2).
- Factual errors found: #42 ("never read" — the zero ciphertext is emitted in `Transfer`/ERC-7984 events); #44 (":61 copies again" — memory-to-memory assignment aliases); #41 undercounts sites (four, not two); #45 off-by-one line cite; #49's fix as phrased is not valid Solidity.
- Recommendation conflicts: #37's "use the reply leg's own errorSelector" cannot distinguish respond from raise and, combined with #50's "set reply-leg errorSelector to 0", would make every reply leg NotErrorContext and break PodERC20's error handlers.
- Already-documented behaviour presented as findings: #36 (InboxBase.sol:150-153), #37 (IInbox.sol:12, :225-227), #40 (IPodErc20CotiSide.sol:47-51 "Legacy"), #46 (InboxMiner.sol:46-47), #47(b) (ModuleCallBase.sol:26).
- Unverifiable items: client statements (#33, #34), production oracle wiring (#33), bytecode emission (#48), git history (#45), provenance of x-ray/invariants.md (#47g), on-COTI precompile gas (#42).
