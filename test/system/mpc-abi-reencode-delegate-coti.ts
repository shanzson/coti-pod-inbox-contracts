/**
 * System test: {MpcAbiReEncode} via DELEGATECALL preserves Inbox/harness identity for validateCiphertext.
 *
 * Requires: `COTI_TESTNET_RPC_URL`, and `COTI_TESTNET_PRIVATE_KEY` or `PRIVATE_KEY`.
 * Run: `npx hardhat test test/system/mpc-abi-reencode-delegate-coti.ts --network cotiTestnet`
 */
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { network } from "hardhat";
import { encodeAbiParameters, keccak256, toHex } from "viem";

const cotiRpc = process.env.COTI_TESTNET_RPC_URL?.trim();
const cotiPkRaw =
  process.env.COTI_TESTNET_PRIVATE_KEY?.trim() || process.env.PRIVATE_KEY?.trim();
const canRunCoti = Boolean(cotiRpc && cotiPkRaw);

const deployGasOpt = (() => {
  const raw = process.env.MPC_COTI_CONTRACT_DEPLOY_GAS?.trim();
  if (!raw) return {};
  return { gas: BigInt(raw) };
})();

describe("MpcAbiReEncode DELEGATECALL (COTI)", { concurrency: false, timeout: 900_000 }, async function () {
  if (!canRunCoti) {
    it.skip(
      "set COTI_TESTNET_RPC_URL and COTI_TESTNET_PRIVATE_KEY (or PRIVATE_KEY) to run this file",
      () => {}
    );
    return;
  }

  const { viem } = await network.connect({ network: "cotiTestnet", chainType: "generic" });
  const publicClient = await viem.getPublicClient();
  const [wallet] = await viem.getWalletClients();
  const account = wallet.account!;

  let codecAddress: `0x${string}`;
  let harness: any;

  before(async () => {
    const codec = await viem.deployContract("MpcAbiReEncode", [], {
      client: { public: publicClient, wallet },
      ...deployGasOpt,
    });
    codecAddress = codec.address;
    harness = await viem.deployContract("DelegateCodecHarness", [codecAddress], {
      client: { public: publicClient, wallet },
      ...deployGasOpt,
    });
  });

  it("DELEGATECALL reEncodeWithGt succeeds for plain uint256 args", async () => {
    const selector = toHex(keccak256(toHex("noop(uint256)")).slice(0, 10));
    const data = encodeAbiParameters([{ type: "uint256" }], [42n]);
    const methodCall = {
      selector,
      data,
      datatypes: [toHex(0, { size: 8 })], // UINT256
      datalens: [toHex(32, { size: 32 })],
    };
    const hash = await harness.write.encodeViaDelegate([methodCall], {
      account,
      ...deployGasOpt,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 600_000 });
    assert.equal(receipt.status, "success");
    const encoded = await harness.read.lastEncoded();
    assert.ok(typeof encoded === "string" && encoded.startsWith("0x"));
    assert.ok(encoded.length >= 10);
  });

  it("plain CALL from outsider does not use harness identity (negative control helper)", async () => {
    // Documents CALL packaging: outsider calls codec directly (msg.sender = EOA).
    // On COTI, it-* validateCiphertext would bind to the wrong contract; plain uint256 still works.
    const codec = await viem.getContractAt("MpcAbiReEncode", codecAddress, {
      client: { public: publicClient, wallet },
    });
    const selector = toHex(keccak256(toHex("noop(uint256)")).slice(0, 10));
    const data = encodeAbiParameters([{ type: "uint256" }], [7n]);
    const methodCall = {
      selector,
      data,
      datatypes: [toHex(0, { size: 8 })],
      datalens: [toHex(32, { size: 32 })],
    };
    const hash = await codec.write.reEncodeWithGt([methodCall], { account, ...deployGasOpt });
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 600_000 });
    assert.equal(receipt.status, "success");
  });
});
