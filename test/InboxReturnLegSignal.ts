import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeEventLog, encodeFunctionData, toFunctionSelector, toHex } from "viem";
import { network } from "hardhat";
import { oracleTokensForChain } from "../scripts/oracle-tokens.js";
import { deployTestInbox, mpcAbiReEncodeOf } from "../scripts/deploy-test-inbox.js";

const receiptWaitOptions = { timeout: 300_000, pollingInterval: 2_000 };

const SOURCE_CHAIN_ID = 1000n;
const TARGET_CHAIN_ID = 1001n;
const GAS_PRICE_WEI = 1_000_000_000n;
const SEND_VALUE_WEI = 5_000_000_000_000_000n;
const CALLBACK_FEE_WEI = 500_000_000_000_000n;
const PRICE_SCALE_18 = 10n ** 18n;

const FEE = {
  constantFee: 1n,
  gasPerByte: 0n,
  callbackExecutionGas: 0n,
  errorLength: 0n,
  bufferRatioX10000: 0n,
  maxMethodCallBytes: 8192n,
  maxExecutionGas: 5_000_000n,
  gasPriceMul: 1n,
  gasPriceDiv: 1n,
} as const;

const packRequestId = (source: bigint, target: bigint, nonce: bigint): `0x${string}` => {
  const packed = (source << 192n) | (target << 128n) | nonce;
  return toHex(packed, { size: 32 });
};

const rawMethod = (data: `0x${string}`) => ({
  selector: "0x00000000" as `0x${string}`,
  data,
  datatypes: [] as `0x${string}`[],
  datalens: [] as `0x${string}`[],
});

describe("return-leg callback success signal", {
  concurrency: false,
  timeout: 600_000,
}, () => {
  const setup = async () => {
    const { viem } = await network.connect({ network: "hardhat" });
    const publicClient = await viem.getPublicClient();
    const [wallet] = await viem.getWalletClients();
    const deployer = wallet.account.address as `0x${string}`;

    const source = await deployTestInbox(viem, { client: { public: publicClient, wallet } });
    await source.write.init([deployer, SOURCE_CHAIN_ID, mpcAbiReEncodeOf(source)], {
      account: deployer,
    });
    await source.write.updateMinFeeConfigs([{ ...FEE }, { ...FEE }], { account: deployer });
    await source.write.addMiner([deployer], { account: deployer });

    const oracle = await viem.deployContract("PriceOracle", [deployer], {
      client: { public: publicClient, wallet },
    });
    const { localToken, remoteToken } = oracleTokensForChain(31337);
    await oracle.write.setInboxTokens([localToken, remoteToken], { account: deployer });
    await oracle.write.setLocalTokenPriceUSD([PRICE_SCALE_18], { account: deployer });
    await oracle.write.setRemoteTokenPriceUSD([PRICE_SCALE_18], { account: deployer });
    await source.write.setPriceOracle([oracle.address], { account: deployer });
    await source.write.setGasPriceBounds([0n, GAS_PRICE_WEI, GAS_PRICE_WEI], { account: deployer });

    const receiver = await viem.deployContract("SystemErrorReceiver", [source.address], {
      client: { public: publicClient, wallet },
    });
    const boom = await viem.deployContract("LargeRevertTarget", [], {
      client: { public: publicClient, wallet },
    });

    const errorSelector = toFunctionSelector("onSystemError(bytes)");
    const sendHash = await source.write.sendTwoWayMessage(
      [
        TARGET_CHAIN_ID,
        deployer,
        rawMethod("0x"),
        "0x11111111",
        errorSelector,
        CALLBACK_FEE_WEI,
      ],
      { account: deployer, value: SEND_VALUE_WEI, gasPrice: GAS_PRICE_WEI }
    );
    await publicClient.waitForTransactionReceipt({ hash: sendHash, ...receiptWaitOptions });

    const outbound = (await source.read.getRequests([TARGET_CHAIN_ID, 0n, 1n])) as any[];
    const originalId = outbound[0].requestId as `0x${string}`;

    return { viem, publicClient, deployer, source, receiver, boom, originalId };
  };

  const mineReturnLeg = async (params: {
    source: any;
    publicClient: any;
    deployer: `0x${string}`;
    targetContract: `0x${string}`;
    methodCall: ReturnType<typeof rawMethod>;
    originalId: `0x${string}`;
    nonce: bigint;
  }) => {
    const returnLegId = packRequestId(TARGET_CHAIN_ID, SOURCE_CHAIN_ID, params.nonce);
    const hash = await params.source.write.batchProcessRequests(
      [
        TARGET_CHAIN_ID,
        [
          {
            requestId: returnLegId,
            sourceContract: params.deployer,
            targetContract: params.targetContract,
            methodCall: params.methodCall,
            callbackSelector: "0x00000000",
            errorSelector: "0x00000000",
            isTwoWay: false,
            sourceRequestId: params.originalId,
            targetFee: 500_000n,
            callerFee: 0n,
          },
        ],
      ],
      { account: params.deployer, gas: 8_000_000n }
    );
    const receipt = await params.publicClient.waitForTransactionReceipt({
      hash,
      ...receiptWaitOptions,
    });
    assert.equal(receipt.status, "success");
    return { receipt, returnLegId };
  };

  const countEvents = (params: {
    logs: readonly any[];
    inbox: `0x${string}`;
    abi: any;
  }) => {
    let received = 0;
    let succeeded = 0;
    for (const log of params.logs) {
      if (log.address.toLowerCase() !== params.inbox.toLowerCase()) continue;
      try {
        const decoded = decodeEventLog({
          abi: params.abi,
          data: log.data,
          topics: log.topics,
        });
        if (decoded.eventName === "IncomingResponseReceived") received += 1;
        if (decoded.eventName === "ReturnLegCallbackSucceeded") succeeded += 1;
      } catch {
        // ignore unrelated logs
      }
    }
    return { received, succeeded };
  };

  it("emits success signal when return-leg target call does not error", async () => {
    const { publicClient, deployer, source, receiver, originalId } = await setup();
    const calldata = encodeFunctionData({
      abi: receiver.abi,
      functionName: "onSystemError",
      args: ["0x"],
    });
    const { receipt, returnLegId } = await mineReturnLeg({
      source,
      publicClient,
      deployer,
      targetContract: receiver.address,
      methodCall: rawMethod(calldata),
      originalId,
      nonce: 1n,
    });

    const { received, succeeded } = countEvents({
      logs: receipt.logs,
      inbox: source.address,
      abi: source.abi,
    });
    assert.equal(received, 1);
    assert.equal(succeeded, 1);

    const original = (await source.read.getRequest([originalId])) as { executed: boolean };
    assert.equal(original.executed, true);
    await assert.rejects(
      () => source.read.getOutboxError([returnLegId]),
      /ErrorNotFound|revert/i
    );
  });

  it("keeps IncomingResponseReceived but omits success signal when callback reverts", async () => {
    const { publicClient, deployer, source, boom, originalId } = await setup();
    const calldata = encodeFunctionData({
      abi: boom.abi,
      functionName: "boom",
      args: [32n],
    });
    const { receipt, returnLegId } = await mineReturnLeg({
      source,
      publicClient,
      deployer,
      targetContract: boom.address,
      methodCall: rawMethod(calldata),
      originalId,
      nonce: 1n,
    });

    const { received, succeeded } = countEvents({
      logs: receipt.logs,
      inbox: source.address,
      abi: source.abi,
    });
    assert.equal(received, 1);
    assert.equal(succeeded, 0);

    const original = (await source.read.getRequest([originalId])) as { executed: boolean };
    assert.equal(original.executed, true);
    const err = (await source.read.getOutboxError([returnLegId])) as [bigint, `0x${string}`];
    assert.equal(err[0], 1n);
  });
});
