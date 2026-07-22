import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import {
  decodeAbiParameters,
  encodeFunctionData,
  toHex,
  type Hex,
} from "viem";
import { network } from "hardhat";
import { oracleTokensForChain } from "../scripts/oracle-tokens.js";

const receiptWaitOptions = { timeout: 300_000, pollingInterval: 2_000 };

const SOURCE_CHAIN_ID = 1000n;
const TARGET_CHAIN_ID = 1001n;
const PRICE_SCALE_18 = 10n ** 18n;
const MAX_ERROR_RETURN_DATA = 256n;
/** Large enough to exceed {MAX_ERROR_RETURN_DATA} while fitting under EDR's 2^24 gas cap. */
const LARGE_REVERT_SIZE = 8_192n;

const CONSTANT_FEE = {
  constantFee: 1n,
  gasPerByte: 0n,
  callbackExecutionGas: 0n,
  errorLength: 0n,
  bufferRatioX10000: 0n,
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

type Harness = {
  publicClient: any;
  deployer: `0x${string}`;
  inbox: any;
  target: any;
  nextNonce: number;
};

const deployHarness = async (): Promise<Harness> => {
  const { viem } = await network.connect({ network: "hardhat" });
  const publicClient = await viem.getPublicClient();
  const [wallet] = await viem.getWalletClients();
  const deployer = wallet.account.address as `0x${string}`;

  const inbox = await viem.deployContract("Inbox", [], {
    client: { public: publicClient, wallet },
  });
  await inbox.write.init([deployer, TARGET_CHAIN_ID], { account: deployer });
  await inbox.write.updateMinFeeConfigs([{ ...CONSTANT_FEE }, { ...CONSTANT_FEE }], {
    account: deployer,
  });
  await inbox.write.addMiner([deployer], { account: deployer });

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

  return { publicClient, deployer, inbox, target, nextNonce: 1 };
};

/** Mine one failing request; returns requestId. */
const mineFailing = async (h: Harness, calldata: Hex, targetFee = 5_000_000n): Promise<`0x${string}`> => {
  const requestId = packRequestId(SOURCE_CHAIN_ID, TARGET_CHAIN_ID, BigInt(h.nextNonce));
  h.nextNonce += 1;
  const hash = await h.inbox.write.batchProcessRequests(
    [
      SOURCE_CHAIN_ID,
      [
        {
          requestId,
          sourceContract: h.deployer,
          targetContract: h.target.address,
          methodCall: rawMethod(calldata),
          callbackSelector: "0x00000000",
          errorSelector: "0x00000000",
          isTwoWay: false,
          sourceRequestId: toHex(0n, { size: 32 }),
          targetFee,
          callerFee: 0n,
        },
      ],
    ],
    { account: h.deployer, gas: 15_000_000n }
  );
  const receipt = await h.publicClient.waitForTransactionReceipt({
    hash,
    ...receiptWaitOptions,
  });
  assert.equal(receipt.status, "success", "mine tx should succeed even when target reverts");
  return requestId;
};

const readStored = async (h: Harness, requestId: `0x${string}`) => {
  const errTuple = (await h.inbox.read.errors([requestId])) as readonly [
    `0x${string}`,
    bigint,
    `0x${string}`,
  ];
  const [, errorCode, errorMessage] = errTuple;
  assert.equal(errorCode, 1n, "expected ERROR_CODE_EXECUTION_FAILED");
  const [fullLength, prefix] = decodeAbiParameters(
    [{ type: "uint256" }, { type: "bytes" }],
    errorMessage
  ) as [bigint, `0x${string}`];
  return { fullLength, prefix, errorMessage };
};

const readOutbox = async (h: Harness, requestId: `0x${string}`) => {
  const [code, message] = (await h.inbox.read.getOutboxError([requestId])) as readonly [
    bigint,
    string,
  ];
  assert.equal(code, 1n);
  return message;
};

const prefixHex = (prefix: `0x${string}`) => prefix.slice(2).toLowerCase();

describe("Inbox POD-02 capped returndata + getOutboxError readability", {
  concurrency: false,
  timeout: 600_000,
}, () => {
  let h: Harness;

  before(async () => {
    h = await deployHarness();
  });

  it("short Error(string) is fully readable via getOutboxError", async () => {
    const reason = "insufficient balance";
    const calldata = encodeFunctionData({
      abi: h.target.abi,
      functionName: "boomErrorString",
      args: [reason],
    });
    const rid = await mineFailing(h, calldata);
    const { fullLength, prefix } = await readStored(h, rid);
    assert.ok(fullLength <= MAX_ERROR_RETURN_DATA);
    assert.equal(BigInt((prefix.length - 2) / 2), fullLength);

    const message = await readOutbox(h, rid);
    assert.equal(message, reason);
  });

  it("Error(string) that fits under the cap is fully readable", async () => {
    // ABI Error(string) = 68 + ceil(n/32)*32. Body 160 → 68+160 = 228 ≤ 256.
    const bodyLen = 160;
    const calldata = encodeFunctionData({
      abi: h.target.abi,
      functionName: "boomErrorStringRepeated",
      args: ["0x41", BigInt(bodyLen)],
    });
    const rid = await mineFailing(h, calldata);
    const { fullLength, prefix } = await readStored(h, rid);
    assert.ok(fullLength <= MAX_ERROR_RETURN_DATA);
    assert.equal(fullLength, 228n);
    assert.equal(BigInt((prefix.length - 2) / 2), fullLength);

    const message = await readOutbox(h, rid);
    assert.equal(message, "A".repeat(bodyLen));
  });

  it("oversized Error(string) keeps a readable truncated message prefix (not corrupted)", async () => {
    const bodyLen = 500;
    const calldata = encodeFunctionData({
      abi: h.target.abi,
      functionName: "boomErrorStringRepeated",
      args: ["0x42", BigInt(bodyLen)],
    });
    const rid = await mineFailing(h, calldata);
    const { fullLength, prefix } = await readStored(h, rid);
    assert.ok(fullLength > MAX_ERROR_RETURN_DATA, `fullLength=${fullLength}`);
    assert.equal(BigInt((prefix.length - 2) / 2), MAX_ERROR_RETURN_DATA);

    const message = await readOutbox(h, rid);
    assert.ok(message.length > 0, "expected truncated readable prefix");
    assert.ok(message.length < bodyLen, "must be truncated vs original");
    assert.match(message, /^B+$/, `corrupted message: ${JSON.stringify(message)}`);
    // Available body bytes in a 256-byte prefix after Error(string) header (68).
    assert.equal(message.length, 188);
    assert.equal(message, "B".repeat(188));
  });

  it("empty revert stores empty prefix; getOutboxError returns empty string", async () => {
    const calldata = encodeFunctionData({
      abi: h.target.abi,
      functionName: "boomEmpty",
      args: [],
    });
    const rid = await mineFailing(h, calldata);
    const { fullLength, prefix } = await readStored(h, rid);
    assert.equal(fullLength, 0n);
    assert.equal(prefix, "0x");
    const message = await readOutbox(h, rid);
    assert.equal(message, "");
  });

  it("Panic returndata is hex-encoded uncorrupted via getOutboxError", async () => {
    const calldata = encodeFunctionData({
      abi: h.target.abi,
      functionName: "boomPanic",
      args: [],
    });
    const rid = await mineFailing(h, calldata, 2_000_000n);
    const { fullLength, prefix } = await readStored(h, rid);
    assert.ok(fullLength > 0n);
    assert.equal(BigInt((prefix.length - 2) / 2), fullLength);
    // Panic(uint256) selector 0x4e487b71
    assert.ok(prefixHex(prefix).startsWith("4e487b71"), `prefix=${prefix}`);

    const message = await readOutbox(h, rid);
    assert.equal(message.toLowerCase(), prefixHex(prefix));
  });

  it("custom error is hex-encoded; hint text still identifiable in hex", async () => {
    const hint = "FactoryNotAllowed";
    const calldata = encodeFunctionData({
      abi: h.target.abi,
      functionName: "boomCustom",
      args: [42n, hint],
    });
    const rid = await mineFailing(h, calldata);
    const { fullLength, prefix } = await readStored(h, rid);
    assert.ok(fullLength <= MAX_ERROR_RETURN_DATA);
    assert.equal(BigInt((prefix.length - 2) / 2), fullLength);

    const message = await readOutbox(h, rid);
    assert.equal(message.toLowerCase(), prefixHex(prefix));
    const hintHex = Buffer.from(hint, "utf8").toString("hex");
    assert.ok(message.toLowerCase().includes(hintHex), `hint hex missing from ${message}`);
  });

  it("exact 256-byte raw revert is stored in full; getOutboxError hex matches prefix", async () => {
    const calldata = encodeFunctionData({
      abi: h.target.abi,
      functionName: "boom",
      args: [MAX_ERROR_RETURN_DATA],
    });
    const rid = await mineFailing(h, calldata);
    const { fullLength, prefix } = await readStored(h, rid);
    assert.equal(fullLength, MAX_ERROR_RETURN_DATA);
    assert.equal(BigInt((prefix.length - 2) / 2), MAX_ERROR_RETURN_DATA);
    assert.equal(prefixHex(prefix), "00".repeat(Number(MAX_ERROR_RETURN_DATA)));

    const message = await readOutbox(h, rid);
    assert.equal(message.toLowerCase(), prefixHex(prefix));
    assert.equal(message.length, Number(MAX_ERROR_RETURN_DATA) * 2);
  });

  it("huge raw revert is capped at 256; fullLength preserved; hex is uncorrupted zeros", async () => {
    const calldata = encodeFunctionData({
      abi: h.target.abi,
      functionName: "boom",
      args: [LARGE_REVERT_SIZE],
    });
    const rid = await mineFailing(h, calldata);
    const { fullLength, prefix, errorMessage } = await readStored(h, rid);
    assert.equal(fullLength, LARGE_REVERT_SIZE);
    assert.equal(BigInt((prefix.length - 2) / 2), MAX_ERROR_RETURN_DATA);
    assert.ok(
      (errorMessage.length - 2) / 2 < 600,
      `stored error too large: ${(errorMessage.length - 2) / 2}`
    );
    assert.equal(prefixHex(prefix), "00".repeat(Number(MAX_ERROR_RETURN_DATA)));

    const message = await readOutbox(h, rid);
    assert.equal(message.toLowerCase(), prefixHex(prefix));
    assert.notEqual(message.toLowerCase(), errorMessage.slice(2).toLowerCase());
  });

  it("tiny raw revert (1–16 bytes) is stored in full without padding corruption", async () => {
    for (const size of [1n, 4n, 16n]) {
      const calldata = encodeFunctionData({
        abi: h.target.abi,
        functionName: "boom",
        args: [size],
      });
      const rid = await mineFailing(h, calldata);
      const { fullLength, prefix } = await readStored(h, rid);
      assert.equal(fullLength, size);
      assert.equal(BigInt((prefix.length - 2) / 2), size);
      assert.equal(prefixHex(prefix), "00".repeat(Number(size)));

      const message = await readOutbox(h, rid);
      assert.equal(message.toLowerCase(), prefixHex(prefix));
    }
  });

  it("contiguous next nonce still works after a failed large revert", async () => {
    const boomCalldata = encodeFunctionData({
      abi: h.target.abi,
      functionName: "boom",
      args: [LARGE_REVERT_SIZE],
    });
    const okCalldata = encodeFunctionData({
      abi: h.target.abi,
      functionName: "ok",
      args: [],
    });
    const ridFail = packRequestId(SOURCE_CHAIN_ID, TARGET_CHAIN_ID, BigInt(h.nextNonce));
    const ridOk = packRequestId(SOURCE_CHAIN_ID, TARGET_CHAIN_ID, BigInt(h.nextNonce + 1));
    h.nextNonce += 2;

    const hash = await h.inbox.write.batchProcessRequests(
      [
        SOURCE_CHAIN_ID,
        [
          {
            requestId: ridFail,
            sourceContract: h.deployer,
            targetContract: h.target.address,
            methodCall: rawMethod(boomCalldata),
            callbackSelector: "0x00000000",
            errorSelector: "0x00000000",
            isTwoWay: false,
            sourceRequestId: toHex(0n, { size: 32 }),
            targetFee: 5_000_000n,
            callerFee: 0n,
          },
          {
            requestId: ridOk,
            sourceContract: h.deployer,
            targetContract: h.target.address,
            methodCall: rawMethod(okCalldata),
            callbackSelector: "0x00000000",
            errorSelector: "0x00000000",
            isTwoWay: false,
            sourceRequestId: toHex(0n, { size: 32 }),
            targetFee: 100_000n,
            callerFee: 0n,
          },
        ],
      ],
      { account: h.deployer, gas: 15_000_000n }
    );
    const receipt = await h.publicClient.waitForTransactionReceipt({
      hash,
      ...receiptWaitOptions,
    });
    assert.equal(receipt.status, "success");

    const incomingOk = (await h.inbox.read.getIncomingRequest([ridOk])) as { executed: boolean };
    assert.equal(incomingOk.executed, true);
    const lastId = (await h.inbox.read.lastIncomingRequestId([SOURCE_CHAIN_ID])) as `0x${string}`;
    assert.equal(lastId.toLowerCase(), ridOk.toLowerCase());

    const { fullLength, prefix } = await readStored(h, ridFail);
    assert.equal(fullLength, LARGE_REVERT_SIZE);
    assert.equal(BigInt((prefix.length - 2) / 2), MAX_ERROR_RETURN_DATA);
    assert.equal((await readOutbox(h, ridFail)).toLowerCase(), prefixHex(prefix));
  });
});
