import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import {
  decodeErrorResult,
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
          targetFee: targetFee,
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

/** Stored errorMessage must equal getOutboxError data (raw capped returndata). */
const readErrorBytes = async (h: Harness, requestId: `0x${string}`) => {
  const errTuple = (await h.inbox.read.errors([requestId])) as readonly [
    `0x${string}`,
    bigint,
    `0x${string}`,
  ];
  const [, errorCode, errorMessage] = errTuple;
  assert.equal(errorCode, 1n, "expected ERROR_CODE_EXECUTION_FAILED");

  const [code, data] = (await h.inbox.read.getOutboxError([requestId])) as readonly [
    bigint,
    `0x${string}`,
  ];
  assert.equal(code, 1n);
  assert.equal(data.toLowerCase(), errorMessage.toLowerCase());
  return data;
};

const byteLen = (hex: `0x${string}`) => (hex.length - 2) / 2;

/** Best-effort Error(string) decode for client-side readability checks. */
const tryDecodeErrorString = (data: `0x${string}`): string | undefined => {
  try {
    const decoded = decodeErrorResult({
      abi: [{ type: "error", name: "Error", inputs: [{ name: "message", type: "string" }] }],
      data,
    });
    return decoded.args[0] as string;
  } catch {
    return undefined;
  }
};

describe("Inbox POD-02 capped returndata (raw bytes)", {
  concurrency: false,
  timeout: 600_000,
}, () => {
  let h: Harness;

  before(async () => {
    h = await deployHarness();
  });

  it("short Error(string) is stored intact; JS can decode the reason", async () => {
    const reason = "insufficient balance";
    const calldata = encodeFunctionData({
      abi: h.target.abi,
      functionName: "boomErrorString",
      args: [reason],
    });
    const rid = await mineFailing(h, calldata);
    const data = await readErrorBytes(h, rid);
    assert.ok(byteLen(data) <= Number(MAX_ERROR_RETURN_DATA));
    assert.equal(tryDecodeErrorString(data), reason);
  });

  it("Error(string) under the cap is fully decodable in JS", async () => {
    const bodyLen = 160;
    const calldata = encodeFunctionData({
      abi: h.target.abi,
      functionName: "boomErrorStringRepeated",
      args: ["0x41", BigInt(bodyLen)],
    });
    const rid = await mineFailing(h, calldata);
    const data = await readErrorBytes(h, rid);
    assert.ok(byteLen(data) <= Number(MAX_ERROR_RETURN_DATA));
    assert.equal(tryDecodeErrorString(data), "A".repeat(bodyLen));
  });

  it("oversized Error(string) is capped at 256 bytes; prefix is uncorrupted", async () => {
    const bodyLen = 500;
    const calldata = encodeFunctionData({
      abi: h.target.abi,
      functionName: "boomErrorStringRepeated",
      args: ["0x42", BigInt(bodyLen)],
    });
    const rid = await mineFailing(h, calldata);
    const data = await readErrorBytes(h, rid);
    assert.equal(byteLen(data), Number(MAX_ERROR_RETURN_DATA));
    // Truncated mid-ABI — full decode fails; selector + header still intact.
    assert.equal(data.slice(0, 10).toLowerCase(), "0x08c379a0");
    assert.equal(undefined, tryDecodeErrorString(data));
    // Body bytes after Error(string) header (68) start as ASCII 'B' (may end with ABI pad zeros).
    const bodyHex = data.slice(2 + 68 * 2).toLowerCase();
    assert.ok(bodyHex.startsWith("42".repeat(32)), `body prefix corrupted: ${bodyHex.slice(0, 64)}`);
    assert.ok(/^(?:42)+0*$/.test(bodyHex), `unexpected body bytes: ${bodyHex.slice(-16)}`);
  });

  it("empty revert stores empty bytes", async () => {
    const calldata = encodeFunctionData({
      abi: h.target.abi,
      functionName: "boomEmpty",
      args: [],
    });
    const rid = await mineFailing(h, calldata);
    const data = await readErrorBytes(h, rid);
    assert.equal(data, "0x");
  });

  it("Panic returndata is preserved uncorrupted", async () => {
    const calldata = encodeFunctionData({
      abi: h.target.abi,
      functionName: "boomPanic",
      args: [],
    });
    const rid = await mineFailing(h, calldata, 2_000_000n);
    const data = await readErrorBytes(h, rid);
    assert.ok(byteLen(data) > 0);
    assert.ok(data.toLowerCase().startsWith("0x4e487b71"), `data=${data}`);
  });

  it("custom error bytes are preserved; hint identifiable in hex", async () => {
    const hint = "FactoryNotAllowed";
    const calldata = encodeFunctionData({
      abi: h.target.abi,
      functionName: "boomCustom",
      args: [42n, hint],
    });
    const rid = await mineFailing(h, calldata);
    const data = await readErrorBytes(h, rid);
    assert.ok(byteLen(data) <= Number(MAX_ERROR_RETURN_DATA));
    assert.ok(data.toLowerCase().includes(Buffer.from(hint, "utf8").toString("hex")));
  });

  it("exact 256-byte raw revert is stored in full", async () => {
    const calldata = encodeFunctionData({
      abi: h.target.abi,
      functionName: "boom",
      args: [MAX_ERROR_RETURN_DATA],
    });
    const rid = await mineFailing(h, calldata);
    const data = await readErrorBytes(h, rid);
    assert.equal(byteLen(data), Number(MAX_ERROR_RETURN_DATA));
    assert.equal(data.toLowerCase(), `0x${"00".repeat(Number(MAX_ERROR_RETURN_DATA))}`);
  });

  it("huge raw revert is capped at 256 zero bytes", async () => {
    const calldata = encodeFunctionData({
      abi: h.target.abi,
      functionName: "boom",
      args: [LARGE_REVERT_SIZE],
    });
    const rid = await mineFailing(h, calldata);
    const data = await readErrorBytes(h, rid);
    assert.equal(byteLen(data), Number(MAX_ERROR_RETURN_DATA));
    assert.equal(data.toLowerCase(), `0x${"00".repeat(Number(MAX_ERROR_RETURN_DATA))}`);
  });

  it("tiny raw revert (1–16 bytes) is stored without padding", async () => {
    for (const size of [1n, 4n, 16n]) {
      const calldata = encodeFunctionData({
        abi: h.target.abi,
        functionName: "boom",
        args: [size],
      });
      const rid = await mineFailing(h, calldata);
      const data = await readErrorBytes(h, rid);
      assert.equal(byteLen(data), Number(size));
      assert.equal(data.toLowerCase(), `0x${"00".repeat(Number(size))}`);
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

    const data = await readErrorBytes(h, ridFail);
    assert.equal(byteLen(data), Number(MAX_ERROR_RETURN_DATA));
  });
});
