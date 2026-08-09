import assert from "node:assert/strict";
import { afterEach, before, describe, it } from "node:test";
import { network } from "hardhat";
import { encodeFunctionData, stringToHex, toFunctionSelector } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  collectInboxFeesAfterTest,
  fundContractForInboxFees,
  logStep,
  normalizePrivateKey,
  podTwoWayWriteOptions,
  receiptWaitOptions,
  requirePrivateKey,
  resolveCotiTestnetPrivateKey,
  runCrossChainTwoWayRoundTrip,
  setupContext,
  type TestContext,
} from "./mpc-test-utils.js";

/** COTI `batchProcessRequests` gas for nested inbox `raise` (no MPC, but safe headroom). */
const COTI_MINE_GAS_RAISE_PATH = 30_000_000n;

describe("Inbox raise() → error callback (system)", { concurrency: 1 }, async function () {
  const { viem: sepoliaViem } = await network.connect({ network: "hardhat" });
  const { viem: cotiViem } = await network.connect({ network: "cotiTestnet" });

  let ctx: TestContext;
  let raiseCoti: any;
  let raiseSepolia: any;
  let raiseSepoliaAsCotiWallet: any;

  afterEach(async function () {
    if (ctx) await collectInboxFeesAfterTest(ctx);
  });

  before(async function () {
    // `raise` must exist on the COTI inbox. Reused deployments often predate it; force a fresh COTI deploy.
    process.env.COTI_REUSE_CONTRACTS = "false";
    ctx = await setupContext({ sepoliaViem, cotiViem });

    const cotiPk = normalizePrivateKey(await resolveCotiTestnetPrivateKey());
    const cotiAccount = privateKeyToAccount(cotiPk as `0x${string}`);
    const hardhatCotiWallet = await sepoliaViem.getWalletClient(cotiAccount.address);

    raiseCoti = await cotiViem.deployContract(
      "RaiseInboxTestCoti",
      [ctx.contracts.inboxCoti.address],
      { client: { public: ctx.coti.publicClient, wallet: ctx.coti.wallet } } as any
    );

    raiseSepolia = await sepoliaViem.deployContract("RaiseInboxTestSepolia", [
      ctx.contracts.inboxSepolia.address,
      BigInt(ctx.chainIds.coti),
      raiseCoti.address,
    ]);

    await raiseCoti.write.setTrustedRemote([BigInt(ctx.chainIds.sepolia), raiseSepolia.address]);

    await fundContractForInboxFees(hardhatCotiWallet, ctx.sepolia.publicClient, raiseSepolia.address as `0x${string}`);

    raiseSepoliaAsCotiWallet = await sepoliaViem.getContractAt("RaiseInboxTestSepolia", raiseSepolia.address, {
      client: { public: ctx.sepolia.publicClient, wallet: hardhatCotiWallet },
    });
  });

  it("full round-trip: Hardhat sendTwoWay → COTI raise → Hardhat onRaiseError", async function () {
    const expectedPayload = stringToHex("inbox-raise-system-test");
    const onRaiseError = toFunctionSelector("onRaiseError(bytes)");

    // 1) Source chain: enqueue two-way message (error path only in this harness).
    logStep("Hardhat: startRaiseRoundTrip → inbox records outbound request");
    const txHash = await raiseSepoliaAsCotiWallet.write.startRaiseRoundTrip(
      [expectedPayload, ctx.podTwoWayFees.callbackFeeWei],
      podTwoWayWriteOptions(ctx.podTwoWayFees)
    );
    await ctx.sepolia.publicClient.waitForTransactionReceipt({ hash: txHash, ...receiptWaitOptions });

    // 2–4) Relay: mine COTI (triggerRaise → raise), load return leg, mine Hardhat (error callback).
    logStep("Relay: mine COTI → mine Hardhat (same flow as MPC pod round-trip)");
    const { outboundRequest, cotiIncomingRequestId, returnLegRequest } = await runCrossChainTwoWayRoundTrip(
      ctx,
      "RaiseRoundTrip",
      { gas: COTI_MINE_GAS_RAISE_PATH }
    );

    assert.equal(outboundRequest.targetContract.toLowerCase(), raiseCoti.address.toLowerCase());
    assert.equal(outboundRequest.isTwoWay, true);
    assert.equal(outboundRequest.errorSelector.toLowerCase(), onRaiseError.toLowerCase());

    assert.equal(returnLegRequest.isTwoWay, false);
    assert.equal(
      returnLegRequest.sourceRequestId.toLowerCase(),
      cotiIncomingRequestId.toLowerCase(),
      "return leg must link sourceRequestId to the COTI incoming request (raise/respond linkage)"
    );
    assert.ok(
      (returnLegRequest.methodCall.data as string).toLowerCase().startsWith(onRaiseError.toLowerCase())
    );

    assert.equal(await raiseSepolia.read.raiseErrorCalled(), true);
    assert.equal(
      ((await raiseSepolia.read.lastErrorSourceRequestId()) as string).toLowerCase(),
      cotiIncomingRequestId.toLowerCase()
    );

    const stored = (await raiseSepolia.read.lastRaiseErrorPayload()) as `0x${string}`;
    assert.equal(stored.toLowerCase(), expectedPayload.toLowerCase());

    assert.equal(
      (returnLegRequest.methodCall.data as string).toLowerCase(),
      encodeFunctionData({
        abi: [
          {
            type: "function",
            name: "onRaiseError",
            stateMutability: "nonpayable",
            inputs: [{ name: "payload", type: "bytes" }],
            outputs: [],
          },
        ],
        functionName: "onRaiseError",
        args: [stored],
      }).toLowerCase()
    );
  });
});
