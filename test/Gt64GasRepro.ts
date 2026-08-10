/**
 * Gt64 gas repro lives in pod-ecosystem-integration (`test/Gt64GasRepro.ts`).
 * This stub keeps `npm test` green (the former copy imported missing PEI utils).
 *
 * Run: `cd ../pod-ecosystem-integration && npm run test:gt64-repro`
 */
import { test } from "node:test";

test.skip(
  "Gt64 repro: set COTI_TESTNET_RPC_URL + key and run PEI npm run test:gt64-repro",
  () => {}
);
