import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeFunctionData, toHex } from "viem";
import { network } from "hardhat";
import { oracleTokensForChain } from "../scripts/oracle-tokens.js";
import { deployTestInbox, mpcAbiReEncodeOf, feeManagerOf } from "../scripts/deploy-test-inbox.js";

const receiptWaitOptions = { timeout: 300_000, pollingInterval: 2_000 };

const SOURCE_CHAIN_ID = 1000n;
const TARGET_CHAIN_ID = 1001n;
const PRICE_SCALE_18 = 10n ** 18n;
const ERROR_CODE_EXECUTION_FAILED = 1n;
const ERROR_CODE_EXPIRED = 4n;
const MESSAGE_LIFE_SECONDS = 100n;

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

describe("maxMessageLife terminalization", {
  concurrency: false,
  timeout: 300_000,
}, () => {
  const setup = async () => {
    const { viem, provider } = await network.connect({ network: "hardhat" });
    const publicClient = await viem.getPublicClient();
    const [wallet] = await viem.getWalletClients();
    const deployer = wallet.account.address as `0x${string}`;

    const inbox = await deployTestInbox(viem, { client: { public: publicClient, wallet } });
    await inbox.write.init([deployer, TARGET_CHAIN_ID, mpcAbiReEncodeOf(inbox), feeManagerOf(inbox)], { account: deployer });
    await inbox.write.updateMinFeeConfigs([{ ...FEE }, { ...FEE }], { account: deployer });
    await inbox.write.addMiner([deployer], { account: deployer });
    await inbox.write.setMaxMessageLife([Number(MESSAGE_LIFE_SECONDS)], { account: deployer });

    const oracle = await viem.deployContract("PriceOracle", [deployer], {
      client: { public: publicClient, wallet },
    });
    const { localToken, remoteToken } = oracleTokensForChain(31337);
    await oracle.write.setInboxTokens([localToken, remoteToken], { account: deployer });
    await oracle.write.setLocalTokenPriceUSD([PRICE_SCALE_18], { account: deployer });
    await oracle.write.setRemoteTokenPriceUSD([PRICE_SCALE_18], { account: deployer });
    await inbox.write.setPriceOracle([oracle.address], { account: deployer });

    const target = await viem.deployContract("LargeRevertTarget", [], {
      client: { public: publicClient, wallet },
    });
    return { inbox, target, deployer, publicClient, provider };
  };

  const mineFailingTwoWay = async (params: {
    inbox: any;
    target: any;
    deployer: `0x${string}`;
    publicClient: any;
    nonce: bigint;
    callerFee: bigint;
  }) => {
    const { inbox, target, deployer, publicClient, nonce, callerFee } = params;
    const requestId = packRequestId(SOURCE_CHAIN_ID, TARGET_CHAIN_ID, nonce);
    const callData = encodeFunctionData({
      abi: target.abi,
      functionName: "boomEmpty",
      args: [],
    });
    const methodCall = {
      selector: "0x00000000" as `0x${string}`,
      data: callData,
      datatypes: [] as `0x${string}`[],
      datalens: [] as `0x${string}`[],
    };
    const hash = await inbox.write.batchProcessRequests(
      [
        SOURCE_CHAIN_ID,
        [
          {
            requestId,
            sourceContract: deployer,
            targetContract: target.address,
            methodCall,
            callbackSelector: "0x11111111",
            errorSelector: "0x22222222",
            isTwoWay: true,
            sourceRequestId: "0x" + "00".repeat(32),
            targetFee: 1_000_000n,
            callerFee,
          },
        ],
      ],
      { account: deployer, gas: 4_000_000n }
    );
    await publicClient.waitForTransactionReceipt({ hash, ...receiptWaitOptions });
    return requestId;
  };

  it("retry after maxMessageLife terminalizes with ERROR_CODE_EXPIRED and blocks further retry", async () => {
    const { inbox, target, deployer, publicClient, provider } = await setup();
    const requestId = await mineFailingTwoWay({
      inbox,
      target,
      deployer,
      publicClient,
      nonce: 1n,
      callerFee: 1_000_000n,
    });

    const errBefore = await inbox.read.errors([requestId]);
    assert.equal(BigInt((errBefore as any).errorCode ?? (errBefore as any)[1]), ERROR_CODE_EXECUTION_FAILED);

    await provider.request({ method: "evm_increaseTime", params: [Number(MESSAGE_LIFE_SECONDS) + 1] });
    await provider.request({ method: "evm_mine", params: [] });

    const ttlHash = await inbox.write.retryFailedRequest([requestId], { account: deployer, gas: 4_000_000n });
    await publicClient.waitForTransactionReceipt({ hash: ttlHash, ...receiptWaitOptions });

    const errAfter = await inbox.read.errors([requestId]);
    assert.equal(BigInt((errAfter as any).errorCode ?? (errAfter as any)[1]), ERROR_CODE_EXPIRED);
    // errorMessage may remain the prior execution-fail payload; code flip is what disables retry.

    const outLen = await inbox.read.getRequestsLen([SOURCE_CHAIN_ID]);
    assert.equal(outLen, 1n, "funded two-way should mint one system-error return leg");

    await assert.rejects(
      () => inbox.write.retryFailedRequest([requestId], { account: deployer }),
      /RetryFailedRequestNotAFailedRequest|revert/i
    );
  });

  it("zero callerFee still terminalizes locally without outbound return leg", async () => {
    const { inbox, target, deployer, publicClient, provider } = await setup();
    const requestId = await mineFailingTwoWay({
      inbox,
      target,
      deployer,
      publicClient,
      nonce: 1n,
      callerFee: 0n,
    });

    await provider.request({ method: "evm_increaseTime", params: [Number(MESSAGE_LIFE_SECONDS) + 1] });
    await provider.request({ method: "evm_mine", params: [] });

    const ttlHash = await inbox.write.retryFailedRequest([requestId], { account: deployer, gas: 4_000_000n });
    await publicClient.waitForTransactionReceipt({ hash: ttlHash, ...receiptWaitOptions });

    const errAfter = await inbox.read.errors([requestId]);
    assert.equal(BigInt((errAfter as any).errorCode ?? (errAfter as any)[1]), ERROR_CODE_EXPIRED);
    assert.equal(await inbox.read.getRequestsLen([SOURCE_CHAIN_ID]), 0n);
  });

  it("maxMessageLife=0 keeps uncapped retry behavior", async () => {
    const { inbox, target, deployer, publicClient, provider } = await setup();
    await inbox.write.setMaxMessageLife([0], { account: deployer });
    const requestId = await mineFailingTwoWay({
      inbox,
      target,
      deployer,
      publicClient,
      nonce: 1n,
      callerFee: 1_000_000n,
    });

    await provider.request({ method: "evm_increaseTime", params: [Number(MESSAGE_LIFE_SECONDS) + 1] });
    await provider.request({ method: "evm_mine", params: [] });

    await assert.rejects(
      () => inbox.write.retryFailedRequest([requestId], { account: deployer, gas: 4_000_000n }),
      /RetryFailedRequestExecutionFailed|revert/i
    );
    const err = await inbox.read.errors([requestId]);
    assert.equal(BigInt((err as any).errorCode ?? (err as any)[1]), ERROR_CODE_EXECUTION_FAILED);
  });
});
