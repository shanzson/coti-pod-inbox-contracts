#!/usr/bin/env node
/**
 * Guard: shared PoD APIs must live in @coti-io/coti-contracts, not be re-vendored here.
 * Fails if any retired duplicate path reappears under contracts/.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contractsRoot = path.join(repoRoot, "contracts");

/** Paths relative to contracts/ that must not exist (SoT is coti-contracts). */
const FORBIDDEN = [
  "IInbox.sol",
  "IInboxMiner.sol",
  "InboxUser.sol",
  "InboxUserCotiTestnet.sol",
  "PodNetworkConstants.sol",
  "fee/IInboxFeeManager.sol",
  "fee/IPodPriceOracle.sol",
  "fee/band/IStdReference.sol",
  "mpccodec/MpcAbiCodec.sol",
];

const found = FORBIDDEN.filter((rel) => fs.existsSync(path.join(contractsRoot, rel)));
if (found.length > 0) {
  console.error(
    "[check-no-vendored-pod-apis] Re-vendored PoD APIs found — import from @coti-io/coti-contracts instead:\n" +
      found.map((f) => `  - contracts/${f}`).join("\n")
  );
  process.exit(1);
}

console.log("[check-no-vendored-pod-apis] OK — no retired duplicate APIs under contracts/");
