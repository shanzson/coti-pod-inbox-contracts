import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertErrorLengthWithinReturnDataCap,
  FEE_CONFIG_SEPOLIA_SIDE,
  MAX_ERROR_RETURN_DATA_BYTES,
  type FeeConfigTuple,
} from "../scripts/deploy-utils.js";

describe("deploy fee template errorLength", () => {
  it("Sepolia-side variable template stays within on-chain returndata cap", () => {
    assert.ok(FEE_CONFIG_SEPOLIA_SIDE.errorLength <= MAX_ERROR_RETURN_DATA_BYTES);
    assertErrorLengthWithinReturnDataCap({ ...FEE_CONFIG_SEPOLIA_SIDE });
  });

  it("rejects errorLength above the returndata cap", () => {
    const over: FeeConfigTuple = {
      ...FEE_CONFIG_SEPOLIA_SIDE,
      errorLength: MAX_ERROR_RETURN_DATA_BYTES + 1n,
    };
    assert.throws(() => assertErrorLengthWithinReturnDataCap(over, "over"), /errorLength/);
  });
});
