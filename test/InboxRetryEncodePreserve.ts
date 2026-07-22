import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  encodeAbiParameters,
  encodeFunctionData,
  toFunctionSelector,
  toHex,
} from "viem";
import { network } from "hardhat";
import { oracleTokensForChain } from "../scripts/oracle-tokens.js";

const receiptWaitOptions = { timeout: 300_000, pollingInterval: 2_000 };
const MPC_PRECOMPILE = "0x0000000000000000000000000000000000000064" as const;

const SOURCE_CHAIN_ID = 1000n;
const TARGET_CHAIN_ID = 1001n;
const PRICE_SCALE_18 = 10n ** 18n;

const CONSTANT_FEE = {
  constantFee: 1n,
  gasPerByte: 0n,
  callbackExecutionGas: 0n,
  errorLength: 0n,
  bufferRatioX10000: 0n,
} as const;

/** MpcAbiCodec.MpcDataType.IT_UINT64 */
const IT_UINT64 = "0x000000000000000e" as `0x${string}`;

const packRequestId = (source: bigint, target: bigint, nonce: bigint): `0x${string}` => {
  const packed = (source << 192n) | (target << 128n) | nonce;
  return toHex(packed, { size: 32 });
};

describe("Inbox POD-04 retry encode failure", { concurrency: false, timeout: 600_000 }, () => {
  it("retry encode failure reverts and preserves ERROR_CODE_EXECUTION_FAILED", async () => {
    const { viem, provider } = await network.connect({ network: "hardhat" });
    const publicClient = await viem.getPublicClient();
    const [wallet] = await viem.getWalletClients();
    const deployer = wallet.account.address as `0x${string}`;

    // Install mock MPC precompile so first-pass encode succeeds.
    const mockMpc = await viem.deployContract("MockExtendedOperations", [], {
      client: { public: publicClient, wallet },
    });
    const mockCode = await publicClient.getCode({ address: mockMpc.address });
    assert.ok(mockCode && mockCode !== "0x");
    await provider.request({
      method: "hardhat_setCode",
      params: [MPC_PRECOMPILE, mockCode],
    });

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

    const gasTarget = await viem.deployContract("InboxGasTarget", [inbox.address], {
      client: { public: publicClient, wallet },
    });
    await gasTarget.write.setShouldFail([true], { account: deployer });

    // itUint64 = (ciphertext, signature) — mock accepts any signature.
    const itArg = encodeAbiParameters(
      [
        {
          type: "tuple",
          components: [
            { type: "uint256", name: "ciphertext" },
            { type: "bytes", name: "signature" },
          ],
        },
      ],
      [{ ciphertext: 42n, signature: "0x1234" }]
    );
    // Target signature is observe(bytes); after GT re-encode the call will still hit observe with
    // wrong ABI and revert — enough for ERROR_CODE_EXECUTION_FAILED after a successful encode.
    const observeSelector = toFunctionSelector("observe(bytes)");
    const methodCall = {
      selector: observeSelector,
      data: itArg,
      datatypes: [IT_UINT64],
      datalens: [toHex(BigInt((itArg.length - 2) / 2), { size: 32 })],
    };

    const rid = packRequestId(SOURCE_CHAIN_ID, TARGET_CHAIN_ID, 1n);
    const mineHash = await inbox.write.batchProcessRequests(
      [
        SOURCE_CHAIN_ID,
        [
          {
            requestId: rid,
            sourceContract: deployer,
            targetContract: gasTarget.address,
            methodCall,
            callbackSelector: "0x00000000",
            errorSelector: "0x00000000",
            isTwoWay: false,
            sourceRequestId: toHex(0n, { size: 32 }),
            targetFee: 2_000_000n,
            callerFee: 0n,
          },
        ],
      ],
      { account: deployer, gas: 8_000_000n }
    );
    await publicClient.waitForTransactionReceipt({ hash: mineHash, ...receiptWaitOptions });

    const [, errorCodeBefore] = (await inbox.read.errors([rid])) as readonly [
      `0x${string}`,
      bigint,
      `0x${string}`,
    ];
    assert.equal(errorCodeBefore, 1n, "expected execution failure (retryable)");

    // Remove MPC precompile so retry-time encode fails.
    await provider.request({
      method: "hardhat_setCode",
      params: [MPC_PRECOMPILE, "0x"],
    });

    await assert.rejects(
      () => inbox.write.retryFailedRequest([rid], { account: deployer, gas: 4_000_000n }),
      /RetryFailedRequestEncodeFailed|0x[a-fA-F0-9]+/
    );

    const [, errorCodeAfter] = (await inbox.read.errors([rid])) as readonly [
      `0x${string}`,
      bigint,
      `0x${string}`,
    ];
    assert.equal(errorCodeAfter, 1n, "encode failure must not overwrite execution error code");
  });
});
