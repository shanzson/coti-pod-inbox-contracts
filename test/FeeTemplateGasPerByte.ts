import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FEE_CONFIG_SEPOLIA_SIDE } from "../scripts/deploy-utils.js";

/** Floor for variable-fee `gasPerByte` (measured ingest ~690+ gas/byte + margin). */
const MIN_GAS_PER_BYTE = 800n;

describe("deploy fee template gasPerByte", () => {
  it("Sepolia-side variable template prices ingest storage at ≥ measured floor", () => {
    assert.ok(
      FEE_CONFIG_SEPOLIA_SIDE.gasPerByte >= MIN_GAS_PER_BYTE,
      `gasPerByte ${FEE_CONFIG_SEPOLIA_SIDE.gasPerByte} < ${MIN_GAS_PER_BYTE}`
    );
  });
});
