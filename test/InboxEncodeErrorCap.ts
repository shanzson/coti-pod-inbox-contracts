import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toHex } from "viem";
import { network } from "hardhat";
import { oracleTokensForChain } from "../scripts/oracle-tokens.js";
import { deployTestInbox } from "../scripts/deploy-test-inbox.js";

const receiptWaitOptions = { timeout: 300_000, pollingInterval: 2_000 };

const SOURCE_CHAIN_ID = 1000n;
const TARGET_CHAIN_ID = 1001n;
const PRICE_SCALE_18 = 10n ** 18n;
const MAX_ERROR_RETURN_DATA = 256n;

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

const packRequestId = (source: bigint, target: bigint, nonce: bigint): `0x${string}` => {
  const packed = (source << 192n) | (target << 128n) | nonce;
  return toHex(packed, { size: 32 });
};

describe("encode-failure returndata cap", {
  concurrency: false,
  timeout: 300_000,
}, () => {
  it("stores at most MAX_ERROR_RETURN_DATA bytes from a large encode revert", async () => {
    const { viem } = await network.connect({ network: "hardhat" });
    const publicClient = await viem.getPublicClient();
    const [wallet] = await viem.getWalletClients();
    const deployer = wallet.account.address as `0x${string}`;

    const largeReEncode = await viem.deployContract("LargeRevertMpcAbiReEncode", [], {
      client: { public: publicClient, wallet },
    });
    const inbox = await deployTestInbox(viem, { client: { public: publicClient, wallet } });
    await inbox.write.init([deployer, TARGET_CHAIN_ID, largeReEncode.address], { account: deployer });
    await inbox.write.updateMinFeeConfigs([{ ...FEE }, { ...FEE }], { account: deployer });
    await inbox.write.addMiner([deployer], { account: deployer });

    const oracle = await viem.deployContract("PriceOracle", [deployer], {
      client: { public: publicClient, wallet },
    });
    const { localToken, remoteToken } = oracleTokensForChain(31337);
    await oracle.write.setInboxTokens([localToken, remoteToken], { account: deployer });
    await oracle.write.setLocalTokenPriceUSD([PRICE_SCALE_18], { account: deployer });
    await oracle.write.setRemoteTokenPriceUSD([PRICE_SCALE_18], { account: deployer });
    await inbox.write.setPriceOracle([oracle.address], { account: deployer });

    const requestId = packRequestId(SOURCE_CHAIN_ID, TARGET_CHAIN_ID, 1n);
    const methodCall = {
      // Non-zero selector forces DELEGATECALL into the large-revert re-encoder.
      selector: "0x12345678" as `0x${string}`,
      data: "0x" as `0x${string}`,
      datatypes: [] as `0x${string}`[],
      datalens: [] as `0x${string}`[],
    };

    const hash = await inbox.write.batchProcessRequests(
      [
        SOURCE_CHAIN_ID,
        [
          {
            requestId,
            sourceContract: deployer,
            targetContract: deployer,
            methodCall,
            callbackSelector: "0x11111111",
            errorSelector: "0x22222222",
            isTwoWay: true,
            sourceRequestId: "0x" + "00".repeat(32),
            targetFee: 1_000_000n,
            callerFee: 1_000_000n,
          },
        ],
      ],
      { account: deployer, gas: 4_000_000n }
    );
    await publicClient.waitForTransactionReceipt({ hash, ...receiptWaitOptions });

    const err = await inbox.read.errors([requestId]);
    const errorCode = BigInt((err as any).errorCode ?? (err as any)[1]);
    const errorMessage = ((err as any).errorMessage ?? (err as any)[2]) as `0x${string}`;
    assert.equal(errorCode, 2n, "expected encode-failed code");
    const byteLen = (errorMessage.length - 2) / 2;
    assert.equal(byteLen, Number(MAX_ERROR_RETURN_DATA));
    assert.equal(errorMessage.toLowerCase(), `0x${"ff".repeat(Number(MAX_ERROR_RETURN_DATA))}`);
  });
});
