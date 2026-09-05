// Isolated PoC config: compiles the REAL PrivacyPortal / PrivacyPortalFactory / PodErc20MintableInitializable
// (+ the real PodErc20CotiMother for the COTI-side half of one PoC) from the symlinked coti-contracts checkout.
import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";
import { defineConfig } from "hardhat/config";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
// The full tree (portal + factory + PodERC20 + mother + MpcCore) under viaIR exceeds the wasm solc memory
// limit in this environment. Point SOLC_NATIVE at a native solc 0.8.28 (0.8.28+commit.7893614a,
// e.g. the GitHub release asset `solc-static-linux`); the wasm build is the fallback.
const soljson = path.join(here, "node_modules", "solc", "soljson.js");
const solcPath = process.env.SOLC_NATIVE && process.env.SOLC_NATIVE.length > 0 ? process.env.SOLC_NATIVE : soljson;

export default defineConfig({
  plugins: [hardhatToolboxViemPlugin],
  paths: {
    sources: ["./test/portal-poc/contracts", "./test/mother-poc/contracts"],
    tests: "./test/portal-poc",
  },
  solidity: {
    version: "0.8.28",
    path: solcPath,
    settings: {
      // coti-contracts pins paris; PoC uses shanghai only to keep the wasm build small. No PoC depends on the EVM version.
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
      // Only relaxes the deploy-size check for the harness implementations; behaviour under test is unchanged.
      allowUnlimitedContractSize: true,
    },
  },
});
