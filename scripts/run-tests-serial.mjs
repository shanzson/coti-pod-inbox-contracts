#!/usr/bin/env node
/**
 * Run Hardhat node:test files in small sequential groups.
 * Full-glob parallel runs OOOM/timeout workers on constrained hosts (~60s silent "test failed").
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(root, "..");
const GROUP = Number(process.env.TEST_GROUP_SIZE || "3");

const inboxFiles = readdirSync(path.join(repo, "test"))
  .filter((f) => f.startsWith("Inbox") && f.endsWith(".ts"))
  .map((f) => path.join("test", f))
  .sort();

const rest = [
  "test/FeeManagerModule.ts",
  "test/FeeTemplateConstantFee.ts",
  "test/MpcAbiReEncodeGuards.ts",
  "test/PoDPriceOracle.ts",
  "test/Gt64GasRepro.ts",
  "test/inbox-raise.ts",
  "test/mpc-abi-codec-128.ts",
  "test/mpc-abi-codec-256.ts",
  "test/system/mpc-abi-reencode-delegate-coti.ts",
].filter((f) => {
  try {
    readdirSync(path.dirname(path.join(repo, f)));
    return true;
  } catch {
    return false;
  }
});

// FeeTemplate may be glob - resolve existing
const feeTemplates = readdirSync(path.join(repo, "test"))
  .filter((f) => f.startsWith("FeeTemplate") && f.endsWith(".ts"))
  .map((f) => path.join("test", f));

const all = [
  ...inboxFiles,
  "test/FeeManagerModule.ts",
  ...feeTemplates,
  ...rest.filter((f) => !f.includes("FeeTemplate") && f !== "test/FeeManagerModule.ts"),
];

// Dedupe preserving order
const seen = new Set();
const files = all.filter((f) => {
  if (seen.has(f)) return false;
  seen.add(f);
  return true;
});

const env = {
  ...process.env,
  NODE_OPTIONS: [process.env.NODE_OPTIONS, "--max-old-space-size=8192"].filter(Boolean).join(" "),
};

for (let i = 0; i < files.length; i += GROUP) {
  const group = files.slice(i, i + GROUP);
  console.log(`\n=== test group ${i / GROUP + 1}: ${group.join(" ")} ===\n`);
  const r = spawnSync("npx", ["hardhat", "test", ...group], {
    cwd: repo,
    env,
    stdio: "inherit",
  });
  if (r.status !== 0) {
    process.exit(r.status ?? 1);
  }
}

console.log(`\nAll ${files.length} test files passed (${GROUP} per group).\n`);
