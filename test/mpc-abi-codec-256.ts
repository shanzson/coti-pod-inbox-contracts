import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import { network } from "hardhat";
import { decodeAbiParameters, encodeAbiParameters, encodeFunctionData } from "viem";
import {
  split256To64Parts,
  combine64PartsTo256,
  split128To64Parts,
  combine64PartsTo128,
  combine128PartsTo256,
  decodeCtUint256FromBytes,
  encodeCtUint256,
  encodeItUint256,
} from "./mpc-codec-helpers.js";

const MPC_PRECOMPILE = "0x0000000000000000000000000000000000000064";

function parts64ToCt256(highHigh: bigint, highLow: bigint, lowHigh: bigint, lowLow: bigint) {
  return {
    ciphertextHigh: combine64PartsTo128(highHigh, highLow),
    ciphertextLow: combine64PartsTo128(lowHigh, lowLow),
  };
}

describe("MpcAbiCodec256 - 256-bit type encoding/decoding", async function () {
  describe("Helper functions", function () {
    it("should split 256-bit values correctly", function () {
      const value =
        (0x1234567890ABCDEFn << 192n) |
        (0xFEDCBA0987654321n << 128n) |
        (0x1111222233334444n << 64n) |
        0x5555666677778888n;

      const [highHigh, highLow, lowHigh, lowLow] = split256To64Parts(value);

      assert.equal(highHigh, 0x1234567890ABCDEFn);
      assert.equal(highLow, 0xFEDCBA0987654321n);
      assert.equal(lowHigh, 0x1111222233334444n);
      assert.equal(lowLow, 0x5555666677778888n);
    });

    it("should combine 64-bit parts back to 256-bit value", function () {
      const highHigh = 0x1234567890ABCDEFn;
      const highLow = 0xFEDCBA0987654321n;
      const lowHigh = 0x1111222233334444n;
      const lowLow = 0x5555666677778888n;

      const combined = combine64PartsTo256(highHigh, highLow, lowHigh, lowLow);
      const expected = (highHigh << 192n) | (highLow << 128n) | (lowHigh << 64n) | lowLow;
      assert.equal(combined, expected);
    });

    it("should round-trip 256-bit values through split/combine", function () {
      const testValues = [
        0n,
        1n,
        (1n << 64n) - 1n,
        (1n << 128n) - 1n,
        (1n << 192n) - 1n,
        (1n << 256n) - 1n,
        0x123456789ABCDEFn,
        BigInt("0x" + "FF".repeat(32)),
      ];

      for (const value of testValues) {
        const parts = split256To64Parts(value);
        const combined = combine64PartsTo256(...parts);
        assert.equal(combined, value, `Round-trip failed for value ${value.toString(16)}`);
      }
    });
  });

  describe("ABI encoding/decoding", function () {
    it("should encode and decode ctUint256", function () {
      const { ciphertextHigh, ciphertextLow } = parts64ToCt256(100n, 200n, 300n, 400n);
      const encoded = encodeCtUint256(ciphertextHigh, ciphertextLow);
      const decoded = decodeCtUint256FromBytes(encoded);
      assert.equal(decoded.ciphertextHigh, ciphertextHigh);
      assert.equal(decoded.ciphertextLow, ciphertextLow);
    });

    it("should encode itUint256 structure", function () {
      const { ciphertextHigh, ciphertextLow } = parts64ToCt256(100n, 200n, 300n, 400n);
      const encoded = encodeItUint256(ciphertextHigh, ciphertextLow, "0x1234");
      assert.ok(encoded.startsWith("0x"));
      assert.ok(encoded.length > 10);
    });

    it("should decode itUint256 structure from encoded bytes", function () {
      const { ciphertextHigh, ciphertextLow } = parts64ToCt256(100n, 200n, 300n, 400n);
      const encoded = encodeItUint256(ciphertextHigh, ciphertextLow, "0x1234");
      const [decoded] = decodeAbiParameters(
        [
          {
            type: "tuple",
            components: [
              {
                type: "tuple",
                name: "ciphertext",
                components: [
                  { type: "uint256", name: "ciphertextHigh" },
                  { type: "uint256", name: "ciphertextLow" },
                ],
              },
              { type: "bytes", name: "signature" },
            ],
          },
        ],
        encoded
      );
      const ct = (decoded as { ciphertext: { ciphertextHigh: bigint; ciphertextLow: bigint } }).ciphertext;
      assert.equal(ct.ciphertextHigh, ciphertextHigh);
      assert.equal(ct.ciphertextLow, ciphertextLow);
    });
  });
});

describe("MpcAbiCodec256 - Contract integration", async function () {
  const { viem } = await network.connect({ network: "hardhat" });
  const publicClient = await viem.getPublicClient();
  const [wallet] = await viem.getWalletClients();

  let harness: any;
  let target: any;

  const buildCall = async (functionName: string, args: any[]) => {
    const data = encodeFunctionData({
      abi: harness.abi,
      functionName,
      args,
    });
    const result = await publicClient.call({ to: harness.address, data });
    const [callData] = decodeAbiParameters([{ type: "bytes" }], result.data ?? "0x");
    return callData;
  };

  before(async function () {
    const mock = await viem.deployContract("MockExtendedOperations", []);
    const bytecode = (await publicClient.getCode({ address: mock.address })) as `0x${string}` | undefined;
    await publicClient.request({
      method: "hardhat_setCode" as any,
      params: [MPC_PRECOMPILE, bytecode ?? "0x"] as any,
    });

    const reEncode = await viem.deployContract("MpcAbiReEncode", []);
    harness = await viem.deployContract("MpcAbiCodecHarness", [reEncode.address]);
    target = await viem.deployContract("MpcAbiCodecTests", []);
  });

  it("encodes itUint256 type mapped to gtUint256", async function () {
    const expectedGt256 = combine128PartsTo256(101n, 201n);
    const expectedData = encodeFunctionData({
      abi: target.abi,
      functionName: "setItTypes",
      args: [2n, 3n, 4n, 5n, 6n, 7n, expectedGt256, { value: [13n, 14n] }],
    });
    const selector = expectedData.slice(0, 10) as `0x${string}`;
    const callData = await buildCall("buildAndReencodeItTypes", [
      selector,
      [1n, 2n, 3n, 4n, 5n, 6n, 100n, 200n],
      [12n, 13n],
      ["0x01", "0x02"],
    ]);

    assert.equal(callData, expectedData);

    const txHash = await wallet.sendTransaction({
      to: target.address,
      data: callData,
    });
    await publicClient.waitForTransactionReceipt({ hash: txHash });

    assert.equal(await target.read.lastGtBool(), 2n);
    assert.equal(await target.read.lastGtUint64(), 6n);
  });

  it("verifies gtUint256 ABI encoding as a single uint256", async function () {
    const gtUint256Value = combine128PartsTo256(0x1111n, 0x2222n);
    const encoded = encodeAbiParameters([{ type: "uint256" }], [gtUint256Value]);
    const [decoded] = decodeAbiParameters([{ type: "uint256" }], encoded);
    assert.equal(decoded, gtUint256Value);
  });
});

describe("MpcAbiCodec256 - Callback decoding", async function () {
  it("should decode ctUint256 from callback bytes", function () {
    const { ciphertextHigh, ciphertextLow } = parts64ToCt256(
      0x1111111111111111n,
      0x2222222222222222n,
      0x3333333333333333n,
      0x4444444444444444n
    );
    const callbackData = encodeCtUint256(ciphertextHigh, ciphertextLow);
    const decoded = decodeCtUint256FromBytes(callbackData);
    assert.equal(decoded.ciphertextHigh, ciphertextHigh);
    assert.equal(decoded.ciphertextLow, ciphertextLow);
  });

  it("should round-trip a 256-bit value through encode/decode", function () {
    const originalValue = (1n << 200n) + (1n << 150n) + (1n << 100n) + (1n << 50n) + 12345n;
    const [highHigh, highLow, lowHigh, lowLow] = split256To64Parts(originalValue);
    const { ciphertextHigh, ciphertextLow } = parts64ToCt256(highHigh, highLow, lowHigh, lowLow);
    const encoded = encodeCtUint256(ciphertextHigh, ciphertextLow);
    const decoded = decodeCtUint256FromBytes(encoded);
    const reconstructed = combine128PartsTo256(decoded.ciphertextHigh, decoded.ciphertextLow);
    assert.equal(reconstructed, originalValue);
  });
});

export {
  split256To64Parts,
  combine64PartsTo256,
  split128To64Parts,
  combine64PartsTo128,
  decodeCtUint256FromBytes,
  encodeCtUint256,
  encodeItUint256,
} from "./mpc-codec-helpers.js";
