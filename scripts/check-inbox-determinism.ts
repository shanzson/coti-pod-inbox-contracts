import { network } from "hardhat";
import { encodeFunctionData, getAddress } from "viem";
import {
  buildInboxSalt,
  computeGuardedSalt,
  CREATEX_ADDRESS,
  CREATEX_ABI,
  isContractDeployed,
  isCreateXAvailable,
  precomputeCreate3Address,
} from "./createx.js";
import { getViemClients, readInboxArtifact, resolveDeployerAddress } from "./deploy-utils.js";

/**
 * Read-only determinism check for the CreateX-deployed Inbox.
 *
 * Sends NO transactions: it precomputes the CREATE3 address, checks for existing code, and (if
 * CreateX is present and the address is empty) simulates `deployCreate3AndInit` via `eth_call` to
 * confirm the simulated address equals the precomputed one and that `init` would not revert.
 *
 * Usage: `npx hardhat run scripts/check-inbox-determinism.ts --network avalancheFuji`
 */
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

  const artifact = await readInboxArtifact();
  const initData = encodeFunctionData({
    abi: artifact.abi,
    functionName: "init",
    args: [deployer, 0n, "0x0000000000000000000000000000000000000000"],
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
