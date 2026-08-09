import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FEE_CONFIG_SEPOLIA_SIDE, MEASURED_INGEST_GAS_PER_BYTE } from "../scripts/deploy-utils.js";

describe("deploy fee template gasPerByte", () => {
  it("Sepolia-side variable template prices ingest storage at ≥ measured floor", () => {
    assert.ok(
      FEE_CONFIG_SEPOLIA_SIDE.gasPerByte >= MEASURED_INGEST_GAS_PER_BYTE,
      `gasPerByte ${FEE_CONFIG_SEPOLIA_SIDE.gasPerByte} < ${MEASURED_INGEST_GAS_PER_BYTE}`
    );
  });
});
