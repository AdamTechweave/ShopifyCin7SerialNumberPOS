import {describe, it, expect} from "vitest";
import {toProductGid, buildSerializedMap, SERIAL_TAG} from "./tags";

describe("toProductGid", () => {
  it("converts a numeric product ID to an Admin GID", () => {
    expect(toProductGid(123456)).toBe("gid://shopify/Product/123456");
  });
});

describe("buildSerializedMap", () => {
  it("maps numeric ids to whether tags include the serial tag", () => {
    const nodes = [
      {id: "gid://shopify/Product/1", tags: ["serialized", "sale"]},
      {id: "gid://shopify/Product/2", tags: ["sale"]},
      null,
    ];
    expect(buildSerializedMap(nodes, "serialized")).toEqual({"1": true, "2": false});
  });

  it("respects a custom tag", () => {
    const nodes = [{id: "gid://shopify/Product/1", tags: ["track-serial"]}];
    expect(buildSerializedMap(nodes, "track-serial")).toEqual({"1": true});
  });

  it("defaults to the `serialized` tag the clients' products are tagged with", () => {
    expect(SERIAL_TAG).toBe("serialized");
  });
});
