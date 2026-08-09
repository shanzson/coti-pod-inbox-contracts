import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertConstantFeeCoversWorstCase,
  CONSTANT_FEE_PRICED_EXECUTION_GAS,
  constantFeeWorstCaseFloor,
  DEFAULT_MAX_METHOD_CALL_BYTES,
  FEE_CONFIG_COTI_SIDE,
  FEE_CONFIG_SEPOLIA_SIDE,
  MEASURED_INGEST_GAS_PER_BYTE,
  type FeeConfigTuple,
} from "../scripts/deploy-utils.js";

describe("deploy fee template constantFee floor", () => {
  it("worst-case floor is priced execution plus max-size ingest", () => {
    const floor = constantFeeWorstCaseFloor({ maxMethodCallBytes: DEFAULT_MAX_METHOD_CALL_BYTES });
    assert.equal(
      floor,
      CONSTANT_FEE_PRICED_EXECUTION_GAS + DEFAULT_MAX_METHOD_CALL_BYTES * MEASURED_INGEST_GAS_PER_BYTE
    );
  });

  it("COTI-side constant template meets the worst-case floor", () => {
    assert.equal(FEE_CONFIG_COTI_SIDE.constantFee, FEE_CONFIG_COTI_SIDE.maxExecutionGas);
    assertConstantFeeCoversWorstCase({ ...FEE_CONFIG_COTI_SIDE });
  });

  it("variable Sepolia-side template skips the constant-fee assert", () => {
    assert.equal(FEE_CONFIG_SEPOLIA_SIDE.constantFee, 0n);
    assertConstantFeeCoversWorstCase({ ...FEE_CONFIG_SEPOLIA_SIDE });
  });

  it("rejects underpriced constantFee relative to max-size ingest", () => {
    const under: FeeConfigTuple = {
      ...FEE_CONFIG_COTI_SIDE,
      constantFee: CONSTANT_FEE_PRICED_EXECUTION_GAS,
      maxExecutionGas: CONSTANT_FEE_PRICED_EXECUTION_GAS,
    };
    assert.throws(() => assertConstantFeeCoversWorstCase(under, "underpriced"), /worst-case floor/);
  });
});
