import {describe, it, expect} from "vitest";
import {loadConfig} from "./config.server";

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

  it("applies defaults for tag and property key", () => {
    const config = loadConfig(BASE_ENV);
    expect(config.serialTag).toBe("serialized");
    expect(config.serialPropertyKey).toBe("Serial Number");
  });

  it("parses the location map", () => {
    const config = loadConfig({...BASE_ENV, CIN7_LOCATION_MAP: '{"123":"Auckland Store"}'});
    expect(config.locationMap).toEqual({"123": "Auckland Store"});
  });

  it("defaults the location map to empty and rejects invalid JSON", () => {
    expect(loadConfig(BASE_ENV).locationMap).toEqual({});
    expect(() => loadConfig({...BASE_ENV, CIN7_LOCATION_MAP: "not json"})).toThrow(/CIN7_LOCATION_MAP/);
  });
});
