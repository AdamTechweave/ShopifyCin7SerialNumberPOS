import {describe, it, expect} from "vitest";
import {loadConfig, getConfig} from "./config.server";

const BASE_ENV = {
  CIN7_ACCOUNT_ID: "acct-123",
  CIN7_APPLICATION_KEY: "key-456",
};

describe("loadConfig", () => {
  it("loads required Cin7 credentials", () => {
    const config = loadConfig(BASE_ENV);
    expect(config.cin7AccountId).toBe("acct-123");
    expect(config.cin7ApplicationKey).toBe("key-456");
  });

  it("throws when a required var is missing", () => {
    expect(() => loadConfig({CIN7_ACCOUNT_ID: "x"})).toThrow(/CIN7_APPLICATION_KEY/);
  });

  // The serial-tag default moved to the extension when the tag lookup switched
  // to direct API access — see extensions/pos-serials/src/lib/tags.test.ts.

  it("parses the location map", () => {
    const config = loadConfig({...BASE_ENV, CIN7_LOCATION_MAP: '{"123":"Auckland Store"}'});
    expect(config.locationMap).toEqual({"123": "Auckland Store"});
  });

  it("defaults the location map to empty and rejects invalid JSON", () => {
    expect(loadConfig(BASE_ENV).locationMap).toEqual({});
    expect(() => loadConfig({...BASE_ENV, CIN7_LOCATION_MAP: "not json"})).toThrow(/CIN7_LOCATION_MAP/);
  });

  it("rejects location maps that are valid JSON but not string-to-string objects", () => {
    for (const bad of ["null", "123", '["a","b"]', '{"123": 5}']) {
      expect(() => loadConfig({...BASE_ENV, CIN7_LOCATION_MAP: bad})).toThrow(/CIN7_LOCATION_MAP/);
    }
  });
});

describe("getConfig", () => {
  it("loads from process.env once and memoizes", () => {
    process.env.CIN7_ACCOUNT_ID = "acct-memo";
    process.env.CIN7_APPLICATION_KEY = "key-memo";
    try {
      const first = getConfig();
      process.env.CIN7_ACCOUNT_ID = "changed";
      const second = getConfig();
      expect(second).toBe(first);
      expect(second.cin7AccountId).toBe("acct-memo");
    } finally {
      delete process.env.CIN7_ACCOUNT_ID;
      delete process.env.CIN7_APPLICATION_KEY;
    }
  });
});
