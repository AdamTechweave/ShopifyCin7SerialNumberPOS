import {describe, it, expect} from "vitest";
import {resolveUnitCost} from "./cost.server";

const movement = (over: Partial<import("./cin7.server").Cin7Movement> = {}) => ({
  BatchSN: "BIKE001", Location: "Main Warehouse", Quantity: 1,
  Amount: 450, Date: "2026-09-01T00:00:00", Type: "Purchase", ...over,
});

describe("resolveUnitCost", () => {
  it("uses the matching inbound movement, divided to a unit cost", () => {
    const product = {AverageCost: 999, Movements: [movement({Quantity: 2, Amount: 900})]};
    expect(resolveUnitCost(product, "BIKE001", "Main Warehouse")).toEqual({ok: true, unitCost: 450, source: "movement"});
  });

  it("prefers the most recent matching movement", () => {
    const product = {Movements: [
      movement({Amount: 400, Date: "2026-01-01T00:00:00"}),
      movement({Amount: 500, Date: "2026-06-01T00:00:00"}),
    ]};
    expect(resolveUnitCost(product, "BIKE001", "Main Warehouse")).toEqual({ok: true, unitCost: 500, source: "movement"});
  });

  it("ignores movements for another serial or another location", () => {
    const product = {AverageCost: 120, Movements: [
      movement({BatchSN: "BIKE002"}), movement({Location: "Other Store"}),
    ]};
    expect(resolveUnitCost(product, "BIKE001", "Main Warehouse")).toEqual({ok: true, unitCost: 120, source: "average"});
  });

  it("ignores outbound movements", () => {
    const product = {AverageCost: 120, Movements: [movement({Quantity: -1, Amount: -450})]};
    expect(resolveUnitCost(product, "BIKE001", "Main Warehouse")).toEqual({ok: true, unitCost: 120, source: "average"});
  });

  it("falls back to AverageCost when there are no movements", () => {
    expect(resolveUnitCost({AverageCost: 75}, "BIKE001", "Main Warehouse")).toEqual({ok: true, unitCost: 75, source: "average"});
  });

  it("refuses when neither source yields a positive cost", () => {
    expect(resolveUnitCost({AverageCost: 0}, "BIKE001", "Main Warehouse")).toEqual({ok: false});
    expect(resolveUnitCost({}, "BIKE001", "Main Warehouse")).toEqual({ok: false});
  });

  it("abandons the movement scan rather than walk an unbounded history", () => {
    const many = Array.from({length: 2001}, () => movement({BatchSN: "OTHER"}));
    many.push(movement({Amount: 450}));
    expect(resolveUnitCost({AverageCost: 75, Movements: many}, "BIKE001", "Main Warehouse")).toEqual({ok: true, unitCost: 75, source: "average"});
  });

  it("matches a serial that arrives from Cin7 as a number", () => {
    const product = {AverageCost: 999, Movements: [movement({BatchSN: 12345 as unknown as string, Amount: 300, Quantity: 1})]};
    expect(resolveUnitCost(product, "12345", "Main Warehouse")).toEqual({ok: true, unitCost: 300, source: "movement"});
  });
});
