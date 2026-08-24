/**
 * Executable PoCs for the audit findings on the InboxBase inheritance chain.
 * Rev 2 — fixes revert-reason extraction, fee staging, and PoC 3's parameter.
 *
 * Run: npx hardhat test test/PocAuditFindings.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toHex } from "viem";
import { network } from "hardhat";
import { oracleTokensForChain } from "../scripts/oracle-tokens.js";
import { deployTestInbox, mpcAbiReEncodeOf, feeManagerOf } from "../scripts/deploy-test-inbox.js";

const wait = { timeout: 300_000, pollingInterval: 500 };
const SRC = 1000n;
const DST = 1001n;
const GP = 1_000_000_000n;
const P18 = 10n ** 18n;
/** EDR rejects tx gas above 2**24 (16,777,216). */
const MAX_TX_GAS = 16_000_000n;

/** Walk viem's whole cause chain — the real revert lives in `details`, not `shortMessage`. */
function revertReason(e: any): string {
  const parts: string[] = [];
  const seen = new Set<any>();
  let cur = e;
  while (cur && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur);
    for (const k of ["shortMessage", "details", "message"]) {
      const v = cur[k];
      if (typeof v === "string" && v && !parts.includes(v)) parts.push(v);
    }
    if (Array.isArray(cur.metaMessages)) parts.push(cur.metaMessages.join(" "));
    cur = cur.cause;
  }
  const all = parts.join(" | ");
  const m = all.match(/custom error '([^']+)'/) ?? all.match(/reverted with reason string '([^']+)'/);
  return m ? m[1] : all.slice(0, 160);
}

const VAR_FEE = {
  constantFee: 0n, gasPerByte: 800n, callbackExecutionGas: 100_000n, errorLength: 256n,
  bufferRatioX10000: 5000n, maxMethodCallBytes: 8192n, maxExecutionGas: 5_000_000n,
  gasPriceMul: 1n, gasPriceDiv: 1n,
} as const;

const CONST_FEE = {
  constantFee: 1n, gasPerByte: 0n, callbackExecutionGas: 0n, errorLength: 0n,
  bufferRatioX10000: 0n, maxMethodCallBytes: 8192n, maxExecutionGas: 5_000_000n,
  gasPriceMul: 1n, gasPriceDiv: 1n,
} as const;

const mc = (dataHex: `0x${string}` = "0x") => ({
  selector: "0x00000000" as `0x${string}`,
  data: dataHex,
  datatypes: [] as `0x${string}`[],
  datalens: [] as `0x${string}`[],
});

const RESULTS: string[] = [];
const verdict = (n: number, name: string, v: string, detail: string) => {
  const line = `[PoC ${String(n).padStart(2)}] ${v.padEnd(15)} ${name}\n            ${detail}`;
  RESULTS.push(line);
  console.log("\n" + line);
};

async function connect() {
  const { viem } = await network.connect({ network: "hardhat" });
  const publicClient = await viem.getPublicClient();
  const [wallet] = await viem.getWalletClients();
  const deployer = wallet.account.address as `0x${string}`;
  return { viem, publicClient, wallet, deployer };
}

async function deployPair(fee: any = CONST_FEE, localUsd = P18, remoteUsd = P18) {
  const env = await connect();
  const { viem, publicClient, wallet, deployer } = env;
  const cli = { client: { public: publicClient, wallet } };

  const source = await deployTestInbox(viem, cli);
  await source.write.init([deployer, SRC, mpcAbiReEncodeOf(source), feeManagerOf(source)], { account: deployer });
  await source.write.updateMinFeeConfigs([{ ...fee }, { ...fee }], { account: deployer });
  await source.write.addMiner([deployer], { account: deployer });

  const target = await deployTestInbox(viem, cli);
  await target.write.init([deployer, DST, mpcAbiReEncodeOf(target), feeManagerOf(target)], { account: deployer });
  await target.write.updateMinFeeConfigs([{ ...fee }, { ...fee }], { account: deployer });
  await target.write.addMiner([deployer], { account: deployer });

  const oracle = await viem.deployContract("PriceOracle", [deployer], cli);
  const { localToken, remoteToken } = oracleTokensForChain(31337);
  await oracle.write.setInboxTokens([localToken, remoteToken], { account: deployer });
  await oracle.write.setLocalTokenPriceUSD([localUsd], { account: deployer });
  await oracle.write.setRemoteTokenPriceUSD([remoteUsd], { account: deployer });
  await source.write.setPriceOracle([oracle.address], { account: deployer });
  await target.write.setPriceOracle([oracle.address], { account: deployer });
  await source.write.setGasPriceBounds([0n, GP, GP], { account: deployer });
  await target.write.setGasPriceBounds([0n, GP, GP], { account: deployer });

  return { ...env, cli, source, target, oracle };
}

const toMined = (r: any) => ({
  requestId: r.requestId as `0x${string}`,
  sourceContract: r.originalSender as `0x${string}`,
  targetContract: r.targetContract as `0x${string}`,
  methodCall: r.methodCall,
  callbackSelector: r.callbackSelector as `0x${string}`,
  errorSelector: r.errorSelector as `0x${string}`,
  isTwoWay: r.isTwoWay as boolean,
  sourceRequestId: r.sourceRequestId as `0x${string}`,
  targetFee: r.targetFee as bigint,
  callerFee: r.callerFee as bigint,
});

/** Deploy a PoC helper, or report the artifact as missing instead of throwing. */
async function tryDeploy(viem: any, name: string, args: any[], cli: any) {
  try { return await viem.deployContract(name, args, cli); }
  catch (e: any) {
    if (/Artifact for contract/.test(String(e?.message))) return null;
    throw e;
  }
}
const MISSING = (n: number, name: string, c: string) =>
  verdict(n, name, "NOT RUN", `Missing artifact "${c}" — add test/contracts/mocks/PocTargets.sol and re-run 'npx hardhat compile'.`);

describe("PoC — audit findings (rev 2)", { concurrency: false, timeout: 900_000 }, () => {

  it("1: 256-byte revert vs 200k POST_CALL_GAS_RESERVE", async () => {
    const { viem, publicClient, cli, source, target, deployer } = await deployPair(VAR_FEE);
    const t = await tryDeploy(viem, "PocRevertTarget", [], cli);
    if (!t) return MISSING(1, "POST_CALL_GAS_RESERVE undersized", "PocRevertTarget");

    const run = async (revertSize: bigint, txGas: bigint) => {
      await t.write.configure([revertSize, 3_000n], { account: deployer });
      const h = await source.write.sendOneWayMessage([DST, t.address, mc(), "0x00000000"],
        { account: deployer, value: 4_500_000n * GP, gasPrice: GP });
      await publicClient.waitForTransactionReceipt({ hash: h, ...wait });
      const len = await source.read.getRequestsLen([DST]);
      const reqs = (await source.read.getRequests([DST, len - 1n, 1n])) as any[];
      const m = toMined(reqs[0]);
      try {
        const mh = await target.write.batchProcessRequests([SRC, [m]], { account: deployer, gas: txGas });
        const rc = await publicClient.waitForTransactionReceipt({ hash: mh, ...wait });
        const err = (await target.read.errors([m.requestId])) as any;
        return { ok: rc.status === "success", code: BigInt(err.errorCode ?? err[1] ?? 0n), targetFee: m.targetFee, gasUsed: rc.gasUsed as bigint };
      } catch (e: any) { return { ok: false, why: revertReason(e), targetFee: m.targetFee }; }
    };

    const small = await run(32n, 3_000_000n);
    const big = await run(256n, 3_000_000n);

    if (small.ok && !big.ok) {
      verdict(1, "POST_CALL_GAS_RESERVE undersized", "REAL",
        `targetFee=${small.targetFee}. 32B recorded (code=${small.code}, mine gasUsed=${small.gasUsed}); 256B aborted the batch: ${big.why}`);
    } else if (small.ok && big.ok) {
      verdict(1, "POST_CALL_GAS_RESERVE undersized", "FALSE POSITIVE",
        `Both recorded (32B code=${small.code} gasUsed=${small.gasUsed}; 256B code=${big.code} gasUsed=${big.gasUsed}). ` +
        `Reserve held ONLY IF the target really burned its stipend — gasUsed near the ~2.5M stipend means it did; a few hundred k means the burn was elided.`);
    } else {
      verdict(1, "POST_CALL_GAS_RESERVE undersized", "INCONCLUSIVE",
        `small.ok=${small.ok} (${small.why ?? "-"}) big.ok=${big.ok} (${big.why ?? "-"})`);
    }
  });

  it("2: oversized reply on a minimum-fee two-way", async () => {
    const { viem, publicClient, cli, source, target, deployer } = await deployPair(VAR_FEE);
    const responder = await tryDeploy(viem, "PocResponder", [target.address], cli);
    if (!responder) return MISSING(2, "Return leg unpriced", "PocResponder");
    // Reply small enough that the destination can afford to CREATE it out of targetFee,
    // but far larger than what the minimum callerFee pays to INGEST on the source chain.
    await responder.write.configure([1200n], { account: deployer });

    const [, cFee] = (await source.read.calculateTwoWayFeeRequiredInLocalToken([256n, 256n, 0n, 0n, GP])) as [bigint, bigint];
    const tFee = 4_800_000n * GP; // near maxExecutionGas so reply creation is funded
    const h = await source.write.sendTwoWayMessage(
      [DST, responder.address, mc(), "0x11111111", "0x22222222", cFee],
      { account: deployer, value: tFee + cFee, gasPrice: GP });
    await publicClient.waitForTransactionReceipt({ hash: h, ...wait });
    const m = toMined(((await source.read.getRequests([DST, 0n, 1n])) as any[])[0]);

    try {
      const mh = await target.write.batchProcessRequests([SRC, [m]], { account: deployer, gas: MAX_TX_GAS });
      await publicClient.waitForTransactionReceipt({ hash: mh, ...wait });
      const outLen = await target.read.getRequestsLen([SRC]);
      if (outLen > 0n) {
        const back = (await target.read.getRequests([SRC, 0n, 1n])) as any[];
        const replyBytes = (back[0].methodCall.data.length - 2) / 2;
        const priced = BigInt(replyBytes) * 800n;
        verdict(2, "Return leg unpriced", "REAL",
          `callerFee=${m.callerFee} funded a ${replyBytes}-byte return leg; protocol's own gasPerByte=800 prices it at ${priced} (${Number(priced) / Number(m.callerFee) | 0}x).`);
      } else {
        const err = (await target.read.errors([m.requestId])) as any;
        const code = BigInt(err.errorCode ?? err[1] ?? 0n);
        verdict(2, "Return leg unpriced", code === 0n ? "FALSE POSITIVE" : "INCONCLUSIVE",
          code === 0n ? "respond() produced no return leg and the target did not fail."
                      : `No return leg because the target itself failed (errorCode=${code}) — reply creation outran targetFee, so the reply size was never tested.`);
      }
    } catch (e: any) {
      verdict(2, "Return leg unpriced", "FALSE POSITIVE", `Oversized reply rejected: ${revertReason(e)}`);
    }
  });

  it("3: callback floor uses request size, not reply size", async () => {
    const { source, deployer } = await deployPair(VAR_FEE);
    // Vary ONLY the callback size — the quoter should track it.
    const [, cbSmall] = (await source.read.calculateTwoWayFeeRequiredInLocalToken([256n, 256n, 0n, 0n, GP])) as [bigint, bigint];
    const [, cbLarge] = (await source.read.calculateTwoWayFeeRequiredInLocalToken([256n, 8000n, 0n, 0n, GP])) as [bigint, bigint];
    const quoterTracksReply = cbLarge > cbSmall;

    // Validator: big REQUEST + the callback fee the quoter says a small reply needs.
    let why = "";
    try {
      await source.write.sendTwoWayMessage(
        [DST, deployer, mc(toHex(new Uint8Array(3000))), "0x11111111", "0x22222222", cbSmall],
        { account: deployer, value: cbSmall + 4_000_000n * GP, gasPrice: GP });
    } catch (e: any) { why = revertReason(e); }
    const validatorUsesRequest = /CallbackFeeTooLow/.test(why);

    if (quoterTracksReply && validatorUsesRequest) {
      verdict(3, "Callback floor priced from request size", "REAL",
        `Quoter prices the callback from REPLY size (256B->${cbSmall}, 8000B->${cbLarge}); the validator rejected a big REQUEST at the small-reply fee with ${why}. They disagree.`);
    } else if (quoterTracksReply && !validatorUsesRequest) {
      verdict(3, "Callback floor priced from request size", "FALSE POSITIVE",
        `Quoter tracks reply size and the validator did not reject on request size. Revert (if any): ${why || "none"}`);
    } else {
      verdict(3, "Callback floor priced from request size", "INCONCLUSIVE",
        `quoterTracksReply=${quoterTracksReply} (${cbSmall} vs ${cbLarge}); validator said: ${why || "no revert"}`);
    }
  });

  it("4: constantFee == maxExecutionGas with realistic prices", async () => {
    const DEGEN = { ...CONST_FEE, constantFee: 25_000_000n, maxExecutionGas: 25_000_000n };
    const { source, deployer } = await deployPair(DEGEN, 3000n * P18, 5n * 10n ** 16n);
    const seen: string[] = [];
    let succeeded = false;
    for (const u of [414n, 415n, 416n, 417n, 418n, 419n]) {
      try {
        await source.write.sendOneWayMessage([DST, deployer, mc(), "0x00000000"],
          { account: deployer, value: u * GP, gasPrice: GP });
        succeeded = true; seen.push(`u=${u} SUCCESS`);
      } catch (e: any) { seen.push(`u=${u} ${revertReason(e)}`); }
    }
    const onlyFeeBandErrors = seen.every(s => /TargetFeeTooLow|FeeGasTooHigh|SUCCESS/.test(s));
    if (!succeeded && onlyFeeBandErrors) {
      verdict(4, "Degenerate fee band unreachable", "REAL",
        `Every value straddles the one-unit band. ${seen.join(" | ")}`);
    } else if (succeeded) {
      verdict(4, "Degenerate fee band unreachable", "FALSE POSITIVE", `A value landed in the band. ${seen.join(" | ")}`);
    } else {
      verdict(4, "Degenerate fee band unreachable", "INCONCLUSIVE",
        `All failed, but not all with fee-band errors: ${seen.join(" | ")}`);
    }
  });

  it("5: estimate gasUsed vs reply size", async () => {
    const { viem, publicClient, cli, source, target, deployer } = await deployPair(VAR_FEE);
    const responder = await tryDeploy(viem, "PocResponder", [target.address], cli);
    if (!responder) return MISSING(5, "Estimate suppresses reply LOG cost", "PocResponder");

    const estimateFor = async (replySize: bigint) => {
      await responder.write.configure([replySize], { account: deployer });
      const [tFee, cFee] = (await source.read.calculateTwoWayFeeRequiredInLocalToken([256n, 256n, 0n, 0n, GP])) as [bigint, bigint];
      const h = await source.write.sendTwoWayMessage(
        [DST, responder.address, mc(), "0x11111111", "0x22222222", cFee],
        { account: deployer, value: tFee + cFee, gasPrice: GP });
      await publicClient.waitForTransactionReceipt({ hash: h, ...wait });
      const len = await source.read.getRequestsLen([DST]);
      const m = toMined(((await source.read.getRequests([DST, len - 1n, 1n])) as any[])[0]);
      try {
        await target.simulate.estimateExecutionGasForMiner([SRC, m, 0n], { account: deployer });
        return null;
      } catch (e: any) {
        const r = revertReason(e);
        const g = r.match(/ExecutionGasEstimate\((\d+)/);
        return g ? BigInt(g[1]) : null;
      }
    };

    const small = await estimateFor(100n);
    const large = await estimateFor(6000n);
    if (small === null || large === null) {
      verdict(5, "Estimate suppresses reply LOG cost", "INCONCLUSIVE",
        `Could not decode ExecutionGasEstimate (small=${small}, large=${large}).`);
    } else {
      const delta = large - small;
      const logCost = (6000n - 100n) * 8n;
      verdict(5, "Estimate suppresses reply LOG cost", "INCONCLUSIVE",
        `gasUsed 100B=${small} 6000B=${large} (delta ${delta} = ${Number(delta) / 5900} gas/byte); LOG data is only ~${logCost} (8/byte) of that, ` +
        `so memory+respond costs dominate and this test cannot isolate the suppressed LOGs. Needs an estimate-vs-real-mine comparison.`);
    }
  });

  it("6+11+12: TTL under pause, half-written record, missing error leg", async () => {
    const { viem, publicClient, cli, source, target, deployer } = await deployPair(VAR_FEE);
    const t = await tryDeploy(viem, "PocRevertTarget", [], cli);
    if (!t) { MISSING(6, "TTL clock runs while paused", "PocRevertTarget");
              MISSING(11, "TTL half-writes the error record", "PocRevertTarget");
              MISSING(12, "No error leg on execution failure", "PocRevertTarget"); return; }
    await t.write.configure([32n, 2_000n], { account: deployer });

    const [tFee, cFee] = (await source.read.calculateTwoWayFeeRequiredInLocalToken([256n, 256n, 0n, 0n, GP])) as [bigint, bigint];
    const h = await source.write.sendTwoWayMessage([DST, t.address, mc(), "0x11111111", "0x22222222", cFee],
      { account: deployer, value: tFee + cFee, gasPrice: GP });
    await publicClient.waitForTransactionReceipt({ hash: h, ...wait });
    const m = toMined(((await source.read.getRequests([DST, 0n, 1n])) as any[])[0]);

    const mh = await target.write.batchProcessRequests([SRC, [m]], { account: deployer, gas: MAX_TX_GAS });
    await publicClient.waitForTransactionReceipt({ hash: mh, ...wait });

    const legs = await target.read.getRequestsLen([SRC]);
    verdict(12, "No error leg on execution failure", legs === 0n ? "REAL" : "FALSE POSITIVE",
      `Outbound legs after a failed two-way execution: ${legs} (0 = sender's errorSelector never invoked at failure time).`);

    const before = (await target.read.errors([m.requestId])) as any;
    const msgBefore = String(before.errorMessage ?? before[2]);
    const codeBefore = BigInt(before.errorCode ?? before[1] ?? 0n);

    await target.write.setMessageProcessingPaused([true], { account: deployer });
    await (publicClient as any).request({ method: "evm_increaseTime", params: [200_000] });
    await (publicClient as any).request({ method: "evm_mine", params: [] });
    await target.write.setMessageProcessingPaused([false], { account: deployer });

    let why = "";
    try {
      const rh = await target.write.retryFailedRequest([m.requestId], { account: deployer, gas: 5_000_000n });
      await publicClient.waitForTransactionReceipt({ hash: rh, ...wait });
    } catch (e: any) { why = revertReason(e); }

    const after = (await target.read.errors([m.requestId])) as any;
    const codeAfter = BigInt(after.errorCode ?? after[1] ?? 0n);
    const msgAfter = String(after.errorMessage ?? after[2]);

    verdict(6, "TTL clock runs while paused", codeAfter === 4n ? "REAL" : "FALSE POSITIVE",
      `code ${codeBefore} -> ${codeAfter} after pause>TTL then unpause (4 = EXPIRED, terminal). retry err: ${why || "none"}`);
    verdict(11, "TTL half-writes the error record",
      codeAfter === 4n && msgAfter === msgBefore ? "REAL" : "FALSE POSITIVE",
      `errorMessage unchanged across the 1->4 transition: ${msgAfter === msgBefore}`);
  });

  it("7: retry executes with caller-chosen gas", async () => {
    const { viem, publicClient, cli, source, target, deployer } = await deployPair(VAR_FEE);
    const gs = await tryDeploy(viem, "PocGasSensitiveTarget", [], cli);
    if (!gs) return MISSING(7, "Retry with caller-chosen gas", "PocGasSensitiveTarget");
    await gs.write.setInnerCost([400_000n], { account: deployer });

    const [minTarget] = (await source.read.calculateTwoWayFeeRequiredInLocalToken([256n, 256n, 0n, 0n, GP])) as [bigint, bigint];
    const h = await source.write.sendOneWayMessage([DST, gs.address, mc(), "0x00000000"],
      { account: deployer, value: minTarget + 200_000n * GP, gasPrice: GP });
    await publicClient.waitForTransactionReceipt({ hash: h, ...wait });
    const m = toMined(((await source.read.getRequests([DST, 0n, 1n])) as any[])[0]);
    const mh = await target.write.batchProcessRequests([SRC, [m]], { account: deployer, gas: MAX_TX_GAS });
    await publicClient.waitForTransactionReceipt({ hash: mh, ...wait });

    const e0 = (await target.read.errors([m.requestId])) as any;
    if (BigInt(e0.errorCode ?? e0[1] ?? 0n) !== 1n) {
      return verdict(7, "Retry with caller-chosen gas", "INCONCLUSIVE",
        `Could not stage an execution failure (code=${BigInt(e0.errorCode ?? e0[1] ?? 0n)}).`);
    }
    try {
      const rh = await target.write.retryFailedRequest([m.requestId], { account: deployer, gas: 600_000n });
      await publicClient.waitForTransactionReceipt({ hash: rh, ...wait });
      const innerOk = (await gs.read.innerSucceeded()) as boolean;
      const e1 = (await target.read.errors([m.requestId])) as any;
      const cleared = BigInt(e1.errorCode ?? e1[1] ?? 0n) === 0n;
      verdict(7, "Retry with caller-chosen gas", innerOk === false && cleared ? "REAL" : "FALSE POSITIVE",
        `innerSucceeded=${innerOk}, errors cleared=${cleared}`);
    } catch (e: any) {
      verdict(7, "Retry with caller-chosen gas", "PARTIAL", `Tight-gas retry reverted: ${revertReason(e)}`);
    }
  });

  it("8+9: reject hatch and system-error leg under a lowered cap", async () => {
    const { viem, publicClient, cli, source, target, deployer } = await deployPair(VAR_FEE);
    const rejectTools = await viem.deployContract("MinerRejectTools", [], cli);

    // Keep callerFee comfortably UNDER maxExecutionGas so the send succeeds.
    const [tFee, cFee] = (await source.read.calculateTwoWayFeeRequiredInLocalToken([256n, 256n, 0n, 0n, GP])) as [bigint, bigint];
    const h = await source.write.sendTwoWayMessage([DST, deployer, mc(), "0x11111111", "0x22222222", cFee],
      { account: deployer, value: tFee + cFee, gasPrice: GP });
    await publicClient.waitForTransactionReceipt({ hash: h, ...wait });
    const m = toMined(((await source.read.getRequests([DST, 0n, 1n])) as any[])[0]);

    // Now lower the destination's REMOTE cap below that in-flight callerFee.
    const lowered = { ...VAR_FEE, maxExecutionGas: m.callerFee > 1n ? m.callerFee - 1n : 1n };
    await target.write.updateMinFeeConfigs([{ ...VAR_FEE }, { ...lowered }], { account: deployer });

    let normalWhy = "", rejectWhy = "";
    try { await target.write.batchProcessRequests([SRC, [m]], { account: deployer, gas: MAX_TX_GAS }); }
    catch (e: any) { normalWhy = revertReason(e); }

    const rej: any = { ...m };
    rej.targetContract = "0x0000000000000000000000000000000000000000";
    rej.methodCall = await rejectTools.read.buildMinerRejectMethodCall([1, toHex(1n, { size: 32 })]);
    try {
      const rh = await target.write.batchProcessRequests([SRC, [rej]], { account: deployer, gas: MAX_TX_GAS });
      await publicClient.waitForTransactionReceipt({ hash: rh, ...wait });
    } catch (e: any) { rejectWhy = revertReason(e); }

    const feeBand = (w: string) => /FeeGasTooHigh|MethodCallTooLarge/.test(w);
    if (normalWhy && rejectWhy && feeBand(normalWhy) && feeBand(rejectWhy)) {
      verdict(8, "Reject hatch re-applies the blocking cap", "REAL",
        `callerFee=${m.callerFee}, cap lowered to ${lowered.maxExecutionGas}. normal: ${normalWhy} || reject ALSO failed: ${rejectWhy}`);
      verdict(9, "System-error leg fail-unsafe", "REAL", `Reject's system-error leg reverted inside _createRequest.`);
    } else if (normalWhy && rejectWhy) {
      verdict(8, "Reject hatch re-applies the blocking cap", "INCONCLUSIVE",
        `Both failed but not on a fee cap — infrastructure error, not contract behaviour. normal: ${normalWhy} || reject: ${rejectWhy}`);
      verdict(9, "System-error leg fail-unsafe", "INCONCLUSIVE", "Depends on PoC 8 staging.");
    } else if (normalWhy && !rejectWhy) {
      verdict(8, "Reject hatch re-applies the blocking cap", "FALSE POSITIVE",
        `normal ingest failed (${normalWhy}) but the reject cleared the nonce.`);
      verdict(9, "System-error leg fail-unsafe", "FALSE POSITIVE", "System-error leg created without reverting.");
    } else {
      verdict(8, "Reject hatch re-applies the blocking cap", "INCONCLUSIVE", `normal="${normalWhy}" reject="${rejectWhy}"`);
      verdict(9, "System-error leg fail-unsafe", "INCONCLUSIVE", "Depends on PoC 8 staging.");
    }
  });

  it("10: execution budget still contains the ingest-storage fee", async () => {
    const { source, publicClient, deployer } = await deployPair(VAR_FEE);
    const payloadBytes = 3000;
    // dataSize ~ 3264 -> expectedMinFee ~ 4,374,000, under the 5,000,000 cap.
    const h = await source.write.sendOneWayMessage(
      [DST, deployer, mc(toHex(new Uint8Array(payloadBytes))), "0x00000000"],
      { account: deployer, value: 4_500_000n * GP, gasPrice: GP });
    await publicClient.waitForTransactionReceipt({ hash: h, ...wait });
    const targetFee = ((await source.read.getRequests([DST, 0n, 1n])) as any[])[0].targetFee as bigint;

    const ingestTerm = BigInt(payloadBytes) * VAR_FEE.gasPerByte;
    const budget = targetFee - VAR_FEE.errorLength * VAR_FEE.gasPerByte;
    verdict(10, "Ingest fee returned as executable gas", budget > ingestTerm ? "REAL" : "FALSE POSITIVE",
      `targetFee=${targetFee}; granted execution budget=${budget}; ingest-storage term charged=${ingestTerm}.`);
  });

  it("prints the verdict table", () => {
    console.log("\n\n══════════════ PoC VERDICTS ══════════════\n" + RESULTS.join("\n") + "\n══════════════════════════════════════════\n");
    assert.ok(RESULTS.length > 0);
  });
});
