import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { oracleTokensForChain } from "../scripts/oracle-tokens.js";

/**
 * Regression test for per-target request isolation (>2 chains).
 *
 * Before the fix, a single global nonce produced interleaved request ids across targets, so a target
 * that only received a subset saw non-contiguous nonces and `batchProcessRequests` reverted. With
 * per-target nonces (and source+target+nonce packed into the id) each target sees a clean 1,2,3,...
 * sequence again.
 */

const receiptWaitOptions = { timeout: 300_000, pollingInterval: 2_000 };

const SOURCE_CHAIN_ID = 1000n;
const TARGET_B = 1001n;
const TARGET_C = 1002n;

const GAS_PRICE_WEI = 25_000_000_000n; // 25 gwei (>= hardhat base fee)
const SEND_VALUE_WEI = 2_500_000_000_000n; // -> targetFee ~ 100 gas units at 1:1 price

/** Constant-min fee template (constantFee > 0 => template is valid and cheap to satisfy). */
const CONSTANT_FEE = {
  constantFee: 1n,
  gasPerByte: 0n,
  callbackExecutionGas: 0n,
  errorLength: 0n,
  bufferRatioX10000: 0n,
} as const;

const PRICE_SCALE_18 = 10n ** 18n;

const minimalMethodCall = () => ({
  selector: "0x00000000" as `0x${string}`,
  data: "0x" as `0x${string}`,
  datatypes: [] as `0x${string}`[],
  datalens: [] as `0x${string}`[],
});

const ZERO_ID = `0x${"0".repeat(64)}` as `0x${string}`;

describe("Inbox per-target request isolation (>2 chains)", { concurrency: false, timeout: 600_000 }, () => {
  const connect = async () => {
    const { viem } = await network.connect({ network: "hardhat" });
    const publicClient = await viem.getPublicClient();
    const [wallet] = await viem.getWalletClients();
    const deployer = wallet.account.address as `0x${string}`;
    return { viem, publicClient, wallet, deployer };
  };

  const deployInbox = async (
    env: Awaited<ReturnType<typeof connect>>,
    chainId: bigint,
    withOracle: boolean
  ) => {
    const { viem, publicClient, wallet, deployer } = env;
    const inbox = await viem.deployContract("Inbox", [], { client: { public: publicClient, wallet } });
    await inbox.write.init([deployer, chainId], { account: deployer });
    if (withOracle) {
      const oracle = await viem.deployContract("PriceOracle", [deployer], {
        client: { public: publicClient, wallet },
      });
      const { localToken, remoteToken } = oracleTokensForChain(31337);
      await oracle.write.setInboxTokens([localToken, remoteToken], { account: deployer });
      await oracle.write.setLocalTokenPriceUSD([PRICE_SCALE_18], { account: deployer });
      await oracle.write.setRemoteTokenPriceUSD([PRICE_SCALE_18], { account: deployer });
      await inbox.write.setPriceOracle([oracle.address], { account: deployer });
    }
    await inbox.write.updateMinFeeConfigs([{ ...CONSTANT_FEE }, { ...CONSTANT_FEE }], { account: deployer });
    return inbox;
  };

  const sendOneWay = async (
    env: Awaited<ReturnType<typeof connect>>,
    inbox: any,
    targetChainId: bigint
  ) => {
    const hash = await inbox.write.sendOneWayMessage(
      [targetChainId, env.deployer, minimalMethodCall(), "0x00000000"],
      { account: env.deployer, value: SEND_VALUE_WEI, gasPrice: GAS_PRICE_WEI }
    );
    await env.publicClient.waitForTransactionReceipt({ hash, ...receiptWaitOptions });
  };

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

  it("indexes outbound requests per target and mines a subset contiguously", async () => {
    const env = await connect();
    const source = await deployInbox(env, SOURCE_CHAIN_ID, true);

    // Interleave targets: B, C, B, C, B  =>  B gets 3, C gets 2.
    await sendOneWay(env, source, TARGET_B);
    await sendOneWay(env, source, TARGET_C);
    await sendOneWay(env, source, TARGET_B);
    await sendOneWay(env, source, TARGET_C);
    await sendOneWay(env, source, TARGET_B);

    assert.equal(await source.read.getRequestsLen([TARGET_B]), 3n);
    assert.equal(await source.read.getRequestsLen([TARGET_C]), 2n);

    const bReqs = (await source.read.getRequests([TARGET_B, 0n, 3n])) as any[];
    assert.equal(bReqs.length, 3);

    // Per-target nonces are contiguous 1,2,3 and the id encodes (source, target, nonce).
    for (let i = 0; i < bReqs.length; i++) {
      const [src, tgt, nonce] = (await source.read.unpackRequestId([bReqs[i].requestId])) as [
        bigint,
        bigint,
        bigint
      ];
      assert.equal(src, SOURCE_CHAIN_ID);
      assert.equal(tgt, TARGET_B);
      assert.equal(nonce, BigInt(i + 1));
      assert.equal(Number(bReqs[i].targetChainId), Number(TARGET_B));
    }

    // get-by-id works from the id alone (id is globally unique).
    const byId = (await source.read.getRequest([bReqs[0].requestId])) as any;
    assert.equal(byId.requestId, bReqs[0].requestId);

    // Target B can mine its 3 requests despite the interleaving with C on the source.
    const targetB = await deployInbox(env, TARGET_B, false);
    await targetB.write.addMiner([env.deployer], { account: env.deployer });
    await targetB.write.batchProcessRequests([SOURCE_CHAIN_ID, bReqs.map(toMined)], {
      account: env.deployer,
      gas: 10_000_000n,
    });

    assert.equal(await targetB.read.lastIncomingRequestId([SOURCE_CHAIN_ID]), bReqs[2].requestId);
    const incoming = (await targetB.read.getIncomingRequest([bReqs[0].requestId])) as any;
    assert.equal(incoming.requestId, bReqs[0].requestId);
    assert.notEqual(incoming.requestId, ZERO_ID);

    // A request destined for another chain (C) must be rejected by B.
    const cReqs = (await source.read.getRequests([TARGET_C, 0n, 1n])) as any[];
    await assert.rejects(
      () =>
        targetB.write.batchProcessRequests([SOURCE_CHAIN_ID, cReqs.map(toMined)], {
          account: env.deployer,
          gas: 10_000_000n,
        }),
      /RequestTargetChainMismatch/
    );
  });
});
