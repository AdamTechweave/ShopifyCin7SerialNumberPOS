import {describe, it, expect} from "vitest";
import {
  SERIAL_PROPERTY_KEY,
  serializedLines,
  unitsNeedingSerial,
  excludeInCart,
  matchScan,
  type CartLineLike,
  type AvailableSerial,
} from "./serials";

function cartLine(overrides: Partial<CartLineLike> = {}): CartLineLike {
  return {
    uuid: "u1", quantity: 1, productId: 1, variantId: 11,
    sku: "WIDGET-001", title: "Widget", properties: {},
    ...overrides,
  };
}

function serial(value: string, overrides: Partial<AvailableSerial> = {}): AvailableSerial {
  return {serial: value, locationName: "Auckland", available: 1, isCurrentLocation: true, ...overrides};
}

const MAP = {"1": true, "2": false};

describe("serializedLines", () => {
  it("keeps only lines whose product is serialized", () => {
    const lines = [cartLine({productId: 1}), cartLine({uuid: "u2", productId: 2})];
    expect(serializedLines(lines, MAP).map((l) => l.uuid)).toEqual(["u1"]);
  });
});

describe("unitsNeedingSerial", () => {
  it("counts full quantity for lines without a serial", () => {
    expect(unitsNeedingSerial([cartLine({quantity: 3})], MAP)).toBe(3);
  });

  it("counts zero for a qty-1 line with a serial property", () => {
    const satisfied = cartLine({properties: {[SERIAL_PROPERTY_KEY]: "SN-1"}});
    expect(unitsNeedingSerial([satisfied], MAP)).toBe(0);
  });

  it("still counts a qty>1 line that somehow has a serial (needs splitting)", () => {
    const odd = cartLine({quantity: 2, properties: {[SERIAL_PROPERTY_KEY]: "SN-1"}});
    expect(unitsNeedingSerial([odd], MAP)).toBe(2);
  });

  it("ignores non-serialized lines", () => {
    expect(unitsNeedingSerial([cartLine({productId: 2, quantity: 5})], MAP)).toBe(0);
  });
});

describe("excludeInCart", () => {
  it("removes serials already assigned to other lines", () => {
    const lines = [cartLine({uuid: "other", properties: {[SERIAL_PROPERTY_KEY]: "SN-1"}})];
    const result = excludeInCart([serial("SN-1"), serial("SN-2")], lines);
    expect(result.map((s) => s.serial)).toEqual(["SN-2"]);
  });

  it("does not exclude the serial on the line being edited", () => {
    const lines = [cartLine({uuid: "editing", properties: {[SERIAL_PROPERTY_KEY]: "SN-1"}})];
    const result = excludeInCart([serial("SN-1")], lines, "editing");
    expect(result.map((s) => s.serial)).toEqual(["SN-1"]);
  });
});

describe("matchScan", () => {
  const candidates = [serial("SN-ABC-123")];

  it("matches exactly, ignoring surrounding whitespace and case", () => {
    expect(matchScan(candidates, " sn-abc-123 ")?.serial).toBe("SN-ABC-123");
  });

  it("returns undefined for non-matches and empty scans", () => {
    expect(matchScan(candidates, "SN-ABC")).toBeUndefined();
    expect(matchScan(candidates, "  ")).toBeUndefined();
  });
});
