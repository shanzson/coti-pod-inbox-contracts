# Adversarial review — PrivacyPortal / PrivacyPortalFactory audit report (2026-09-05)

Reviewer: independent Solidity security critic. Every code claim below is cited `file:line` against
`/home/user/coti-contracts` @ `55f5298`, whose `contracts/` tree is **byte-identical** to the audited commit
(`git diff --stat 8a0c4928004dac7a6c8d50bde58a022b6912f963 HEAD -- contracts/` → empty; verified).

## 1. PoC run

```
cd /home/user/coti-pod-inbox-contracts && \
SOLC_NATIVE=/tmp/claude-0/-home-user-coti-pod-inbox-contracts/88818f92-4ee1-55bc-bc05-42a0654542b9/scratchpad/solc-0.8.28-static \
NODE_OPTIONS='--max-old-space-size=8192' npx hardhat --config hardhat.config.portal-poc.ts test \
  test/portal-poc/findings-A.ts test/portal-poc/findings-B.ts
```

**Result: 15 passing / 0 failing (exit 0).** 15 tests for 14 findings (F1 has two: `F1a` native, `F1b` ERC-20).
No file under `test/portal-poc/` or in either contract tree was modified.

**Harness fidelity (checked, not assumed).** The contracts under test are the real ones, reached through
constructor-passthrough subclasses that add no storage and no overrides
(`/home/user/coti-pod-inbox-contracts/test/portal-poc/contracts/PortalHarnesses.sol:22-38`): real
`PrivacyPortal`, real `PrivacyPortalFactory` (real `Clones` deployment of real clones), real
`PodErc20MintableInitializable` → `PodErc20Mintable` → `PodERC20`, real `PortalFeeOracle`,
real `PodErc20CotiMother` (F5). The repo's own mocks (`MockERC20`, `MockFeeOnTransferERC20`,
`MockWrappedNative`, `RejectEthReceiver`) are re-used unchanged. Only the **inbox** is a stand-in
(`MockInboxForPortal.sol`); it reproduces `InboxBase._packRequestId` (`contracts/InboxBase.sol:650-662`)
and `++_requestNonce[targetChainId]` (`InboxBase.sol:507`) exactly, and delivers callbacks as
`msg.sender == inbox` so the real `InboxUser.onlyInboxPeer` / `onlyInboxReturnLeg`
(`coti-contracts/contracts/pod/InboxUser.sol:45-69`) execute for real. **One fidelity gap that matters:** the
mock enforces no fee minimums, whereas the production `FeeManager` reverts `TotalFeeTooLow` /
`CallbackFeeTooLow` (`coti-pod-inbox-contracts/contracts/fee/FeeManager.sol:164-170`). See §C.

## 2. Summary table

| # | Report title (short) | Report conf | Verdict | My severity | My conf | One-line reason |
|---|---|---|---|---|---|---|
| 1 | Stuck withdrawal after pToken transfer Success | 90 | CONFIRMED | Medium | 92 | Terminal `Success` + reverting payout = no cancel, no kill, no re-target; only realistic trigger is an issuer blocklist mid-flight. |
| 2 | Blacklist/pause not enforced on release leg | 85 | CONFIRMED-DOWNGRADED | Low | 85 | Pause-bypass is *intended* (repo test proves it); only the blacklist half is a real, narrow compliance gap. |
| 3 | Remount minter rotation bricks `adminRefundPendingDeposit` | 85 | CONFIRMED-DOWNGRADED | Low | 88 | Real revert, but the PoC itself demonstrates three shipped admin recovery paths; the refund was admin-only anyway. |
| 4 | Cross-factory remount skips all old-portal guards | 80 | CONFIRMED | Medium | 88 | Guards are dead code cross-factory; the team's *own* test performs the unguarded attach on a live portal. |
| 5 | `createPortal` live before COTI registration | 80 | DESIGN-CHOICE | Low | 90 | Explicitly documented with ops guidance in NatSpec; residual is only the un-atomic close window. |
| 6 | Remount rotates minter with no escrow check | 80 | DUPLICATE (of #3) | Informational | 95 | Self-declared "factory side of #3"; the added content is a test-coverage observation, not a vuln. |
| 7 | Operator freezes withdrawals via `uint96` fixedFee | 75 | CONFIRMED | Low | 88 | Real privilege gap (operator gets an admin-only emergency stop), but no theft and instantly reversible. |
| 8 | `refundFailedDeposit` rejects `Failed` | 75 | CONFIRMED-DOWNGRADED | Low | 85 | Behaviour real and documented; the "kill destroys the refund" framing is wrong — Pending was never refundable either. |
| 9 | Limits/fee on `amount` vs measured `received` | 75 | CONFIRMED-DOWNGRADED | Low | 82 | Real, but needs FoT underlying **and** an admin setting `minWithdraw ≈ minDeposit`; the PoC's second half is self-inflicted. |
| 10 | `rescueERC20` drains committed collateral | 75 | CONFIRMED-DOWNGRADED | Low | 87 | Real missing reserve, but the PoC's own recovery is a plain ERC-20 transfer back by the rescue recipient. |
| 11 | Fee floor collapses to `fixedFee`/0 on zero rate | 75 | DESIGN-CHOICE | Informational | 90 | Fail-open is spelled out in `IPodPriceOracle` and `PortalFeeOracle` NatSpec; protocol-revenue only. |
| 12 | `setLimits` unpartitionable withdraw window | 75 | CONFIRMED-DOWNGRADED | Informational | 80 | Pure admin misconfiguration, dust bounded by `minWithdraw-1`, and pTokens are transferable/poolable. |
| 13 | `wrap` has no caller-side fee bound | 70 | CONFIRMED | Low | 85 | Real missing slippage bound on the ERC-7984 entry point; loss capped by `maxFee`. |
| 14 | Request-id reuse across inbox rotation | 70 | CONFIRMED | Medium | 82 | Mechanism fully real (id has no inbox component, `Pending` writes are unguarded); needs an admin repoint to a *fresh* inbox. |

**Counts:** CONFIRMED 5 · CONFIRMED-DOWNGRADED 6 · DESIGN-CHOICE 2 · DUPLICATE 1 · NOT-REPRODUCED 0.
**Severities:** Medium 3 · Low 8 · Informational 3 · (no Critical/High).

---

## 3. Per-finding review

### #1 — Withdrawal stuck after a successful pToken transfer whose payout reverts

**PoC vs claim.** Exercises the real code exactly. `F1a` (findings-A.ts:21-62) uses a native portal and the
repo's own `RejectEthReceiver`; `F1b` (:64-82) uses an ERC-20 with a USDC-style issuer blocklist applied
*after* the request. Both drive the release through the genuine pToken `transferCallback` hook
(`PodERC20.sol:366-373`), not a direct call, and both show `RequestCallbackFailed` swallowing the revert.
No harness behaviour manufactures the outcome: the terminal-status wall is the real
`_setRequestStatus` guard (`PodERC20.sol:630-637`) and the real status checks in
`_releaseWithdrawal` (`PrivacyPortal.sol:862-864`) and `cancelFailedWithdrawal` (`:655-660`).

**Precondition.** Unprivileged, no admin required. `F1a` is user error (recipient can't receive ETH).
`F1b` is the realistic one: an external token issuer blacklists the recipient while the COTI leg is in flight.

**Impact.** The user has already lost the pTokens (custody moved on COTI), the collateral stays locked, and
`pendingBurnAmount` never increments — the increment at `:866` is rolled back with the revert, so
`burnAccumulatedPTokens` (`:682-685`) can never burn them (PoC :50-51). `killPTokenStaleRequest` needs
`Pending` (`PodERC20.sol:592`). No re-target function exists (PoC :53-54 enumerates the ABI). Recovery is
admin-only and pays `rescueRecipient`, not the user (`PrivacyPortal.sol:769-782`).

**Fixes.** Option B (`adminResolveStuckWithdrawal`) is correct and implementable. **Option A is only half a
fix** — re-wrapping to WETH rescues `F1a` but does nothing for `F1b`, where the ERC-20 `transfer` itself is
what reverts.

**Verdict: CONFIRMED · Medium · confidence 92.**

---

### #2 — Blacklist and pause not enforced on the collateral-release leg

**PoC vs claim.** findings-A.ts:86-128 proves both halves against the real contracts: (a) the automatic
callback release pays a factory- *and* portal-blacklisted recipient from a paused portal and a paused factory;
(b) `triggerWithdrawalRelease` from a stranger does the same. Sound. Step (b) is somewhat theatrical — it
rescues then re-funds the collateral only to force the callback to fail first; (a) alone already proves the claim.

**Precondition and design intent.** The pause half is **intended, not a bug**. The repo's own test
`test/pod/privacy/PrivacyPortalFactory.portalRemount.test.ts:383-435` ("completes in-flight TransferPending
withdraw on old portal after remount") *requires* `triggerWithdrawalRelease` to work on a paused, retired
portal, and the migration NatSpec (`PrivacyPortalFactory.sol:600-601`) is built on it. Adding the report's
Option B pause check would convert every in-flight withdrawal at pause time into finding #1 — the report
concedes this itself. The blacklist half is real but narrow: only withdrawals *already requested* before the
listing can slip through; request-time checks (`PrivacyPortal.sol:519, 1031-1035`) hold for everything else.
The claim that this "defeats the control the code's own comment promises" overreads `:1028-1030`, which
describes recipient checking at request time only.

**Impact.** A sanctions/compliance evasion window of exactly the in-flight set. No collateral loss, no
unbacked supply.

**Verdict: CONFIRMED-DOWNGRADED · Low · confidence 85** (pause half: DESIGN-CHOICE).

---

### #3 — Remount rotates the minter and bricks the retired portal's `adminRefundPendingDeposit`

**PoC vs claim.** findings-A.ts:132-181 runs the documented same-factory remount and gets the exact revert
`OnlyMinter(oldPortal)`. Real mechanism: `adminRefundPendingDeposit` calls `pToken.invalidatePendingRequest`
when the mint is `Pending` (`PrivacyPortal.sol:632-634`), which is minter-gated
(`PodERC20.sol:573-574` → `PodErc20Mintable.sol:47-51`), and the remount moved `minter` to the new clone
(`PrivacyPortalFactory.sol:674`). Auth and `whenPaused` both still pass via `bindingFactory`
(`PrivacyPortal.sol:986-992`), so the *only* blocker is the minter gate. Confirmed.

**Precondition.** Requires a factory admin to remount while a mint escrow is `Pending`. Note the repo tests
this path only for the `SystemFailed` case (`portalRemount.test.ts:235-272`), which is why the gap survived.

**Impact — materially smaller than claimed.** The PoC itself demonstrates three shipped recovery paths
(:155-179): (A) `killPTokenStaleRequest` after the 1-day `requestKillMinAge` (`PodERC20.sol:67, 590-605`) →
refund works; (B) `setPTokenMinter` back to the old portal (`PrivacyPortalFactory.sol:394-397`); (C)
`setPTokenRequestKillMinAge(0)` then kill immediately. All three are DEFAULT_ADMIN — but so is
`adminRefundPendingDeposit`. So this is an ops speed bump, not unrecoverable depositor loss.

**Fixes.** Option A is workable. **Option B does not work as written**: `IPrivacyPortal.pendingEscrowCount()`
does not exist and cannot be derived — escrows are only ever set `Pending` (`:420, :468`) or `Refunded`
(`:597, :638`); a mint *success* never terminalizes one, so any such counter would be permanently non-zero
after the first deposit and would block remount forever. Option C works.

**Verdict: CONFIRMED-DOWNGRADED · Low · confidence 88.**

---

### #4 — Cross-factory remount skips every old-portal guard

**PoC vs claim.** findings-A.ts:185-232 is the strongest PoC in the set. It deploys a second **real** factory
with a different admin, calls the real `transferPTokenOwnership`, then `createPortalWithExistingPToken` on
F2 — and reaches a state with one pToken supply over two disjoint collateral pools. Root cause confirmed:
`oldPortal` is read from *this* factory's `portalForPToken` (`PrivacyPortalFactory.sol:622, 651`), so on F2 it
is `address(0)` and the whole guard block at `:652-666` (`OldPortalNotPaused`, native-mode equality,
`retireDepositsForUpgrade`) is skipped while `setMinter(portal)` at `:674` still runs.

**Precondition.** Two DEFAULT_ADMIN actions. Crucially, **the repo's own test does exactly this**:
`test/pod/privacy/PrivacyPortalFactory.createPortalWithExistingPToken.test.ts:84-124` hands ownership to
`factory2` and remounts while the original portal is unpaused, asserting only the new state — the old portal
is never inspected. And `PrivacyPortalFactory.sol:411` documents "after handoff, remount on the new factory"
as a supported path. So this is a blessed path with the safety rail silently absent.

**Impact.** Portal A stays `paused()==false`, `isDepositEnabled==true`, `factory != 0` — every UI flag says
"open" while deposits revert deep inside the pToken with `OnlyMinter` (PoC :216). A keeps and still pays out
all collateral (:218-221). B is openable by F2's admin with zero collateral, and withdrawals accepted there
become finding #1 (:225-230). F2's admin cannot pause A (:223) — cross-org, A becomes unreachable.

**Fix.** The proposed `prevMinter` check is correct and is the right shape (read authority from the token, not
from the local mapping); it should also `retireDepositsForUpgrade()` on `prevMinter`, which the diff omits.

**Verdict: CONFIRMED · Medium · confidence 88.**

---

### #5 — `createPortal` returns a live, deposit-enabled portal before COTI registration

**PoC vs claim.** findings-A.ts:236-274 proves each sub-claim: the clone is unpaused with
`isDepositEnabled == true` (`PrivacyPortal.sol:255`), registration is one-way with a zero error selector
(`PrivacyPortalFactory.sol:731-747`), a pre-registration deposit is accepted and leaves the mint `Pending`,
and — on the **real** `PodErc20CotiMother` — `mintPublic` reverts `TokenNotRegistered` before
`registerToken` and passes the gate after (`PodErc20CotiMother.sol:113-120, 317`). Good, genuinely
end-to-end.

**Precondition / design intent.** This is **documented verbatim**: `PrivacyPortalFactory.sol:530-542` states
the function "returns as soon as the message is *submitted*", that mints will hit `TokenNotRegistered` and
"leaves each deposit's mint stuck `Pending` rather than failing cleanly (see PP-02/PP-14)", and gives
explicit operational guidance to set `isDepositEnabled = false` immediately. So the risk is a known,
accepted one.

**Residual (real).** The guidance is not atomically enforceable — between `createPortal` (DEPLOYER_ROLE, the
lowest-trust role, `:549`) and the admin's follow-up transaction there is a window in which any user can
deposit and lock collateral behind a pause-gated admin refund (PoC :272 shows `ExpectedPause`). Minor
documentation inaccuracy: the NatSpec says "leave ... `false`", but `initialize` hardcodes `true`, so there
is nothing to leave.

**Fixes.** Both options work. Option A (`pauseByFactory()` in `createPortal`) is the cleaner one — `unpause()`
still functions because `factory != 0` (`PrivacyPortal.sol:272-277`).

**Verdict: DESIGN-CHOICE (documented, with a real un-atomic window) · Low · confidence 90.**

---

### #6 — Remount rotates the minter with no in-flight-escrow check

**PoC vs claim.** findings-A.ts:278-304 confirms the two factual assertions: the remount succeeds with a
`Pending` escrow on the old portal, and the repo's shipped mocks cannot catch #3 —
`MockPodErc20MintableForPortal` has no `invalidatePendingRequest` at all (verified: no such symbol in
`contracts/pod/privacy/mocks/MockPodErc20MintableForPortal.sol`), and `MockPodERC20ForPortal.sol:197`
implements it with **no minter gate**, so any caller can invalidate.

**Assessment.** The report's own title says "(factory side of #3)" and its description says this "is precisely
what revokes the authority finding #3 depends on". That is a definition of a duplicate: same root cause,
same precondition, same impact, same fix menu (Fix A/B here restate #3's Fix A/B). It should have been
merged into #3 at the dedup stage rather than scored as a separate 80-confidence finding — inflating the
count. The genuinely new content — that the shipped test mocks are structurally incapable of exercising the
minter gate — is a valid **test-coverage** observation and belongs in a coverage note, not a finding list.
The PoC also surfaces a useful corollary the report should have stated: escrows are never terminalized on
mint success, so "pending escrow count" is not computable on-chain today (findings-A.ts:285) — this is
exactly what breaks #3's Fix Option B.

**Verdict: DUPLICATE (of #3) · Informational · confidence 95.**

---

### #7 — OPERATOR_ROLE can freeze all withdrawals via an unbounded `fixedFee`

**PoC vs claim.** findings-A.ts:308-336 is clean and uses a real, separately-granted operator account. It
shows: operator cannot pause the portal (`OnlyFactoryAdmin`) or the factory
(`AccessControlUnauthorizedAccount`); operator *can* set `fixedFee = 2^96-1` per portal
(`PrivacyPortal.sol:363-367`) or factory-wide in one call (`PrivacyPortalFactory.sol:463-470`); every
withdrawal then reverts `InsufficientPortalFee`; `paused()` stays `false` on both. Root cause confirmed —
`packFeeConfig` bounds `percentageBps` at 10% but `fixedFee` only by `uint96`
(`PrivacyPortalFeeLib.sol:29-34`), and `_portalFeeFloor` returns `fixedFee` unmodified when `bps == 0`
(`PrivacyPortal.sol:909-911`).

**Precondition.** A malicious or compromised OPERATOR_ROLE holder — a role NatSpec'd for "routine
fee-parameter updates" (`PrivacyPortalFactory.sol:32`), i.e. deliberately lower-trust than admin, which
reserves `pause()` (`:433`, `PrivacyPortal.sol:266`). So this is a genuine privilege boundary violation, not
just admin-adversarial noise.

**Impact.** Denial of service on *new* deposits and withdrawals, silently (no `Paused` event, no
`paused()` signal for monitors). Importantly the PoC also establishes what is **not** possible: rescue stays
locked behind `whenPaused` (:325), and already-`TransferPending` withdrawals still release (release takes no
fee). No theft, no permanent loss; any operator or admin restores service in one transaction (:332-334).

**Fix.** The report proposes none. A `fixedFee <= maxFee` bound already exists; what is missing is an
absolute ceiling (or making `fixedFee` admin-only while leaving `percentageBps` to operators).

**Verdict: CONFIRMED · Low · confidence 88.**

---

### #8 — `refundFailedDeposit` rejects mint status `Failed`

**PoC vs claim.** findings-B.ts:18-54 is technically flawless: after `killPTokenStaleRequest` writes `Failed`
(`PodERC20.sol:602`), `refundFailedDeposit` reverts `DepositMintNotFailed` (`PrivacyPortal.sol:592`); the
`SystemFailed` path is permissionless as designed; and `cancelFailedWithdrawal` really does accept both
terminal states (`:655-660`). The dead-branch claim also checks out: `DepositEscrowStatus.Failed` is accepted
at `:586` but never written anywhere in the tree.

**Where the report is wrong.** The framing — "clearing a stale mint **kills** the permissionless refund" — is
false. Before the kill the mint is `Pending`, and `refundFailedDeposit` reverts for `Pending` too (the PoC
proves this itself at findings-A.ts:151 and findings-A.ts:254). No capability is destroyed by the kill; the
kill in fact *enables* `adminRefundPendingDeposit` by making a late `Success` impossible. The exclusion of
`Failed` is also explicitly documented: `IPrivacyPortal.sol:155-159` — "App `raise` / `Failed` is not
refundable (mint should not raise)".

**Residual (real).** The asymmetry with the withdrawal side is a genuine design inconsistency, and the
operational cost is real: refunding one depositor after a kill requires pausing the entire portal
(`whenPaused`, `PrivacyPortal.sol:619`). A safe improvement would be to accept `Failed` *only* when the
portal itself invalidated/killed it.

**Verdict: CONFIRMED-DOWNGRADED · Low · confidence 85.**

---

### #9 — Deposit limits and fee use `amount`, escrow and mint use `received`

**PoC vs claim.** findings-B.ts:58-88 uses the repo's own `MockFeeOnTransferERC20` at the same 5% the repo
test uses. The mechanism is exactly as stated: `_checkDepositLimits(amount)` at `PrivacyPortal.sol:404` and
`_validateAndCollectPortalFee(portalFee, amount, true)` at `:406` both precede the balance-delta measurement
at `:412-414`, while escrow and mint use `received` (`:419-425`). Fee-floor asymmetry demonstrated against
the real factory view (floor for 100 = 1.0 native vs floor for 95 = 0.95).

**Precondition.** FoT underlyings are an explicitly supported case (`PrivacyPortal.measuredMint.test.ts`,
"PP-06"), **plus** an admin setting `minWithdrawAmount` at or near `minDepositAmount` with no headroom for
the transfer tax. Defaults are `minDeposit = minWithdraw = 1` (`PrivacyPortal.sol:258-259`), under which the
issue cannot occur (`NoUnderlyingReceived` at `:415-417` already covers 0).

**Impact — partly overstated.** The first half is sound: one deposit at exactly `minDeposit` yields a position
that can never be withdrawn if the user cannot top up (deposits disabled, or portal retired). The second half
is self-inflicted: with `maxWithdrawAmount = MAX128`, the user holding 190 should withdraw 190 in one
transaction; the PoC chooses to withdraw 100 and then reports the 90 residue as stuck (:73-75). The fee
overcharge is a real but small (≤ FoT rate) rounding in the protocol's favour.

**Fix.** None proposed. The correct one is to move `_checkDepositLimits`/`_validateAndCollectPortalFee` after
the measurement and charge on `received`.

**Verdict: CONFIRMED-DOWNGRADED · Low · confidence 82.**

---

### #10 — `rescueERC20` keeps no reserve for `TransferPending` withdrawals

**PoC vs claim.** findings-B.ts:92-118 runs the real documented migration (pause → remount → rescue full
balance) and strands a real in-flight withdrawal. Root cause confirmed: `rescueERC20`
(`PrivacyPortal.sol:769-782`) excludes only the pToken and consults no obligation total — none exists,
because `pendingBurnAmount` is incremented *inside* the release (`:866`) and therefore never reflects
committed-but-unreleased withdrawals. The scenario is not contrived: the repo's own migration test rescues
the **full** balance (`portalRemount.test.ts:147-156`) while another repo test
(`portalRemount.test.ts:383-435`) relies on in-flight withdrawals still settling against that same balance.
The two tests are in direct tension; the PoC is the intersection.

**Precondition.** DEFAULT_ADMIN performing the documented migration without externally checking for in-flight
withdrawals — which the contract gives them no way to do on-chain.

**Impact — recoverable.** Once the COTI leg settles, release reverts on balance and `cancelFailedWithdrawal`
is unavailable (status is `Success`), so this is finding #1's shape. **But** recovery is a plain ERC-20
transfer back to the retired portal, after which anyone can release (PoC :114-116). No permanent loss unless
`rescueRecipient` is operationally unreachable. `pendingBurnAmount == 0` throughout (:112) means there is no
on-chain signal of the obligation — that missing invariant is the real finding here, more than the drain.

**Fix.** None proposed. Track an `outstandingWithdrawalTotal` incremented at request and decremented at
release/cancel, and floor `rescueERC20` on `underlyingToken` at it.

**Verdict: CONFIRMED-DOWNGRADED · Low · confidence 87.**

---

### #11 — Fee floor collapses to `fixedFee` (legally 0) on a zero oracle rate

**PoC vs claim.** findings-B.ts:122-154 proves it precisely against the real `PortalFeeOracle`: with a 1%
config and both pegs set, a zero-fee withdrawal reverts `InsufficientPortalFee`; after
`clearTokenPriceUSD` the identical withdrawal succeeds with fee 0 and `accumulatedPortalFees` stays 0; and a
newly created portal for a never-priced underlying runs at fee 0 despite the 1% default. Mechanism confirmed:
`resolvePortalFee` returns `(fixedFee, false)` on any zero rate (`PrivacyPortalFeeLib.sol:88-90`) and
`_portalFeeFloor` discards the flag (`PrivacyPortal.sol:917-923`).

**Precondition / design intent.** This is **documented fail-open, twice**. `IPodPriceOracle.sol:9-10`: "Feed
adapters never revert; return `0` when a feed is unset, stale, or failed. Zero rates make
{PrivacyPortalFeeLib.resolvePortalFee} skip dynamic pricing (fixed fee only)." `PortalFeeOracle.sol:9`: "Zero
prices disable dynamic portal fees (fixed fee only)." And `resolvePortalFee`'s own `@dev` at
`PrivacyPortalFeeLib.sol:78` says the same. The alternative (revert on a zero rate) would brick deposits *and
the exit path* factory-wide on any feed outage — strictly worse, and the report's own leads section
identifies precisely that as a hazard.

**Impact.** Protocol fee revenue only; no user funds at risk, no state corruption. Detection exists:
`estimateDepositFees`/`estimateWithdrawFees` return `usedDynamicPricing`
(`PrivacyPortal.sol:785-812`), which the PoC confirms goes `false` (:138), and `PortalFeeOracle` exposes
`tokenPriceUpdatedAt` / `getTokenPriceMeta` (`:16, 54-56`) for staleness alarms.

**Verdict: DESIGN-CHOICE · Informational · confidence 90.**

---

### #12 — `setLimits` accepts an unpartitionable withdraw window

**PoC vs claim.** findings-B.ts:158-172 is correct on the arithmetic: with `(minWithdraw, maxWithdraw) =
(100, 150)`, a 170 balance cannot be fully redeemed, and `setLimits` accepts it because each pair is checked
only against itself (`PrivacyPortal.sol:342-347`).

**Precondition.** Pure DEFAULT_ADMIN misconfiguration (`:341`). Nothing an unprivileged actor can trigger.

**Impact — small and partly avoidable.** The stranded residue is bounded by `minWithdrawAmount - 1` per
holder, not by the balance: the optimal user withdraws `maxWithdraw` first, so from 170 they lose 20, not 70.
Any balance below `minWithdraw` is already unredeemable with *no* max configured at all, so the max only
widens an existing dust class. pTokens are freely transferable, so holders can pool or shed dust to reach a
partitionable amount (200 = 100+100 works). The "permanently locked" qualifier requires deposits to be
disabled *and* no counterparty — a compound worst case.

**Inconsistent gating.** The report's own dedup notes state it dropped "the `setLimits` 'maxWithdraw = 0'
freeze" as admin-adversarial. That dropped issue is strictly *worse* than this one (it freezes 100% of
withdrawals, this one strands ≤ `minWithdraw-1` per holder), yet this one was promoted at confidence 75.
The gate was applied inconsistently to the same function.

**Verdict: CONFIRMED-DOWNGRADED · Informational · confidence 80.**

---

### #13 — `wrap` charges the execution-time fee with no caller-supplied bound

**PoC vs claim.** findings-B.ts:176-200 is a good, tight PoC and the arithmetic checks out (1% → 1.4% of a
100e6 notional at 1:1 pegs = 1.4e18, under the 10e18 cap). It contrasts the two entry points correctly:
`deposit` validates the caller's declared `portalFee` and reverts `InsufficientPortalFee` on a stale quote,
while `wrap` derives the floor at execution time (`PrivacyPortal.sol:498`) and passes it straight into
`_deposit`, where `_validateAndCollectPortalFee` trivially accepts it (`:888-898`) and the remainder becomes
the mint budget (`:410`). The event assertions confirm the mint budget silently absorbs the delta.

**Precondition.** Either an OPERATOR_ROLE fee change landing between quote and inclusion (the PoC's framing;
same semi-trusted role as #7) or an ordinary oracle move — the latter needs no privilege at all.

**Impact.** Bounded overcharge, not loss of principal: `maxFee` from the packed config caps the fee
(`:893-895`, `PrivacyPortalFeeLib.sol:73-74`). Two outcomes: the user overpays up to `maxFee`, or — if the
squeeze pushes the mint budget under the inbox minimum — the whole transaction reverts
(`FeeManager.sol:164-170`; the mock inbox does not model this, so the PoC's "starves the mint budget" reads
milder than production, where it is a revert). `wrap` is the ERC-7984 wrapper interface, i.e. an
integrator-facing secondary path; `deposit` remains the bounded primary path.

**Fix.** None proposed. Add a `maxPortalFee` parameter, or have `wrap` revert when the live floor exceeds a
caller-supplied bound.

**Verdict: CONFIRMED · Low · confidence 85.**

---

### #14 — Escrow, burn and withdrawal state keyed on inbox-instance-local request ids

**PoC vs claim.** findings-B.ts:204-248 is the most impressive PoC here and each step is anchored in real
code. The id scheme is verified against the production inbox: `_packRequestId` mixes only
(source chain, target chain, nonce) with **no inbox component**
(`coti-pod-inbox-contracts/contracts/InboxBase.sol:650-662`), and the nonce is a per-target counter that a
fresh deployment restarts at 1 (`InboxBase.sol:507`). The mock reproduces both exactly. The three corruptions
are then real: escrow records are assigned unconditionally (`PrivacyPortal.sol:420, :468`), so D3 silently
replaces the user's D1 escrow; `_setRequestStatus` guards only `Success`/`Failed`/`SystemFailed` writes and
lets `Pending` overwrite any terminal status (`PodERC20.sol:628-643`), so D1 rewinds `Success → Pending`; and
a colliding mint success flips a stranded withdrawal's `transferRequestId` to `Success`, after which the
permissionless `triggerWithdrawalRelease` pays out real collateral for a pToken transfer that never settled,
with `pendingBurnAmount` inflated by pTokens the portal never received.

**Precondition.** DEFAULT_ADMIN calling `configurePToken` (`PrivacyPortalFactory.sol:375-382`) — a documented
supported operation — pointing a live pToken at a **newly deployed** inbox. A proxy-style inbox upgrade keeps
the address and the nonce and is harmless; only a from-scratch redeploy triggers it. That narrows the
likelihood considerably, and the report should have said so.

**Impact.** Severe where it fires: destroyed refund claims, unbacked collateral release, corrupted burn
accounting. Not self-healing and not admin-recoverable.

**Unproven sub-claim.** The `burnInFlightTotal` double-count and wedged batch burns
(`PrivacyPortal.sol:693-694` assignment beside `+=`) is asserted in the description but not exercised by the
PoC. Plausible from inspection; flagged as unverified.

**Verdict: CONFIRMED · Medium · confidence 82.**

---

## 4. Section C — report errors, and things it missed

### C.1 Where the PoCs or the code contradict the report

1. **#8's core framing is wrong.** "Clearing a stale mint kills the permissionless refund" — the PoCs
   themselves show `refundFailedDeposit` reverting `DepositMintNotFailed` for a *Pending* mint
   (findings-A.ts:151, findings-A.ts:254), so no permissionless refund existed to kill. The kill strictly
   improves the situation. Also documented as intended at `IPrivacyPortal.sol:155-159`.
2. **#3's Fix Option B cannot be implemented.** It calls `IPrivacyPortal(oldPortal).pendingEscrowCount()`,
   which does not exist and is not derivable: an escrow is set `Pending` (`PrivacyPortal.sol:420, :468`) and
   only ever cleared to `Refunded` (`:597, :638`) — a mint *success* never terminalizes it, so the counter
   would be permanently non-zero and would block every future remount. The PoC flags this
   (findings-A.ts:285); the report does not.
3. **#1's Fix Option A only fixes half the finding.** Re-wrapping to WETH addresses the native case (F1a) but
   not F1b, where the ERC-20 transfer to an issuer-blocked recipient is itself the revert.
4. **#2 asserts as a defect what the repo tests as intended.** The pause bypass on the release leg is
   required by `PrivacyPortalFactory.portalRemount.test.ts:383-435` and by the migration model at
   `PrivacyPortalFactory.sol:600-601`. The report's own leads section concedes it ("the pause-bypass is
   asserted as intended by a remount test") while the finding body treats it as a vulnerability.
5. **#6 is a self-declared duplicate of #3** ("factory side of #3", same root cause / precondition / fix),
   and **#12 contradicts the report's own gating note**, which dropped the strictly worse `setLimits`
   "maxWithdraw = 0" freeze as admin-adversarial. Both inflate the finding count.

### C.2 Material things the report missed (noticed while verifying; no deep dives)

1. **`feeRecipient` is `immutable` with no setter** (`PrivacyPortalFactory.sol:52, 205`) while
   `withdrawPortalFees` hard-requires the send to succeed (`PrivacyPortal.sol:742-743`). If that address ever
   stops accepting ETH, **every** portal's accumulated fees are permanently stranded factory-wide; the only
   escape is `rescueNative`, which pays `rescueRecipient` (mutable) instead. The report notes the immutability
   nowhere.
2. **`setLimits` accepts `maxWithdraw == 0` / `maxDeposit == 0`** — only `min > max` is rejected
   (`PrivacyPortal.sol:342-347`) — giving an admin a silent total freeze with no `Paused` event, i.e. the
   same shape as #7 but one privilege level up. The report explicitly discarded this while promoting the
   weaker #12.
3. **No on-chain record exists of pTokens the portal actually holds on COTI.** `pendingBurnAmount` is
   incremented *inside* `_releaseWithdrawal` (`PrivacyPortal.sol:866`), so a reverting payout rolls the
   accounting back too. This single ordering choice is the shared root cause of #1's unburnable custody and
   #10's invisible obligation, and deserves to be stated as its own invariant break rather than split across
   two findings.
4. **PoC-fidelity caveat worth recording:** `MockInboxForPortal` enforces no fee minimums, whereas the
   production `FeeManager` reverts `TotalFeeTooLow` / `CallbackFeeTooLow`
   (`coti-pod-inbox-contracts/contracts/fee/FeeManager.sol:164-170`). Consequences: #13's "starved mint
   budget" is a transaction revert in production rather than an under-funded message, and the fixture's
   `createPortal` with `msg.value == 0` (helpers.ts:135) would not be accepted on a real chain. No finding's
   mechanism depends on this.
5. **The "1-day kill delay" that #3 treats as a hard recovery constraint is a one-transaction admin knob.**
   `setPTokenRequestKillMinAge` (`PrivacyPortalFactory.sol:400-403` → `PodERC20.sol:584-586`) lets any
   DEFAULT_ADMIN set the age to 0 and kill immediately — the PoC's own recovery path C
   (findings-A.ts:176-179). The report's #3 severity leans on a delay that does not really bind.
