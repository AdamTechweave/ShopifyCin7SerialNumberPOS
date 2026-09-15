import {describe, it, expect} from "vitest";
import {TRANSFORM_PREFIX, computeTargetSerial} from "./transform";

describe("TRANSFORM_PREFIX", () => {
  it("is the assembled-unit prefix", () => {
    expect(TRANSFORM_PREFIX).toBe("A-");
  });
});

describe("computeTargetSerial", () => {
  it("prefixes a plain serial when assembling", () => {
    expect(computeTargetSerial("BIKE001", "assemble")).toEqual({ok: true, target: "A-BIKE001"});
  });

  it("refuses to assemble a serial that is already prefixed", () => {
    expect(computeTargetSerial("A-BIKE001", "assemble")).toEqual({ok: false, reason: "already_transformed"});
  });

  it("strips the prefix when disassembling", () => {
    expect(computeTargetSerial("A-BIKE001", "disassemble")).toEqual({ok: true, target: "BIKE001"});
  });

  it("refuses to disassemble a serial that is not prefixed", () => {
    expect(computeTargetSerial("BIKE001", "disassemble")).toEqual({ok: false, reason: "not_transformed"});
  });

  it("refuses when the prefixed serial would exceed Cin7's 50-character BatchSN limit", () => {
    const serial = "X".repeat(49);
    expect(computeTargetSerial(serial, "assemble")).toEqual({ok: false, reason: "too_long"});
  });

  it("accepts a serial that prefixes to exactly 50 characters", () => {
    const serial = "X".repeat(48);
    expect(computeTargetSerial(serial, "assemble")).toEqual({ok: true, target: `A-${serial}`});
  });

  it("is case-sensitive about the prefix", () => {
    expect(computeTargetSerial("a-bike001", "assemble")).toEqual({ok: true, target: "A-a-bike001"});
  });
});
