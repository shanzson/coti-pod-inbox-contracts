import assert from "node:assert/strict";
import { network } from "hardhat";
import {
  keccak256,
  parseEventLogs,
  parseSignature,
  toFunctionSelector,
  toHex,
  zeroAddress,
  type Hex,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";

// ─────────────────────────────────────────────────────────────────────────────
// Shared fixture + helpers for the PrivacyPortal / PrivacyPortalFactory PoCs.
// Everything under test is the UNMODIFIED coti-contracts code (commit 8a0c4928...) reached through
// constructor-passthrough harnesses (see contracts/PortalHarnesses.sol). Only the inbox and the
// underlying ERC20s are stand-ins.
// ─────────────────────────────────────────────────────────────────────────────

export const COTI_CHAIN_ID = 7082400n;
export const LOCAL_CHAIN_ID = 31337n;
export const MAX128 = (1n << 128n) - 1n;
export const MAX96 = (1n << 96n) - 1n;
export const ONE = 10n ** 18n;
export const USDC = (n: number | bigint) => BigInt(n) * 10n ** 6n; // 6-decimal helper
export const OPERATOR_ROLE = keccak256(toHex("OPERATOR_ROLE")) as Hex;
export const ZERO32 = ("0x" + "0".repeat(64)) as Hex;
/// COTI-side mother address the pTokens trust (the mock inbox presents it as the authenticated peer).
export const COTI_SIDE = "0x00000000000000000000000000000000c0000071" as Hex;
export const HH_MNEMONIC = "test test test test test test test test test test test junk";

export const Status = { None: 0, Pending: 1, Success: 2, Failed: 3, SystemFailed: 4 } as const;
export const WStatus = { None: 0, TransferPending: 1, Released: 2, Failed: 3 } as const;
export const EStatus = { None: 0, Pending: 1, Failed: 2, Refunded: 3 } as const;

// Custom-error selectors (enums are uint8 in the ABI signature).
export const SEL = {
  OnlyMinter: toFunctionSelector("OnlyMinter(address)"),
  EthTransferFailed: toFunctionSelector("EthTransferFailed()"),
  WithdrawTransferNotFailed: toFunctionSelector("WithdrawTransferNotFailed(bytes32,uint8)"),
  WithdrawalNotPending: toFunctionSelector("WithdrawalNotPending(bytes32,uint8)"),
  PTokenTransferNotSuccessful: toFunctionSelector("PTokenTransferNotSuccessful(bytes32,uint8)"),
  RequestNotPending: toFunctionSelector("RequestNotPending(bytes32,uint8)"),
  RequestNotAged: toFunctionSelector("RequestNotAged(bytes32,uint64,uint64)"),
  PendingBurnTooLow: toFunctionSelector("PendingBurnTooLow(uint256,uint256)"),
  AddressBlacklisted: toFunctionSelector("AddressBlacklisted(address)"),
  WithdrawalsPaused: toFunctionSelector("WithdrawalsPaused()"),
  DepositsPaused: toFunctionSelector("DepositsPaused()"),
  DepositDisabled: toFunctionSelector("DepositDisabled()"),
  DepositMintNotFailed: toFunctionSelector("DepositMintNotFailed(bytes32,uint8)"),
  DepositEscrowInvalid: toFunctionSelector("DepositEscrowInvalid(bytes32,uint8)"),
  InsufficientPortalFee: toFunctionSelector("InsufficientPortalFee(uint256,uint256)"),
  IncorrectFee: toFunctionSelector("IncorrectFee(uint256,uint256)"),
  OnlyFactoryAdmin: toFunctionSelector("OnlyFactoryAdmin(address)"),
  WithdrawBelowMinimum: toFunctionSelector("WithdrawBelowMinimum()"),
  WithdrawExceedsMaximum: toFunctionSelector("WithdrawExceedsMaximum()"),
  DepositBelowMinimum: toFunctionSelector("DepositBelowMinimum()"),
  ExpectedPause: toFunctionSelector("ExpectedPause()"),
  ERC20InsufficientBalance: toFunctionSelector("ERC20InsufficientBalance(address,uint256,uint256)"),
  IssuerBlocked: toFunctionSelector("IssuerBlocked(address)"),
  TokenNotRegistered: toFunctionSelector("TokenNotRegistered(bytes32)"),
  OnlyInbox: toFunctionSelector("OnlyInbox(address)"),
  OldPortalNotPaused: toFunctionSelector("OldPortalNotPaused(address)"),
  FactoryNotConfigured: toFunctionSelector("FactoryNotConfigured()"),
  AccessControlUnauthorizedAccount: toFunctionSelector("AccessControlUnauthorizedAccount(address,bytes32)"),
} as const;

/// Matcher: the thrown error carries this custom error (by decoded name OR raw 4-byte selector).
export function isErr(sel: Hex, name: string) {
  return (e: unknown) => {
    const s = errText(e).toLowerCase();
    return s.includes(name.toLowerCase()) || s.includes(sel.slice(2).toLowerCase());
  };
}

export function errText(e: unknown): string {
  const parts: string[] = [String(e)];
  let c: any = e;
  let depth = 0;
  // Walk the viem cause chain: EDR puts the raw revert data on a nested cause.
  while (c && depth++ < 8) {
    for (const k of ["message", "shortMessage", "details", "data", "metaMessages"]) {
      const v = c[k];
      if (v === undefined || v === null) continue;
      parts.push(typeof v === "string" ? v : JSON.stringify(v));
    }
    c = c.cause;
  }
  return parts.filter(Boolean).join(" | ");
}

/// Run a write; return "NO_REVERT" or the error text.
export async function callErr(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "NO_REVERT";
  } catch (e) {
    return errText(e);
  }
}

/// Assert `fn` reverts with the given custom error.
export async function expectRevert(fn: () => Promise<unknown>, sel: Hex, name: string, label: string) {
  const err = await callErr(fn);
  assert.notEqual(err, "NO_REVERT", `${label}: expected revert ${name}`);
  assert.ok(isErr(sel, name)(err), `${label}: expected ${name} (${sel}) but got: ${err.slice(0, 400)}`);
  return err;
}

const SEL_NAMES: Record<string, string> = Object.fromEntries(Object.entries(SEL).map(([n, sel]) => [sel.slice(2).toLowerCase(), n]));

/// Human-readable revert summary: decoded custom-error name (by selector) + truncated raw data.
export function shortErr(err: string): string {
  const low = err.toLowerCase();
  for (const [sel, name] of Object.entries(SEL_NAMES)) {
    const i = low.indexOf(sel);
    if (i >= 0) {
      const raw = low.slice(i, i + 8 + 64 * 2);
      return `${name}(0x${sel}) data=0x${raw}${raw.length >= 136 ? "…" : ""}`;
    }
  }
  const m = err.match(/reverted with[^\n]*|custom error[^\n]*|Error: [^\n]*/i);
  return (m ? m[0] : err.split("\n")[0]).slice(0, 160);
}

/// Case-insensitive address equality.
export function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
export function assertAddr(actual: string, expected: string, msg: string) {
  assert.equal(actual.toLowerCase(), expected.toLowerCase(), msg);
}

// ─────────────────────────────────────────────────────────────────────────────
// Network + fixture
// ─────────────────────────────────────────────────────────────────────────────

export async function connectNet() {
  const conn = await network.connect({ network: "hardhat" });
  const client = await conn.viem.getPublicClient();
  const wallets = await conn.viem.getWalletClients();
  // `provider` is a prototype getter on the connection object; keep the object itself (a spread would drop it).
  return { conn, viem: conn.viem, provider: conn.provider, client, wallets };
}
export type Net = Awaited<ReturnType<typeof connectNet>>;

export type UnderlyingKind = "erc20" | "fot" | "native" | "blocklist";

export async function deployStack(net: Net, opts: { kind?: UnderlyingKind; feeBps?: bigint; adminIndex?: number } = {}) {
  const kind = opts.kind ?? "erc20";
  const { viem, wallets, client } = net;
  const adminW = wallets[opts.adminIndex ?? 0];
  const [, userW, user2W, operatorW, strangerW, rescueW] = wallets;
  const admin = adminW.account.address;
  const user = userW.account.address;
  const user2 = user2W.account.address;
  const operator = operatorW.account.address;
  const stranger = strangerW.account.address;
  const rescue = rescueW.account.address;
  const c = { client: { public: client, wallet: adminW } };

  const inbox = await viem.deployContract("MockInboxForPortal", [], c);
  const wnative = await viem.deployContract("MockWrappedNativeHarness", [], c);
  const oracle = await viem.deployContract("PortalFeeOracleHarness", [admin], c);
  const portalImpl = await viem.deployContract("PrivacyPortalHarness", [], c);
  const pTokenImpl = await viem.deployContract("PodErc20MintableInitializableHarness", [], c);
  const factory = await viem.deployContract(
    "PrivacyPortalFactoryHarness",
    [
      admin,
      inbox.address,
      COTI_CHAIN_ID,
      COTI_SIDE,
      pTokenImpl.address,
      portalImpl.address,
      admin, // feeRecipient
      rescue, // rescueRecipient
      wnative.address,
      oracle.address,
      0n, 0n, MAX128, // default deposit fee: fixed 0, 0 bps, max
      0n, 0n, MAX128, // default withdraw fee
    ],
    c
  );

  let underlyingAddr: Hex;
  let decimals = 6;
  let isNative = false;
  let underlying: any;
  if (kind === "erc20") {
    underlying = await viem.deployContract("MockERC20Harness", ["Mock USD", "mUSD", 6], c);
  } else if (kind === "fot") {
    underlying = await viem.deployContract("MockFeeOnTransferERC20Harness", ["Fee USD", "fUSD", 6, opts.feeBps ?? 500n], c);
  } else if (kind === "blocklist") {
    underlying = await viem.deployContract("IssuerBlocklistERC20", ["Issuer USD", "iUSD", 6], c);
  } else {
    underlying = wnative;
    decimals = 18;
    isNative = true;
  }
  underlyingAddr = underlying.address;

  await factory.write.createPortal([underlyingAddr, "pMock", "pMOCK", decimals, isNative]);
  const portalAddr = (await factory.read.portalForUnderlying([underlyingAddr])) as Hex;
  const pTokenAddr = (await factory.read.pTokenForUnderlying([underlyingAddr])) as Hex;
  const portal = await viem.getContractAt("PrivacyPortalHarness", portalAddr, c);
  const pToken = await viem.getContractAt("PodErc20MintableInitializableHarness", pTokenAddr, c);

  if (!isNative) {
    for (const who of [user, user2, stranger]) {
      await underlying.write.mint([who, USDC(1_000_000)]);
      await underlying.write.approve([portalAddr, USDC(1_000_000)], { account: who });
    }
  }

  const s = {
    net, viem, client, provider: net.conn.provider,
    adminW, userW, user2W, operatorW, strangerW, rescueW,
    admin, user, user2, operator, stranger, rescue,
    inbox, wnative, oracle, portalImpl, pTokenImpl, factory, underlying, portal, pToken,
    decimals, isNative,
    balanceNonce: 0n,
  };
  return s;
}
export type Stack = Awaited<ReturnType<typeof deployStack>>;

// ─────────────────────────────────────────────────────────────────────────────
// Flow helpers
// ─────────────────────────────────────────────────────────────────────────────

export async function receipt(s: Stack, hash: Hex) {
  return s.client.waitForTransactionReceipt({ hash });
}

/// Current inbox of the pToken (rotates in F14).
export async function currentInbox(s: Stack) {
  const addr = (await s.pToken.read.inbox()) as Hex;
  return s.viem.getContractAt("MockInboxForPortal", addr, { client: { public: s.client, wallet: s.adminW } });
}

/// ERC20 deposit; returns the mint request id (== escrow key) from DepositRequested.
export async function doDeposit(
  s: Stack,
  from: Hex,
  amount: bigint,
  o: { recipient?: Hex; portalFee?: bigint; cbFee?: bigint; mintBudget?: bigint; portal?: any } = {}
) {
  const portal = o.portal ?? s.portal;
  const portalFee = o.portalFee ?? 0n;
  const cbFee = o.cbFee ?? 100n;
  const mintBudget = o.mintBudget ?? 1000n;
  const hash = await portal.write.deposit([o.recipient ?? from, amount, portalFee, cbFee], {
    account: from,
    value: portalFee + mintBudget,
  });
  const rc = await receipt(s, hash);
  const ev = parseEventLogs({ abi: portal.abi, logs: rc.logs, eventName: "DepositRequested" });
  assert.equal(ev.length, 1, "DepositRequested emitted once");
  return { requestId: (ev[0] as any).args.mintRequestId as Hex, receipt: rc };
}

/// Native deposit (native-wrapped portal only).
export async function doDepositNative(s: Stack, from: Hex, amount: bigint, o: { portalFee?: bigint; cbFee?: bigint; mintBudget?: bigint } = {}) {
  const portalFee = o.portalFee ?? 0n;
  const cbFee = o.cbFee ?? 100n;
  const mintBudget = o.mintBudget ?? 1000n;
  const hash = await s.portal.write.depositNative([from, amount, portalFee, cbFee], { account: from, value: amount + portalFee + mintBudget });
  const rc = await receipt(s, hash);
  const ev = parseEventLogs({ abi: s.portal.abi, logs: rc.logs, eventName: "DepositRequested" });
  return { requestId: (ev[0] as any).args.mintRequestId as Hex, receipt: rc };
}

/// EIP-712 TransferPermit signed locally with the Hardhat default-mnemonic key of `ownerIndex`.
export async function signPermit(s: Stack, ownerIndex: number, pToken: any, spender: Hex, to: Hex, value: bigint, deadline: bigint) {
  const acct = mnemonicToAccount(HH_MNEMONIC, { addressIndex: ownerIndex });
  const expected = s.net.wallets[ownerIndex].account.address;
  assert.equal(acct.address.toLowerCase(), expected.toLowerCase(), "derived permit signer must be the wallet");
  const nonce = (await pToken.read.nonces([acct.address])) as bigint;
  const name = (await pToken.read.name()) as string;
  const sig = await acct.signTypedData({
    domain: { name, version: "1", chainId: Number(LOCAL_CHAIN_ID), verifyingContract: pToken.address },
    types: {
      TransferPermit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "TransferPermit",
    message: { owner: acct.address, spender, to, value, nonce, deadline },
  });
  const p = parseSignature(sig);
  const v = p.v !== undefined ? Number(p.v) : Number(p.yParity ?? 0) + 27;
  return { deadline, v, r: p.r, s: p.s, owner: acct.address as Hex };
}

export async function chainNow(s: Stack) {
  const b = await s.client.getBlock();
  return b.timestamp;
}

/// requestWithdrawWithPermit by wallet index `ownerIndex`; returns ids from WithdrawalRequested.
export async function doWithdraw(
  s: Stack,
  ownerIndex: number,
  recipient: Hex,
  amount: bigint,
  o: { portalFee?: bigint; transferFee?: bigint; cbFee?: bigint; portal?: any; pToken?: any } = {}
) {
  const portal = o.portal ?? s.portal;
  const pToken = o.pToken ?? s.pToken;
  const portalFee = o.portalFee ?? 0n;
  const transferFee = o.transferFee ?? 1000n;
  const cbFee = o.cbFee ?? 100n;
  const deadline = (await chainNow(s)) + 86_400n * 30n;
  const p = await signPermit(s, ownerIndex, pToken, portal.address, portal.address, amount, deadline);
  const hash = await portal.write.requestWithdrawWithPermit(
    [recipient, amount, portalFee, transferFee, cbFee, p.deadline, p.v, p.r, p.s],
    { account: p.owner, value: portalFee + transferFee }
  );
  const rc = await receipt(s, hash);
  const ev = parseEventLogs({ abi: portal.abi, logs: rc.logs, eventName: "WithdrawalRequested" });
  assert.equal(ev.length, 1, "WithdrawalRequested emitted once");
  const a = (ev[0] as any).args;
  return { withdrawalId: a.withdrawalId as Hex, transferRequestId: a.transferRequestId as Hex, receipt: rc };
}

/// Deliver a COTI success callback through the pToken's CURRENT inbox. Returns whether the pToken's
/// downstream `transferAndCall` hook (portal.onPTokenTransferred) failed (RequestCallbackFailed).
export async function deliverSuccess(s: Stack, requestId: Hex, from: Hex, to: Hex, o: { pToken?: any } = {}) {
  const pToken = o.pToken ?? s.pToken;
  const inbox = await currentInbox({ ...s, pToken } as Stack);
  const cotiSide = (await pToken.read.cotiSideContract()) as Hex;
  s.balanceNonce += 1n;
  const hash = await inbox.write.deliverTransferSuccess([pToken.address, COTI_CHAIN_ID, cotiSide, requestId, from, to, s.balanceNonce]);
  const rc = await receipt(s, hash);
  const failed = parseEventLogs({ abi: pToken.abi, logs: rc.logs, eventName: "RequestCallbackFailed" });
  return { receipt: rc, callbackFailed: failed.length > 0 };
}
export const deliverMintSuccess = (s: Stack, requestId: Hex, recipient: Hex, o: { pToken?: any } = {}) =>
  deliverSuccess(s, requestId, zeroAddress, recipient, o);

export async function deliverSystemError(s: Stack, requestId: Hex, code = 2n, message: Hex = "0x") {
  const inbox = await currentInbox(s);
  const hash = await inbox.write.deliverSystemError([s.pToken.address, COTI_CHAIN_ID, requestId, code, message]);
  return receipt(s, hash);
}

export async function deliverRaise(s: Stack, requestId: Hex, from: Hex, to: Hex, message: Hex = "0x") {
  const inbox = await currentInbox(s);
  const cotiSide = (await s.pToken.read.cotiSideContract()) as Hex;
  const hash = await inbox.write.deliverRaise([s.pToken.address, COTI_CHAIN_ID, cotiSide, requestId, from, to, message]);
  return receipt(s, hash);
}

export async function reqStatus(s: Stack, id: Hex, pToken: any = s.pToken): Promise<number> {
  const r = (await pToken.read.requests([id])) as { status: number };
  return Number(r.status);
}

export async function withdrawal(s: Stack, id: Hex, portal: any = s.portal) {
  const w = (await portal.read.withdrawals([id])) as readonly [Hex, Hex, bigint, Hex, number];
  return { user: w[0], recipient: w[1], amount: w[2], transferRequestId: w[3], status: Number(w[4]) };
}

export async function escrow(s: Stack, id: Hex, portal: any = s.portal) {
  const e = (await portal.read.depositEscrows([id])) as readonly [Hex, Hex, bigint, number];
  return { user: e[0], recipient: e[1], amount: e[2], status: Number(e[3]) };
}

export async function warp(s: Stack, seconds: number) {
  await s.provider.request({ method: "evm_increaseTime", params: [seconds] });
  await s.provider.request({ method: "evm_mine", params: [] });
}

export async function snapshot(s: Stack): Promise<string> {
  return (await s.provider.request({ method: "evm_snapshot", params: [] })) as string;
}
export async function revertTo(s: Stack, id: string) {
  const ok = await s.provider.request({ method: "evm_revert", params: [id] });
  assert.equal(ok, true, "evm_revert must succeed");
}

export async function bal(s: Stack, token: any, who: Hex): Promise<bigint> {
  return (await token.read.balanceOf([who])) as bigint;
}

/// Same-factory remount (the documented upgrade path): pause old portal → createPortalWithExistingPToken.
export async function remount(s: Stack, o: { pause?: boolean } = {}) {
  if (o.pause ?? true) await s.portal.write.pause();
  await s.factory.write.createPortalWithExistingPToken([s.underlying.address, s.pToken.address, s.isNative]);
  const newAddr = (await s.factory.read.portalForUnderlying([s.underlying.address])) as Hex;
  const newPortal = await s.viem.getContractAt("PrivacyPortalHarness", newAddr, { client: { public: s.client, wallet: s.adminW } });
  return newPortal;
}

export function log(...a: unknown[]) {
  console.log("     ·", ...a);
}
