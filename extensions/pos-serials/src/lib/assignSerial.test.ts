import {describe, it, expect} from "vitest";
import {assignSerial, type CartOps, type SplitLine} from "./assignSerial";

const PROPERTY_KEY = "Serial Number";

type Call =
  | {op: "addLineItem"; variantId: number; quantity: number}
  | {op: "addLineItemProperties"; uuid: string; properties: Record<string, string>}
  | {op: "removeLineItem"; uuid: string};

interface FakeConfig {
  /** Results returned by successive `addLineItem` calls, in call order. */
  addLineItemResults?: string[];
  /** uuids for which `addLineItemProperties` should throw. */
  propertiesThrowFor?: Set<string>;
  /** uuids for which `removeLineItem` should throw. */
  removeThrowsFor?: Set<string>;
}

function makeFakeCart(config: FakeConfig = {}) {
  const calls: Call[] = [];
  let addLineItemCallIndex = 0;

  const cart: CartOps = {
    async addLineItem(variantId, quantity) {
      calls.push({op: "addLineItem", variantId, quantity});
      const result = config.addLineItemResults?.[addLineItemCallIndex] ?? "";
      addLineItemCallIndex++;
      return result;
    },
    async addLineItemProperties(uuid, properties) {
      calls.push({op: "addLineItemProperties", uuid, properties});
      if (config.propertiesThrowFor?.has(uuid)) throw new Error("properties failed");
    },
    async removeLineItem(uuid) {
      calls.push({op: "removeLineItem", uuid});
      if (config.removeThrowsFor?.has(uuid)) throw new Error("remove failed");
    },
  };

  return {cart, calls};
}

const originalLine: SplitLine = {uuid: "original-uuid", variantId: 42, quantity: 1};

describe("assignSerial", () => {
  it("qty 1: success -> single addLineItemProperties call, {ok:true}", async () => {
    const {cart, calls} = makeFakeCart();
    const line: SplitLine = {...originalLine, quantity: 1};

    const outcome = await assignSerial(cart, line, "SN-1", PROPERTY_KEY);

    expect(outcome).toEqual({ok: true});
    expect(calls).toEqual([
      {op: "addLineItemProperties", uuid: "original-uuid", properties: {[PROPERTY_KEY]: "SN-1"}},
    ]);
  });

  it("qty 1: property write throws -> {ok:false, cartIntact:true}, no removals", async () => {
    const {cart, calls} = makeFakeCart({propertiesThrowFor: new Set(["original-uuid"])});
    const line: SplitLine = {...originalLine, quantity: 1};

    const outcome = await assignSerial(cart, line, "SN-1", PROPERTY_KEY);

    expect(outcome).toEqual({ok: false, cartIntact: true});
    expect(calls).toEqual([
      {op: "addLineItemProperties", uuid: "original-uuid", properties: {[PROPERTY_KEY]: "SN-1"}},
    ]);
    expect(calls.some((c) => c.op === "removeLineItem")).toBe(false);
  });

  it("qty 3 success: exact call order, {ok:true}", async () => {
    const {cart, calls} = makeFakeCart({
      addLineItemResults: ["new-serialized-uuid", "new-remainder-uuid"],
    });
    const line: SplitLine = {...originalLine, quantity: 3};

    const outcome = await assignSerial(cart, line, "SN-1", PROPERTY_KEY);

    expect(outcome).toEqual({ok: true});
    expect(calls).toEqual([
      {op: "addLineItem", variantId: 42, quantity: 1},
      {
        op: "addLineItemProperties",
        uuid: "new-serialized-uuid",
        properties: {[PROPERTY_KEY]: "SN-1"},
      },
      {op: "addLineItem", variantId: 42, quantity: 2},
      {op: "removeLineItem", uuid: "original-uuid"},
    ]);
  });

  it('first addLineItem returns "" -> no further calls, {ok:false, cartIntact:true}', async () => {
    const {cart, calls} = makeFakeCart({addLineItemResults: [""]});
    const line: SplitLine = {...originalLine, quantity: 3};

    const outcome = await assignSerial(cart, line, "SN-1", PROPERTY_KEY);

    expect(outcome).toEqual({ok: false, cartIntact: true});
    expect(calls).toEqual([{op: "addLineItem", variantId: 42, quantity: 1}]);
  });

  it("addLineItemProperties throws -> serialized unit removed, original untouched, {ok:false, cartIntact:true}", async () => {
    const {cart, calls} = makeFakeCart({
      addLineItemResults: ["new-serialized-uuid"],
      propertiesThrowFor: new Set(["new-serialized-uuid"]),
    });
    const line: SplitLine = {...originalLine, quantity: 3};

    const outcome = await assignSerial(cart, line, "SN-1", PROPERTY_KEY);

    expect(outcome).toEqual({ok: false, cartIntact: true});
    expect(calls).toEqual([
      {op: "addLineItem", variantId: 42, quantity: 1},
      {
        op: "addLineItemProperties",
        uuid: "new-serialized-uuid",
        properties: {[PROPERTY_KEY]: "SN-1"},
      },
      {op: "removeLineItem", uuid: "new-serialized-uuid"},
    ]);
    expect(calls.some((c) => c.op === "removeLineItem" && c.uuid === "original-uuid")).toBe(false);
  });

  it('remainder addLineItem returns "" -> serialized unit removed, {ok:false, cartIntact:true}', async () => {
    const {cart, calls} = makeFakeCart({
      addLineItemResults: ["new-serialized-uuid", ""],
    });
    const line: SplitLine = {...originalLine, quantity: 3};

    const outcome = await assignSerial(cart, line, "SN-1", PROPERTY_KEY);

    expect(outcome).toEqual({ok: false, cartIntact: true});
    expect(calls).toEqual([
      {op: "addLineItem", variantId: 42, quantity: 1},
      {
        op: "addLineItemProperties",
        uuid: "new-serialized-uuid",
        properties: {[PROPERTY_KEY]: "SN-1"},
      },
      {op: "addLineItem", variantId: 42, quantity: 2},
      {op: "removeLineItem", uuid: "new-serialized-uuid"},
    ]);
  });

  it("final removeLineItem(original) throws -> BOTH new lines removed, {ok:false, cartIntact:true}", async () => {
    const {cart, calls} = makeFakeCart({
      addLineItemResults: ["new-serialized-uuid", "new-remainder-uuid"],
      removeThrowsFor: new Set(["original-uuid"]),
    });
    const line: SplitLine = {...originalLine, quantity: 3};

    const outcome = await assignSerial(cart, line, "SN-1", PROPERTY_KEY);

    expect(outcome).toEqual({ok: false, cartIntact: true});
    expect(calls).toEqual([
      {op: "addLineItem", variantId: 42, quantity: 1},
      {
        op: "addLineItemProperties",
        uuid: "new-serialized-uuid",
        properties: {[PROPERTY_KEY]: "SN-1"},
      },
      {op: "addLineItem", variantId: 42, quantity: 2},
      {op: "removeLineItem", uuid: "original-uuid"},
      {op: "removeLineItem", uuid: "new-serialized-uuid"},
      {op: "removeLineItem", uuid: "new-remainder-uuid"},
    ]);
  });

  it("rollback removal also throws -> {ok:false, cartIntact:false}", async () => {
    const {cart, calls} = makeFakeCart({
      addLineItemResults: ["new-serialized-uuid", "new-remainder-uuid"],
      removeThrowsFor: new Set(["original-uuid", "new-serialized-uuid"]),
    });
    const line: SplitLine = {...originalLine, quantity: 3};

    const outcome = await assignSerial(cart, line, "SN-1", PROPERTY_KEY);

    expect(outcome).toEqual({ok: false, cartIntact: false});
    expect(calls).toEqual([
      {op: "addLineItem", variantId: 42, quantity: 1},
      {
        op: "addLineItemProperties",
        uuid: "new-serialized-uuid",
        properties: {[PROPERTY_KEY]: "SN-1"},
      },
      {op: "addLineItem", variantId: 42, quantity: 2},
      {op: "removeLineItem", uuid: "original-uuid"},
      {op: "removeLineItem", uuid: "new-serialized-uuid"},
      {op: "removeLineItem", uuid: "new-remainder-uuid"},
    ]);
  });
});
