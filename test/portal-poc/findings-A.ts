import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseEventLogs, zeroAddress, type Hex } from "viem";
import {
  COTI_SIDE, LOCAL_CHAIN_ID, MAX96, MAX128, OPERATOR_ROLE, ONE, USDC, SEL, Status, WStatus, EStatus,
  connectNet, deployStack, doDeposit, doDepositNative, doWithdraw, deliverSuccess, deliverMintSuccess,
  reqStatus, withdrawal, escrow, warp, snapshot, revertTo, bal, remount, expectRevert, callErr, shortErr,
  currentInbox, log, isErr, assertAddr,
} from "./helpers.ts";

// ─────────────────────────────────────────────────────────────────────────────
// PoCs for findings #1–#7 of the Pashov solidity-auditor report on PrivacyPortal /
// PrivacyPortalFactory @ coti-contracts 8a0c4928004dac7a6c8d50bde58a022b6912f963.
// Every contract under test is the real one (see contracts/PortalHarnesses.sol).
// Run: SOLC_NATIVE=<solc 0.8.28> npx hardhat --config hardhat.config.portal-poc.ts test test/portal-poc/findings-A.ts
// ─────────────────────────────────────────────────────────────────────────────

const net = await connectNet();

describe("F1 — withdrawal stuck after pToken transfer Success when payout reverts", { concurrency: 1 }, () => {
  it("F1a native portal: recipient rejects ETH → release reverts forever; cancel/kill unavailable; pTokens uncounted", async () => {
    const s = await deployStack(net, { kind: "native" });
    const amount = ONE; // 1 native

    // User deposits 1 native (wrapped in-contract) and the COTI mint settles Success.
    const { requestId } = await doDepositNative(s, s.user, amount);
    await deliverMintSuccess(s, requestId, s.user);
    assert.equal(await reqStatus(s, requestId), Status.Success);

    // Withdraw to a contract that cannot receive ETH (no receive/fallback).
    const rejecter = await s.viem.deployContract("RejectEthReceiverHarness", []);
    const { withdrawalId, transferRequestId } = await doWithdraw(s, 1, rejecter.address, amount);
    assert.equal((await withdrawal(s, withdrawalId)).status, WStatus.TransferPending);

    // COTI leg settles: pToken marks Success, then calls portal.onPTokenTransferred → _releaseWithdrawal
    // → WETH.withdraw + ETH send to the rejecter → revert → swallowed by the pToken (RequestCallbackFailed).
    const { callbackFailed, receipt: cbReceipt } = await deliverSuccess(s, transferRequestId, s.user, s.portal.address);
    assert.equal(callbackFailed, true, "portal hook must have failed (RequestCallbackFailed)");
    // The revert happened inside `address(to).call(callbackData)` (PodERC20.sol:367), a low-level call whose failure is
    // swallowed. The OUTER transaction (the inbox delivery) therefore SUCCEEDED and its state changes persisted:
    assert.equal(cbReceipt.status, "success", "the callback-delivery transaction did NOT revert");
    const statusEvents = parseEventLogs({ abi: s.pToken.abi, logs: cbReceipt.logs, eventName: "RequestStatusUpdated" }) as any[];
    assert.equal(statusEvents.length, 1);
    assert.equal(Number(statusEvents[0].args.status), Status.Success, "RequestStatusUpdated(Success) was written in that same tx");
    const hookFailed = parseEventLogs({ abi: s.pToken.abi, logs: cbReceipt.logs, eventName: "RequestCallbackFailed" }) as any[];
    assert.equal(hookFailed.length, 1, "RequestCallbackFailed emitted in that same tx");
    log("F1a callback-delivery tx status:", cbReceipt.status, "| events:", [...statusEvents, ...hookFailed].map((e) => e.eventName).join(", "));
    assert.equal(await reqStatus(s, transferRequestId), Status.Success, "pToken transfer is terminal Success");
    assert.equal((await withdrawal(s, withdrawalId)).status, WStatus.TransferPending, "withdrawal still TransferPending");

    // (1) permissionless release reverts, forever (recipient cannot change).
    const e1 = await expectRevert(() => s.portal.write.triggerWithdrawalRelease([withdrawalId], { account: s.stranger }), SEL.EthTransferFailed, "EthTransferFailed", "triggerWithdrawalRelease");
    // (2) cancel needs Failed/SystemFailed — the request is Success.
    await expectRevert(() => s.portal.write.cancelFailedWithdrawal([withdrawalId]), SEL.WithdrawTransferNotFailed, "WithdrawTransferNotFailed", "cancelFailedWithdrawal");
    // (3) admin kill needs Pending — the request is Success (even after the 1-day kill age).
    await warp(s, 2 * 86_400);
    await expectRevert(() => s.factory.write.killPTokenStaleRequest([s.pToken.address, transferRequestId]), SEL.RequestNotPending, "RequestNotPending", "killPTokenStaleRequest");
    // (4) the custodied pTokens are not counted: pendingBurnAmount is only bumped inside the reverting release.
    assert.equal(await s.portal.read.pendingBurnAmount(), 0n);
    await expectRevert(() => s.portal.write.burnAccumulatedPTokens([amount, 100n], { value: 1000n }), SEL.PendingBurnTooLow, "PendingBurnTooLow", "burnAccumulatedPTokens");
    // (5) no portal function can re-target a withdrawal: the only withdrawalId-taking entry points are these three.
    const fns = (s.portal.abi as any[]).filter((i) => i.type === "function" && i.inputs.some((x: any) => x.name === "withdrawalId")).map((i) => i.name).sort();
    assert.deepEqual(fns, ["cancelFailedWithdrawal", "onPTokenTransferred", "triggerWithdrawalRelease"]);
    // (6) collateral is still inside the portal; only the admin catastrophe path can move it — to rescueRecipient, not the user.
    assert.equal(await bal(s, s.wnative, s.portal.address), amount);
    await s.portal.write.pause();
    await s.portal.write.rescueERC20([s.wnative.address, amount]);
    assert.equal(await bal(s, s.wnative, s.rescue), amount);
    log("F1a release revert:", shortErr(e1));
    log("F1a state: transfer=Success, withdrawal=TransferPending, pendingBurnAmount=0, kill/cancel impossible");
  });

  it("F1b ERC-20 portal: issuer blocklists the recipient AFTER the request → identical permanent stuck state", async () => {
    const s = await deployStack(net, { kind: "blocklist" });
    const amount = USDC(100);
    const { requestId } = await doDeposit(s, s.user, amount);
    await deliverMintSuccess(s, requestId, s.user);

    const { withdrawalId, transferRequestId } = await doWithdraw(s, 1, s.user2, amount);
    // Recipient was fine at request time; the token issuer blocks it while the COTI leg is in flight.
    await s.underlying.write.setBlocked([s.user2, true]);

    const { callbackFailed } = await deliverSuccess(s, transferRequestId, s.user, s.portal.address);
    assert.equal(callbackFailed, true);
    assert.equal(await reqStatus(s, transferRequestId), Status.Success);
    await expectRevert(() => s.portal.write.triggerWithdrawalRelease([withdrawalId], { account: s.stranger }), SEL.IssuerBlocked, "IssuerBlocked", "release to issuer-blocked recipient");
    await expectRevert(() => s.portal.write.cancelFailedWithdrawal([withdrawalId]), SEL.WithdrawTransferNotFailed, "WithdrawTransferNotFailed", "cancel");
    assert.equal(await s.portal.read.pendingBurnAmount(), 0n);
    assert.equal(await bal(s, s.underlying, s.portal.address), amount, "collateral remains locked in the portal");
    log("F1b: recipient blocked by issuer after request → user has neither pTokens (in portal custody on COTI) nor collateral");
  });
});

describe("F2 — blacklist / pause are not enforced on the collateral-release leg", { concurrency: 1 }, () => {
  it("withdrawal requested before listing pays a blacklisted recipient from a paused portal (callback + permissionless trigger)", async () => {
    const s = await deployStack(net, { kind: "erc20" });
    const amount = USDC(100);
    const { requestId } = await doDeposit(s, s.user, amount * 2n);
    await deliverMintSuccess(s, requestId, s.user);

    // Two withdrawals to `user2`, both requested while user2 is clean.
    const w1 = await doWithdraw(s, 1, s.user2, amount);
    const w2 = await doWithdraw(s, 1, s.user2, amount);

    // Admin now blacklists user2 (factory + portal lists) — new requests naming user2 are rejected...
    await s.factory.write.addToBlacklist([s.user2]);
    await s.portal.write.addToBlacklist([s.user2]);
    await expectRevert(() => doWithdraw(s, 1, s.user2, amount), SEL.AddressBlacklisted, "AddressBlacklisted", "new request for a blacklisted recipient");
    // ...and pauses both the portal instance and the whole factory.
    await s.portal.write.pause();
    await s.factory.write.pause();
    assert.equal(await s.portal.read.paused(), true);
    assert.equal(await s.factory.read.paused(), true);
    await expectRevert(() => doWithdraw(s, 1, s.user, amount), SEL.WithdrawalsPaused, "WithdrawalsPaused", "new request while paused");

    // (a) Release via the pToken callback path: the COTI leg settles → portal pays the blacklisted recipient while paused.
    const before = await bal(s, s.underlying, s.user2);
    const r1 = await deliverSuccess(s, w1.transferRequestId, s.user, s.portal.address);
    assert.equal(r1.callbackFailed, false, "release leg executed inside the callback");
    assert.equal(await bal(s, s.underlying, s.user2), before + amount, "blacklisted recipient received collateral");
    assert.equal((await withdrawal(s, w1.withdrawalId)).status, WStatus.Released);

    // (b) Release via the permissionless trigger. Make the callback fail once (drain collateral while paused,
    //     exactly the documented migration step) so that the withdrawal stays TransferPending with status Success.
    const portalBal = await bal(s, s.underlying, s.portal.address);
    await s.portal.write.rescueERC20([s.underlying.address, portalBal]);
    const r2 = await deliverSuccess(s, w2.transferRequestId, s.user, s.portal.address);
    assert.equal(r2.callbackFailed, true);
    assert.equal(await reqStatus(s, w2.transferRequestId), Status.Success);
    // Refund the portal (rescue recipient sends the collateral back) — a stranger then releases to the blacklisted user2.
    await s.underlying.write.transfer([s.portal.address, portalBal], { account: s.rescue });
    await s.portal.write.triggerWithdrawalRelease([w2.withdrawalId], { account: s.stranger });
    assert.equal(await bal(s, s.underlying, s.user2), before + 2n * amount, "second payout to the blacklisted recipient while paused");
    assert.equal(await s.portal.read.paused(), true);
    assert.equal(await s.factory.read.blacklisted([s.user2]), true);
    log("F2: 2 payouts to a blacklisted recipient from a paused portal; only request-time checks exist");
  });
});

describe("F3 — remount rotates the minter: retired portal's adminRefundPendingDeposit reverts OnlyMinter", { concurrency: 1 }, () => {
  it("refund reverts after remount; recovery only via 1-day kill age, kill-age reset, or a minter swap back", async () => {
    const s = await deployStack(net, { kind: "erc20" });
    const amount = USDC(100);
    const { requestId } = await doDeposit(s, s.user, amount);
    assert.equal(await reqStatus(s, requestId), Status.Pending, "mint callback never delivered");
    assert.equal((await escrow(s, requestId)).status, EStatus.Pending);

    // Documented upgrade path: pause old portal → createPortalWithExistingPToken → minter moves to the new clone.
    const oldPortal = s.portal;
    const newPortal = await remount(s);
    assertAddr(await s.pToken.read.minter(), newPortal.address, "minter rotated");
    assertAddr(await oldPortal.read.factory(), zeroAddress, "old portal detached");
    assert.equal(await oldPortal.read.paused(), true);
    assert.equal(await bal(s, s.underlying, oldPortal.address), amount, "escrowed collateral stays on the old portal");

    // The admin refund on the retired portal is bricked: pToken.invalidatePendingRequest is minter-gated.
    const e = await expectRevert(() => oldPortal.write.adminRefundPendingDeposit([requestId]), SEL.OnlyMinter, "OnlyMinter", "adminRefundPendingDeposit after remount");
    log("F3 adminRefundPendingDeposit:", shortErr(e));
    // The permissionless refund cannot substitute (needs SystemFailed, request is Pending).
    await expectRevert(() => oldPortal.write.refundFailedDeposit([requestId], { account: s.stranger }), SEL.DepositMintNotFailed, "DepositMintNotFailed", "refundFailedDeposit");
    // The new portal does not know the escrow at all.
    await expectRevert(() => newPortal.write.adminRefundPendingDeposit([requestId]), SEL.DepositEscrowInvalid, "DepositEscrowInvalid", "new portal refund");

    // Recovery path A: admin kill of the stale request — gated by requestKillMinAge (1 day default).
    const snap = await snapshot(s);
    await expectRevert(() => s.factory.write.killPTokenStaleRequest([s.pToken.address, requestId]), SEL.RequestNotAged, "RequestNotAged", "kill before min age");
    await warp(s, 86_400 + 1);
    await s.factory.write.killPTokenStaleRequest([s.pToken.address, requestId]);
    assert.equal(await reqStatus(s, requestId), Status.Failed);
    const b0 = await bal(s, s.underlying, s.user);
    await oldPortal.write.adminRefundPendingDeposit([requestId]);
    assert.equal(await bal(s, s.underlying, s.user), b0 + amount, "refund works once the request is terminal");
    await revertTo(s, snap);

    // Recovery path B: undocumented minter swap back to the retired portal (leaves the live portal unable to mint meanwhile).
    const snap2 = await snapshot(s);
    await s.factory.write.setPTokenMinter([s.pToken.address, oldPortal.address]);
    await oldPortal.write.adminRefundPendingDeposit([requestId]);
    assert.equal(await reqStatus(s, requestId), Status.Failed);
    assert.equal((await escrow(s, requestId)).status, EStatus.Refunded);
    await s.factory.write.setPTokenMinter([s.pToken.address, newPortal.address]);
    await revertTo(s, snap2);

    // Recovery path C: drop the kill age to 0 first (factory forwarder), then kill immediately.
    await s.factory.write.setPTokenRequestKillMinAge([s.pToken.address, 0n]);
    await s.factory.write.killPTokenStaleRequest([s.pToken.address, requestId]);
    await oldPortal.write.adminRefundPendingDeposit([requestId]);
    assert.equal((await escrow(s, requestId)).status, EStatus.Refunded);
    log("F3: refund bricked by OnlyMinter; all three recovery paths are admin-only and outside the documented refund flow");
  });
});

describe("F4 — cross-factory remount skips every old-portal guard", { concurrency: 1 }, () => {
  it("old portal stays unpaused/undetached and keeps paying withdrawals while the minter is rotated to a second factory's clone", async () => {
    const s = await deployStack(net, { kind: "erc20" });
    const amount = USDC(100);
    const { requestId } = await doDeposit(s, s.user, amount * 3n);
    await deliverMintSuccess(s, requestId, s.user);
    const portalA = s.portal;

    // A second factory (different admin: wallets[2]) — the documented `transferPTokenOwnership → remount on the new factory` path.
    const admin2 = s.user2;
    const f2 = await s.viem.deployContract(
      "PrivacyPortalFactoryHarness",
      [admin2, s.inbox.address, 7082400n, COTI_SIDE, s.pTokenImpl.address, s.portalImpl.address, admin2, admin2, s.wnative.address, s.oracle.address, 0n, 0n, MAX128, 0n, 0n, MAX128],
      { client: { public: s.client, wallet: s.adminW } }
    );
    await s.factory.write.transferPTokenOwnership([s.pToken.address, f2.address]);
    assertAddr(await s.pToken.read.owner(), f2.address, "pToken owned by F2");

    // Same-factory remount would revert OldPortalNotPaused; the cross-factory path has no such check.
    assert.equal(await portalA.read.paused(), false);
    await f2.write.createPortalWithExistingPToken([s.underlying.address, s.pToken.address, false], { account: admin2 });
    const portalBAddr = (await f2.read.portalForUnderlying([s.underlying.address])) as Hex;
    const portalB = await s.viem.getContractAt("PrivacyPortalHarness", portalBAddr, { client: { public: s.client, wallet: s.user2W } });

    // Guards that a same-factory remount applies were all skipped:
    assertAddr(await s.pToken.read.minter(), portalBAddr, "minter rotated to B");
    assert.equal(await portalA.read.paused(), false, "A was never paused");
    assert.equal(await portalA.read.isDepositEnabled(), true, "A still advertises deposits");
    assertAddr(await portalA.read.factory(), s.factory.address, "A not detached (retireDepositsForUpgrade never called)");
    assert.equal(await portalB.read.paused(), true);

    // A's deposits now revert deep inside the pToken (OnlyMinter) although every UI flag says "open".
    await expectRevert(() => doDeposit(s, s.user, amount), SEL.OnlyMinter, "OnlyMinter", "deposit on A after cross-factory remount");
    // A still serves withdrawals against its own collateral.
    const w = await doWithdraw(s, 1, s.user, amount);
    const r = await deliverSuccess(s, w.transferRequestId, s.user, portalA.address);
    assert.equal(r.callbackFailed, false);
    assert.equal((await withdrawal(s, w.withdrawalId)).status, WStatus.Released);
    // F2's admin cannot close A (auth is A.bindingFactory == F1); F1's admin can, but F1 was never told.
    await expectRevert(() => portalA.write.pause({ account: admin2 }), SEL.OnlyFactoryAdmin, "OnlyFactoryAdmin", "F2 admin pausing A");
    // B can be opened by F2's admin with zero collateral: a withdrawal on B is accepted and its release then reverts (F1 shape).
    await portalB.write.unpause({ account: admin2 });
    const wB = await doWithdraw(s, 1, s.user, amount, { portal: portalB });
    const rB = await deliverSuccess(s, wB.transferRequestId, s.user, portalBAddr);
    assert.equal(rB.callbackFailed, true, "B has no collateral: release reverts");
    assert.equal(await reqStatus(s, wB.transferRequestId), Status.Success);
    await expectRevert(() => portalB.write.triggerWithdrawalRelease([wB.withdrawalId]), SEL.ERC20InsufficientBalance, "ERC20InsufficientBalance", "release on B");
    log("F4: one pToken supply, two live portals (A unpaused on F1, B unpaused on F2), minter on B, collateral on A");
  });
});

describe("F5 — createPortal returns a live, deposit-enabled portal before COTI registration", { concurrency: 1 }, () => {
  it("deposits are accepted immediately; the registration message is one-way; the mother rejects the unregistered token", async () => {
    const s = await deployStack(net, { kind: "erc20" });
    // Right after createPortal: open for deposits.
    assert.equal(await s.portal.read.paused(), false);
    assert.equal(await s.portal.read.isDepositEnabled(), true);
    // The registration is a one-way message with no error selector (nothing can report a failure back).
    const inbox = await currentInbox(s);
    const regId = (await inbox.read.getRequestId([LOCAL_CHAIN_ID, 7082400n, 1n])) as Hex;
    const sent = (await inbox.read.sent([regId])) as readonly [bigint, Hex, Hex, Hex, Hex, bigint, bigint, boolean];
    assertAddr(sent[1], COTI_SIDE, "registration targets the mother");
    assert.equal(sent[7], false, "one-way");
    assert.equal(sent[4], "0x00000000", "no error selector");

    // A user deposits before registration has landed on COTI: collateral locked, mint Pending.
    const amount = USDC(100);
    const { requestId } = await doDeposit(s, s.user, amount);
    assert.equal(await reqStatus(s, requestId), Status.Pending);
    assert.equal(await bal(s, s.underlying, s.portal.address), amount);
    await expectRevert(() => s.portal.write.refundFailedDeposit([requestId], { account: s.stranger }), SEL.DepositMintNotFailed, "DepositMintNotFailed", "refund while Pending");

    // COTI half, on the REAL PodErc20CotiMother: the mint for an unregistered pToken reverts TokenNotRegistered.
    const mockM = await s.viem.deployContract("MockInboxForMother", []);
    const mother = await s.viem.deployContract("PodErc20CotiMotherHarness", [mockM.address, s.admin]);
    await s.provider.request({ method: "hardhat_impersonateAccount", params: [mockM.address] });
    await s.provider.request({ method: "hardhat_setBalance", params: [mockM.address, "0x3635c9adc5dea00000"] });
    await mother.write.setAllowedFactory([LOCAL_CHAIN_ID, s.factory.address, true]);
    await mockM.write.setContext([LOCAL_CHAIN_ID, s.pToken.address]);
    const e = await expectRevert(() => mother.write.mintPublic([s.user, amount], { account: mockM.address }), SEL.TokenNotRegistered, "TokenNotRegistered", "mother mint before registerToken");
    log("F5 mother.mintPublic before registration:", shortErr(e));
    // Once the (one-way) registration executes, the same mint passes the registration gate.
    await mockM.write.setContext([LOCAL_CHAIN_ID, s.factory.address]);
    await mother.write.registerToken([s.pToken.address, "pMock", "pMOCK", 6], { account: mockM.address });
    await mockM.write.setContext([LOCAL_CHAIN_ID, s.pToken.address]);
    const after = await callErr(() => mother.write.mintPublic([s.user, amount], { account: mockM.address }));
    assert.ok(!isErr(SEL.TokenNotRegistered, "TokenNotRegistered")(after), "after registration the gate no longer blocks (MPC-layer revert only on a node without the precompile)");
    // Until then the user's collateral is refundable only by an admin, and only after pausing the portal.
    await expectRevert(() => s.portal.write.adminRefundPendingDeposit([requestId]), SEL.ExpectedPause, "ExpectedPause", "admin refund needs pause");
    log("F5: deposit accepted pre-registration; refund path = pause + admin only (NatSpec documents this as PP-02/PP-14)");
  });
});

describe("F6 — remount path performs no in-flight escrow check (factory side of F3); shipped mocks cannot observe it", { concurrency: 1 }, () => {
  it("setMinter runs with a Pending escrow on the old portal; repo mocks lack the minter gate", async () => {
    const s = await deployStack(net, { kind: "erc20" });
    const { requestId } = await doDeposit(s, s.user, USDC(100));
    assert.equal((await escrow(s, requestId)).status, EStatus.Pending);
    // No revert: the factory never inspects the retiring portal's escrows.
    const newPortal = await remount(s);
    assertAddr(await s.pToken.read.minter(), newPortal.address, "minter rotated");
    // Note: escrows are never marked terminal on mint Success either, so "pendingEscrowCount" is not derivable on-chain today.

    // Repo mock used by the remount tests has no invalidatePendingRequest at all → the OnlyMinter path is untestable there.
    const mockMintable = await s.viem.deployContract("MockPodErc20MintableForPortalHarness", []);
    const sel = "0x" + (await import("viem")).toFunctionSelector("invalidatePendingRequest(bytes32)").slice(2) + requestId.slice(2);
    let mockReverted = false;
    try {
      await s.client.call({ to: mockMintable.address, data: sel as Hex });
    } catch {
      mockReverted = true;
    }
    assert.equal(mockReverted, true, "MockPodErc20MintableForPortal has no invalidatePendingRequest");
    // The other repo mock has invalidatePendingRequest but no minter gate: any caller can invalidate.
    const mockPod = await s.viem.deployContract("MockPodERC20ForPortalHarness", []);
    await mockPod.write.mint([s.user, 1n, 1n], { account: s.stranger, value: 1n });
    const id = (await mockPod.read.lastMintRequestId()) as Hex;
    await mockPod.write.invalidatePendingRequest([id], { account: s.stranger });
    assert.equal(Number(((await mockPod.read.requests([id])) as any).status), Status.Failed);
    log("F6: remount ok with Pending escrow; mocks: no function / no gate → suite cannot catch F3");
  });
});

describe("F7 — OPERATOR_ROLE can freeze withdrawals through a uint96 fixedFee floor, with no pause", { concurrency: 1 }, () => {
  it("operator (not admin) sets fixedFee = 2^96-1 per portal or factory-wide; every withdrawal reverts; paused() stays false", async () => {
    const s = await deployStack(net, { kind: "erc20" });
    const amount = USDC(100);
    const { requestId } = await doDeposit(s, s.user, amount);
    await deliverMintSuccess(s, requestId, s.user);
    await s.factory.write.grantRole([OPERATOR_ROLE, s.operator]);
    // The operator is explicitly not an admin: it cannot pause.
    await expectRevert(() => s.portal.write.pause({ account: s.operator }), SEL.OnlyFactoryAdmin, "OnlyFactoryAdmin", "operator pause");
    await expectRevert(() => s.factory.write.pause({ account: s.operator }), SEL.AccessControlUnauthorizedAccount, "AccessControlUnauthorizedAccount", "operator factory pause");

    // Per-portal override: packFeeConfig only caps bps (10%) — fixedFee is bounded by uint96 only.
    await s.portal.write.setWithdrawFee([MAX96, 0n, MAX96], { account: s.operator });
    const e = await expectRevert(() => doWithdraw(s, 1, s.user, amount), SEL.InsufficientPortalFee, "InsufficientPortalFee", "withdraw under uint96 floor");
    log("F7 per-portal:", shortErr(e));
    assert.equal(await s.portal.read.paused(), false);
    assert.equal(await s.factory.read.paused(), false);
    // Rescue is NOT enabled by this (needs paused): it is a freeze, not a theft.
    await expectRevert(() => s.portal.write.rescueERC20([s.underlying.address, 1n]), SEL.ExpectedPause, "ExpectedPause", "rescue while unpaused");

    // Factory-wide in one call: every portal without an override inherits it.
    await s.portal.write.clearWithdrawFeeOverride({ account: s.operator });
    await s.factory.write.setDefaultWithdrawFee([MAX96, 0n, MAX96], { account: s.operator });
    await expectRevert(() => doWithdraw(s, 1, s.user, amount), SEL.InsufficientPortalFee, "InsufficientPortalFee", "withdraw under factory-wide floor");
    // Withdrawals resume only when the fee is lowered again (any admin/operator).
    await s.factory.write.setDefaultWithdrawFee([0n, 0n, MAX128], { account: s.operator });
    const w = await doWithdraw(s, 1, s.user, amount);
    assert.equal((await withdrawal(s, w.withdrawalId)).status, WStatus.TransferPending);
    log("F7: floor = 2^96-1 wei (~7.9e28) blocks all withdrawals; no Paused event; role model reserves emergency stop for admin");
  });
});
