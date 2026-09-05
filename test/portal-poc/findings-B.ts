import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseEventLogs, zeroAddress, type Hex } from "viem";
import {
  COTI_SIDE, COTI_CHAIN_ID, LOCAL_CHAIN_ID, MAX128, OPERATOR_ROLE, ONE, USDC, SEL, Status, WStatus, EStatus,
  connectNet, deployStack, doDeposit, doWithdraw, deliverSuccess, deliverMintSuccess, deliverSystemError,
  reqStatus, withdrawal, escrow, warp, bal, remount, expectRevert, callErr, shortErr, currentInbox, log, assertAddr,
} from "./helpers.ts";

// ─────────────────────────────────────────────────────────────────────────────
// PoCs for findings #8–#14 (same harness as findings-A.ts).
// Run: SOLC_NATIVE=<solc 0.8.28> npx hardhat --config hardhat.config.portal-poc.ts test test/portal-poc/findings-B.ts
// ─────────────────────────────────────────────────────────────────────────────

const net = await connectNet();

describe("F8 — refundFailedDeposit rejects mint status Failed, which the protocol's own kill tools write", { concurrency: 1 }, () => {
  it("after killStaleRequest → Failed, the permissionless refund reverts; only pause + admin refund remains; cancelFailedWithdrawal accepts Failed", async () => {
    const s = await deployStack(net, { kind: "erc20" });
    const amount = USDC(100);
    const { requestId } = await doDeposit(s, s.user, amount);

    // Ops terminalizes a stuck mint with the shipped tooling (factory forwarders).
    await s.factory.write.setPTokenRequestKillMinAge([s.pToken.address, 0n]);
    await s.factory.write.killPTokenStaleRequest([s.pToken.address, requestId]);
    assert.equal(await reqStatus(s, requestId), Status.Failed);

    const e = await expectRevert(() => s.portal.write.refundFailedDeposit([requestId], { account: s.stranger }), SEL.DepositMintNotFailed, "DepositMintNotFailed", "refund after kill");
    log("F8 refundFailedDeposit after kill:", shortErr(e));
    // The only remaining path: pause the whole portal, then admin refund (works because status != Success).
    await expectRevert(() => s.portal.write.adminRefundPendingDeposit([requestId]), SEL.ExpectedPause, "ExpectedPause", "admin refund unpaused");
    await s.portal.write.pause();
    const b0 = await bal(s, s.underlying, s.user);
    await s.portal.write.adminRefundPendingDeposit([requestId]);
    assert.equal(await bal(s, s.underlying, s.user), b0 + amount);
    await s.portal.write.unpause();

    // Contrast 1: the SystemFailed path is permissionless as designed.
    const d2 = await doDeposit(s, s.user, amount);
    await deliverSystemError(s, d2.requestId, 2n, "0x");
    assert.equal(await reqStatus(s, d2.requestId), Status.SystemFailed);
    await s.portal.write.refundFailedDeposit([d2.requestId], { account: s.stranger });
    assert.equal((await escrow(s, d2.requestId)).status, EStatus.Refunded);

    // Contrast 2: the withdrawal-side cancel accepts BOTH terminal failure states.
    const d3 = await doDeposit(s, s.user, amount);
    await deliverMintSuccess(s, d3.requestId, s.user);
    const w = await doWithdraw(s, 1, s.user, amount);
    await s.factory.write.killPTokenStaleRequest([s.pToken.address, w.transferRequestId]);
    assert.equal(await reqStatus(s, w.transferRequestId), Status.Failed);
    await s.portal.write.cancelFailedWithdrawal([w.withdrawalId], { account: s.stranger });
    assert.equal((await withdrawal(s, w.withdrawalId)).status, WStatus.Failed);
    log("F8: deposit refund accepts only SystemFailed; withdrawal cancel accepts Failed|SystemFailed");
  });
});

describe("F9 — deposit limits and fee use the requested amount; escrow/mint use the measured amount", { concurrency: 1 }, () => {
  it("5% fee-on-transfer underlying: a deposit at minDeposit creates a position below minWithdraw that cannot be withdrawn; fee charged on pre-fee notional", async () => {
    const s = await deployStack(net, { kind: "fot", feeBps: 500n });
    const min = USDC(100);
    await s.portal.write.setLimits([min, MAX128, min, MAX128]);

    const { requestId } = await doDeposit(s, s.user, min);
    const esc = await escrow(s, requestId);
    assert.equal(esc.amount, USDC(95), "escrow/mint carry the measured 95");
    await deliverMintSuccess(s, requestId, s.user);
    // The user holds 95 pTokens. Any amount they can actually cover is below minWithdraw.
    await expectRevert(() => doWithdraw(s, 1, s.user, USDC(95)), SEL.WithdrawBelowMinimum, "WithdrawBelowMinimum", "withdraw the real position");
    await expectRevert(() => doWithdraw(s, 1, s.user, USDC(99)), SEL.WithdrawBelowMinimum, "WithdrawBelowMinimum", "withdraw 99");
    // A second deposit at the minimum only shifts the residue: 95 + 95 = 190 → withdraw 100 → 90 stuck again.
    const d2 = await doDeposit(s, s.user, min);
    await deliverMintSuccess(s, d2.requestId, s.user);
    const w = await doWithdraw(s, 1, s.user, USDC(100));
    assert.equal((await withdrawal(s, w.withdrawalId)).status, WStatus.TransferPending);
    await expectRevert(() => doWithdraw(s, 1, s.user, USDC(90)), SEL.WithdrawBelowMinimum, "WithdrawBelowMinimum", "withdraw the 90 residue");

    // Fee side: percentage fee is computed on `amount` (100), not on `received` (95).
    await s.oracle.write.setTokenPriceUSD([s.wnative.address, ONE]);
    await s.oracle.write.setTokenPriceUSD([s.underlying.address, ONE]);
    await s.factory.write.setDefaultDepositFee([0n, 10_000n, 10n * ONE]); // 1%
    const floor100 = (await s.factory.read.getDepositPortalFeeFloor([s.underlying.address, USDC(100), 6]))[0] as bigint;
    const floor95 = (await s.factory.read.getDepositPortalFeeFloor([s.underlying.address, USDC(95), 6]))[0] as bigint;
    assert.equal(floor100, ONE);
    assert.equal(floor95, (ONE * 95n) / 100n);
    await expectRevert(() => doDeposit(s, s.user, min, { portalFee: floor95 }), SEL.InsufficientPortalFee, "InsufficientPortalFee", "fee on measured amount rejected");
    await doDeposit(s, s.user, min, { portalFee: floor100 });
    log("F9: minDeposit=minWithdraw=100, received=95 → position unredeemable; fee floor 1.00 vs 0.95 native");
  });
});

describe("F10 — rescueERC20 keeps no reserve for withdrawals already in TransferPending", { concurrency: 1 }, () => {
  it("pause → remount → rescue full balance (documented migration) strands a pending withdrawal once its COTI leg settles", async () => {
    const s = await deployStack(net, { kind: "erc20" });
    const amount = USDC(100);
    const { requestId } = await doDeposit(s, s.user, amount);
    await deliverMintSuccess(s, requestId, s.user);
    const w = await doWithdraw(s, 1, s.user, amount);
    assert.equal((await withdrawal(s, w.withdrawalId)).status, WStatus.TransferPending);

    const oldPortal = s.portal;
    await remount(s);
    // No reserve check: the full balance (including the 100 owed to the pending withdrawal) can leave.
    await oldPortal.write.rescueERC20([s.underlying.address, amount]);
    assert.equal(await bal(s, s.underlying, oldPortal.address), 0n);

    // The COTI leg settles: pTokens are now in portal custody on COTI, but the release reverts on balance.
    const r = await deliverSuccess(s, w.transferRequestId, s.user, oldPortal.address);
    assert.equal(r.callbackFailed, true);
    assert.equal(await reqStatus(s, w.transferRequestId), Status.Success);
    await expectRevert(() => oldPortal.write.triggerWithdrawalRelease([w.withdrawalId]), SEL.ERC20InsufficientBalance, "ERC20InsufficientBalance", "release after rescue");
    await expectRevert(() => oldPortal.write.cancelFailedWithdrawal([w.withdrawalId]), SEL.WithdrawTransferNotFailed, "WithdrawTransferNotFailed", "cancel");
    assert.equal(await oldPortal.read.pendingBurnAmount(), 0n, "custodied pTokens uncounted");
    // Recovery requires someone to send collateral back to the retired portal (no protocol function does it).
    await s.underlying.write.transfer([oldPortal.address, amount], { account: s.rescue });
    await oldPortal.write.triggerWithdrawalRelease([w.withdrawalId], { account: s.stranger });
    assert.equal((await withdrawal(s, w.withdrawalId)).status, WStatus.Released);
    log("F10: rescue drained collateral committed to a TransferPending withdrawal; stuck until manually re-funded");
  });
});

describe("F11 — fee floor silently collapses to fixedFee (0) when the oracle returns a zero rate", { concurrency: 1 }, () => {
  it("1% percentage fee → 0 after the underlying's peg is cleared, or for a new portal whose underlying was never priced", async () => {
    const s = await deployStack(net, { kind: "erc20" });
    const amount = USDC(100);
    const d = await doDeposit(s, s.user, amount * 2n);
    await deliverMintSuccess(s, d.requestId, s.user);

    await s.oracle.write.setTokenPriceUSD([s.wnative.address, ONE]);
    await s.oracle.write.setTokenPriceUSD([s.underlying.address, ONE]);
    await s.factory.write.setDefaultWithdrawFee([0n, 10_000n, 10n * ONE]); // fixed 0, 1%, cap 10 native
    // Priced: the floor is enforced.
    const e = await expectRevert(() => doWithdraw(s, 1, s.user, amount, { portalFee: 0n }), SEL.InsufficientPortalFee, "InsufficientPortalFee", "withdraw with fee 0 while priced");
    log("F11 priced:", shortErr(e));
    // Peg cleared (admin op, or any adapter returning 0 for stale/failed feeds): the same withdrawal passes with fee 0.
    await s.oracle.write.clearTokenPriceUSD([s.underlying.address]);
    const est = (await s.portal.read.estimateWithdrawFees([amount])) as readonly [bigint, boolean, bigint, bigint];
    assert.equal(est[0], 0n);
    assert.equal(est[1], false, "estimate reports no dynamic pricing — the tx path does not check this flag");
    const w = await doWithdraw(s, 1, s.user, amount, { portalFee: 0n });
    assert.equal((await withdrawal(s, w.withdrawalId)).status, WStatus.TransferPending);
    assert.equal(await s.portal.read.accumulatedPortalFees(), 0n);

    // New portal for an underlying that was never priced: createPortal sets no peg, so it runs at fee 0 despite bps=1%.
    const usdt = await s.viem.deployContract("MockERC20Harness", ["Mock USDT", "mUSDT", 6]);
    await s.factory.write.setDefaultDepositFee([0n, 10_000n, 10n * ONE]);
    await s.factory.write.createPortal([usdt.address, "pUSDT", "pUSDT", 6, false]);
    const p2Addr = (await s.factory.read.portalForUnderlying([usdt.address])) as Hex;
    const p2 = await s.viem.getContractAt("PrivacyPortalHarness", p2Addr);
    await usdt.write.mint([s.user, amount]);
    await usdt.write.approve([p2Addr, amount], { account: s.user });
    await p2.write.deposit([s.user, amount, 0n, 100n], { account: s.user, value: 1000n });
    assert.equal(await p2.read.accumulatedPortalFees(), 0n);
    log("F11: percentage fee configured, 0 collected, no revert/event — fail-open by design of IPodPriceOracle");
  });
});

describe("F12 — setLimits accepts a withdraw window that cannot partition every balance", { concurrency: 1 }, () => {
  it("minWithdraw=100, maxWithdraw=150: a 170 balance cannot be fully redeemed by any sequence", async () => {
    const s = await deployStack(net, { kind: "erc20" });
    await s.portal.write.setLimits([1n, MAX128, USDC(100), USDC(150)]); // accepted (only min<=max is checked)
    const d = await doDeposit(s, s.user, USDC(170));
    await deliverMintSuccess(s, d.requestId, s.user);
    await expectRevert(() => doWithdraw(s, 1, s.user, USDC(170)), SEL.WithdrawExceedsMaximum, "WithdrawExceedsMaximum", "170");
    // Every split of 170 into legal parts needs two parts >= 100 (sum >= 200): impossible. Residues are rejected:
    for (const r of [20, 70, 99]) {
      await expectRevert(() => doWithdraw(s, 1, s.user, USDC(r)), SEL.WithdrawBelowMinimum, "WithdrawBelowMinimum", `residue ${r}`);
    }
    // The only way out is topping up the position with a deposit — which an operator can switch off.
    await s.portal.write.setIsDepositEnabled([false]);
    await expectRevert(() => doDeposit(s, s.user, USDC(30)), SEL.DepositDisabled, "DepositDisabled", "top-up disabled");
    log("F12: with deposits disabled, >=20 of a 170 balance is permanently unredeemable under (100,150)");
  });
});

describe("F13 — wrap charges the execution-time fee floor with no caller-supplied bound", { concurrency: 1 }, () => {
  it("fee raised between quote and inclusion: deposit() reverts InsufficientPortalFee, wrap() silently pays the higher fee from the mint budget", async () => {
    const s = await deployStack(net, { kind: "erc20" });
    const amount = USDC(100);
    await s.oracle.write.setTokenPriceUSD([s.wnative.address, ONE]);
    await s.oracle.write.setTokenPriceUSD([s.underlying.address, ONE]);
    await s.factory.write.grantRole([OPERATOR_ROLE, s.operator]);
    await s.factory.write.setDefaultDepositFee([0n, 10_000n, 10n * ONE]); // 1% → floor 1 native for 100 USD
    const quote = (await s.portal.read.estimateDepositFees([amount])) as readonly [bigint, boolean, bigint, bigint];
    assert.equal(quote[0], ONE, "user is quoted 1.0 native");
    const mintBudget = ONE / 2n; // user funds the async mint leg generously

    // Operator front-runs with a 1.4% fee (well inside the 10% cap).
    await s.factory.write.setDefaultDepositFee([0n, 14_000n, 10n * ONE], { account: s.operator });

    // deposit(): the caller-declared fee is validated → reverts.
    await expectRevert(() => doDeposit(s, s.user, amount, { portalFee: ONE, mintBudget }), SEL.InsufficientPortalFee, "InsufficientPortalFee", "deposit with stale quote");
    // wrap(): no declared fee → the live floor (1.4 native) is taken, the mint leg gets what is left.
    const hash = await s.portal.write.wrap([s.user, amount, 100n], { account: s.user, value: ONE + mintBudget });
    const rc = await s.client.waitForTransactionReceipt({ hash });
    const fees = parseEventLogs({ abi: s.portal.abi, logs: rc.logs, eventName: "OperationFeesPaid" })[0] as any;
    assert.equal(fees.args.portalFee, (ONE * 14n) / 10n, "1.4 native charged vs 1.0 quoted");
    assert.equal(fees.args.podFee, mintBudget - (ONE * 4n) / 10n, "mint budget silently reduced by 0.4 native");
    assert.equal(await s.portal.read.accumulatedPortalFees(), (ONE * 14n) / 10n);
    log("F13: quoted 1.0, wrap paid 1.4 (from the mint budget); deposit() with the same value would have reverted");
  });
});

describe("F14 — request ids are unique only per inbox instance: rotation collides escrow/request state", { concurrency: 1 }, () => {
  it("fresh inbox restarts the nonce → same ids: escrow overwritten, Success→Pending rewind, stranded withdrawal resurrected and paid", async () => {
    const s = await deployStack(net, { kind: "erc20" });
    const amount = USDC(100);
    const inbox1 = await currentInbox(s);

    // Nonce 1 on inbox1 was consumed by createPortal's one-way registration message.
    // D1 by user: nonce 2 (Success). W1 by user: nonce 3 — its COTI leg is stranded (no callback ever arrives).
    const d1 = await doDeposit(s, s.user, amount);
    assert.equal(d1.requestId, await inbox1.read.getRequestId([LOCAL_CHAIN_ID, COTI_CHAIN_ID, 2n]));
    await deliverMintSuccess(s, d1.requestId, s.user);
    const w1 = await doWithdraw(s, 1, s.user, amount / 2n);
    assert.equal(w1.transferRequestId, await inbox1.read.getRequestId([LOCAL_CHAIN_ID, COTI_CHAIN_ID, 3n]));
    assert.equal(await reqStatus(s, w1.transferRequestId), Status.Pending);

    // Admin re-points the pToken at a fresh inbox (documented forwarder; e.g. an inbox redeploy). Its per-target nonce restarts at 1
    // (InboxBase.sol:507 `++_requestNonce[targetChainId]`; the id packs only (src, target, nonce) — InboxBase.sol:650-662).
    const inbox2 = await s.viem.deployContract("MockInboxForPortal", []);
    await s.factory.write.configurePToken([s.pToken.address, inbox2.address, COTI_SIDE]);
    assertAddr(await s.pToken.read.inbox(), inbox2.address, "pToken now uses inbox2");

    // D2 by user2 takes nonce 1 (never used by the pToken before): harmless.
    const d2 = await doDeposit(s, s.user2, USDC(10));
    assert.equal(d2.requestId, await inbox2.read.getRequestId([LOCAL_CHAIN_ID, COTI_CHAIN_ID, 1n]));
    assert.notEqual(d2.requestId, d1.requestId);

    // D3 by user2 takes nonce 2 = D1's id: escrow record overwritten, pToken status rewound Success → Pending.
    const d3 = await doDeposit(s, s.user2, USDC(10));
    assert.equal(d3.requestId, d1.requestId, "same request id as D1");
    const esc = await escrow(s, d1.requestId);
    assertAddr(esc.user, s.user2, "user's D1 escrow record replaced by user2's");
    assert.equal(esc.amount, USDC(10));
    assert.equal(await reqStatus(s, d1.requestId), Status.Pending, "D1 rewound from Success to Pending");

    // D4 by user2 takes nonce 3 = W1's transferRequestId. Its mint success then flips W1's transfer to Success.
    const d4 = await doDeposit(s, s.user2, USDC(10));
    assert.equal(d4.requestId, w1.transferRequestId, "same id as the stranded withdrawal's transfer request");
    await deliverMintSuccess(s, d4.requestId, s.user2);
    assert.equal(await reqStatus(s, w1.transferRequestId), Status.Success);
    // Anyone can now release W1: collateral leaves for a pToken transfer that never settled on COTI.
    const b0 = await bal(s, s.underlying, s.user);
    await s.portal.write.triggerWithdrawalRelease([w1.withdrawalId], { account: s.stranger });
    assert.equal(await bal(s, s.underlying, s.user), b0 + amount / 2n, "W1 paid out");
    assert.equal(await s.portal.read.pendingBurnAmount(), amount / 2n, "portal now claims custody of pTokens it never received");
    log("F14: after inbox rotation, ids 2 and 3 were reissued; escrow overwrite + Success rewind + resurrected withdrawal paid");
  });
});
