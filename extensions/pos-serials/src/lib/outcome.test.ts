import {describe, it, expect} from "vitest";
import {describeOutcome, nothingWasWritten, COST_SOURCE_LABEL} from "./outcome";
import type {TransformResponse} from "./api";

const ctx = {serial: "BIKE001", target: "A-BIKE001"};

// One representative response per status — the full `ok`/`written_unconfirmed`/
// `error` payloads exercised more specifically further down.
const RESPONSE_BY_STATUS: Record<TransformResponse["status"], TransformResponse> = {
  ok: {
    status: "ok", fromSerial: "BIKE001", toSerial: "A-BIKE001",
    unitCost: 450, costSource: "average", taskId: "t1",
    existingLineCount: 1, newLineCount: 1,
  },
  preview: {
    status: "preview", fromSerial: "BIKE001", toSerial: "A-BIKE001",
    unitCost: 450, costSource: "average",
  },
  already_transformed: {status: "already_transformed"},
  not_transformed: {status: "not_transformed"},
  too_long: {status: "too_long"},
  empty_target_serial: {status: "empty_target_serial"},
  unknown_location: {status: "unknown_location"},
  serial_not_found: {status: "serial_not_found"},
  not_single_unit: {status: "not_single_unit"},
  serial_allocated: {status: "serial_allocated"},
  target_exists: {status: "target_exists"},
  cost_unresolved: {status: "cost_unresolved"},
  written_unconfirmed: {
    status: "written_unconfirmed", taskId: "task-42",
    existingLineCount: 1, newLineCount: 0,
  },
  error: {status: "error", code: "RATE_LIMITED", phase: "write"},
};

const ALL_STATUSES = Object.keys(RESPONSE_BY_STATUS) as TransformResponse["status"][];

describe("describeOutcome", () => {
  it.each(ALL_STATUSES)("%s: returns a real tone, heading, and message", (status) => {
    const outcome = describeOutcome(RESPONSE_BY_STATUS[status], ctx);
    expect(["success", "warning", "critical"]).toContain(outcome.tone);
    expect(outcome.heading.length).toBeGreaterThan(0);
    expect(outcome.message.length).toBeGreaterThan(0);
  });

  it("ok is toned success and states the new serial plainly", () => {
    const outcome = describeOutcome(RESPONSE_BY_STATUS.ok, ctx);
    expect(outcome.tone).toBe("success");
    expect(outcome.message).toContain("BIKE001");
    expect(outcome.message).toContain("A-BIKE001");
  });

  it("ok's detail states the ExistingStockLines/NewStockLines split", () => {
    const outcome = describeOutcome(RESPONSE_BY_STATUS.ok, ctx);
    expect(outcome.detail).toContain("1 existing");
    expect(outcome.detail).toContain("1 new");
  });

  // The safety-critical message: staff must be told the write already
  // happened, told not to retry, and given the taskId to trace it in Cin7.
  it("written_unconfirmed instructs no retry and includes the taskId", () => {
    const outcome = describeOutcome(RESPONSE_BY_STATUS.written_unconfirmed, ctx);
    expect(outcome.tone).toBe("critical");
    expect(outcome.message.toLowerCase()).toContain("do not retry");
    expect(outcome.message).toContain("task-42");
    expect(outcome.message).toContain(ctx.target);
  });

  it("written_unconfirmed falls back to a placeholder when taskId is null", () => {
    const response: TransformResponse = {
      status: "written_unconfirmed", taskId: null, existingLineCount: 0, newLineCount: 0,
    };
    const outcome = describeOutcome(response, ctx);
    expect(outcome.message.toLowerCase()).toContain("do not retry");
    expect(outcome.message).not.toContain("null");
  });

  it("a read-phase error says the check failed and it's safe to try again", () => {
    const response: TransformResponse = {status: "error", code: "RATE_LIMITED", phase: "read"};
    const outcome = describeOutcome(response, ctx);
    expect(outcome.tone).not.toBe("critical");
    expect(outcome.message.toLowerCase()).toContain("safe to try again");
    expect(outcome.message).not.toContain("may have been written");
    expect(outcome.message).toContain("RATE_LIMITED");
  });

  it("a write-phase error keeps the no-retry, may-have-been-written wording", () => {
    const response: TransformResponse = {status: "error", code: "RATE_LIMITED", phase: "write"};
    const outcome = describeOutcome(response, ctx);
    expect(outcome.tone).toBe("critical");
    expect(outcome.message).toContain("may have been written");
    expect(outcome.message.toLowerCase()).not.toContain("safe to try again");
  });

  it.each<TransformResponse["status"]>([
    "already_transformed", "not_transformed", "too_long", "empty_target_serial",
    "serial_not_found", "not_single_unit", "serial_allocated",
  ])("%s's message names the serial that was picked", (status) => {
    const outcome = describeOutcome(RESPONSE_BY_STATUS[status], ctx);
    expect(outcome.message).toContain(ctx.serial);
  });

  it("target_exists names the computed target, not the source serial", () => {
    const outcome = describeOutcome(RESPONSE_BY_STATUS.target_exists, ctx);
    expect(outcome.message).toContain(ctx.target);
  });

  // Fail-closed path: `response` is an unvalidated cast of backend JSON, so
  // a status this union doesn't even list must still resolve to a critical,
  // non-success outcome — never silently treated as `ok`.
  it("an unrecognized status resolves to a critical, non-success outcome naming it", () => {
    const bogus = {status: "totally_unexpected"} as unknown as TransformResponse;
    const outcome = describeOutcome(bogus, ctx);
    expect(outcome.tone).toBe("critical");
    expect(outcome.message).toContain("totally_unexpected");
    expect(outcome.message).not.toContain("Transform complete");
  });
});

describe("nothingWasWritten", () => {
  const PRE_WRITE_GUARDS: TransformResponse["status"][] = [
    "already_transformed", "not_transformed", "too_long", "empty_target_serial",
    "unknown_location", "serial_not_found", "not_single_unit", "serial_allocated",
    "target_exists", "cost_unresolved",
  ];

  it.each(PRE_WRITE_GUARDS)("%s: true — this guard always fires before any write", (status) => {
    expect(nothingWasWritten(RESPONSE_BY_STATUS[status])).toBe(true);
  });

  it.each<TransformResponse["status"]>(["ok", "preview", "written_unconfirmed"])(
    "%s: false — a write may have happened",
    (status) => {
      expect(nothingWasWritten(RESPONSE_BY_STATUS[status])).toBe(false);
    },
  );

  it("a read-phase error is true — the failure was provably before any write", () => {
    expect(nothingWasWritten({status: "error", code: "X", phase: "read"})).toBe(true);
  });

  it("a write-phase error is false — the write may have been attempted", () => {
    expect(nothingWasWritten({status: "error", code: "X", phase: "write"})).toBe(false);
  });

  it("an unrecognized status is false — fail closed, never assume it's safe", () => {
    const bogus = {status: "totally_unexpected"} as unknown as TransformResponse;
    expect(nothingWasWritten(bogus)).toBe(false);
  });

  it("covers exactly the 10 documented pre-write guards, not more or fewer", () => {
    expect(PRE_WRITE_GUARDS).toHaveLength(10);
  });
});

describe("COST_SOURCE_LABEL", () => {
  it("has plain-language labels for both cost sources", () => {
    expect(COST_SOURCE_LABEL.movement).toBe("from last movement");
    expect(COST_SOURCE_LABEL.average).toBe("product average");
  });
});
