import { network } from "hardhat";
import {
  appendDeploymentLog,
  asAddress,
  deployDeterministicInbox,
  ensureMinerRegistered,
  getChainConfig,
  getViemClients,
  readDeployConfig,
  requireSaltLabel,
  requireEnv,
} from "./deploy-utils.js";

const main = async () => {
  console.log("[deploy-inbox-with-executor] Connecting to network from CLI");
  const connection = await network.connect();
  const { viem, provider, networkName } = connection;
  const { chainId, chainName, publicClient, walletClient } = await getViemClients(
    viem,
    provider,
    networkName
  );
  const networkLabel = chainName ?? "unknown";
  const deployConfig = await readDeployConfig();
  const existingChainConfig = getChainConfig(deployConfig, chainId, "coti");
  console.log(`[deploy-inbox-with-executor] Connected: chainId=${chainId} network=${networkLabel}`);
  if (existingChainConfig.inbox || existingChainConfig.cotiExecutor) {
    console.log(
      `[deploy-inbox-with-executor] Existing config inbox=${existingChainConfig.inbox ?? "unset"} ` +
        `cotiExecutor=${existingChainConfig.cotiExecutor ?? "unset"}`
    );
  }
  const minerAddress = asAddress(requireEnv("MINER_ADDRESS"), "MINER_ADDRESS");
  console.log(`[deploy-inbox-with-executor] Using miner: ${minerAddress}`);

  console.log("[deploy-inbox-with-executor] Deploying deterministic Inbox via CreateX...");
  const saltLabel = requireSaltLabel({
    fromConfig: deployConfig.inboxSalt?.label,
    envKey: "INBOX_SALT_LABEL",
    configPath: "deployConfig.inboxSalt.label",
  });
  const { inbox, predictedAddress, alreadyDeployed, txHash } = await deployDeterministicInbox({
    viem,
    publicClient,
    walletClient,
    saltLabel,
    deployReEncode: true,
    reEncodeSaltLabel: requireSaltLabel({ fromConfig: deployConfig.mpcAbiCodecSalt?.label, envKey: "MPC_ABI_CODEC_SALT_LABEL", configPath: "deployConfig.mpcAbiCodecSalt.label" }),
  });
  console.log(
    alreadyDeployed
      ? `[deploy-inbox-with-executor] Inbox already deployed at deterministic address: ${predictedAddress}`
      : `[deploy-inbox-with-executor] Inbox deployed at deterministic address: ${inbox.address} (tx ${txHash})`
  );
  console.log("[deploy-inbox-with-executor] Deploying MpcExecutor...");
  const mpcExecutor = await viem.deployContract("MpcExecutor", [inbox.address], {
    client: { public: publicClient, wallet: walletClient },
  });
  console.log(`[deploy-inbox-with-executor] MpcExecutor deployed: ${mpcExecutor.address}`);
  console.log("[deploy-inbox-with-executor] Ensuring miner is registered...");
  const minerAdded = await ensureMinerRegistered({
    inbox,
    miner: minerAddress,
    publicClient,
    walletClient,
  });
  console.log(
    minerAdded
      ? "[deploy-inbox-with-executor] Miner added"
      : "[deploy-inbox-with-executor] Miner already registered"
  );

  console.log("[deploy-inbox-with-executor] Writing deployment log entries");
  await appendDeploymentLog({
    contract: "Inbox",
    address: inbox.address,
    chainId,
    network: networkLabel,
  });
  await appendDeploymentLog({
    contract: "MpcExecutor",
    address: mpcExecutor.address,
    chainId,
    network: networkLabel,
  });
  console.log("[deploy-inbox-with-executor] Done");
};

main().catch((error) => {
  console.error("[deploy-inbox-with-executor] Failed:", error);
  process.exitCode = 1;
});
