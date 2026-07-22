import {describe, it, expect} from "vitest";
import {TtlCache} from "./cache.server";

describe("TtlCache", () => {
  it("returns stored values before expiry and undefined after", () => {
    let clock = 1000;
    const cache = new TtlCache<string>(500, () => clock);
    cache.set("k", "v");
    expect(cache.get("k")).toBe("v");
    clock = 1501;
    expect(cache.get("k")).toBeUndefined();
  });

  it("returns undefined for unknown keys", () => {
    const cache = new TtlCache<string>(500);
    expect(cache.get("missing")).toBeUndefined();
  });
});
