import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  decodeAbiParameters,
  decodeEventLog,
  toFunctionSelector,
} from "viem";
import { network } from "hardhat";
import { oracleTokensForChain } from "../scripts/oracle-tokens.js";

const receiptWaitOptions = { timeout: 300_000, pollingInterval: 2_000 };

const SOURCE_CHAIN_ID = 1000n;
const TARGET_CHAIN_ID = 1001n;
const GAS_PRICE_WEI = 1_000_000_000n; // 1 gwei — keeps fee→gas conversion generous
const SEND_VALUE_WEI = 2_000_000_000_000_000n; // 0.002 ether
const CALLBACK_FEE_WEI = 500_000_000_000_000n; // 0.0005 ether → 500_000 gas units
const PRICE_SCALE_18 = 10n ** 18n;

const CONSTANT_FEE = {
  constantFee: 1n,
  gasPerByte: 0n,
  callbackExecutionGas: 0n,
  errorLength: 0n,
  bufferRatioX10000: 0n,
} as const;

const ERROR_CODE_ENCODE_FAILED = 2n;

describe("Inbox system-error callback", { concurrency: false, timeout: 600_000 }, () => {
  it("encode failure emits ErrorReceived + SystemErrorRaised and refuses retry", async () => {
    const { viem } = await network.connect({ network: "hardhat" });
    const publicClient = await viem.getPublicClient();
    const [wallet] = await viem.getWalletClients();
    const deployer = wallet.account.address as `0x${string}`;

    const source = await viem.deployContract("Inbox", [], {
      client: { public: publicClient, wallet },
    });
    await source.write.init([deployer, SOURCE_CHAIN_ID], { account: deployer });
    await source.write.updateMinFeeConfigs([{ ...CONSTANT_FEE }, { ...CONSTANT_FEE }], {
      account: deployer,
    });
    await source.write.addMiner([deployer], { account: deployer });

    const oracle = await viem.deployContract("PriceOracle", [deployer], {
      client: { public: publicClient, wallet },
    });
    const { localToken, remoteToken } = oracleTokensForChain(31337);
    await oracle.write.setInboxTokens([localToken, remoteToken], { account: deployer });
    await oracle.write.setLocalTokenPriceUSD([PRICE_SCALE_18], { account: deployer });
    await oracle.write.setRemoteTokenPriceUSD([PRICE_SCALE_18], { account: deployer });
    await source.write.setPriceOracle([oracle.address], { account: deployer });

    const target = await viem.deployContract("Inbox", [], {
      client: { public: publicClient, wallet },
    });
    await target.write.init([deployer, TARGET_CHAIN_ID], { account: deployer });
    await target.write.updateMinFeeConfigs([{ ...CONSTANT_FEE }, { ...CONSTANT_FEE }], {
      account: deployer,
    });
    await target.write.addMiner([deployer], { account: deployer });
    await target.write.setPriceOracle([oracle.address], { account: deployer });

    // Receiver is called on the *source* inbox (error return leg).
    const receiver = await viem.deployContract("SystemErrorReceiver", [source.address], {
      client: { public: publicClient, wallet },
    });
    const dummyTarget = await viem.deployContract("SystemErrorReceiver", [target.address], {
      client: { public: publicClient, wallet },
    });

    const errorSelector = toFunctionSelector("onSystemError(bytes)");
    // Raw call with datatypes forces encode failure before the COTI target runs.
    const badMethodCall = {
      selector: "0x00000000" as `0x${string}`,
      data: "0x" as `0x${string}`,
      datatypes: ["0x0000000000000001" as `0x${string}`],
      datalens: [] as `0x${string}`[],
    };

    // Impersonate receiver as request sender by using a funded wallet that sends via receiver's
    // address is hard; instead send from deployer then rewrite via mining with sourceContract=receiver.
    const sendHash = await source.write.sendTwoWayMessage(
      [
        TARGET_CHAIN_ID,
        dummyTarget.address,
        badMethodCall,
        "0x00000000",
        errorSelector,
        CALLBACK_FEE_WEI,
      ],
      { account: deployer, value: SEND_VALUE_WEI, gasPrice: GAS_PRICE_WEI }
    );
    await publicClient.waitForTransactionReceipt({ hash: sendHash, ...receiptWaitOptions });

    const outbound = (await source.read.getRequests([TARGET_CHAIN_ID, 0n, 1n])) as any[];
    const request = outbound[0];

    const mineHash = await target.write.batchProcessRequests(
      [
        SOURCE_CHAIN_ID,
        [
          {
            requestId: request.requestId,
            sourceContract: receiver.address,
            targetContract: dummyTarget.address,
            methodCall: request.methodCall,
            callbackSelector: request.callbackSelector,
            errorSelector: request.errorSelector,
            isTwoWay: request.isTwoWay,
            sourceRequestId: request.sourceRequestId,
            targetFee: request.targetFee,
            callerFee: request.callerFee,
          },
        ],
      ],
      { account: deployer, gas: 4_000_000n }
    );
    const mineReceipt = await publicClient.waitForTransactionReceipt({
      hash: mineHash,
      ...receiptWaitOptions,
    });

    let sawErrorReceived = false;
    let sawSystemErrorRaised = false;
    let systemPayload: `0x${string}` | undefined;

    for (const log of mineReceipt.logs) {
      if (log.address.toLowerCase() !== target.address.toLowerCase()) continue;
      try {
        const decoded = decodeEventLog({
          abi: target.abi,
          data: log.data,
          topics: log.topics,
        });
        if (decoded.eventName === "ErrorReceived") {
          sawErrorReceived = true;
          assert.equal(decoded.args.errorCode, ERROR_CODE_ENCODE_FAILED);
        }
        if (decoded.eventName === "SystemErrorRaised") {
          sawSystemErrorRaised = true;
          assert.equal(decoded.args.errorCode, ERROR_CODE_ENCODE_FAILED);
          systemPayload = decoded.args.payload as `0x${string}`;
        }
      } catch {
        // ignore non-matching logs
      }
    }

    assert.equal(sawErrorReceived, true, "ErrorReceived not emitted");
    assert.equal(sawSystemErrorRaised, true, "SystemErrorRaised not emitted");
    assert.ok(systemPayload, "missing system error payload");

    const [code] = decodeAbiParameters(
      [{ type: "uint64" }, { type: "bytes" }],
      systemPayload
    );
    assert.equal(code, ERROR_CODE_ENCODE_FAILED);

    await assert.rejects(
      () => target.write.retryFailedRequest([request.requestId], { account: deployer }),
      /RetryFailedRequestNotAFailedRequest|revert/i
    );

    const targetOutbound = (await target.read.getRequests([SOURCE_CHAIN_ID, 0n, 1n])) as any[];
    assert.equal(targetOutbound.length, 1);
    const reply = targetOutbound[0];
    const systemSender = (await target.read.SYSTEM_SENDER()) as `0x${string}`;
    assert.equal(reply.originalSender.toLowerCase(), systemSender.toLowerCase());
    assert.equal(reply.targetContract.toLowerCase(), receiver.address.toLowerCase());

    const replyMineHash = await source.write.batchProcessRequests(
      [
        TARGET_CHAIN_ID,
        [
          {
            requestId: reply.requestId,
            sourceContract: reply.originalSender,
            targetContract: reply.targetContract,
            methodCall: reply.methodCall,
            callbackSelector: reply.callbackSelector,
            errorSelector: reply.errorSelector,
            isTwoWay: reply.isTwoWay,
            sourceRequestId: reply.sourceRequestId,
            targetFee: reply.targetFee,
            callerFee: reply.callerFee,
          },
        ],
      ],
      { account: deployer, gas: 4_000_000n }
    );
    await publicClient.waitForTransactionReceipt({ hash: replyMineHash, ...receiptWaitOptions });

    const errorCount = await receiver.read.errorCount();
    assert.equal(errorCount, 1n);
    // InboxErrorType.SystemError == 1
    assert.equal(await receiver.read.lastErrorType(), 1);
    const lastError = (await receiver.read.lastError()) as `0x${string}`;
    const [recvCode] = decodeAbiParameters(
      [{ type: "uint64" }, { type: "bytes" }],
      lastError
    );
    assert.equal(recvCode, ERROR_CODE_ENCODE_FAILED);
  });
});
