/**
 * Live COTI raise-path system test lives in pod-ecosystem-integration
 * (`test/system/inbox-raise.ts`). This stub keeps `npm test` green in this repo
 * (the former in-repo copy imported a missing `./mpc-test-utils.js`).
 */
import { describe, it } from "node:test";

describe("Inbox raise() → error callback (system)", { concurrency: false }, () => {
  it.skip("run via PEI: npm run test -- test/system/inbox-raise.ts (COTI credentials)", () => {});
});
