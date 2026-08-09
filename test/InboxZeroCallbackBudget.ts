import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeEventLog, toHex } from "viem";
import { network } from "hardhat";
import { oracleTokensForChain } from "../scripts/oracle-tokens.js";
import { deployTestInbox, mpcAbiReEncodeOf } from "../scripts/deploy-test-inbox.js";

const SOURCE_CHAIN_ID = 1000n;
const TARGET_CHAIN_ID = 1001n;
const GAS_PRICE_WEI = 1_000_000_000n;
const SEND_VALUE_WEI = 5_000_000_000_000_000n;
const PRICE_SCALE_18 = 10n ** 18n;
const receiptWaitOptions = { timeout: 300_000, pollingInterval: 2_000 };

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

describe("zero-budget return legs", {
  concurrency: false,
  timeout: 600_000,
}, () => {
  it("one-way encode failure emits local SystemErrorRaised without outbound return leg", async () => {
    const { viem } = await network.connect({ network: "hardhat" });
    const publicClient = await viem.getPublicClient();
    const [wallet] = await viem.getWalletClients();
    const deployer = wallet.account.address as `0x${string}`;

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
    await target.write.setPriceOracle([oracle.address], { account: deployer });
    await target.write.setGasPriceBounds([0n, GAS_PRICE_WEI, GAS_PRICE_WEI], { account: deployer });

    const badMethodCall = {
      selector: "0x00000000" as `0x${string}`,
      data: "0x" as `0x${string}`,
      datatypes: ["0x0000000000000001" as `0x${string}`],
      datalens: [] as `0x${string}`[],
    };
    const requestId = toHex((SOURCE_CHAIN_ID << 192n) | (TARGET_CHAIN_ID << 128n) | 1n, { size: 32 });
    const mined = {
      requestId,
      sourceContract: deployer,
      targetContract: deployer,
      methodCall: badMethodCall,
      callbackSelector: "0x00000000" as `0x${string}`,
      errorSelector: "0x12345678" as `0x${string}`,
      isTwoWay: false,
      sourceRequestId: ("0x" + "00".repeat(32)) as `0x${string}`,
      targetFee: 500_000n,
      callerFee: 0n,
    };

    const mineHash = await target.write.batchProcessRequests([SOURCE_CHAIN_ID, [mined]], {
      account: deployer,
      gas: 10_000_000n,
    });
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: mineHash,
      ...receiptWaitOptions,
    });

    assert.equal(await target.read.getRequestsLen([SOURCE_CHAIN_ID]), 0n);

    let sawLocal = false;
    for (const log of receipt.logs) {
      try {
        const decoded = decodeEventLog({
          abi: target.abi,
          data: log.data,
          topics: log.topics,
        });
        if (decoded.eventName === "SystemErrorRaised") {
          sawLocal = true;
          break;
        }
      } catch {
        /* skip */
      }
    }
    assert.ok(sawLocal, "expected local SystemErrorRaised without outbound");
  });

  it("two-way respond with forged callerFee=0 reverts ZeroCallbackBudget", async () => {
    const { viem } = await network.connect({ network: "hardhat" });
    const publicClient = await viem.getPublicClient();
    const [wallet] = await viem.getWalletClients();
    const deployer = wallet.account.address as `0x${string}`;

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
    await target.write.setPriceOracle([oracle.address], { account: deployer });
    await target.write.setGasPriceBounds([0n, GAS_PRICE_WEI, GAS_PRICE_WEI], { account: deployer });

    const estTarget = await viem.deployContract("EstimateGasTarget", [target.address], {
      client: { public: publicClient, wallet },
    });
    await estTarget.write.configure([0n, true, false, "0xab"], { account: deployer });

    const { encodeFunctionData } = await import("viem");
    const entryCall = encodeFunctionData({
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

    const requestId = toHex((SOURCE_CHAIN_ID << 192n) | (TARGET_CHAIN_ID << 128n) | 1n, { size: 32 });
    const mined = {
      requestId,
      sourceContract: deployer,
      targetContract: estTarget.address,
      methodCall: {
        selector: "0x00000000" as const,
        data: entryCall,
        datatypes: [] as const,
        datalens: [] as const,
      },
      callbackSelector: "0x12345678" as `0x${string}`,
      errorSelector: "0x87654321" as `0x${string}`,
      isTwoWay: true,
      sourceRequestId: ("0x" + "00".repeat(32)) as `0x${string}`,
      targetFee: 500_000n,
      callerFee: 0n,
    };

    const mineHash = await target.write.batchProcessRequests([SOURCE_CHAIN_ID, [mined]], {
      account: deployer,
      gas: 10_000_000n,
    });
    await publicClient.waitForTransactionReceipt({ hash: mineHash, ...receiptWaitOptions });

    const err = await target.read.errors([requestId]);
    assert.equal(BigInt((err as any).errorCode ?? (err as any)[1]), 1n);
    assert.equal(await target.read.getRequestsLen([SOURCE_CHAIN_ID]), 0n);
  });
});
