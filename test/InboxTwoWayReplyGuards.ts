import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeFunctionData, toHex } from "viem";
import { network } from "hardhat";
import { oracleTokensForChain } from "../scripts/oracle-tokens.js";
import { deployTestInbox, mpcAbiReEncodeOf, feeManagerOf } from "../scripts/deploy-test-inbox.js";

const SOURCE_CHAIN_ID = 1000n;
const TARGET_CHAIN_ID = 1001n;
const GAS_PRICE_WEI = 1_000_000_000n;
const SEND_VALUE_WEI = 5_000_000_000_000_000n;
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

const receiptWaitOptions = { timeout: 300_000, pollingInterval: 2_000 };

const entryCall = () =>
  encodeFunctionData({
    abi: [
      {
        type: "function",
        name: "entry",
        inputs: [{ name: "data", type: "bytes" }],
        outputs: [],
        stateMutability: "nonpayable",
      },
    ],
    functionName: "entry",
    args: ["0x"],
  });

describe("two-way reply guards (respond/raise)", {
  concurrency: false,
  timeout: 600_000,
}, () => {
  const connect = async () => {
    const { viem } = await network.connect({ network: "hardhat" });
    const publicClient = await viem.getPublicClient();
    const [wallet] = await viem.getWalletClients();
    const deployer = wallet.account.address as `0x${string}`;
    return { viem, publicClient, wallet, deployer };
  };

  const deployPair = async () => {
    const env = await connect();
    const { viem, publicClient, wallet, deployer } = env;

    const source = await deployTestInbox(viem, { client: { public: publicClient, wallet } });
    await source.write.init([deployer, SOURCE_CHAIN_ID, mpcAbiReEncodeOf(source), feeManagerOf(source)], { account: deployer });
    await source.write.updateMinFeeConfigs([{ ...FEE }, { ...FEE }], { account: deployer });
    await source.write.addMiner([deployer], { account: deployer });

    const target = await deployTestInbox(viem, { client: { public: publicClient, wallet } });
    await target.write.init([deployer, TARGET_CHAIN_ID, mpcAbiReEncodeOf(target), feeManagerOf(target)], { account: deployer });
    await target.write.updateMinFeeConfigs([{ ...FEE }, { ...FEE }], { account: deployer });
    await target.write.addMiner([deployer], { account: deployer });

    const oracle = await viem.deployContract("PriceOracle", [deployer], {
      client: { public: publicClient, wallet },
    });
    const { localToken, remoteToken } = oracleTokensForChain(31337);
    await oracle.write.setInboxTokens([localToken, remoteToken], { account: deployer });
    await oracle.write.setLocalTokenPriceUSD([PRICE_SCALE_18], { account: deployer });
    await oracle.write.setRemoteTokenPriceUSD([PRICE_SCALE_18], { account: deployer });
    await source.write.setPriceOracle([oracle.address], { account: deployer });
    await target.write.setPriceOracle([oracle.address], { account: deployer });
    await source.write.setGasPriceBounds([0n, GAS_PRICE_WEI, GAS_PRICE_WEI], { account: deployer });
    await target.write.setGasPriceBounds([0n, GAS_PRICE_WEI, GAS_PRICE_WEI], { account: deployer });

    const estTarget = await viem.deployContract("EstimateGasTarget", [target.address], {
      client: { public: publicClient, wallet },
    });

    return { ...env, source, target, estTarget };
  };

  const packRequestId = (source: bigint, dest: bigint, nonce: bigint): `0x${string}` =>
    toHex((source << 192n) | (dest << 128n) | nonce, { size: 32 });

  const mineEntry = async (params: {
    target: any;
    estTarget: any;
    deployer: `0x${string}`;
    publicClient: any;
    isTwoWay: boolean;
    callbackSelector: `0x${string}`;
    errorSelector: `0x${string}`;
    nonce?: bigint;
  }) => {
    const {
      target,
      estTarget,
      deployer,
      publicClient,
      isTwoWay,
      callbackSelector,
      errorSelector,
      nonce = 1n,
    } = params;
    const mined = {
      requestId: packRequestId(SOURCE_CHAIN_ID, TARGET_CHAIN_ID, nonce),
      sourceContract: deployer,
      targetContract: estTarget.address,
      methodCall: {
        selector: "0x00000000" as const,
        data: entryCall(),
        datatypes: [] as const,
        datalens: [] as const,
      },
      callbackSelector,
      errorSelector,
      isTwoWay,
      sourceRequestId: ("0x" + "00".repeat(32)) as `0x${string}`,
      targetFee: 500_000n,
      callerFee: isTwoWay ? 200_000n : 0n,
    };
    const hash = await target.write.batchProcessRequests([SOURCE_CHAIN_ID, [mined]], {
      account: deployer,
      gas: 10_000_000n,
    });
    await publicClient.waitForTransactionReceipt({ hash, ...receiptWaitOptions });
    return mined;
  };

  it("respond/raise on one-way revert NotTwoWayMessage and leave no outbound reply", async () => {
    const { target, estTarget, deployer, publicClient } = await deployPair();
    await estTarget.write.configure([0n, true, false, "0xabcd"], { account: deployer });

    const mined = await mineEntry({
      target,
      estTarget,
      deployer,
      publicClient,
      isTwoWay: false,
      callbackSelector: "0x12345678",
      errorSelector: "0x87654321",
    });

    const incoming = await target.read.incomingRequests([mined.requestId]);
    const executed = Boolean((incoming as any).executed ?? (incoming as any)[10]);
    assert.equal(executed, true);

    const err = await target.read.errors([mined.requestId]);
    const errorCode = BigInt((err as any).errorCode ?? (err as any)[1]);
    assert.equal(errorCode, 1n, "target call should fail with execution error");

    const outLen = await target.read.getRequestsLen([SOURCE_CHAIN_ID]);
    assert.equal(outLen, 0n, "one-way must not mint a return leg");
  });

  it("raise on one-way also leaves no outbound reply", async () => {
    const { target, estTarget, deployer, publicClient } = await deployPair();
    await estTarget.write.configure([0n, false, true, "0xee"], { account: deployer });

    const mined = await mineEntry({
      target,
      estTarget,
      deployer,
      publicClient,
      isTwoWay: false,
      callbackSelector: "0x12345678",
      errorSelector: "0x87654321",
      nonce: 1n,
    });

    const err = await target.read.errors([mined.requestId]);
    assert.equal(BigInt((err as any).errorCode ?? (err as any)[1]), 1n);
    assert.equal(await target.read.getRequestsLen([SOURCE_CHAIN_ID]), 0n);
  });

  it("respond with zero callbackSelector reverts NoCallbackHandler", async () => {
    const { target, estTarget, deployer, publicClient } = await deployPair();
    await estTarget.write.configure([0n, true, false, "0xabcd"], { account: deployer });

    const mined = await mineEntry({
      target,
      estTarget,
      deployer,
      publicClient,
      isTwoWay: true,
      callbackSelector: "0x00000000",
      errorSelector: "0x87654321",
    });

    const err = await target.read.errors([mined.requestId]);
    const errorCode = BigInt((err as any).errorCode ?? (err as any)[1]);
    assert.equal(errorCode, 1n);

    const outLen = await target.read.getRequestsLen([SOURCE_CHAIN_ID]);
    assert.equal(outLen, 0n);
  });

  it("two-way respond still creates a return leg", async () => {
    const { target, estTarget, deployer, publicClient } = await deployPair();
    await estTarget.write.configure([0n, true, false, "0xabcd"], { account: deployer });

    await mineEntry({
      target,
      estTarget,
      deployer,
      publicClient,
      isTwoWay: true,
      callbackSelector: "0x12345678",
      errorSelector: "0x87654321",
    });

    const outLen = await target.read.getRequestsLen([SOURCE_CHAIN_ID]);
    assert.equal(outLen, 1n);
  });
});
