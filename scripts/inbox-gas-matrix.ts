import { encodeFunctionData, zeroHash } from "viem";
import { network } from "hardhat";
import { oracleTokensForChain } from "./oracle-tokens.js";

const receiptWaitOptions = { timeout: 300_000, pollingInterval: 2_000 };

const SOURCE_CHAIN_ID = 1000n;
const TARGET_CHAIN_ID = 1001n;
const GAS_PRICE_WEI = 25_000_000_000n;
const SEND_VALUE_WEI = 10_000_000_000_000_000n;
const TARGET_GAS_UNITS = 1_000_000n;
const PRICE_SCALE_18 = 10n ** 18n;

const CONSTANT_FEE = {
  constantFee: 1n,
  gasPerByte: 0n,
  callbackExecutionGas: 0n,
  errorLength: 0n,
  bufferRatioX10000: 0n,
} as const;

const rawMethodCall = (data: `0x${string}`) => ({
  selector: "0x00000000" as `0x${string}`,
  data,
  datatypes: [] as `0x${string}`[],
  datalens: [] as `0x${string}`[],
});

const main = async () => {
  const { viem } = await network.connect({ network: "hardhat" });
  const publicClient = await viem.getPublicClient();
  const [wallet] = await viem.getWalletClients();
  const deployer = wallet.account.address as `0x${string}`;

  const deployInbox = async (chainId: bigint, withOracle: boolean) => {
    const inbox = await viem.deployContract("Inbox", [], {
      client: { public: publicClient, wallet },
    });
    await inbox.write.init([deployer, chainId], { account: deployer });
    await inbox.write.updateMinFeeConfigs([{ ...CONSTANT_FEE }, { ...CONSTANT_FEE }], { account: deployer });
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
    return inbox;
  };

  const source = await deployInbox(SOURCE_CHAIN_ID, true);
  const targetInbox = await deployInbox(TARGET_CHAIN_ID, false);
  await targetInbox.write.addMiner([deployer], { account: deployer });

  const target = await viem.deployContract("InboxGasTarget", [targetInbox.address], {
    client: { public: publicClient, wallet },
  });

  const report: Record<string, string> = {};
  const record = async (label: string, hash: `0x${string}`) => {
    const receipt = await publicClient.waitForTransactionReceipt({ hash, ...receiptWaitOptions });
    report[label] = receipt.gasUsed.toString();
  };

  const observeData = encodeFunctionData({
    abi: target.abi,
    functionName: "observe",
    args: ["0x1234"],
  });
  const respondData = encodeFunctionData({
    abi: target.abi,
    functionName: "observeAndRespond",
    args: ["0x5678"],
  });

  await record(
    "sendOneWay.raw.2bytes",
    await source.write.sendOneWayMessage(
      [TARGET_CHAIN_ID, target.address, rawMethodCall(observeData), "0x00000000"],
      { account: deployer, value: SEND_VALUE_WEI, gasPrice: GAS_PRICE_WEI }
    )
  );
  await record(
    "sendTwoWay.raw.2bytes",
    await source.write.sendTwoWayMessage(
      [TARGET_CHAIN_ID, target.address, rawMethodCall(respondData), "0x12345678", "0x00000000", SEND_VALUE_WEI / 2n],
      { account: deployer, value: SEND_VALUE_WEI, gasPrice: GAS_PRICE_WEI }
    )
  );

  const mined = async (nonce: bigint, data: `0x${string}`, isTwoWay = false, callerFee = 0n) => ({
    requestId: await targetInbox.read.getRequestId([SOURCE_CHAIN_ID, TARGET_CHAIN_ID, nonce]),
    sourceContract: deployer,
    targetContract: target.address,
    methodCall: rawMethodCall(data),
    callbackSelector: "0x12345678" as `0x${string}`,
    errorSelector: "0x00000000" as `0x${string}`,
    isTwoWay,
    sourceRequestId: zeroHash,
    targetFee: TARGET_GAS_UNITS,
    callerFee,
  });

  await record(
    "batchProcessRequests.raw.success",
    await targetInbox.write.batchProcessRequests([SOURCE_CHAIN_ID, [await mined(1n, observeData)]], {
      account: deployer,
      gas: 4_000_000n,
    })
  );

  await record(
    "batchProcessRequests.raw.respond",
    await targetInbox.write.batchProcessRequests([SOURCE_CHAIN_ID, [await mined(2n, respondData, true, TARGET_GAS_UNITS)]], {
      account: deployer,
      gas: 5_000_000n,
    })
  );

  const failHash = await target.write.setShouldFail([true], { account: deployer });
  await publicClient.waitForTransactionReceipt({ hash: failHash, ...receiptWaitOptions });
  const failedRequest = await mined(3n, observeData);
  await record(
    "batchProcessRequests.raw.failure",
    await targetInbox.write.batchProcessRequests([SOURCE_CHAIN_ID, [failedRequest]], {
      account: deployer,
      gas: 4_000_000n,
    })
  );

  const passHash = await target.write.setShouldFail([false], { account: deployer });
  await publicClient.waitForTransactionReceipt({ hash: passHash, ...receiptWaitOptions });
  await record(
    "retryFailedRequest.raw.success",
    await targetInbox.write.retryFailedRequest([failedRequest.requestId], {
      account: deployer,
      gas: 4_000_000n,
    })
  );

  const getRequestsEstimate = await publicClient.estimateContractGas({
    address: source.address,
    abi: source.abi,
    functionName: "getRequests",
    args: [TARGET_CHAIN_ID, 0n, 2n],
    account: deployer,
  });
  report["estimate.getRequests.2"] = getRequestsEstimate.toString();

  console.log("[inbox-gas] " + JSON.stringify(report, null, 2));
};

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
