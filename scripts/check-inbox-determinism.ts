import { network } from "hardhat";
import { encodeFunctionData, getAddress, zeroAddress, type Address } from "viem";
import {
  buildInboxSalt,
  computeGuardedSalt,
  CREATEX_ADDRESS,
  CREATEX_ABI,
  isContractDeployed,
  isCreateXAvailable,
  precomputeCreate3Address,
} from "./createx.js";
import { getViemClients, readDeployConfig, readInboxArtifact, resolveDeployerAddress } from "./deploy-utils.js";

/**
 * Read-only determinism check for the CreateX-deployed Inbox.
 *
 * Sends NO transactions: it precomputes the CREATE3 address, checks for existing code, and (if
 * CreateX is present and the address is empty) simulates `deployCreate3AndInit` via `eth_call` to
 * confirm the simulated address equals the precomputed one and that `init` would not revert.
 *
 * `Inbox.init` requires `(owner, chainId, mpcAbiReEncode, feeManager)`. FeeManager is resolved
 * without deploying (read-only):
 *   1. `FEE_MANAGER_ADDRESS` env, or
 *   2. `deployConfig.chains[<chainId>].feeManager`, or
 *   3. CREATE3-predicted address from `FEE_MANAGER_SALT_LABEL` / `deployConfig.feeManagerSalt.label`
 *
 * Optional: `MPC_ABI_REENCODE_ADDRESS` (defaults to zero — valid on non-MPC chains).
 *
 * Usage: `npx hardhat run scripts/check-inbox-determinism.ts --network avalancheFuji`
 *
 * CI note: this package depends on `file:../coti-contracts`; workflows must check out
 * `coti-io/coti-contracts` as a sibling (see `.github/workflows/ci.yml`).
 */
const resolveFeeManager = async (params: {
  deployer: Address;
  chainId: number;
  publicClient: Awaited<ReturnType<typeof getViemClients>>["publicClient"];
}): Promise<Address> => {
  const fromEnv = process.env.FEE_MANAGER_ADDRESS?.trim();
  if (fromEnv) {
    return getAddress(fromEnv as Address);
  }

  let deployConfig: Awaited<ReturnType<typeof readDeployConfig>> | undefined;
  try {
    deployConfig = await readDeployConfig();
  } catch {
    deployConfig = undefined;
  }

  const fromChain = deployConfig?.chains?.[String(params.chainId)]?.feeManager?.trim();
  if (fromChain) {
    return getAddress(fromChain as Address);
  }

  const saltLabel =
    process.env.FEE_MANAGER_SALT_LABEL?.trim() || deployConfig?.feeManagerSalt?.label?.trim();
  if (saltLabel) {
    const salt = buildInboxSalt(params.deployer, saltLabel);
    return await precomputeCreate3Address(params.publicClient, params.deployer, salt);
  }

  throw new Error(
    "FeeManager required for Inbox.init simulate: set FEE_MANAGER_ADDRESS, " +
      "deployConfig.chains[<chainId>].feeManager, or FEE_MANAGER_SALT_LABEL / deployConfig.feeManagerSalt.label " +
      "(CREATE3-predicted; no deploy tx is sent)."
  );
};

const main = async () => {
  const connection = await network.connect();
  const { viem, provider, networkName } = connection;
  const { chainId, chainName, publicClient, walletClient } = await getViemClients(
    viem,
    provider,
    networkName
  );

  const deployer = await resolveDeployerAddress(walletClient);
  const saltLabel = process.env.INBOX_SALT_LABEL?.trim();
  if (!saltLabel) {
    throw new Error(
      "Set INBOX_SALT_LABEL to deployConfig.inboxSalt.label (no hardcoded salt labels in scripts)"
    );
  }
  const salt = buildInboxSalt(deployer, saltLabel);
  const guardedSalt = computeGuardedSalt(deployer, salt);
  const predicted = await precomputeCreate3Address(publicClient, deployer, salt);

  console.log(`[check-determinism] network=${chainName} chainId=${chainId}`);
  console.log(`[check-determinism] deployer=${deployer}`);
  console.log(`[check-determinism] saltLabel=${saltLabel}`);
  console.log(`[check-determinism] salt=${salt}`);
  console.log(`[check-determinism] guardedSalt=${guardedSalt}`);
  console.log(`[check-determinism] predicted Inbox address=${predicted}`);

  const createxPresent = await isCreateXAvailable(publicClient);
  console.log(`[check-determinism] CreateX present at ${CREATEX_ADDRESS}: ${createxPresent}`);

  const already = await isContractDeployed(publicClient, predicted);
  console.log(`[check-determinism] code already at predicted address: ${already}`);

  if (!createxPresent) {
    console.log("[check-determinism] CreateX missing; cannot simulate. Stopping (no tx sent).");
    return;
  }
  if (already) {
    console.log("[check-determinism] Inbox already deployed; nothing to simulate (no tx sent).");
    return;
  }

  const feeManager = await resolveFeeManager({ deployer, chainId, publicClient });
  const mpcAbiReEncode = process.env.MPC_ABI_REENCODE_ADDRESS?.trim()
    ? getAddress(process.env.MPC_ABI_REENCODE_ADDRESS.trim() as Address)
    : zeroAddress;
  console.log(`[check-determinism] feeManager=${feeManager}`);
  console.log(`[check-determinism] mpcAbiReEncode=${mpcAbiReEncode}`);

  const artifact = await readInboxArtifact();
  const initData = encodeFunctionData({
    abi: artifact.abi,
    functionName: "init",
    args: [deployer, BigInt(chainId), mpcAbiReEncode, feeManager],
  });

  const { result } = await publicClient.simulateContract({
    account: deployer,
    address: CREATEX_ADDRESS,
    abi: CREATEX_ABI,
    functionName: "deployCreate3AndInit",
    args: [salt, artifact.bytecode, initData, { constructorAmount: 0n, initCallAmount: 0n }],
  });

  const simulated = getAddress(result as `0x${string}`);
  const match = simulated === predicted;
  console.log(`[check-determinism] simulated deploy address=${simulated}`);
  console.log(`[check-determinism] simulated == predicted: ${match}`);
  if (!match) {
    throw new Error("[check-determinism] MISMATCH between simulated and precomputed address");
  }
  console.log("[check-determinism] OK: deterministic deploy + init simulate cleanly (no tx sent).");
};

main().catch((error) => {
  console.error("[check-determinism] Failed:", error);
  process.exitCode = 1;
});
