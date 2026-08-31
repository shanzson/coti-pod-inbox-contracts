// Isolated oracle-only Hardhat config for PoC validation.
// Compiles ONLY contracts/fee + the fee mocks with the locally-installed WASM solc
// (node_modules/solc/soljson.js), so no compiler download is needed and the heavy
// MPC stack (Inbox / MpcCore) is never compiled. Run with:
//   npx hardhat --config hardhat.config.poc.ts test
import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";
import { defineConfig } from "hardhat/config";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const soljson = path.join(here, "node_modules", "solc", "soljson.js");

export default defineConfig({
  plugins: [hardhatToolboxViemPlugin],
  paths: {
    sources: ["./contracts/fee", "./test/contracts/fee-mocks"],
    tests: "./test/oracle-poc",
  },
  solidity: {
    version: "0.8.28",
    // Point Hardhat at the local WASM compiler → no network download.
    path: soljson,
    settings: {
      evmVersion: "shanghai",
      viaIR: true,
      optimizer: { enabled: true, runs: 1 },
      metadata: { bytecodeHash: "none" },
    },
  },
  networks: {
    hardhat: {
      type: "edr-simulated",
      chainId: 31337,
      blockGasLimit: 120_000_000,
    },
  },
});
