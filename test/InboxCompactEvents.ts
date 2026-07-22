import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeAbiParameters, decodeEventLog, keccak256, toHex } from "viem";
import { network } from "hardhat";
import { oracleTokensForChain } from "../scripts/oracle-tokens.js";

const receiptWaitOptions = { timeout: 300_000, pollingInterval: 2_000 };

const SOURCE_CHAIN_ID = 1000n;
const TARGET_CHAIN_ID = 1001n;
const GAS_PRICE_WEI = 25_000_000_000n;
const SEND_VALUE_WEI = 2_500_000_000_000n;
const PRICE_SCALE_18 = 10n ** 18n;

const CONSTANT_FEE = {
  constantFee: 1n,
  gasPerByte: 0n,
  callbackExecutionGas: 0n,
  errorLength: 0n,
  bufferRatioX10000: 0n,
} as const;

const MPC_METHOD_CALL_TYPE = {
  type: "tuple",
  components: [
    { name: "selector", type: "bytes4" },
    { name: "data", type: "bytes" },
    { name: "datatypes", type: "bytes8[]" },
    { name: "datalens", type: "bytes32[]" },
  ],
} as const;

const methodCallHash = (methodCall: {
  selector: `0x${string}`;
  data: `0x${string}`;
  datatypes: readonly `0x${string}`[];
  datalens: readonly `0x${string}`[];
}) =>
  keccak256(
    encodeAbiParameters(
      [MPC_METHOD_CALL_TYPE],
      [
        {
          selector: methodCall.selector,
          data: methodCall.data,
          datatypes: [...methodCall.datatypes],
          datalens: [...methodCall.datalens],
        },
      ]
    )
  );

describe("Inbox compact message events", { concurrency: false, timeout: 600_000 }, () => {
  it("MessageSent logs compact metadata while storage keeps full methodCall", async () => {
    const { viem } = await network.connect({ network: "hardhat" });
    const publicClient = await viem.getPublicClient();
    const [wallet] = await viem.getWalletClients();
    const deployer = wallet.account.address as `0x${string}`;

    const inbox = await viem.deployContract("Inbox", [], {
      client: { public: publicClient, wallet },
    });
    await inbox.write.init([deployer, SOURCE_CHAIN_ID], { account: deployer });
    await inbox.write.updateMinFeeConfigs([{ ...CONSTANT_FEE }, { ...CONSTANT_FEE }], { account: deployer });

    const oracle = await viem.deployContract("PriceOracle", [deployer], {
      client: { public: publicClient, wallet },
    });
    const { localToken, remoteToken } = oracleTokensForChain(31337);
    await oracle.write.setInboxTokens([localToken, remoteToken], { account: deployer });
    await oracle.write.setLocalTokenPriceUSD([PRICE_SCALE_18], { account: deployer });
    await oracle.write.setRemoteTokenPriceUSD([PRICE_SCALE_18], { account: deployer });
    await inbox.write.setPriceOracle([oracle.address], { account: deployer });

    const methodCall = {
      selector: "0x00000000" as `0x${string}`,
      data: toHex(new Uint8Array([0xde, 0xad, 0xbe, 0xef])) as `0x${string}`,
      datatypes: [] as `0x${string}`[],
      datalens: [] as `0x${string}`[],
    };

    const txHash = await inbox.write.sendOneWayMessage(
      [TARGET_CHAIN_ID, deployer, methodCall, "0x00000000"],
      { account: deployer, value: SEND_VALUE_WEI, gasPrice: GAS_PRICE_WEI }
    );
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, ...receiptWaitOptions });

    const sentLog = receipt.logs.find((log) => log.topics.length === 4);
    assert.ok(sentLog, "MessageSent log not found");

    const decoded = decodeEventLog({
      abi: inbox.abi,
      data: sentLog.data,
      topics: sentLog.topics,
    });
    assert.equal(decoded.eventName, "MessageSent");
    assert.equal(decoded.args.methodSelector, methodCall.selector);
    assert.equal(decoded.args.methodCallHash, methodCallHash(methodCall));
    assert.equal(decoded.args.dataLength, 4n);
    assert.equal(decoded.args.datatypeCount, 0);
    assert.equal(decoded.args.datalenCount, 0);

    const stored = (await inbox.read.getRequests([TARGET_CHAIN_ID, 0n, 1n])) as any[];
    assert.equal(stored.length, 1);
    assert.equal(stored[0].methodCall.data, methodCall.data);
    assert.equal(stored[0].methodCall.selector, methodCall.selector);
  });

  it("MessageReceived logs compact metadata while incoming storage keeps full methodCall", async () => {
    const { viem } = await network.connect({ network: "hardhat" });
    const publicClient = await viem.getPublicClient();
    const [wallet] = await viem.getWalletClients();
    const deployer = wallet.account.address as `0x${string}`;

    const source = await viem.deployContract("Inbox", [], {
      client: { public: publicClient, wallet },
    });
    await source.write.init([deployer, SOURCE_CHAIN_ID], { account: deployer });
    await source.write.updateMinFeeConfigs([{ ...CONSTANT_FEE }, { ...CONSTANT_FEE }], { account: deployer });

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
    await target.write.addMiner([deployer], { account: deployer });

    const methodCall = {
      selector: "0x00000000" as `0x${string}`,
      data: toHex(new Uint8Array(64).fill(0xab)) as `0x${string}`,
      datatypes: [] as `0x${string}`[],
      datalens: [] as `0x${string}`[],
    };

    const sendHash = await source.write.sendOneWayMessage(
      [TARGET_CHAIN_ID, deployer, methodCall, "0x00000000"],
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
            sourceContract: request.originalSender,
            targetContract: request.targetContract,
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
    const receipt = await publicClient.waitForTransactionReceipt({ hash: mineHash, ...receiptWaitOptions });

    const receivedLog = receipt.logs.find((log) => log.topics.length === 4 && log.address === target.address);
    assert.ok(receivedLog, "MessageReceived log not found");

    const decoded = decodeEventLog({
      abi: target.abi,
      data: receivedLog.data,
      topics: receivedLog.topics,
    });
    assert.equal(decoded.eventName, "MessageReceived");
    assert.equal(decoded.args.methodSelector, methodCall.selector);
    assert.equal(decoded.args.methodCallHash, methodCallHash(methodCall));
    assert.equal(decoded.args.dataLength, 64n);

    const incoming = (await target.read.getIncomingRequest([request.requestId])) as any;
    assert.equal(incoming.methodCall.data, methodCall.data);
    assert.equal(incoming.methodCall.selector, methodCall.selector);
  });
});
