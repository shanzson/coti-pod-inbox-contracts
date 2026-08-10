import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { keccak256, encodeAbiParameters, parseAbiParameters, hexToBigInt } from "viem";
import { network } from "hardhat";
import { deployTestInbox, mpcAbiReEncodeOf, feeManagerOf } from "../scripts/deploy-test-inbox.js";
import { oracleTokensForChain } from "../scripts/oracle-tokens.js";

describe("FeeManager module", { concurrency: false, timeout: 300_000 }, () => {
  it("ERC-7201 slot constant matches pod.inbox.fee.v1", () => {
    const labelHash = keccak256(Buffer.from("pod.inbox.fee.v1"));
    const n = hexToBigInt(labelHash) - 1n;
    const encoded = encodeAbiParameters(parseAbiParameters("uint256"), [n]);
    const slot = BigInt(keccak256(encoded)) & ~0xffn;
    assert.equal(
      `0x${slot.toString(16).padStart(64, "0")}`,
      "0xd050cb16de05f0d1bf135ea8150bd588c80bebfb96a13dbebca4dce96e619600"
    );
  });

  it("init wires feeManager; paid send validates via payable DELEGATECALL", async () => {
    const { viem } = await network.connect({ network: "hardhat" });
    const publicClient = await viem.getPublicClient();
    const [wallet] = await viem.getWalletClients();
    const deployer = wallet.account.address as `0x${string}`;

    const inbox = await deployTestInbox(viem, { client: { public: publicClient, wallet } });
    const fee = feeManagerOf(inbox);
    await inbox.write.init([deployer, 1000n, mpcAbiReEncodeOf(inbox), fee], { account: deployer });
    assert.equal((await inbox.read.feeManager()).toLowerCase(), fee.toLowerCase());

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
    };
    await inbox.write.updateMinFeeConfigs([{ ...FEE }, { ...FEE }], { account: deployer });

    const oracle = await viem.deployContract("PriceOracle", [deployer], {
      client: { public: publicClient, wallet },
    });
    const { localToken, remoteToken } = oracleTokensForChain(31337);
    await oracle.write.setInboxTokens([localToken, remoteToken], { account: deployer });
    await oracle.write.setLocalTokenPriceUSD([10n ** 18n], { account: deployer });
    await oracle.write.setRemoteTokenPriceUSD([10n ** 18n], { account: deployer });
    await inbox.write.setPriceOracle([oracle.address], { account: deployer });

    const hash = await inbox.write.sendOneWayMessage(
      [
        1001n,
        deployer,
        { selector: "0x00000000", data: "0x", datatypes: [], datalens: [] },
        "0x00000000",
      ],
      { account: deployer, value: 2_000_000_000_000_000n }
    );
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "success");
  });
});
