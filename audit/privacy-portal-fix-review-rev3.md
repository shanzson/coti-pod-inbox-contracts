# Independent re-judgement + fix review — PrivacyPortal / Factory / PodERC20

Original tree verified byte-identical to `8a0c4928004dac7a6c8d50bde58a022b6912f963`
(`cd /home/user/coti-contracts && git diff --stat 8a0c4928… HEAD -- contracts/` → empty).

## 1. Test run

```
cd /home/user/coti-pod-inbox-contracts && SOLC_NATIVE=…/solc-0.8.28-static NODE_OPTIONS='--max-old-space-size=8192' \
  npx hardhat --config hardhat.config.portal-poc.ts test \
  test/portal-poc/findings-A.ts test/portal-poc/findings-B.ts test/portal-poc/fixes.ts
→ 28 passing (28 nodejs), 0 failing, exit 0
  (15 exploit PoCs against the original code + 13 fix-validation tests against the patched code)
```

I also wrote four throwaway adversarial tests against the **patched** code
(`/tmp/…/scratchpad/adversarial.ts`, run with the same config, **4 passing**; no repo file touched):

* **Y1** — the withdrawal requester re-targets a *deliverable* third-party payment away from its recipient.
* **Y2** — `createPortalWithExistingPToken` on a new factory reverts forever when the pToken's minter is a non-portal contract, and neither factory can rotate it back.
* **Y3** — `requireDynamicPricing = true` reverts the **withdrawal** path on an oracle outage, and is silently bypassed when `priceOracle == 0`.
* **Y4** — after `retirePortal(A)`, the *same* factory can never remount that pToken (`retireDepositsForUpgrade` reverts on a detached portal) and `createPortal` is blocked by `PortalAlreadyExists`.

## 2. Verdict table

| # | Real issue? | My severity | Agree with prior critic? | Fix verdict | Test proves claim? | One-line reason |
|---|---|---|---|---|---|---|
| 1 | REAL | Medium | Yes | **SHIP-WITH-CHANGES** | Partial | WETH fallback + re-target closes both legs, but owner re-target has no stuck-ness precondition → payment revocation (Y1). |
| 2 | REAL (blacklist half) / DESIGN-CHOICE (pause half) | Low | Yes | **SHIP-WITH-CHANGES** | Partial | Correctly refuses the report's harmful pause check, but omits `withdrawal.user` and the listed party can re-target around it. |
| 3 | REAL | Low | Yes | **SHIP** | Yes | Owner-authorised invalidation + admin forwarder; adds no capability a DEFAULT_ADMIN did not already have. |
| 4 | REAL | Medium | Yes | **SHIP-WITH-CHANGES** | Partial | Right shape (authority read from the token), but three new bricks: Y2, Y4, and `setPTokenMinter` bypasses it entirely. |
| 5 | DESIGN-CHOICE (documented) with real residual | Low | Yes | **SHIP** | Yes | `pauseByFactory()` in `createPortal` makes the documented ops guidance atomic; `unpause` still works. |
| 6 | DUPLICATE of #3 | Informational | Yes | **SHIP** (n/a) | No test | Same root cause/fix as #3; its only non-duplicate residual belongs to #4 and is still open. |
| 7 | REAL | Low | Yes | **SHIP** | Yes | Ceiling closes the `uint96` freeze; residual 10 % bps lever is bounded by design. |
| 8 | REAL (design inconsistency) | Low | Yes | **SHIP** | Yes | Pause only guards a late `Success`; terminal statuses cannot produce one — correct and minimal. |
| 9 | REAL | Low | Yes | **SHIP** | Yes | Limits + fee now evaluated on the measured delta; ordering is safe under `nonReentrant`. |
| 10 | REAL | Low | Yes | **SHIP** | Yes | Obligation counter is the fix the critic asked for; every increment has a reachable decrement. |
| 11 | DESIGN-CHOICE | Informational | Yes | **REJECT** | No test | Enabling it DoSes the exit path and it does not fire when `priceOracle == 0` (Y3) — false assurance. |
| 12 | REAL (admin misconfiguration) | Informational | Yes | **SHIP** | Yes | `max ≥ 2·min−1` is exactly the k-partition bound; underflow/disable edges handled. |
| 13 | REAL | Low | Yes | **SHIP-WITH-CHANGES** | Partial | New bounded entry point is correct, but the unbounded `wrap` — the ERC-7984 path integrators call — is unchanged. |
| 14 | REAL | Medium | Yes | **SHIP** | Partial | Single-use request ids at the pToken is the right fail-closed choke point; portal-side guards are unreachable belt-and-braces. |

Net: I reach the same verdict and the same severity as the prior critic on all 14. Where I add
material content is (a) fix quality, and (b) three sub-claims neither the report nor the critic
made: the `setPTokenMinter` back door (belongs under #4), the arithmetic derivation behind #12,
and the fact that #14's `burnInFlightTotal` sub-claim is *still* unproven after the fix.

## 3. Per-finding

### #1 — stuck withdrawal · REAL · Medium · SHIP-WITH-CHANGES

**(A)** Real and unrecoverable for the user in the original. `PrivacyPortal.sol:862-864` requires
`Success` before release; `PrivacyPortal.sol:870-873` reverts the whole release when the ETH send
fails; `cancelFailedWithdrawal` (`:655-660`) needs `Failed`/`SystemFailed`, which
`PodERC20._setRequestStatus` (`:630-637`) can never write over `Success`; and `pendingBurnAmount +=`
at `:866` is rolled back with the revert, so the custodied pTokens are also uncounted. Only
`rescueERC20` recovers, and it pays `rescueRecipient`. Medium — user-scoped permanent loss, trigger
is unprivileged (issuer blocklist mid-flight). Agree with the critic.

**(B)** Fix #1a (`PrivacyPortalFixed.sol:952-956`) is correct: CEI holds (status/counters written at
`:946-948` before the call), the low-level call discards return data so there is no memory bomb, and
both release entry points are `nonReentrant`. Fix #1b (`:976-1001`) covers the ERC-20 half the
critic said Option A missed. **The problem is the owner path.** `retargetStuckWithdrawal` requires
only `TransferPending` + `Success`; nothing verifies the payout is actually undeliverable, and
`msg.sender == withdrawal.user` is enough. Y1 shows a requester revoking a payment to a third party
*after* the issuer un-blocked them. The window is cheap to open on purpose (underfund
`transferCallbackFee` so the release hook fails), so this is not theoretical.
**Required change:** on the owner path require `newRecipient == withdrawal.user`; keep arbitrary
re-targeting for the factory-admin-while-paused path only (`:992-994` already carries that branch).
X1b proves the mechanism but is itself an instance of the redirect it does not flag, and never
exercises the admin branch.

### #2 — blacklist on release · REAL (blacklist) / DESIGN-CHOICE (pause) · Low · SHIP-WITH-CHANGES

**(A)** The pause half is intended: `PrivacyPortalFactory.sol:600-601` documents in-flight settlement
on a paused, retired portal, and X10 relies on it. The blacklist half is a real but narrow
compliance window bounded by the in-flight set — no loss, no unbacked supply. Low. Agree.

**(B)** The fix (`PrivacyPortalFixed.sol:939-944`) is the right shape: recipient-only, read through
`_controllerFactory()` so a detached portal still settles, and pause deliberately not checked. X10
independently proves the retired-portal path still releases (`callbackFailed == false` on `oldPortal`
after `remount`), which is the regression that mattered. Two gaps: (i) the report's own Option A
(report:109-110) checks `withdrawal.user` too; the fix checks only the recipient, so a listed *payer*
whose withdrawal predates the listing is still paid; (ii) `retargetStuckWithdrawal` (`:976-1001`)
applies no blacklist check to `msg.sender`, so a listed user simply re-points the withdrawal at a
clean address and releases — the control is circumventable by exactly the party it targets.
**Required change:** add `withdrawal.user` to the release check and `_checkNotBlacklistedAccount(msg.sender)`
(or `withdrawal.user`) to the owner branch of `retargetStuckWithdrawal`.

### #3 — remount bricks admin refund · REAL · Low · SHIP

**(A)** Revert path is exactly as described (`PrivacyPortal.sol:632-634` → `PodERC20.sol:573-574` →
`PodErc20Mintable.sol:145-149`; minter moved at `PrivacyPortalFactory.sol:674`). Three shipped
admin recoveries exist and the refund was DEFAULT_ADMIN-only anyway → Low. Agree.

**(B)** Correct and minimal. `PodERC20Fixed.sol:575-581` lets the Ownable owner invalidate;
`PrivacyPortalFactoryFixed.sol:433-436` is the DEFAULT_ADMIN forwarder behind
`_requireFactoryOwnedPToken`; `PrivacyPortalFixed.sol:691-694` then skips the invalidate branch
because the request is already terminal. Crucially this grants DEFAULT_ADMIN **no new capability**:
`killStaleRequest` is already `onlyOwner` (`PodERC20.sol:590`) and `setRequestKillMinAge(0)`
(`:584-586`, forwarded at `PrivacyPortalFactory.sol:400-403`) already removes the age gate in one tx,
so the fix is a convenience, not a privilege escalation. X3 proves it end to end, including that the
portal alone still reverts `OnlyMinter` (no silent fallback). Nit: the `@dev` block on
`adminRefundPendingDeposit` (`PrivacyPortalFixed.sol:658-667`) still says "Gated on `whenPaused`" —
update it. Second nit: the un-paused branch is also taken for `mintStatus == None`; unreachable
today, but invert to `if (mintStatus != Failed && mintStatus != SystemFailed) require paused`.

### #4 — cross-factory remount · REAL · Medium · SHIP-WITH-CHANGES

**(A)** Confirmed: `oldPortal` is read from *this* factory's mapping (`PrivacyPortalFactory.sol:622,
651`) so the whole guard block `:652-666` is dead on the new factory while `setMinter` at `:674`
still runs. The repo's own hand-off test blesses the path. Medium. Agree.

**(B)** `PrivacyPortalFactoryFixed.sol:712-728` reads authority from the token, which is the right
shape, and adds the retire step the critic asked for (`retirePortal`, `:440-448`). X4 proves the
happy path. But it introduces three problems:

1. **Y2 — permanent brick.** `IPrivacyPortal(prevMinter).paused()` / `.factory()` /
   `.nativeWrappedUnderlying()` are called unguarded on an arbitrary address. If `prevMinter` is a
   contract that is not a portal, all three revert and the pToken can *never* be attached — and
   neither factory can rotate the minter back (`_requireFactoryOwnedPToken` fails on the old factory
   after hand-off, `UnknownPToken` on the new one).
2. **Y4 — one-way door.** `retirePortal(A)` clears `A.factory()`, after which the *same* factory's
   `createPortalWithExistingPToken` reverts `OnlyPortalFactory` at `:665` (`retireDepositsForUpgrade`
   requires `msg.sender == factory`, now `0`) and `createPortal` is blocked by `PortalAlreadyExists`.
   A hand-off that falls through strands the underlying on the old factory forever.
3. **Back door.** `setPTokenMinter` (`PrivacyPortalFactoryFixed.sol:403-406`) is unchanged and still
   rotates the minter with no pause/retire coupling, so an admin bypasses the entire new guard. This
   is report lead line 481; it belongs under #4, not in the leads list.

**Required changes:** (a) wrap the three `prevMinter` probes in `try/catch` and treat a failed probe
like `code.length == 0`; (b) make `retireDepositsForUpgrade` idempotent (`if (factory != address(0)
&& msg.sender != factory) revert`) or have `createPortalWithExistingPToken` skip the retire call when
`oldPortal.factory() == 0`; (c) apply the same `prevMinter` guard inside `setPTokenMinter`.

### #5 — live before registration · DESIGN-CHOICE with real residual · Low · SHIP

**(A)** Documented verbatim at `PrivacyPortalFactory.sol:530-542`, but the guidance is not atomically
enforceable and `createPortal` is `DEPLOYER_ROLE` — the lowest-trust role — while the follow-up close
is admin-only. Low. Agree.

**(B)** `PrivacyPortalFactoryFixed.sol:628-630` is Option A, exactly as the critic preferred. Safe:
`pauseByFactory` matches on `bindingFactory` set moments earlier in `initialize`, and `unpause()`
still works because `factory != 0` (`PrivacyPortal.sol:272-277`). It also converts the deploy into a
two-role handshake (DEPLOYER creates, DEFAULT_ADMIN opens), which is the point. X5 proves it. Note
for the team: this is a **breaking behaviour change** — every deploy script and every upstream test
that deposits straight after `createPortal` must now unpause first, and the `createPortal` NatSpec
("leave `isDepositEnabled` false") should be rewritten to describe the pause.

### #6 — duplicate of #3 · Informational · SHIP (nothing to review)

Agree it is a duplicate: same root cause (`setMinter` at `:674` revokes the retired portal's
authority), same fix menu, and the report's own title says so. The genuinely new content is the
test-coverage observation about the shipped mocks, which is not a vulnerability. One correction:
its remaining non-duplicate residual — minter rotation with no pause/retire coupling — is the
`setPTokenMinter` back door above, which the patch does **not** close, so #6 should be tracked as
closed-by-#3 *plus* an open item on #4.

### #7 — operator freeze · REAL · Low · SHIP

**(A)** Genuine privilege-boundary violation: OPERATOR_ROLE gets an emergency stop the role model
reserves for admin (`PrivacyPortalFeeLib.sol:29-34` bounds `fixedFee` only by `uint96`;
`PrivacyPortal.sol:909-911` returns it unmodified when `bps == 0`), silent (no `Paused` event) and
instantly reversible. Low. Agree.

**(B)** Correct. `PrivacyPortalFactoryFixed.sol:66` + `:455-459` and `PrivacyPortalFixed.sol:1008-1013`
bound both the factory defaults and the portal overrides, with a DEFAULT_ADMIN escape. The residual
lever — `percentageBps` up to `MAX_FEE_UNITS` (10 %) — is bounded by design, so the freeze vector is
closed. X7 proves both surfaces and that legitimate withdrawals still work. Two deployment notes:
the portal now hard-depends on `bindingFactory.maxOperatorFixedFee()` (`:1010`), so a fixed portal
implementation paired with an old factory bricks both fee setters — ship the pair together; and
`0.1 ether` is a chain-dependent default that admins must tune.

### #8 — refund rejects `Failed` · REAL · Low · SHIP

**(A)** The report's framing is wrong (a `Pending` mint was never permissionlessly refundable either)
but the asymmetry with `cancelFailedWithdrawal` (`:655-660`, which accepts both terminal states) and
the operational cost of pausing a whole portal to refund one depositor are real. Low. Agree.

**(B)** Correct and well-reasoned. The pause was only ever a speed bump against a late `Success`
(NatSpec `:605-613`), and `PodERC20._setRequestStatus:630-637` makes `Failed`/`SystemFailed`
terminal, so no late `Success` is possible — the pause buys nothing there. The fix keeps pause for
the `Pending` branch (`PrivacyPortalFixed.sol:686-689`), keeps the permissionless refund
`SystemFailed`-only, and stays DEFAULT_ADMIN-gated. X8 is a strong test: it asserts both halves
(pause still required while `Pending`, not required once `Failed`) and that the portal is still
unpaused after the refund.

### #9 — limits/fee on requested amount · REAL · Low · SHIP

**(A)** Mechanism exactly as stated (`:404`, `:406` precede the delta at `:412-414` while escrow and
mint use `received` at `:419-425`). Needs a fee-on-transfer underlying *and* `minWithdraw ≈
minDeposit`; the PoC's second half is self-inflicted. Low. Agree.

**(B)** Correct and minimal (`PrivacyPortalFixed.sol:446-448` and `:498-500`). Ordering is safe: the
new external call before fee accounting is covered by `nonReentrant` on all four entry points, and a
failed limit check reverts the transfer with it. `wrap`/`wrapWithMaxFee` still derive the floor from
the requested `amount`, but since `received ≤ amount` the derived fee always clears
`floor(received)`, so the only effect is a bounded over-declaration on FoT tokens — no break. X9 is a
strong test: it asserts the rejection at `minDeposit`, the escrow carrying the measured amount, and
`floor(received) < floor(requested)` against the real factory view.

### #10 — rescue drains committed collateral · REAL · Low · SHIP

**(A)** The missing on-chain obligation counter is the real finding; recovery is a plain ERC-20
transfer back, so no permanent loss unless `rescueRecipient` is unreachable. Low. Agree.

**(B)** Correct: `+=` at request (`:608`), `-=` at release (`:948`) and at cancel (`:724`), floor
applied only to the underlying (`:845-851`), and `rescueNative` correctly left alone since native
portals hold their collateral as WETH. Every increment has a reachable decrement: a stuck-`Pending`
transfer can be killed → `cancelFailedWithdrawal`; a blacklisted recipient can be re-targeted by the
admin while paused. X10 proves both the floor and that release still settles afterwards. Known
incompleteness, correctly not attempted: deposit escrows are equally committed but can never be
terminalised on mint success (`DepositEscrowStatus` is only ever written `Pending`/`Refunded`), so a
symmetric escrow reserve would grow monotonically and eventually block all rescue — worth a NatSpec
line saying `rescueERC20` can still strand refundable escrows.

### #11 — fee fail-open · DESIGN-CHOICE · Informational · **REJECT**

**(A)** Fail-open is documented three times (`IPodPriceOracle.sol:9-10`, `PortalFeeOracle.sol:9`,
`PrivacyPortalFeeLib.sol:78`); impact is protocol revenue only and detection already exists via the
`usedDynamicPricing` flag. Informational. Agree.

**(B)** Do not ship this flag. Y3 shows both halves: (i) `requireDynamicPricing = true` makes
`requestWithdrawWithPermit` revert `OracleRateUnavailable` on an oracle outage — the fee floor is
consulted on the *exit* path too (`:1015-1016` → `:1028`), so an admin protecting fee revenue
converts an Informational revenue leak into an availability failure on the exit path, which is
precisely the hazard the critic said made fail-open correct; (ii) the check at `:1053-1056` sits
*after* the early return at `:1048-1050`, so with `priceOracle == 0` a configured percentage fee
still silently collapses to `fixedFee` with strict mode on — the flag gives false assurance. It is
also the only fix with **zero** tests in `fixes.ts`.
**If it must ship:** scope the revert to `isDeposit == true`, and move the check above the
`priceOracle == 0 || bps == 0` early return so "percentage configured, no usable rate" is caught in
every shape. Better: leave the code alone and monitor `usedDynamicPricing`.

### #12 — unpartitionable limits · REAL (admin misconfiguration) · Informational · SHIP

**(A)** Pure DEFAULT_ADMIN misconfiguration; residue bounded by `minWithdraw − 1` per holder and
pTokens are transferable. Informational. Agree — and the report's own gating note dropped the
strictly worse `maxWithdraw == 0` freeze, which the fix also does not address.

**(B)** The rule at `PrivacyPortalFixed.sol:372-376` is arithmetically **exactly** right, which
neither the report nor the critic derived: sums of `k` parts drawn from `[min, max]` cover
`[k·min, k·max]`, and the union over `k ≥ 1` is contiguous from `min` iff `(k+1)·min ≤ k·max + 1` for
all `k`, whose tightest case `k = 1` is `max ≥ 2·min − 1`. The `minWithdraw > 1` guard both prevents
the `2*0-1` underflow and is a no-op for `min ≤ 1`; `maxWithdraw == 0` keeps the documented disable
semantics (and the pre-existing `min > max` check forces `min == 0` with it). X12 tests exactly the
boundary (`2·min−2` rejected, `2·min−1` accepted, `(0,0)` accepted). Only nit: `2 * minWithdraw`
panics rather than reverting `InvalidLimitConfiguration` for absurd `min > 2^255`.

### #13 — unbounded `wrap` · REAL · Low · SHIP-WITH-CHANGES

**(A)** Real missing slippage bound on the one value entry point that derives the fee at execution
time (`:498`); loss capped by `maxFee`, and in production a squeezed mint budget reverts on
`FeeManager` minimums rather than under-funding. Low. Agree.

**(B)** `wrapWithMaxFee` (`PrivacyPortalFixed.sol:542-553`) is correct: the bound is checked against
the floor derived from the requested amount, and since `floor(received) ≤ floor(amount)` the fee
actually charged never exceeds the caller's bound. X13 proves it against an operator front-run.
**But the finding is not closed:** `wrap` is unchanged and is the `IERC7984PortalWrapper` entry point
integrators actually call, so every existing integration keeps the unbounded behaviour, and X13 never
demonstrates that. **Required change:** at minimum mark `wrap` deprecated in NatSpec and point
`IERC7984PortalWrapper` consumers at `wrapWithMaxFee`; preferably add a per-portal admin-settable
`maxAutoWrapPortalFee` (defaulting to the config's `maxFee`, i.e. no behaviour change) that `wrap`
enforces, so ops can cap the silent overpay for callers that cannot pass a bound.

### #14 — request-id reuse · REAL · Medium · SHIP

**(A)** Every step anchored in production code: `InboxBase._packRequestId` mixes only
(src chain, target chain, nonce) with no inbox component, a fresh deployment restarts the per-target
nonce, escrows are written unconditionally (`:420`, `:468`), and `_setRequestStatus` (`:628-643`)
guards only terminal writes so `Pending` overwrites `Success`. Needs a DEFAULT_ADMIN repoint to a
from-scratch inbox, but where it fires the impact is severe and not admin-recoverable. Medium. Agree.

**(B)** `PodERC20Fixed.sol:644-647` is the right choke point — the single line every send funnels
through, fail-closed instead of fail-corrupt, no extra SLOAD (`current` was already read), and no
legitimate flow re-uses an id within one inbox. X14 is a strong test: the colliding deposit reverts
*before* any portal state is written, D1's escrow and status are intact, and stranded W1 cannot be
resurrected. Two caveats to record rather than change: (i) the portal-side guards
(`PrivacyPortalFixed.sol:451-454`, `:503-506`, `:755-757`) are unreachable through the mint/burn
paths because the pToken reverts first — harmless belt-and-braces, but untested; (ii) the critic's
"unverified sub-claim" about `burnInFlightTotal` double-counting is **still** unverified — neither
the PoC nor X14 exercises it, so the `burnInFlight` guard is shipped without evidence of the bug it
prevents. Also note the fix's failure mode: after an inbox redeploy the pToken reverts on every
colliding nonce until the shared per-target nonce climbs past its highest used id. That is the
correct trade, but it is a temporary user-facing DoS and should be documented.

## 4. New risks introduced by the fixes

1. **Payment revocation via `retargetStuckWithdrawal`** (`PrivacyPortalFixed.sol:976-1001`). The owner
   path has no stuck-ness precondition, so the requester can redirect any third-party recipient's
   payout up to the moment of release, and can open the window on purpose by underfunding
   `transferCallbackFee`. Proven in Y1. Fix: owner path → `newRecipient == withdrawal.user` only.
2. **FIX #2 is circumventable by the listed party.** `retargetStuckWithdrawal` applies no blacklist
   check to `msg.sender`/`withdrawal.user`, and `_releaseWithdrawal` checks only `recipient`
   (`:939-944`), so a sanctioned user re-points the withdrawal at a clean address and releases.
3. **FIX #4 can permanently brick a pToken.** Unguarded `paused()` / `factory()` /
   `nativeWrappedUnderlying()` probes on `prevMinter` (`PrivacyPortalFactoryFixed.sol:715-727`) revert
   for any non-portal minter, and no factory can then rotate the minter back. Proven in Y2.
4. **`retirePortal` is a one-way door** (`PrivacyPortalFactoryFixed.sol:440-448`). Clearing
   `factory` makes the same factory's own remount revert `OnlyPortalFactory` and `createPortal` revert
   `PortalAlreadyExists` — a failed hand-off strands the underlying forever. Proven in Y4.
5. **FIX #11 turns a revenue leak into an exit-path outage** while not covering `priceOracle == 0`
   (`PrivacyPortalFixed.sol:1048-1056`). Proven in Y3. It is also the only fix with no test.
6. **Deployment / layout coupling.** The portal now hard-calls
   `bindingFactory.maxOperatorFixedFee()` (`:1010`), so a fixed portal implementation on an old
   factory bricks both fee setters; and `outstandingWithdrawalTotal` / `requireDynamicPricing` were
   inserted mid-struct (`:72`, `:75`) rather than appended — harmless for EIP-1167 clones of a fresh
   implementation, but it makes storage-layout diffs noisy and is a trap if the pattern ever changes.

## 5. Fix-validation test quality

Strong and genuinely adversarial: X3, X8, X9, X10, X12, X14 each assert both that the exploit is
closed *and* that the legitimate path still works, and X10 incidentally proves the most important
non-regression in the set (in-flight release on a paused, retired portal after FIX #2). Weaknesses:
**#11 has no test at all**; X1b never exercises the admin-while-paused branch and is itself an
instance of the redirect it does not flag; X4 has no negative test for a non-portal `prevMinter`, the
`code.length == 0` skip, or a post-`retirePortal` remount; X13 never shows that plain `wrap` is still
unbounded; and X14 leaves the portal-side guards and the `burnInFlightTotal` sub-claim unexercised.
