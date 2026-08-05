import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import { network } from "hardhat";
import { decodeAbiParameters, encodeFunctionData, toFunctionSelector } from "viem";
import {
  split128To64Parts,
  combine64PartsTo128,
  combine128PartsTo256,
  decodeCtUint128FromBytes,
  encodeCtUint128,
  encodeItUint128,
} from "./mpc-codec-helpers.js";

const MPC_PRECOMPILE = "0x0000000000000000000000000000000000000064";

describe("MpcAbiCodec128 - 128-bit type encoding/decoding", function () {
  describe("Helper functions", function () {
    it("should split 128-bit values correctly", function () {
      const value = (0x1234567890ABCDEFn << 64n) | 0xFEDCBA0987654321n;
      const [high, low] = split128To64Parts(value);
      assert.equal(high, 0x1234567890ABCDEFn);
      assert.equal(low, 0xFEDCBA0987654321n);
    });

    it("should combine 64-bit parts back to 128-bit value", function () {
      const high = 0x1234567890ABCDEFn;
      const low = 0xFEDCBA0987654321n;
      const combined = combine64PartsTo128(high, low);
      assert.equal(combined, (high << 64n) | low);
    });

    it("should round-trip 128-bit values through split/combine", function () {
      const testValues = [0n, 1n, (1n << 64n) - 1n, (1n << 128n) - 1n, 0x123456789ABCDEFn];
      for (const value of testValues) {
        const [high, low] = split128To64Parts(value);
        const combined = combine64PartsTo128(high, low);
        assert.equal(combined, value, `Round-trip failed for ${value.toString(16)}`);
      }
    });
  });

  describe("ABI encoding/decoding", function () {
    it("should encode and decode ctUint128", function () {
      const value = combine64PartsTo128(100n, 200n);
      const encoded = encodeCtUint128(value);
      const decoded = decodeCtUint128FromBytes(encoded);
      assert.equal(decoded, value);
    });

    it("should encode and decode ctUint128 with large values", function () {
      const value = combine64PartsTo128(0x1234567890ABCDEFn, 0xFEDCBA0987654321n);
      const encoded = encodeCtUint128(value);
      const decoded = decodeCtUint128FromBytes(encoded);
      assert.equal(decoded, value);
    });

    it("should encode itUint128 structure", function () {
      const encoded = encodeItUint128(100n, "0x1234");
      assert.ok(encoded.startsWith("0x"));
      assert.ok(encoded.length > 10);
    });

    it("should decode itUint128 structure from encoded bytes", function () {
      const encoded = encodeItUint128(100n, "0x1234");
      const [decoded] = decodeAbiParameters(
        [
          {
            type: "tuple",
            components: [
              { type: "uint256", name: "ciphertext" },
              { type: "bytes", name: "signature" },
            ],
          },
        ],
        encoded
      );
      assert.equal((decoded as { ciphertext: bigint }).ciphertext, 100n);
    });
  });

  describe("Value conversions", function () {
    it("should prepare 128-bit value as 2 x 64-bit parts", function () {
      const value = 42n;
      const [high, low] = split128To64Parts(value);
      assert.equal(high, 0n);
      assert.equal(low, 42n);
    });

    it("should handle 128-bit addition result correctly", function () {
      const a = 42n;
      const b = 100n;
      const sum = a + b;
      const [high, low] = split128To64Parts(sum);
      const reconstructed = combine64PartsTo128(high, low);
      assert.equal(reconstructed, sum);
    });
  });
});

describe("MpcAbiCodec128 - Contract integration", async function () {
  const { viem } = await network.connect({ network: "hardhat" });
  const publicClient = await viem.getPublicClient();

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

  it("encodes itUint128 type mapped to gtUint128", async function () {
    const expectedGt256 = combine128PartsTo256(101n, 201n);
    const expectedData = encodeFunctionData({
      abi: target.abi,
      functionName: "setItTypes",
      args: [
        2n,
        3n,
        4n,
        5n,
        6n,
        7n,
        expectedGt256,
        { value: [13n, 14n] },
      ],
    });
    const selector = expectedData.slice(0, 10) as `0x${string}`;
    const callData = await buildCall("buildAndReencodeItTypes", [
      selector,
      [1n, 2n, 3n, 4n, 5n, 6n, 100n, 200n],
      [12n, 13n],
      ["0x01", "0x02"],
    ]);
    assert.equal(callData, expectedData);
  });
});

describe("MpcAbiCodec128 - Callback decoding", function () {
  it("should decode ctUint128 from callback bytes", function () {
    const value = combine64PartsTo128(0x1111111111111111n, 0x2222222222222222n);
    const callbackData = encodeCtUint128(value);
    const decoded = decodeCtUint128FromBytes(callbackData);
    assert.equal(decoded, value);
  });

  it("should decode ctUint128 from receiveC callback wrapper", function () {
    const value = combine64PartsTo128(100n, 200n);
    const ctUint128Encoded = encodeCtUint128(value);
    const receiveCData = encodeFunctionData({
      abi: [
        {
          type: "function",
          name: "receiveC",
          stateMutability: "nonpayable",
          inputs: [{ name: "data", type: "bytes" }],
          outputs: [],
        },
      ],
      functionName: "receiveC",
      args: [ctUint128Encoded],
    });
    const argsData = `0x${receiveCData.slice(10)}` as `0x${string}`;
    const [bytesArg] = decodeAbiParameters([{ type: "bytes" }], argsData);
    const decoded = decodeCtUint128FromBytes(bytesArg as `0x${string}`);
    assert.equal(decoded, value);
  });

  it("should round-trip a 128-bit value through encode/decode", function () {
    const originalValue = (1n << 100n) + (1n << 50n) + 12345n;
    const encoded = encodeCtUint128(originalValue);
    const decoded = decodeCtUint128FromBytes(encoded);
    assert.equal(decoded, originalValue);
  });

  it("should handle maximum uint128 value", function () {
    const maxUint128 = (1n << 128n) - 1n;
    const encoded = encodeCtUint128(maxUint128);
    const decoded = decodeCtUint128FromBytes(encoded);
    assert.equal(decoded, maxUint128);
  });
});
