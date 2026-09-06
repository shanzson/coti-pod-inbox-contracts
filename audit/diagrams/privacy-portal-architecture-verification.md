# Architecture diagram verdict — Privacy Portal (coti-contracts 8a0c4928)

**Summary: 109 claims checked — 84 CORRECT · 22 IMPRECISE · 3 WRONG.**

Checkout verified: `git diff --stat 8a0c4928004dac7a6c8d50bde58a022b6912f963 HEAD -- contracts/` is empty, so
`/home/user/coti-contracts/contracts/` is byte-identical to the audited commit. All `PP*` / `PodERC20*` /
`PodErc20CotiMother` / `MpcCore` paths below are relative to `/home/user/coti-contracts/`; `InboxBase.sol` /
`InboxMiner.sol` are relative to `/home/user/coti-pod-inbox-contracts/`.

---

## Claim-by-claim table

| Area | Claim (short) | Verdict | Evidence file:line | Note |
|---|---|---|---|---|
| Header | "coti-contracts 8a0c4928" | CORRECT | git diff empty vs 8a0c4928 | Tree matches audited commit. |
| Role box | Admin = `DEFAULT_ADMIN_ROLE` exists | CORRECT | PrivacyPortalFactory.sol:29,236 | OZ `AccessControl`; `isAdmin` view. |
| Role box | Admin: pause | CORRECT | PrivacyPortalFactory.sol:433; PrivacyPortal.sol:266 | Factory-wide `pause()` + per-portal `pause()` (`onlyFactoryAdmin`). |
| Role box | Admin: blacklist | CORRECT | PrivacyPortalFactory.sol:286,295; PrivacyPortal.sol:317,326 | Both levels are `DEFAULT_ADMIN_ROLE`. |
| Role box | Admin: limits | CORRECT | PrivacyPortal.sol:336 | `setLimits` is `onlyFactoryAdmin`. |
| Role box | Admin: rescue | CORRECT | PrivacyPortal.sol:748,769 | `onlyFactoryAdmin` + `whenPaused`. |
| Role box | Admin: remount | CORRECT | PrivacyPortalFactory.sol:607-611 | `createPortalWithExistingPToken` is `onlyRole(DEFAULT_ADMIN_ROLE)`. |
| Role box | Admin capability list is complete | IMPRECISE | PrivacyPortalFactory.sol:314,327,344,361,375,385,473 | Omits `setDeployer`, both `set*Implementation`, `configureRouting`, `setPriceOracle`, `configurePToken`, `transferPTokenOwnership`; and `adminRefundPendingDeposit` (PrivacyPortal.sol:614). |
| Role box | Operator = `OPERATOR_ROLE`: fee configs | CORRECT | PrivacyPortalFactory.sol:33,453,463; PrivacyPortal.sol:356,363,370,376 | Factory defaults + per-portal overrides. |
| Role box | Operator: soft deposit switch | CORRECT | PrivacyPortal.sol:281 | `setIsDepositEnabled` is `onlyFactoryOperator`. |
| Role box | Deployer = `DEPLOYER_ROLE`: `createPortal(...)` | CORRECT | PrivacyPortalFactory.sol:66,151-156,549 | `onlyDeployer` → `OnlyDeployer`. |
| Role box | User: "deposit · depositNative · wrap · withdraw" | IMPRECISE | PrivacyPortal.sol:382,434,492,503 | No `withdraw` function exists; it is `requestWithdrawWithPermit` (legend #4 gets it right). |
| Role box | Anyone/keeper: release · refund · finalize burn · cancel | CORRECT | PrivacyPortal.sol:583,646,667,703 | All four carry no access modifier. |
| Factory | "one per chain" | IMPRECISE | PrivacyPortalFactory.sol (no singleton logic) | Deployment convention only; nothing in code prevents several factories per chain. |
| Factory | "Ownable OWNER of every pToken clone" | CORRECT | PrivacyPortalFactory.sol:576; PodErc20MintableInitializable.sol:46 | Factory passes `address(this)` as pToken owner. Transferable later (Factory:385); the factory itself is AccessControl, not Ownable. |
| Factory | config: inbox·cotiChainId·cotiMother·impls·priceOracle·nativeToken | CORRECT | PrivacyPortalFactory.sol:42-59 | All six state vars present. |
| Factory | `feeRecipient` is **immutable** | CORRECT | PrivacyPortalFactory.sol:52 | `address public immutable`; no setter in the contract or `IPrivacyPortalFactoryAdmin`. |
| Factory | rescueRecipient · default fees (fixed\|bps\|max) · pause · blacklist | CORRECT | PrivacyPortalFactory.sol:54,61-63,74,433 | `packFeeConfig` triple = PrivacyPortalFeeLib.sol:24-38. |
| Factory | `createPortal` → clone portal + clone pToken + one-way registerToken | CORRECT | PrivacyPortalFactory.sol:567,568,592,744 | Exactly that order. |
| Factory | `createPortalWithExistingPToken` → remount on a fresh clone (minter rotates) | IMPRECISE | PrivacyPortalFactory.sol:611,625-637,665,673,674 | Minter rotation correct (674), but it is *also* the create path when the pToken is unmapped; and it retires + requires the old portal paused (653,665) and leaves the new clone paused (673). |
| Factory | pToken forwarders gated "**owner only**" | **WRONG** | PrivacyPortalFactory.sol:375,394,400,406 vs 228-233 | All four are `onlyRole(DEFAULT_ADMIN_ROLE)`. `owner()` is only a primary-admin *pointer* view and is not consulted by any of them. |
| Factory | forwarder named `setRequestKillMinAge` | IMPRECISE | PrivacyPortalFactory.sol:400; PodERC20.sol:584 | Factory function is `setPTokenRequestKillMinAge`; `setRequestKillMinAge` is the *pToken's* own `onlyOwner` function. Abbreviation collides across contracts. |
| Factory | forwarder named `killStaleRequest` | IMPRECISE | PrivacyPortalFactory.sol:406; PodERC20.sol:590 | Factory function is `killPTokenStaleRequest`; the same string appears verbatim in the pToken box for a different function. |
| Factory | forwarder list complete | IMPRECISE | PrivacyPortalFactory.sol:385 | Omits `transferPTokenOwnership`. |
| Factory | views read by portals (isAdmin/isOperator, paused, blacklisted, fees, oracle) | CORRECT | PrivacyPortal.sol:909,913,985-990,1001-1006,1013,1020,1029 | Portal also reads `feeRecipient` (727), `rescueRecipient` (752,774), `nativeToken` (914). |
| Oracle | "admin-set USD prices (1e18 scale) per token" | IMPRECISE | PortalFeeOracle.sol:11,31 | Gate is the oracle's *own* `Ownable` owner, not a factory role; scale is 18-dec USD per whole token (13). |
| Oracle | "zero price ⇒ dynamic fee off (fixed fee only)" | CORRECT | PrivacyPortalFeeLib.sol:87-89 | Falls back to `fixedFee` if either rate is 0. |
| Portal | "holds the ERC-20 / WETH collateral" | CORRECT | PrivacyPortal.sol:33,412-421,461 | |
| Portal | `depositEscrows[mintRequestId]{user,recipient,amount=received,status}` | CORRECT | PrivacyPortal.sol:79,420-425; IPrivacyPortal.sol:35-44 | `amount` is the measured delta. |
| Portal | `withdrawals[withdrawalId]{user,recipient,amount,transferReqId,status}` | CORRECT | PrivacyPortal.sol:77,548-554; IPrivacyPortal.sol:47-58 | `transferReqId` = `transferRequestId`. |
| Portal | state "pendingBurnAmount · burnInFlight · inFlightTotal" | IMPRECISE | PrivacyPortal.sol:59,61,63 | Third variable is `burnInFlightTotal`, not `inFlightTotal`. |
| Portal | accumulatedPortalFees · limits · fee overrides | CORRECT | PrivacyPortal.sol:52-56,67-73 | |
| Portal | per-portal blacklist · paused · isDepositEnabled | CORRECT | PrivacyPortal.sol:47,49; Pausable | |
| Portal | STATE list complete | IMPRECISE | PrivacyPortal.sol:38,40,65 | Omits `factory` vs `bindingFactory` (the remount detach split — materially load-bearing) and `withdrawalNonce`. |
| Portal | ENTRY `deposit · depositNative · wrap` | CORRECT | PrivacyPortal.sol:382,434,492 | `depositNative` additionally requires `nativeWrappedUnderlying` (436). |
| Portal | ENTRY `requestWithdrawWithPermit` | CORRECT | PrivacyPortal.sol:503 | |
| Portal | `onPTokenTransferred` (**pToken only**) | CORRECT | PrivacyPortal.sol:575-578 | `msg.sender != address(pToken)` → `OnlyPToken`. |
| Portal | `triggerWithdrawalRelease` permissionless | CORRECT | PrivacyPortal.sol:667 | No access modifier. |
| Portal | `cancelFailedWithdrawal` / `refundFailedDeposit` permissionless | CORRECT | PrivacyPortal.sol:583,646 | |
| Portal | `adminRefundPendingDeposit` gate shown as "**(paused)**" | **WRONG** | PrivacyPortal.sol:614-620 | Real gate is `onlyFactoryAdmin` **and** `whenPaused`. Every other parenthetical in the box names the caller, so "(paused)" reads as "anyone, while paused". |
| Portal | `burnAccumulatedPTokens · finalizeBatchBurn` (no gate shown) | IMPRECISE | PrivacyPortal.sol:672-677 vs 703 | `burnAccumulatedPTokens` is `onlyFactoryAdmin`; `finalizeBatchBurn` is permissionless. Grouping them with no annotation conflates the two. |
| Portal | `withdrawPortalFees · rescueERC20 · rescueNative` (no gate shown) | IMPRECISE | PrivacyPortal.sol:727,748,769 | All `onlyFactoryAdmin`; rescues also `whenPaused`. Legend #15 covers it, the box does not. |
| Portal | ENTRY list complete | IMPRECISE | PrivacyPortal.sol:292,304 | Omits factory-only `retireDepositsForUpgrade` and `pauseByFactory` — the two calls that make remount work. |
| pToken | "minter = portal · owner = factory" | CORRECT | PrivacyPortalFactory.sol:574-576; PodErc20MintableInitializable.sol:30-47 | |
| pToken | "ctUint256 balance cache — NOT authoritative" | CORRECT | PodERC20.sol:51,347-362 | Written only by nonce-gated inbox callbacks; mother is SoT. |
| pToken | `_requests[id]: Pending\|Success\|Failed\|SystemFailed` | IMPRECISE | IPodERC20.sol:13-21 | Enum also has `None` (value 0) — what an unknown/never-created request id reads. |
| pToken | `_requestCallbacks[id]` (portal hook on withdraw) | CORRECT | PodERC20.sol:57,249,363-372 | |
| pToken | `nonces` (EIP-712 TransferPermit) · `balanceNonces` | CORRECT | PodERC20.sol:36,46-49,63,853-872 | Real EIP-712 `TransferPermit` typehash + domain. |
| pToken | `mint` (**minter only**) | CORRECT | PodERC20.sol:269,297; PodErc20Mintable.sol:46-50 | `_checkMinter` → `OnlyMinter`. |
| pToken | `transferFromAndCallWithPermit · burn` | CORRECT | PodERC20.sol:232,264,292 | |
| pToken | `transferCallback/transferError` (**inbox only**) | IMPRECISE | PodERC20.sol:334,430; InboxUser.sol:44-67 | `transferCallback` is `onlyInboxPeer` (inbox **and** `trustedRemote` origin); `transferError` is `onlyInboxReturnLeg` (inbox **and** linked return leg, peer deliberately *not* checked so SYSTEM_SENDER legs land). "inbox only" is the weakest of the three gates and describes neither. |
| pToken | `invalidatePendingRequest` (**minter**) | CORRECT | PodERC20.sol:573-574 | `_checkMinter()` first line. |
| pToken | `killStaleRequest · configure` (**owner = factory**) | CORRECT | PodERC20.sol:156,590 | Both `onlyOwner`; owner is the factory. Omits `setRequestKillMinAge` (584) and the min-age precondition (596-599). |
| pToken | "no MPC here: every move is a message to COTI" | CORRECT | PodERC20.sol:4-12; MpcAbiCodec.sol:41-160 | Only `MpcAbiCodec` (all `internal pure` encoding) is imported; no MpcCore precompile call anywhere in PodERC20. |
| pToken | box lists all entry points | IMPRECISE | PodERC20.sol:174-323 | Omits the permissionless holder-facing surface: `transfer`, `transferFrom`, `approve`, `burn`, `transferAndCall`, `syncBalances` — none of which are gated. |
| Underlying | "safeTransferFrom on deposit (balance delta measured)" | IMPRECISE | PrivacyPortal.sol:412-414 vs 460-462 | True for `deposit`/`wrap`; `depositNative` uses `IWrappedNative.deposit{value:}`, not `safeTransferFrom` (delta measurement is used on both). |
| Underlying | "safeTransfer / WETH.withdraw on release · rescue" | CORRECT | PrivacyPortal.sol:866-873,780 | |
| Inbox (src) | `sendTwoWayMessage / sendOneWayMessage → requestId` | CORRECT | InboxBase.sol:185,209 | |
| Inbox (src) | "return legs: callback \| app error \| system error" | CORRECT | InboxBase.sol:106,230,236,386-389 | System legs attributed to `SYSTEM_SENDER`. |
| MpcCore | ops onBoard·add/sub·gt/mux·offBoard·decrypt are real | CORRECT | MpcCore.sol:296,301,352,358,410,429,505,530,535 | All exist. Note the mother actually compares with `ge`, not `gt` (PodErc20CotiMother.sol:419,425,438,446). |
| MpcCore | "balances exist only as garbled / ciphertext values" | CORRECT | PodErc20CotiMother.sol:32,339-352 | Stored `ctUint256`, computed as `gtUint256`. |
| Mother | "unified ledger for ALL pTokens" | CORRECT | PodErc20CotiMother.sol:11-14,32-38 | Namespaced maps. |
| Mother | namespace derived **ONLY** from `inboxMsgSender`, **never** from arguments | IMPRECISE | PodErc20CotiMother.sol:331-334 vs 178-189 | True of every balance-moving op (`_activeTokenId`). **False for `registerToken`**: only the chain id comes from the inbox; `remotePToken` is a calldata argument (189), so an allow-listed factory can register any address on its chain. |
| Mother | `registerToken(...)` ← allow-listed factory only | CORRECT | PodErc20CotiMother.sol:102-110,178-183 | `onlyRegisteredFactoryMessage` → `FactoryNotAllowed`. |
| Mother | `mintPublic / mint` = portal deposits | CORRECT | PodErc20CotiMother.sol:313,318; PodERC20.sol:1085 | Portal `mint` → `mintPublic`. |
| Mother | `transferOwnerPublic` = withdraw, user → portal custody | CORRECT | PodErc20CotiMother.sol:250-257; PodERC20.sol:998 | `transferFromAndCallWithPermit` encodes exactly this selector. |
| Mother | `burnPublic / burn` = portal batch burn | CORRECT | PodErc20CotiMother.sol:302-309; PodERC20.sol:1057 | |
| Mother | `transfer / transferFromAsSpender / approve / syncBalances` exist | CORRECT | PodErc20CotiMother.sol:203,232,255,268,283 | Omits `transferPublic`, `transferOwner`, `approvePublic`, `transferFromPublicAsSpender`, and `ownerMint` (170, always reverts). |
| Mother | "all gated by `onlyRegisteredPTokenMessage` → `TokenNotRegistered`" | CORRECT | PodErc20CotiMother.sol:113-120 | Holds for every listed op. |
| Mother | "success → `respond(new ciphertexts, nonce)`" | IMPRECISE | PodErc20CotiMother.sol:226,461,482,557 vs 531 | Transfer/mint/burn/sync carry the nonce; the **approve** response does not. |
| Mother | "app failure → `raise(reason)`" | CORRECT | PodErc20CotiMother.sol:574,579,584 | Raise, never revert (mother runs under inbox execution). |
| Mother | "per-token callback nonce starts at 1 on registration" | CORRECT | PodErc20CotiMother.sol:28,196 | `INITIAL_TOKEN_NONCE = 1`; matches PodERC20.sol:330 comment. |
| Inbox (COTI) | "executes the MpcMethodCall on the mother as (chainId, sender)" | CORRECT | InboxBase.sol:356-360 | `inboxMsgSender()` = `(remoteChainId, remoteContract)`. |
| Inbox (COTI) | "carries respond / raise back as the return leg" | CORRECT | InboxBase.sol:230-244 | |
| Flow #1 | decimals must match underlying and be ≤ 18 | CORRECT | PrivacyPortalFactory.sol:35,556-562 | Both checks live in the **factory**, not portal/pToken. |
| Flow #2 | clones + initializes; `minter = portal`, `owner = factory` | CORRECT | PrivacyPortalFactory.sol:567-586 | |
| Flow #3 | one-way `registerToken`, **no error selector** | CORRECT | PrivacyPortalFactory.sol:744-746; InboxBase.sol:215-217 | Stronger than stated: one-way sends *reject* a non-zero error selector (`OneWayErrorSelectorNotSupported`). |
| Flow #3 | "the portal is already live" | CORRECT | PrivacyPortal.sol:255; PrivacyPortalFactory.sol:536-542 | `isDepositEnabled = true` at initialize and not paused, so deposits are accepted before the mother has registered. |
| Flow #3/#13 | "(#5)" and "(#1)" cross-references | IMPRECISE | legend numbering 1-17 | Read as legend items (#5 = "Portal ↔ underlying", #1 = "Deployer: createPortal"), which is nonsense; they are audit-finding ids. |
| Flow #4 | user entry points + escrow Pending / EIP-712 | CORRECT | PrivacyPortal.sol:382,434,492,503,420-425 | |
| Flow #5 | "safeTransferFrom on deposit, safeTransfer / WETH.withdraw on release, rescue when paused" | IMPRECISE | PrivacyPortal.sol:461,866-873,748,769 | Omits the `WETH.deposit` (wrap) leg used by `depositNative`. |
| Flow #6 | `mint(recipient, received)` · `transferFromAndCallWithPermit(user → portal)` · `burn(amount)` | CORRECT | PrivacyPortal.sol:419,539-546,692 | Real signatures carry a trailing callback-fee arg. |
| Flow #7 | `sendTwoWayMessage(MpcMethodCall, cb=transferCallback, err=transferError, fee)` | CORRECT | PodERC20.sol:608-626,1004-1009,1090-1096,1062-1068 | Mint, burn and permit-transfer all use this pair. |
| Flow #8 | miner relays, "nonce-ordered per target chain" | CORRECT | InboxBase.sol:30-33,507; InboxMiner.sol:54-72 | Outbound nonce is per target chain; ingest enforces contiguity per source chain (`NoncesNotContiguous`) — the same sequence seen from the far end. |
| Flow #9 | mintPublic / transferOwnerPublic / burnPublic, auth as (chainId, pToken) | CORRECT | PodErc20CotiMother.sol:113-120,331-334 | |
| Flow #10 | "onBoard → compute on garbled values → offBoard" | CORRECT | PodErc20CotiMother.sol:339-360,453,477 | |
| Flow #10 | "**never plaintext**" | **WRONG** | PodErc20CotiMother.sol:238,256,308,318,419,425 | Every portal path is a `*Public` variant carrying a **plaintext uint256 amount** into `MpcCore.setPublic256`, and the public branch calls `MpcCore.decrypt(MpcCore.ge(...))` to reveal solvency as a plaintext bool. The MpcCore box even lists `decrypt` as an op. |
| Flow #11 | respond on success, raise on app failure, inbox may emit a system error | CORRECT | PodErc20CotiMother.sol:461,482,557,574; InboxBase.sol:106,386-389 | |
| Flow #12 | transferCallback (Success) / transferError (Failed or SystemFailed); terminal, one-way | CORRECT | PodERC20.sol:336,437,628-637,684-690 | `_setRequestStatus` requires `current == Pending` for any terminal write → monotonic. |
| Flow #13 | low-level call `onPTokenTransferred(withdrawalId)` → `_releaseWithdrawal`; failure swallowed | CORRECT | PodERC20.sol:367-372; PrivacyPortal.sol:535-536,575-578,853 | `address(to).call(...)`; on failure only `RequestCallbackFailed` is emitted. |
| Flow #14 | Anyone: trigger/refund(SystemFailed)/finalize/cancel | CORRECT | PrivacyPortal.sol:583-595,646,667,703 | |
| Flow #15 | Admin: pause·blacklist·setLimits·rescue*(paused)·burnAccumulatedPTokens·withdrawPortalFees→feeRecipient·remount | CORRECT | PrivacyPortal.sol:266,317,336,672,727-730,748,769; Factory:611 | Omits `adminRefundPendingDeposit` (614). |
| Flow #16 | Operator: setDepositFee/setWithdrawFee/factory defaults (fixed \| bps ≤ 10% \| max) · setIsDepositEnabled | CORRECT | PrivacyPortal.sol:281,356,363; Factory:453,463; FeeLib:13-15,32 | `MAX_FEE_UNITS 100_000 / FEE_DIVISOR 1_000_000` = 10%. Omits `clear*FeeOverride` (370,376). |
| Flow #17 | Portal → oracle via factory, `getLivePrices(native, underlying)`, zero rate ⇒ fixed fee | CORRECT | PrivacyPortal.sol:900-919; FeeLib:87-89 | Address is discovered through `factory.priceOracle()`, then called directly. Fixed fee also applies when `bps == 0` (909). |
| Escrow | mint is asynchronous; collateral locked now | CORRECT | PrivacyPortal.sol:412-419 | |
| Escrow | keyed by pToken request id; refund validated against `requests(id).status` = **SystemFailed only** | CORRECT | PrivacyPortal.sol:583-595 | `DepositMintNotFailed` otherwise. |
| Escrow | amount = measured received (fee-on-transfer safe) | CORRECT | PrivacyPortal.sol:414,420-424 | `NoUnderlyingReceived` if delta is 0. |
| Escrow | user ≠ recipient allowed; pTokens → recipient, refund → user | CORRECT | PrivacyPortal.sol:419-425,598 | |
| Escrow | Pending → Refunded makes refund one-shot | CORRECT | PrivacyPortal.sol:586,597 | `Refunded` fails the `Pending\|Failed` precondition. |
| Escrow | admin path needs pause + status ≠ Success | CORRECT | PrivacyPortal.sol:614-635 | Also requires escrow status **exactly** `Pending` (623) and calls `pToken.invalidatePendingRequest` first (633-635) — both omitted. |
| Escrow | never marked terminal on mint SUCCESS (stays Pending) | CORRECT | grep `DepositEscrowStatus` — only writes at 424,472,597,638 | No success path writes the escrow. |
| Escrow | `DepositEscrowStatus.Failed` is never written | CORRECT | IPrivacyPortal.sol:29; PrivacyPortal.sol:586 (read only) | |
| Arrows | #1 Deployer→Factory; #4 User→Portal; #14 Anyone→Portal | CORRECT | gen_arch.py:101,107,108 | |
| Arrows | #15 Admin→**Factory only**, #16 Operator→**Factory only** | IMPRECISE | gen_arch.py:102,103; PrivacyPortal.sol:266,336,672,727,994-1006 | Most listed admin/operator actions are direct **portal** calls; the portal merely *reads* `isAdmin`/`isOperator` from the factory (Factory:572-573 comment: "no local Ownable — call the portal directly"). No Admin→Portal or Operator→Portal arrow exists. |
| Arrows | #3 Factory→Mother (dashed, direct) | IMPRECISE | gen_arch.py:106; PrivacyPortalFactory.sol:744 | The factory calls the **source-chain inbox**; the arrow skips both inbox boxes that every other cross-chain flow routes through. |
| Arrows | #2 Factory→Portal & Factory→pToken | CORRECT | gen_arch.py:104,105 | |
| Arrows | #5 Portal↔Underlying (both directions) | CORRECT | gen_arch.py:109 | |
| Arrows | #6 Portal→pToken; #13 pToken→Portal | CORRECT | gen_arch.py:110,111 | |
| Arrows | #7 pToken→Inbox(src); #12 Inbox(src)→pToken | CORRECT | gen_arch.py:112,113 | |
| Arrows | #17 Portal→Oracle | CORRECT | gen_arch.py:114 | |
| Arrows | #8 Inbox(src)→Inbox(COTI); #11 Inbox(COTI)→Inbox(src) | CORRECT | gen_arch.py:115,116 | |
| Arrows | #9 Inbox(COTI)→Mother; #11 Mother→Inbox(COTI) | CORRECT | gen_arch.py:117,118 | |
| Arrows | #10 Mother→MpcCore (legend says "↔") | CORRECT | gen_arch.py:119 | One-way arrow for a library call that returns values; acceptable. |

---

## Required corrections (ordered by importance)

1. **Flow #10 — "never plaintext" is false.** Replace
   `Mother ↔ MpcCore: onBoard → compute on garbled values → offBoard; never plaintext`
   with
   **`Mother ↔ MpcCore: onBoard → compute on garbled values → offBoardToUser; balances never stored in the clear. Portal legs are the *Public variants: amounts travel as plaintext uint256 and solvency is revealed via decrypt(ge(...))`**
   (PodErc20CotiMother.sol:238,256,308,318,419,425).

2. **Factory box — "pToken forwarders (owner only)" states the wrong gate.** Replace
   `pToken forwarders (owner only): configurePToken · setPTokenMinter · setRequestKillMinAge · killStaleRequest`
   with
   **`pToken forwarders (DEFAULT_ADMIN_ROLE; factory must still be pToken Ownable owner): configurePToken · setPTokenMinter · setPTokenRequestKillMinAge · killPTokenStaleRequest · transferPTokenOwnership`**
   (PrivacyPortalFactory.sol:375,394,400,406,385,412-420). This fixes the gate **and** the two misleading
   abbreviations that collide with the pToken's own `setRequestKillMinAge` / `killStaleRequest`
   (PodERC20.sol:584,590).

3. **Portal box — `adminRefundPendingDeposit (paused)` omits the caller.** Replace with
   **`adminRefundPendingDeposit (factory admin + paused)`**
   (PrivacyPortal.sol:614-620). Optionally add: escrow must be `Pending` and the portal calls
   `pToken.invalidatePendingRequest` first (623,633-635).

4. **Mother box — the "never from arguments" absolute is false for registration.** Replace
   `namespace = tokenId(sourceChainId, pToken) — derived ONLY from the authenticated inbox origin (inboxMsgSender), never from arguments`
   with
   **`namespace = tokenId(sourceChainId, pToken); for every balance op both halves come from the authenticated inbox origin (_activeTokenId → inboxMsgSender), never from arguments. registerToken is the exception: chainId from the inbox, pToken from calldata`**
   (PodErc20CotiMother.sol:331-334 vs 189).

5. **pToken box — "transferCallback/transferError (inbox only)" understates the auth.** Replace with
   **`transferCallback (onlyInboxPeer: inbox + trustedRemote) / transferError (onlyInboxReturnLeg: inbox + linked leg, no peer check)`**
   (PodERC20.sol:334,430; InboxUser.sol:44-67).

6. **Portal box — split the ungated group by access.** Replace
   `burnAccumulatedPTokens · finalizeBatchBurn` / `withdrawPortalFees · rescueERC20 · rescueNative`
   with
   **`burnAccumulatedPTokens · withdrawPortalFees (factory admin) · rescueERC20 · rescueNative (factory admin + paused)`** and move
   **`finalizeBatchBurn`** up beside `triggerWithdrawalRelease` / `cancelFailedWithdrawal` / `refundFailedDeposit`
   as permissionless (PrivacyPortal.sol:672,703,727,748,769).

7. **Portal box — state variable name.** `pendingBurnAmount · burnInFlight · inFlightTotal` →
   **`pendingBurnAmount · burnInFlight[reqId] · burnInFlightTotal · withdrawalNonce · factory / bindingFactory`**
   (PrivacyPortal.sol:38,40,59,61,63,65).

8. **Add the missing Admin→Portal and Operator→Portal arrows** (or relabel #15/#16 as
   **"Admin/Operator act directly on each portal; the portal only reads isAdmin/isOperator from the factory"**),
   PrivacyPortal.sol:994-1006, PrivacyPortalFactory.sol:572-573.

9. **Arrow #3 should terminate at the source-chain inbox**, with the dashed continuation to the mother labelled
   "relayed" — the factory never calls the mother directly (PrivacyPortalFactory.sol:744).

10. **Factory box — `createPortalWithExistingPToken`.** Replace with
    **`createPortalWithExistingPToken (admin) → fresh portal clone for an existing pToken; create when unmapped, remount when paired (old portal must be paused → retireDepositsForUpgrade); new clone starts paused; minter rotates`**
    (PrivacyPortalFactory.sol:611,625-637,653,665,673,674).

11. **pToken box — `_requests[id]` enum.** → **`_requests[id]: None|Pending|Success|Failed|SystemFailed`**
    (IPodERC20.sol:13-21).

12. **Mother box — `success → respond(new ciphertexts, nonce)`** → **`respond(new ciphertexts + nonce; approve responds without a nonce)`** (PodErc20CotiMother.sol:531).

13. **Flow #5 / Underlying box** → add the wrap leg: **`WETH.deposit on depositNative · safeTransferFrom on deposit/wrap (balance delta measured) · safeTransfer / WETH.withdraw on release`** (PrivacyPortal.sol:461).

14. **Oracle box** → **`owner-set USD pegs (1e18 per whole token), Ownable owner of the oracle itself`** (PortalFeeOracle.sol:11,31).

15. **User role box** → `deposit · depositNative · wrap · requestWithdrawWithPermit` (PrivacyPortal.sol:503).

16. **Replace the dangling "(#5)" / "(#1)" audit-finding references** in legend items 3 and 13 with explicit
    text (e.g. "see finding PP-xx") so they are not read as legend numbers.

17. **Factory title** → `PrivacyPortalFactory (AccessControl; Ownable owner of the pToken clones it creates)`
    — drop "one per chain" or mark it a deployment convention (PrivacyPortalFactory.sol:29,52).

---

## Missing from an "architecture" view (≤ 6)

1. **The COTI mother's own `Ownable` owner is absent** — no role box for it, yet it decides which source-chain
   factories may register tokens (`setAllowedFactory`, PodErc20CotiMother.sol:152) and can rotate the COTI inbox
   (`configure`, 161). This is the most privileged account on the COTI side.
2. **Users interacting with the pToken directly.** `transfer`, `transferFrom`, `approve`, `burn`,
   `transferAndCall`, `syncBalances` are all permissionless holder entry points (PodERC20.sol:174-323) with no
   User→pToken arrow and no mention in the pToken box. The pToken is a full confidential ERC-20, not a
   portal-only mint/burn sink.
3. **The remount / detach machinery.** `retireDepositsForUpgrade` (PrivacyPortal.sol:292) clears `factory`
   while `bindingFactory` (40) keeps admin/rescue auth alive, and `pauseByFactory` (304) keeps the new clone
   closed. This is the whole reason the portal has two factory pointers and it is invisible in the diagram.
4. **The `TokenNotRegistered` → stuck-Pending failure mode.** Because inbox execution reverts are retryable
   (InboxMiner.sol:294 `retryFailedRequest`), a deposit whose mint hits `onlyRegisteredPTokenMessage` stays
   `Pending` forever rather than becoming `SystemFailed` — so it is *not* refundable by the permissionless path
   (PrivacyPortalFactory.sol:534-542; PrivacyPortal.sol:590-595). The diagram states the ordering hazard (flow
   #3) but not this consequence, which is the reason `adminRefundPendingDeposit` exists.
5. **Factory routing/implementation rotation.** `configureRouting` (361), `setPortalImplementation` (327),
   `setPodTokenImplementation` (344), `setPriceOracle` (473) — admin levers that change where every future
   clone and registration message points.
6. **The ERC-7984 wrapper facade on the portal** (`IERC7984PortalWrapper`: `underlying()`, `rate()`, `wrap()`,
   and the `WrapRequested` / `UnwrapRequested` / `UnwrapFinalized` events, PrivacyPortal.sol:28,482-499) — the
   diagram shows `wrap` as a bare entry point without indicating it is a standards-conformance surface.
