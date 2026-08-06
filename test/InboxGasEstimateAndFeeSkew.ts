import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeErrorResult, encodeFunctionData, toHex } from "viem";
import { network } from "hardhat";
import { oracleTokensForChain } from "../scripts/oracle-tokens.js";
import { deployTestInbox, mpcAbiReEncodeOf } from "../scripts/deploy-test-inbox.js";

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

const ESTIMATE_ERROR_ABI = [
  {
    type: "error",
    name: "ExecutionGasEstimate",
    inputs: [
      { name: "gasUsed", type: "uint256" },
      { name: "responseDataSize", type: "uint256" },
      { name: "errorDataSize", type: "uint256" },
    ],
  },
] as const;

describe("estimateExecutionGasForMiner and gasPriceMul/Div", {
  concurrency: false,
  timeout: 600_000,
}, () => {
  const connect = async () => {
    const { viem } = await network.connect({ network: "hardhat" });
    const publicClient = await viem.getPublicClient();
    const [wallet, otherWallet] = await viem.getWalletClients();
    const deployer = wallet.account.address as `0x${string}`;
    const other = otherWallet.account.address as `0x${string}`;
    return { viem, publicClient, wallet, otherWallet, deployer, other };
  };

  const deployPair = async () => {
    const env = await connect();
    const { viem, publicClient, wallet, deployer } = env;

    const source = await deployTestInbox(viem, { client: { public: publicClient, wallet } });
    await source.write.init([deployer, SOURCE_CHAIN_ID, mpcAbiReEncodeOf(source)], { account: deployer });
    await source.write.updateMinFeeConfigs([{ ...FEE }, { ...FEE }], { account: deployer });
    await source.write.addMiner([deployer], { account: deployer });

    const target = await deployTestInbox(viem, { client: { public: publicClient, wallet } });
    await target.write.init([deployer, TARGET_CHAIN_ID, mpcAbiReEncodeOf(target)], { account: deployer });
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

  const parseEstimate = (e: any) => {
    const raw = e?.data ?? e?.cause?.data ?? e?.walk?.()?.data;
    const data = typeof raw === "string" ? raw : raw?.data;
    assert.ok(data, `missing revert data: ${String(e)}`);
    return decodeErrorResult({ abi: ESTIMATE_ERROR_ABI, data: data as `0x${string}` });
  };

  const rawEntryCall = () =>
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

  it("gasPriceMul/Div: exact targetFee and callerFee for remote and local skew", async () => {
    const { source, deployer, publicClient } = await deployPair();
    const methodCall = {
      selector: "0x00000000" as const,
      data: "0x" as const,
      datatypes: [] as const,
      datalens: [] as const,
    };
    const callback = "0x12345678" as `0x${string}`;
    const errSel = "0x87654321" as `0x${string}`;
    const totalWei = SEND_VALUE_WEI;
    const callbackWei = SEND_VALUE_WEI / 2n;

    const expected = (localMul: bigint, localDiv: bigint, remoteMul: bigint, remoteDiv: bigint) => {
      const callerBase = callbackWei / GAS_PRICE_WEI;
      const remoteBase = (totalWei - callbackWei) / GAS_PRICE_WEI;
      return {
        callerFee: (callerBase * localMul) / localDiv,
        targetFee: (remoteBase * remoteMul) / remoteDiv,
      };
    };

    const cases = [
      { name: "baseline", localMul: 1n, localDiv: 1n, remoteMul: 1n, remoteDiv: 1n },
      { name: "target higher", localMul: 1n, localDiv: 1n, remoteMul: 2n, remoteDiv: 1n },
      { name: "target lower", localMul: 1n, localDiv: 1n, remoteMul: 1n, remoteDiv: 2n },
      { name: "callback higher", localMul: 2n, localDiv: 1n, remoteMul: 1n, remoteDiv: 1n },
      { name: "callback lower", localMul: 1n, localDiv: 2n, remoteMul: 1n, remoteDiv: 1n },
      { name: "both skewed", localMul: 2n, localDiv: 3n, remoteMul: 3n, remoteDiv: 2n },
    ] as const;

    let nonce = 0n;
    for (const c of cases) {
      await source.write.updateMinFeeConfigs(
        [
          { ...FEE, gasPriceMul: c.localMul, gasPriceDiv: c.localDiv },
          { ...FEE, gasPriceMul: c.remoteMul, gasPriceDiv: c.remoteDiv },
        ],
        { account: deployer }
      );
      const hash = await source.write.sendTwoWayMessage(
        [TARGET_CHAIN_ID, deployer, methodCall, callback, errSel, callbackWei],
        { account: deployer, value: totalWei, gasPrice: GAS_PRICE_WEI }
      );
      await publicClient.waitForTransactionReceipt({ hash });
      nonce += 1n;
      const id = packRequestId(SOURCE_CHAIN_ID, TARGET_CHAIN_ID, nonce);
      const req = await source.read.requests([id]);
      const targetFee = BigInt((req as any).targetFee ?? (req as any)[12]);
      const callerFee = BigInt((req as any).callerFee ?? (req as any)[13]);
      const exp = expected(c.localMul, c.localDiv, c.remoteMul, c.remoteDiv);
      assert.equal(targetFee, exp.targetFee, `${c.name}: targetFee`);
      assert.equal(callerFee, exp.callerFee, `${c.name}: callerFee`);
    }

    await assert.rejects(
      () =>
        source.write.updateMinFeeConfigs([{ ...FEE, gasPriceMul: 0n }, { ...FEE }], {
          account: deployer,
        }),
      /FeeConfigInvalid/
    );
  });

  it("estimate returns gasUsed; respond sets responseDataSize", async () => {
    const { publicClient, deployer, target, estTarget } = await deployPair();
    const payload = "0x68656c6c6f2d726573706f6e73652d7061796c6f61642121" as `0x${string}`;
    await estTarget.write.configure([0n, true, false, payload], { account: deployer });

    const requestId = packRequestId(SOURCE_CHAIN_ID, TARGET_CHAIN_ID, 1n);
    const mined = {
      requestId,
      sourceContract: deployer,
      targetContract: estTarget.address,
      methodCall: {
        selector: "0x00000000" as const,
        data: rawEntryCall(),
        datatypes: [] as const,
        datalens: [] as const,
      },
      callbackSelector: "0x12345678" as `0x${string}`,
      errorSelector: "0x87654321" as `0x${string}`,
      isTwoWay: true,
      sourceRequestId: ("0x" + "00".repeat(32)) as `0x${string}`,
      targetFee: 500_000n,
      callerFee: 200_000n,
    };

    let decoded: ReturnType<typeof decodeErrorResult> | null = null;
    try {
      await publicClient.simulateContract({
        address: target.address,
        abi: target.abi,
        functionName: "estimateExecutionGasForMiner",
        args: [SOURCE_CHAIN_ID, mined, 1_000_000n],
        account: deployer,
      });
      assert.fail("expected revert");
    } catch (e: any) {
      decoded = parseEstimate(e);
    }
    assert.ok(decoded);
    assert.equal(decoded!.errorName, "ExecutionGasEstimate");
    const [gasUsed, responseDataSize, errorDataSize] = decoded!.args as [bigint, bigint, bigint];
    assert.ok(gasUsed > 0n);
    assert.ok(responseDataSize > 0n);
    assert.equal(errorDataSize, 0n);

    const stored = await target.read.incomingRequests([requestId]);
    const storedId = (stored as any).requestId ?? (stored as any)[0];
    assert.equal(storedId, "0x" + "00".repeat(32));
  });

  it("public eth_call works from a non-miner account", async () => {
    const { publicClient, other, target, estTarget, deployer } = await deployPair();
    await estTarget.write.configure([0n, false, false, "0x"], { account: deployer });
    const mined = {
      requestId: packRequestId(SOURCE_CHAIN_ID, TARGET_CHAIN_ID, 1n),
      sourceContract: deployer,
      targetContract: estTarget.address,
      methodCall: {
        selector: "0x00000000" as const,
        data: rawEntryCall(),
        datatypes: [] as const,
        datalens: [] as const,
      },
      callbackSelector: "0x00000000" as `0x${string}`,
      errorSelector: "0x00000000" as `0x${string}`,
      isTwoWay: false,
      sourceRequestId: ("0x" + "00".repeat(32)) as `0x${string}`,
      targetFee: 300_000n,
      callerFee: 0n,
    };
    try {
      await publicClient.simulateContract({
        address: target.address,
        abi: target.abi,
        functionName: "estimateExecutionGasForMiner",
        args: [SOURCE_CHAIN_ID, mined, 500_000n],
        account: other,
      });
      assert.fail("expected estimate revert");
    } catch (e: any) {
      const decoded = parseEstimate(e);
      assert.equal(decoded.errorName, "ExecutionGasEstimate");
      assert.ok((decoded.args[0] as bigint) > 0n);
    }
  });
});
