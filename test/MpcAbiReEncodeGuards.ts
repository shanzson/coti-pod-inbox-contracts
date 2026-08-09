import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { encodeAbiParameters, padHex } from "viem";

/** BYTES = 4 in MpcAbiReEncode.MpcDataType */
const BYTES_TYPE = padHex("0x04", { size: 8 });
const BYTES_ALIASED = padHex("0x0104", { size: 8 }); // high-byte garbage

describe("MpcAbiReEncode guards (L-01/L-02/L-16)", { concurrency: 1 }, async () => {
  const { viem } = await network.connect({ network: "hardhat" });
  const publicClient = await viem.getPublicClient();
  const [wallet] = await viem.getWalletClients();
  const c = { public: publicClient, wallet };

  const reEncode = await viem.deployContract("MpcAbiReEncode", [], { client: c });
  const harness = await viem.deployContract("DelegateCodecHarness", [reEncode.address], { client: c });

  it("rejects datatype high-byte aliasing", async () => {
    const emptyBytes = encodeAbiParameters([{ type: "bytes" }], ["0x"]);
    await assert.rejects(
      () => harness.write.encodeOneArgViaDelegate(["0x12345678", emptyBytes, BYTES_ALIASED]),
      (err: unknown) => String(err).includes("datatype alias") || String(err).includes("reverted")
    );
  });

  it("rejects unaligned / malformed BYTES dynamic arg (closes L-16 reachability)", async () => {
    const junk = ("0x" + "aa".repeat(33)) as `0x${string}`;
    await assert.rejects(
      () => harness.write.encodeOneArgViaDelegate(["0x12345678", junk, BYTES_TYPE]),
      (err: unknown) =>
        /bad dynamic|unaligned|reverted/i.test(String(err)) || String(err).includes("MpcAbiReEncode")
    );
  });

  it("re-encodes well-formed BYTES without corruption", async () => {
    const payload = "0xbe" as `0x${string}`;
    const encoded = encodeAbiParameters([{ type: "bytes" }], [payload]);
    const out = (await harness.write.encodeOneArgViaDelegate(["0x12345678", encoded, BYTES_TYPE])) as `0x${string}`;
    // write returns tx hash — use simulate/read via staticcall pattern
    const staticOut = await publicClient.simulateContract({
      address: harness.address,
      abi: harness.abi,
      functionName: "encodeOneArgViaDelegate",
      args: ["0x12345678", encoded, BYTES_TYPE],
      account: wallet.account,
    });
    const result = staticOut.result as `0x${string}`;
    assert.equal(result.slice(0, 10).toLowerCase(), "0x12345678");
    assert.ok(result.toLowerCase().includes("be"), `expected payload byte in ${result}`);
    void out;
  });

  it("exposes MAX_IT_STRING_CELLS = 128", async () => {
    assert.equal(await reEncode.read.MAX_IT_STRING_CELLS(), 128n);
  });
});
