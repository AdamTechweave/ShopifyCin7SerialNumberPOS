import {describe, it, expect} from "vitest";
import {parsePrice} from "./price";

describe("parsePrice", () => {
  it("accepts a plain decimal and normalises to two places", () => {
    expect(parsePrice("12.5")).toEqual({ok: true, price: "12.50"});
  });

  it("accepts a whole number", () => {
    expect(parsePrice("40")).toEqual({ok: true, price: "40.00"});
  });

  it("passes through a value already at two places", () => {
    expect(parsePrice("12.99")).toEqual({ok: true, price: "12.99"});
  });

  it("strips a leading currency symbol", () => {
    expect(parsePrice("$12.99")).toEqual({ok: true, price: "12.99"});
  });

  it("strips thousands separators", () => {
    expect(parsePrice("1,234.50")).toEqual({ok: true, price: "1234.50"});
  });

  it("tolerates surrounding whitespace", () => {
    expect(parsePrice("  12.99  ")).toEqual({ok: true, price: "12.99"});
  });

  it("rejects an empty or whitespace-only entry", () => {
    expect(parsePrice("")).toEqual({ok: false, reason: "empty"});
    expect(parsePrice("   ")).toEqual({ok: false, reason: "empty"});
  });

  it("rejects something that isn't a number", () => {
    expect(parsePrice("abc")).toEqual({ok: false, reason: "not_a_number"});
    expect(parsePrice("12abc")).toEqual({ok: false, reason: "not_a_number"});
    expect(parsePrice("1.2.3")).toEqual({ok: false, reason: "not_a_number"});
  });

  it("rejects zero and negatives — a custom sale must have a real price", () => {
    expect(parsePrice("0")).toEqual({ok: false, reason: "not_positive"});
    expect(parsePrice("0.00")).toEqual({ok: false, reason: "not_positive"});
    expect(parsePrice("-5")).toEqual({ok: false, reason: "not_positive"});
  });

  it("rejects more than two decimal places rather than silently rounding money", () => {
    expect(parsePrice("12.345")).toEqual({ok: false, reason: "too_many_decimals"});
  });

  it("rejects a value that isn't finite", () => {
    expect(parsePrice("Infinity")).toEqual({ok: false, reason: "not_a_number"});
    expect(parsePrice("1e400")).toEqual({ok: false, reason: "not_a_number"});
  });

  it("accepts a sub-unit amount", () => {
    expect(parsePrice("0.05")).toEqual({ok: true, price: "0.05"});
  });
});
