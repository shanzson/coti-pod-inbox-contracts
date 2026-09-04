// Isolated PoC config to compile the REAL PodErc20CotiMother (+ MpcCore) with local WASM solc.
// Verifies whether the mother even compiles here before attempting the access-control PoC.
import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";
import { defineConfig } from "hardhat/config";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const soljson = path.join(here, "node_modules", "solc", "soljson.js");

export default defineConfig({
  plugins: [hardhatToolboxViemPlugin],
  paths: {
    sources: ["./test/mother-poc/contracts"],
    tests: "./test/mother-poc",
  },
  solidity: {
    version: "0.8.28",
    path: soljson,
    settings: {
      evmVersion: "shanghai",
      viaIR: true,
      optimizer: { enabled: true, runs: 1 },
      metadata: { bytecodeHash: "none" },
    },
  },
  networks: {
    hardhat: { type: "edr-simulated", chainId: 31337, blockGasLimit: 120_000_000 },
  },
});
