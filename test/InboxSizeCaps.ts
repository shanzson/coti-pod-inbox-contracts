import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeEventLog, padHex, toHex, size } from "viem";
import { network } from "hardhat";
import { oracleTokensForChain } from "../scripts/oracle-tokens.js";
import { deployTestInbox, mpcAbiReEncodeOf } from "../scripts/deploy-test-inbox.js";

const receiptWaitOptions = { timeout: 300_000, pollingInterval: 2_000 };

const SOURCE_CHAIN_ID = 1000n;
const TARGET_CHAIN_ID = 1001n;
const GAS_PRICE_WEI = 1_000_000_000n;
const SEND_VALUE_WEI = 2_000_000_000_000_000n;
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

const ERROR_CODE_MINER_REJECTED = 3n;

const minimalMethodCall = (dataHex: `0x${string}` = "0x") => ({
  selector: "0x00000000" as `0x${string}`,
  data: dataHex,
  datatypes: [] as `0x${string}`[],
  datalens: [] as `0x${string}`[],
});

describe("Size caps and miner reject", { concurrency: false, timeout: 600_000 }, () => {
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

    const rejectTools = await viem.deployContract("MinerRejectTools", [], {
      client: { public: publicClient, wallet },
    });

    return { ...env, source, target, rejectTools };
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

  it("rejects updateMinFeeConfigs when constantFee>0 but max caps are zero", async () => {
    const { viem, publicClient, wallet, deployer } = await connect();
    const inbox = await deployTestInbox(viem, { client: { public: publicClient, wallet } });
    await inbox.write.init([deployer, SOURCE_CHAIN_ID, mpcAbiReEncodeOf(inbox)], { account: deployer });
    const bad = { ...FEE, maxMethodCallBytes: 0n };
    await assert.rejects(
      () => inbox.write.updateMinFeeConfigs([{ ...bad }, { ...FEE }], { account: deployer }),
      /FeeConfigInvalid/
    );
  });

  it("reverts create when methodCall payload weight exceeds maxMethodCallBytes", async () => {
    const { source, deployer } = await deployPair();
    const fat = minimalMethodCall(toHex(new Uint8Array(9000)));
    await assert.rejects(
      () =>
        source.write.sendOneWayMessage([TARGET_CHAIN_ID, deployer, fat, "0x00000000"], {
          account: deployer,
          value: SEND_VALUE_WEI,
          gasPrice: GAS_PRICE_WEI,
        }),
      /MethodCallTooLarge/
    );
    assert.equal(await source.read.getRequestsLen([TARGET_CHAIN_ID]), 0n);
  });

  it("owner can retune maxReplyMethodCallBytes", async () => {
    const { target, deployer } = await deployPair();
    assert.equal(BigInt(await target.read.maxReplyMethodCallBytes()), 8192n);
    await target.write.setMaxReplyMethodCallBytes([2048], { account: deployer });
    assert.equal(BigInt(await target.read.maxReplyMethodCallBytes()), 2048n);
    await assert.rejects(
      () => target.write.setMaxReplyMethodCallBytes([0], { account: deployer }),
      /MaxReplyMethodCallBytesInvalid/
    );
  });

  it("helper builds reject methodCall; isMinerRejectMethodCall round-trips", async () => {
    const { rejectTools } = await deployPair();
    const reason = padHex("0x01", { size: 32 });
    const mc = (await rejectTools.read.buildMinerRejectMethodCall([7, reason])) as any;
    assert.equal(mc.selector, "0x00000000");
    assert.equal(mc.datatypes.length, 0);
    assert.equal(mc.datalens.length, 0);
    assert.equal(size(mc.data), 34);

    const parsed = (await rejectTools.read.isMinerRejectMethodCall([mc])) as [boolean, number, `0x${string}`];
    assert.equal(parsed[0], true);
    assert.equal(Number(parsed[1]), 7);
    assert.equal(parsed[2].toLowerCase(), reason.toLowerCase());

    const spoof = { ...mc, datatypes: ["0x0000000000000001" as `0x${string}`] };
    const spoofParsed = (await rejectTools.read.isMinerRejectMethodCall([spoof])) as [
      boolean,
      number,
      `0x${string}`,
    ];
    assert.equal(spoofParsed[0], false);
  });

  it("in-batch reject advances cursor without fat storage; retry fails", async () => {
    const { source, target, deployer, publicClient, rejectTools } = await deployPair();

    const hash = await source.write.sendOneWayMessage(
      [TARGET_CHAIN_ID, deployer, minimalMethodCall(), "0x00000000"],
      { account: deployer, value: SEND_VALUE_WEI, gasPrice: GAS_PRICE_WEI }
    );
    await publicClient.waitForTransactionReceipt({ hash, ...receiptWaitOptions });

    const reqs = (await source.read.getRequests([TARGET_CHAIN_ID, 0n, 1n])) as any[];
    const mined = toMined(reqs[0]);
    const reason = padHex("0xdead", { size: 32 });
    mined.methodCall = (await rejectTools.read.buildMinerRejectMethodCall([1, reason])) as any;

    const mineHash = await target.write.batchProcessRequests([SOURCE_CHAIN_ID, [mined]], {
      account: deployer,
      gas: 10_000_000n,
    });
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: mineHash,
      ...receiptWaitOptions,
    });

    assert.equal(await target.read.lastIncomingRequestId([SOURCE_CHAIN_ID]), mined.requestId);

    const incoming = (await target.read.getIncomingRequest([mined.requestId])) as any;
    assert.equal(incoming.requestId, mined.requestId);
    assert.equal(incoming.executed, true);
    assert.equal(incoming.methodCall.data, "0x");
    assert.equal(incoming.methodCall.datatypes.length, 0);

    const err = (await target.read.errors([mined.requestId])) as any;
    const errorCode = err.errorCode ?? err[1];
    assert.equal(errorCode, ERROR_CODE_MINER_REJECTED);

    let sawRejected = false;
    for (const log of receipt.logs) {
      try {
        const decoded = decodeEventLog({
          abi: target.abi,
          data: log.data,
          topics: log.topics,
        });
        if (decoded.eventName === "RequestRejected") {
          sawRejected = true;
          assert.equal(decoded.args.requestId, mined.requestId);
          assert.equal(Number(decoded.args.rejectionCode), 1);
        }
      } catch {
        // ignore non-matching logs
      }
    }
    assert.equal(sawRejected, true);

    await assert.rejects(
      () => target.write.retryFailedRequest([mined.requestId], { account: deployer, gas: 5_000_000n }),
      /RetryFailedRequestNotAFailedRequest/
    );
  });

  it("ingest overweight without reject sentinel reverts and does not advance cursor", async () => {
    const { source, target, deployer, publicClient } = await deployPair();
    const hash = await source.write.sendOneWayMessage(
      [TARGET_CHAIN_ID, deployer, minimalMethodCall(), "0x00000000"],
      { account: deployer, value: SEND_VALUE_WEI, gasPrice: GAS_PRICE_WEI }
    );
    await publicClient.waitForTransactionReceipt({ hash, ...receiptWaitOptions });
    const reqs = (await source.read.getRequests([TARGET_CHAIN_ID, 0n, 1n])) as any[];
    const mined = toMined(reqs[0]);
    mined.methodCall = minimalMethodCall(toHex(new Uint8Array(9000)));

    await assert.rejects(
      () =>
        target.write.batchProcessRequests([SOURCE_CHAIN_ID, [mined]], {
          account: deployer,
          gas: 10_000_000n,
        }),
      /MethodCallTooLarge/
    );
    assert.equal(
      await target.read.lastIncomingRequestId([SOURCE_CHAIN_ID]),
      "0x0000000000000000000000000000000000000000000000000000000000000000"
    );
  });

  it("happy-path small message still mines and executes", async () => {
    const { source, target, deployer, publicClient } = await deployPair();
    const hash = await source.write.sendOneWayMessage(
      [TARGET_CHAIN_ID, deployer, minimalMethodCall("0x1234"), "0x00000000"],
      { account: deployer, value: SEND_VALUE_WEI, gasPrice: GAS_PRICE_WEI }
    );
    await publicClient.waitForTransactionReceipt({ hash, ...receiptWaitOptions });
    const reqs = (await source.read.getRequests([TARGET_CHAIN_ID, 0n, 1n])) as any[];
    await target.write.batchProcessRequests([SOURCE_CHAIN_ID, reqs.map(toMined)], {
      account: deployer,
      gas: 10_000_000n,
    });
    const incoming = (await target.read.getIncomingRequest([reqs[0].requestId])) as any;
    assert.equal(incoming.executed, true);
    assert.equal(incoming.methodCall.data, "0x1234");
  });
});
