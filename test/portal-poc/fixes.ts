import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseEventLogs, zeroAddress, type Hex } from "viem";
import {
  COTI_SIDE, COTI_CHAIN_ID, LOCAL_CHAIN_ID, MAX96, MAX128, OPERATOR_ROLE, ONE, USDC, SEL, Status, WStatus, EStatus,
  connectNet, deployStack, doDeposit, doDepositNative, doWithdraw, deliverSuccess, deliverMintSuccess,
  reqStatus, withdrawal, escrow, warp, bal, remount, expectRevert, callErr, shortErr, currentInbox, log, assertAddr,
} from "./helpers.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Fix validation: every exploit scenario from findings-A/B re-run against the PATCHED contracts
// (test/portal-poc/contracts/patched/*Fixed.sol). Each test asserts the exploit no longer works and that the
// legitimate path still does. Run:
//   SOLC_NATIVE=<solc 0.8.28> npx hardhat --config hardhat.config.portal-poc.ts test test/portal-poc/fixes.ts
// ─────────────────────────────────────────────────────────────────────────────

const net = await connectNet();
const FIXED = { fixed: true } as const;

describe("X1 — fix for #1: stuck withdrawal", { concurrency: 1 }, () => {
  it("X1a native: a non-payable recipient receives WETH instead; withdrawal Released; pTokens counted", async () => {
    const s = await deployStack(net, { kind: "native", ...FIXED });
    const amount = ONE;
    const { requestId } = await doDepositNative(s, s.user, amount);
    await deliverMintSuccess(s, requestId, s.user);
    const rejecter = await s.viem.deployContract("RejectEthReceiverHarness", []);
    const w = await doWithdraw(s, 1, rejecter.address, amount);
    const r = await deliverSuccess(s, w.transferRequestId, s.user, s.portal.address);
    // The hook may still fail if the miner's callback gas budget is tighter than the WETH fallback path needs;
    // the permissionless trigger then completes it. Either way the withdrawal must end Released.
    if (r.callbackFailed) {
      log("X1a: hook ran out of gas inside the callback; completing via triggerWithdrawalRelease");
      await s.portal.write.triggerWithdrawalRelease([w.withdrawalId], { account: s.stranger });
    }
    assert.equal((await withdrawal(s, w.withdrawalId)).status, WStatus.Released);
    assert.equal(await bal(s, s.wnative, rejecter.address), amount, "recipient got the wrapped asset");
    assert.equal(await s.portal.read.pendingBurnAmount(), amount, "custodied pTokens are counted");
    log("X1a: ETH send failed → WETH delivered; Released; pendingBurnAmount =", amount);
  });

  it("X1b ERC-20 issuer blocklist: owner may only pull the payout back to themself; admin (paused) may re-target elsewhere", async () => {
    const s = await deployStack(net, { kind: "blocklist", ...FIXED });
    const amount = USDC(100);
    const { requestId } = await doDeposit(s, s.user, amount * 2n);
    await deliverMintSuccess(s, requestId, s.user);
    // Withdrawal #1: Alice (user) pays a third party (user2); the issuer blocks user2 mid-flight.
    const w = await doWithdraw(s, 1, s.user2, amount);
    await expectRevert(() => s.portal.write.retargetStuckWithdrawal([w.withdrawalId, s.user], { account: s.user }), SEL.WithdrawalNotStuck, "WithdrawalNotStuck", "retarget before settlement");
    await s.underlying.write.setBlocked([s.user2, true]);
    const r = await deliverSuccess(s, w.transferRequestId, s.user, s.portal.address);
    assert.equal(r.callbackFailed, true, "issuer block still makes the automatic release fail");
    await expectRevert(() => s.portal.write.retargetStuckWithdrawal([w.withdrawalId, s.user], { account: s.stranger }), SEL.NotWithdrawalOwner, "NotWithdrawalOwner", "stranger retarget");
    // Review change Y1: the requester cannot redirect a third-party payment to an arbitrary address...
    await expectRevert(() => s.portal.write.retargetStuckWithdrawal([w.withdrawalId, s.operator], { account: s.user }), SEL.RetargetOnlyToSelf, "RetargetOnlyToSelf", "owner retarget to third party");
    // ...only pull it back to themself.
    await s.portal.write.retargetStuckWithdrawal([w.withdrawalId, s.user], { account: s.user });
    const b0 = await bal(s, s.underlying, s.user);
    await s.portal.write.triggerWithdrawalRelease([w.withdrawalId], { account: s.stranger });
    assert.equal((await withdrawal(s, w.withdrawalId)).status, WStatus.Released);
    assert.equal(await bal(s, s.underlying, s.user), b0 + amount);
    // Withdrawal #2: Alice pays herself and the issuer blocks ALICE. Self re-target cannot help; the admin path (paused) can.
    const w2 = await doWithdraw(s, 1, s.user, amount);
    await s.underlying.write.setBlocked([s.user, true]);
    const r2 = await deliverSuccess(s, w2.transferRequestId, s.user, s.portal.address);
    assert.equal(r2.callbackFailed, true);
    await expectRevert(() => s.portal.write.retargetStuckWithdrawal([w2.withdrawalId, s.operator], { account: s.admin }), SEL.NotWithdrawalOwner, "NotWithdrawalOwner", "admin retarget while unpaused");
    await s.portal.write.pause();
    await s.portal.write.retargetStuckWithdrawal([w2.withdrawalId, s.operator], { account: s.admin });
    const c0 = await bal(s, s.underlying, s.operator);
    await s.portal.write.triggerWithdrawalRelease([w2.withdrawalId], { account: s.stranger });
    assert.equal(await bal(s, s.underlying, s.operator), c0 + amount);
    assert.equal(await s.portal.read.pendingBurnAmount(), 2n * amount);
    log("X1b: owner→self re-target; admin-while-paused re-target for a blocked owner; third-party redirect refused");
  });
});

describe("X2 — fix for #2: blacklist enforced on the release leg", { concurrency: 1 }, () => {
  it("a recipient listed after the request is not paid; release resumes after de-listing; pause bypass stays (intended)", async () => {
    const s = await deployStack(net, { kind: "erc20", ...FIXED });
    const amount = USDC(100);
    const { requestId } = await doDeposit(s, s.user, amount * 2n);
    await deliverMintSuccess(s, requestId, s.user);
    const w = await doWithdraw(s, 1, s.user2, amount);
    await s.factory.write.addToBlacklist([s.user2]);
    const r = await deliverSuccess(s, w.transferRequestId, s.user, s.portal.address);
    assert.equal(r.callbackFailed, true, "automatic release refused for a blacklisted recipient");
    await expectRevert(() => s.portal.write.triggerWithdrawalRelease([w.withdrawalId], { account: s.stranger }), SEL.AddressBlacklisted, "AddressBlacklisted", "trigger to blacklisted");
    assert.equal(await bal(s, s.underlying, s.user2), USDC(1_000_000), "no payout");
    // Review change: a listed PAYER is not paid either, and cannot route around the control by re-targeting to themself.
    const w2 = await doWithdraw(s, 1, s.user, amount);
    await s.factory.write.addToBlacklist([s.user]);
    const r2 = await deliverSuccess(s, w2.transferRequestId, s.user, s.portal.address);
    assert.equal(r2.callbackFailed, true);
    await expectRevert(() => s.portal.write.triggerWithdrawalRelease([w2.withdrawalId], { account: s.stranger }), SEL.AddressBlacklisted, "AddressBlacklisted", "listed payer");
    await expectRevert(() => s.portal.write.retargetStuckWithdrawal([w2.withdrawalId, s.user], { account: s.user }), SEL.AddressBlacklisted, "AddressBlacklisted", "listed payer retarget");
    // Compliance decision: de-list → release works, even while the portal is paused (documented migration model).
    await s.factory.write.removeFromBlacklist([s.user2]);
    await s.factory.write.removeFromBlacklist([s.user]);
    await s.portal.write.pause();
    await s.portal.write.triggerWithdrawalRelease([w.withdrawalId], { account: s.stranger });
    await s.portal.write.triggerWithdrawalRelease([w2.withdrawalId], { account: s.stranger });
    assert.equal((await withdrawal(s, w.withdrawalId)).status, WStatus.Released);
    assert.equal((await withdrawal(s, w2.withdrawalId)).status, WStatus.Released);
    log("X2: listed recipient AND listed payer blocked at settlement; released after de-listing (paused)");
  });
});

describe("X3 — fix for #3: refund after remount via owner-authorized invalidation", { concurrency: 1 }, () => {
  it("factory.invalidatePTokenPendingRequest then adminRefundPendingDeposit on the retired portal — no kill age, no minter swap", async () => {
    const s = await deployStack(net, { kind: "erc20", ...FIXED });
    const amount = USDC(100);
    const { requestId } = await doDeposit(s, s.user, amount);
    const oldPortal = s.portal;
    await remount(s);
    // Still bricked on the portal alone (it is neither minter nor owner)...
    await expectRevert(() => oldPortal.write.adminRefundPendingDeposit([requestId]), SEL.OnlyMinter, "OnlyMinter", "refund without owner invalidation");
    // ...but the factory (pToken owner) can terminalize the request through the admin-gated forwarder.
    await expectRevert(() => s.factory.write.invalidatePTokenPendingRequest([s.pToken.address, requestId], { account: s.stranger }), SEL.AccessControlUnauthorizedAccount, "AccessControlUnauthorizedAccount", "stranger forwarder");
    await s.factory.write.invalidatePTokenPendingRequest([s.pToken.address, requestId]);
    assert.equal(await reqStatus(s, requestId), Status.Failed);
    const b0 = await bal(s, s.underlying, s.user);
    await oldPortal.write.adminRefundPendingDeposit([requestId]);
    assert.equal(await bal(s, s.underlying, s.user), b0 + amount);
    assert.equal((await escrow(s, requestId, oldPortal)).status, EStatus.Refunded);
    log("X3: refund completed immediately after remount");
  });
});

describe("X4 — fix for #4: cross-factory remount requires a paused AND retired previous portal", { concurrency: 1 }, () => {
  it("F2 remount reverts until F1's admin pauses and retires portal A; then it succeeds", async () => {
    const s = await deployStack(net, { kind: "erc20", ...FIXED });
    const amount = USDC(100);
    const { requestId } = await doDeposit(s, s.user, amount);
    await deliverMintSuccess(s, requestId, s.user);
    const portalA = s.portal;
    const admin2 = s.user2;
    const f2 = await s.viem.deployContract(
      "PrivacyPortalFactoryFixed",
      [admin2, s.inbox.address, COTI_CHAIN_ID, COTI_SIDE, s.pTokenImpl.address, s.portalImpl.address, admin2, admin2, s.wnative.address, s.oracle.address, 0n, 0n, MAX128, 0n, 0n, MAX128],
      { client: { public: s.client, wallet: s.adminW } }
    );
    await s.factory.write.transferPTokenOwnership([s.pToken.address, f2.address]);
    await expectRevert(() => f2.write.createPortalWithExistingPToken([s.underlying.address, s.pToken.address, false], { account: admin2 }), SEL.OldPortalNotPaused, "OldPortalNotPaused", "remount while A live");
    await portalA.write.pause();
    await expectRevert(() => f2.write.createPortalWithExistingPToken([s.underlying.address, s.pToken.address, false], { account: admin2 }), SEL.OldPortalNotRetired, "OldPortalNotRetired", "remount while A not retired");
    await expectRevert(() => s.factory.write.retirePortal([portalA.address], { account: s.stranger }), SEL.AccessControlUnauthorizedAccount, "AccessControlUnauthorizedAccount", "stranger retire");
    await s.factory.write.retirePortal([portalA.address]);
    assertAddr(await portalA.read.factory(), zeroAddress, "A detached");
    await f2.write.createPortalWithExistingPToken([s.underlying.address, s.pToken.address, false], { account: admin2 });
    const portalB = (await f2.read.portalForUnderlying([s.underlying.address])) as Hex;
    assertAddr(await s.pToken.read.minter(), portalB, "minter rotated only after A was closed");
    await expectRevert(() => doDeposit(s, s.user, amount), SEL.DepositsPaused, "DepositsPaused", "deposit on retired A");
    log("X4: cross-factory attach blocked until A paused + retired");
  });

  it("Y2 regression: a non-portal minter cannot brick the pToken; Y4 regression: retirePortal is not a one-way door; setPTokenMinter needs a paused portal", async () => {
    const s = await deployStack(net, { kind: "erc20", ...FIXED });
    const portalA = s.portal;
    const notAPortal = await s.viem.deployContract("MockERC20Harness", ["x", "x", 6]);
    // setPTokenMinter away from a live, unpaused portal is refused (the back door the reviewer flagged).
    await expectRevert(() => s.factory.write.setPTokenMinter([s.pToken.address, notAPortal.address]), SEL.OldPortalNotPaused, "OldPortalNotPaused", "rotate away from live portal");
    await portalA.write.pause();
    await s.factory.write.setPTokenMinter([s.pToken.address, notAPortal.address]); // allowed once paused (emergency tool)
    // Y2: the minter is now a contract that is not a portal → probes fail → treated as "no portal", attach succeeds.
    await s.factory.write.retirePortal([portalA.address]);
    // Y4: after retirePortal the SAME factory can still remount (no double retire).
    await s.factory.write.createPortalWithExistingPToken([s.underlying.address, s.pToken.address, false]);
    const portalB = (await s.factory.read.portalForUnderlying([s.underlying.address])) as Hex;
    assertAddr(await s.pToken.read.minter(), portalB, "remounted on the same factory after retirePortal");
    log("Y2/Y4: non-portal minter tolerated; retirePortal followed by a same-factory remount works");
  });
});

describe("X5 — fix for #5: portals start paused until registration is confirmed", { concurrency: 1 }, () => {
  it("createPortal leaves the clone paused; deposits revert until the admin unpauses", async () => {
    const s = await deployStack(net, { kind: "erc20", fixed: true, keepPaused: true });
    assert.equal(await s.portal.read.paused(), true);
    await expectRevert(() => doDeposit(s, s.user, USDC(100)), SEL.DepositsPaused, "DepositsPaused", "deposit before unpause");
    await s.portal.write.unpause();
    const { requestId } = await doDeposit(s, s.user, USDC(100));
    assert.equal(await reqStatus(s, requestId), Status.Pending);
    log("X5: clone created paused; admin opens it after observing registration");
  });
});

describe("X7 — fix for #7: operator fixed-fee ceiling", { concurrency: 1 }, () => {
  it("operator cannot exceed maxOperatorFixedFee (portal override or factory default); admin can", async () => {
    const s = await deployStack(net, { kind: "erc20", ...FIXED });
    await s.factory.write.grantRole([OPERATOR_ROLE, s.operator]);
    await expectRevert(() => s.portal.write.setWithdrawFee([MAX96, 0n, MAX96], { account: s.operator }), SEL.FixedFeeAboveCeiling, "FixedFeeAboveCeiling", "operator huge fixedFee");
    await expectRevert(() => s.factory.write.setDefaultWithdrawFee([MAX96, 0n, MAX96], { account: s.operator }), SEL.FixedFeeAboveCeiling, "FixedFeeAboveCeiling", "operator huge default");
    await s.portal.write.setWithdrawFee([ONE / 20n, 0n, ONE], { account: s.operator }); // 0.05 native ≤ 0.1 ceiling
    await s.factory.write.setDefaultWithdrawFee([MAX96, 0n, MAX96]); // admin may
    const { requestId } = await doDeposit(s, s.user, USDC(100));
    await deliverMintSuccess(s, requestId, s.user);
    const w = await doWithdraw(s, 1, s.user, USDC(50), { portalFee: ONE / 20n });
    assert.equal((await withdrawal(s, w.withdrawalId)).status, WStatus.TransferPending);
    log("X7: operator bounded by the ceiling; withdrawals keep working");
  });
});

describe("X8 — fix for #8: terminal Failed mints are refundable by the admin without pausing", { concurrency: 1 }, () => {
  it("pause still required while Pending; not required once the request is Failed", async () => {
    const s = await deployStack(net, { kind: "erc20", ...FIXED });
    const amount = USDC(100);
    const { requestId } = await doDeposit(s, s.user, amount);
    await expectRevert(() => s.portal.write.adminRefundPendingDeposit([requestId]), SEL.ExpectedPause, "ExpectedPause", "unpaused refund of a Pending mint");
    await s.factory.write.setPTokenRequestKillMinAge([s.pToken.address, 0n]);
    await s.factory.write.killPTokenStaleRequest([s.pToken.address, requestId]);
    assert.equal(await reqStatus(s, requestId), Status.Failed);
    const b0 = await bal(s, s.underlying, s.user);
    await s.portal.write.adminRefundPendingDeposit([requestId]);
    assert.equal(await bal(s, s.underlying, s.user), b0 + amount);
    assert.equal(await s.portal.read.paused(), false);
    log("X8: killed mint refunded with the portal still open");
  });
});

describe("X9 — fix for #9: limits and fee on the measured amount", { concurrency: 1 }, () => {
  it("a deposit that nets below minWithdraw is rejected; the fee floor is charged on received", async () => {
    const s = await deployStack(net, { kind: "fot", feeBps: 500n, ...FIXED });
    const min = USDC(100);
    await s.portal.write.setLimits([min, MAX128, min, MAX128]);
    await expectRevert(() => doDeposit(s, s.user, min), SEL.DepositBelowMinimum, "DepositBelowMinimum", "100 requested, 95 received");
    const { requestId } = await doDeposit(s, s.user, USDC(106));
    assert.equal((await escrow(s, requestId)).amount, 100_700_000n);
    await s.oracle.write.setTokenPriceUSD([s.wnative.address, ONE]);
    await s.oracle.write.setTokenPriceUSD([s.underlying.address, ONE]);
    await s.factory.write.setDefaultDepositFee([0n, 10_000n, 10n * ONE]);
    const floorReceived = (await s.factory.read.getDepositPortalFeeFloor([s.underlying.address, 100_700_000n, 6]))[0] as bigint;
    const floorRequested = (await s.factory.read.getDepositPortalFeeFloor([s.underlying.address, USDC(106), 6]))[0] as bigint;
    assert.ok(floorReceived < floorRequested);
    await doDeposit(s, s.user, USDC(106), { portalFee: floorReceived });
    await expectRevert(() => doDeposit(s, s.user, USDC(106), { portalFee: floorReceived - 1n }), SEL.InsufficientPortalFee, "InsufficientPortalFee", "below floor(received)");
    log("X9: floor(received) =", floorReceived, "< floor(requested) =", floorRequested);
  });
});

describe("X10 — fix for #10: rescue cannot take collateral committed to pending withdrawals", { concurrency: 1 }, () => {
  it("rescueERC20 is floored by outstandingWithdrawalTotal; release still settles afterwards", async () => {
    const s = await deployStack(net, { kind: "erc20", ...FIXED });
    const amount = USDC(100);
    const { requestId } = await doDeposit(s, s.user, amount * 2n);
    await deliverMintSuccess(s, requestId, s.user);
    const w = await doWithdraw(s, 1, s.user, amount);
    const oldPortal = s.portal;
    await remount(s);
    assert.equal(await oldPortal.read.outstandingWithdrawalTotal(), amount);
    await expectRevert(() => oldPortal.write.rescueERC20([s.underlying.address, amount * 2n]), SEL.RescueExceedsFreeCollateral, "RescueExceedsFreeCollateral", "rescue full balance");
    await oldPortal.write.rescueERC20([s.underlying.address, amount]); // only the free part
    const r = await deliverSuccess(s, w.transferRequestId, s.user, oldPortal.address);
    assert.equal(r.callbackFailed, false);
    assert.equal((await withdrawal(s, w.withdrawalId, oldPortal)).status, WStatus.Released);
    assert.equal(await oldPortal.read.outstandingWithdrawalTotal(), 0n);
    log("X10: rescue limited to free collateral; pending withdrawal still paid");
  });
});

describe("X12 — fix for #12: unpartitionable windows rejected", { concurrency: 1 }, () => {
  it("setLimits rejects maxWithdraw < 2*minWithdraw-1 unless maxWithdraw == 0", async () => {
    const s = await deployStack(net, { kind: "erc20", ...FIXED });
    await expectRevert(() => s.portal.write.setLimits([1n, MAX128, USDC(100), USDC(150)]), SEL.InvalidLimitConfiguration, "InvalidLimitConfiguration", "(100,150)");
    await expectRevert(() => s.portal.write.setLimits([1n, MAX128, USDC(100), 2n * USDC(100) - 2n]), SEL.InvalidLimitConfiguration, "InvalidLimitConfiguration", "(100, 2*100-2 units)");
    await s.portal.write.setLimits([1n, MAX128, USDC(100), 2n * USDC(100) - 1n]); // exactly 2*min-1 base units: every balance >= min is splittable
    await s.portal.write.setLimits([1n, MAX128, 0n, 0n]); // documented "disable withdrawals" semantics kept (min must be 0 too, as before)
    log("X12: (100,150) rejected; (100, 2*100-1 units) and (0,0) accepted");
  });
});

describe("X13 — fix for #13: bounded wrap", { concurrency: 1 }, () => {
  it("wrapWithMaxFee reverts when the live floor exceeds the caller's bound", async () => {
    const s = await deployStack(net, { kind: "erc20", ...FIXED });
    const amount = USDC(100);
    await s.oracle.write.setTokenPriceUSD([s.wnative.address, ONE]);
    await s.oracle.write.setTokenPriceUSD([s.underlying.address, ONE]);
    await s.factory.write.grantRole([OPERATOR_ROLE, s.operator]);
    await s.factory.write.setDefaultDepositFee([0n, 10_000n, 10n * ONE]);
    await s.factory.write.setDefaultDepositFee([0n, 14_000n, 10n * ONE], { account: s.operator }); // front-run
    await expectRevert(() => s.portal.write.wrapWithMaxFee([s.user, amount, 100n, ONE], { account: s.user, value: ONE + ONE / 2n }), SEL.ExcessivePortalFee, "ExcessivePortalFee", "wrap above bound");
    const hash = await s.portal.write.wrapWithMaxFee([s.user, amount, 100n, (ONE * 14n) / 10n], { account: s.user, value: ONE + ONE / 2n });
    const rc = await s.client.waitForTransactionReceipt({ hash });
    const fees = parseEventLogs({ abi: s.portal.abi, logs: rc.logs, eventName: "OperationFeesPaid" })[0] as any;
    assert.equal(fees.args.portalFee, (ONE * 14n) / 10n);
    // Plain ERC-7984 `wrap` is still unbounded by default (integrators cannot pass a bound)...
    const h2 = await s.portal.write.wrap([s.user, amount, 100n], { account: s.user, value: ONE + ONE / 2n });
    const rc2 = await s.client.waitForTransactionReceipt({ hash: h2 });
    const fees2 = parseEventLogs({ abi: s.portal.abi, logs: rc2.logs, eventName: "OperationFeesPaid" })[0] as any;
    assert.equal(fees2.args.portalFee, (ONE * 14n) / 10n, "plain wrap still charges the live floor");
    // ...until the admin caps it.
    await s.portal.write.setMaxAutoWrapPortalFee([ONE]);
    await expectRevert(() => s.portal.write.wrap([s.user, amount, 100n], { account: s.user, value: ONE + ONE / 2n }), SEL.ExcessivePortalFee, "ExcessivePortalFee", "capped plain wrap");
    log("X13: wrapWithMaxFee bound enforced; plain wrap capped by maxAutoWrapPortalFee");
  });
});

describe("X14 — fix for #14: request ids are single-use", { concurrency: 1 }, () => {
  it("a colliding id after inbox rotation reverts; the old escrow and the stranded withdrawal are untouched", async () => {
    const s = await deployStack(net, { kind: "erc20", ...FIXED });
    const amount = USDC(100);
    const inbox1 = await currentInbox(s);
    const d1 = await doDeposit(s, s.user, amount);
    assert.equal(d1.requestId, await inbox1.read.getRequestId([LOCAL_CHAIN_ID, COTI_CHAIN_ID, 2n]));
    await deliverMintSuccess(s, d1.requestId, s.user);
    const w1 = await doWithdraw(s, 1, s.user, amount / 2n);
    const inbox2 = await s.viem.deployContract("MockInboxForPortal", []);
    await s.factory.write.configurePToken([s.pToken.address, inbox2.address, COTI_SIDE]);
    const d2 = await doDeposit(s, s.user2, USDC(10)); // nonce 1 on inbox2: never used before → fine
    assert.notEqual(d2.requestId, d1.requestId);
    // nonce 2 on inbox2 == D1's id → refused by the pToken before any portal state is written.
    await expectRevert(() => doDeposit(s, s.user2, USDC(10)), SEL.RequestIdAlreadyUsedP, "RequestIdAlreadyUsed", "colliding deposit");
    const e = await escrow(s, d1.requestId);
    assertAddr(e.user, s.user, "D1 escrow intact");
    assert.equal(e.amount, amount);
    assert.equal(await reqStatus(s, d1.requestId), Status.Success, "D1 stays Success");
    assert.equal(await reqStatus(s, w1.transferRequestId), Status.Pending, "W1 cannot be resurrected");
    await expectRevert(() => s.portal.write.triggerWithdrawalRelease([w1.withdrawalId], { account: s.stranger }), SEL.PTokenTransferNotSuccessful, "PTokenTransferNotSuccessful", "release of stranded W1");
    log("X14: collision refused; a fresh inbox cannot re-issue ids the pToken already holds");
  });

  it("burn-id collision (the unverified rev-2 sub-claim): the second burn with a reused id is refused", async () => {
    const s = await deployStack(net, { kind: "erc20", ...FIXED });
    const amount = USDC(100);
    const d = await doDeposit(s, s.user, amount);
    await deliverMintSuccess(s, d.requestId, s.user);
    const w = await doWithdraw(s, 1, s.user, amount);
    await deliverSuccess(s, w.transferRequestId, s.user, s.portal.address);
    assert.equal(await s.portal.read.pendingBurnAmount(), amount);
    const b1 = await s.portal.write.burnAccumulatedPTokens([amount / 4n, 100n], { value: 1000n }); // nonce 4 on inbox1
    await s.client.waitForTransactionReceipt({ hash: b1 });
    const inbox1 = await currentInbox(s);
    const burnId = (await inbox1.read.lastRequestId()) as Hex;
    assert.equal(await s.portal.read.burnInFlight([burnId]), amount / 4n);
    const inbox2 = await s.viem.deployContract("MockInboxForPortal", []);
    await s.factory.write.configurePToken([s.pToken.address, inbox2.address, COTI_SIDE]);
    // Advance inbox2 to nonce 3 so the next burn would be issued id nonce 4 == burnId.
    const dummy = { selector: "0x00000000", data: "0x", datatypes: [], datalens: [] } as any;
    for (let i = 0; i < 3; i++) await inbox2.write.sendOneWayMessage([COTI_CHAIN_ID, COTI_SIDE, dummy, "0x00000000"]);
    await expectRevert(() => s.portal.write.burnAccumulatedPTokens([amount / 4n, 100n], { value: 1000n }), SEL.RequestIdAlreadyUsedP, "RequestIdAlreadyUsed", "colliding burn");
    assert.equal(await s.portal.read.burnInFlightTotal(), amount / 4n, "no double count");
    log("X14b: colliding burn id refused; burnInFlightTotal not inflated");
  });
});
