import {describe, it, expect} from "vitest";
import {assignSerial, SPLIT_MARKER_KEY, type CartOps, type SplitLine} from "./assignSerial";

const PROPERTY_KEY = "Serial Number";

type Call =
  | {op: "addLineItem"; variantId: number; quantity: number}
  | {op: "addLineItemProperties"; uuid: string; properties: Record<string, string>}
  | {op: "removeLineItemProperties"; uuid: string; keys: string[]}
  | {op: "removeLineItem"; uuid: string}
  | {op: "waitForProperty"; uuid: string; key: string};

interface FakeConfig {
  /** Results returned by successive `addLineItem` calls, in call order. */
  addLineItemResults?: string[];
  /** uuids for which `addLineItemProperties` should throw. */
  propertiesThrowFor?: Set<string>;
  /** uuids for which `removeLineItem` should throw. */
  removeThrowsFor?: Set<string>;
  /** uuids for which `removeLineItemProperties` should throw. */
  removePropertiesThrowsFor?: Set<string>;
  /** When false, the marker never becomes visible in cart state. */
  markerBecomesVisible?: boolean;
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
    async removeLineItemProperties(uuid, keys) {
      calls.push({op: "removeLineItemProperties", uuid, keys});
      if (config.removePropertiesThrowsFor?.has(uuid)) throw new Error("unmark failed");
    },
    async removeLineItem(uuid) {
      calls.push({op: "removeLineItem", uuid});
      if (config.removeThrowsFor?.has(uuid)) throw new Error("remove failed");
    },
    async waitForProperty(uuid, key) {
      calls.push({op: "waitForProperty", uuid, key});
      return config.markerBecomesVisible ?? true;
    },
  };

  return {cart, calls};
}

const qty1Line: SplitLine = {uuid: "original-uuid", variantId: 42, quantity: 1};
const qty3Line: SplitLine = {uuid: "original-uuid", variantId: 42, quantity: 3};

describe("assignSerial — quantity 1 (no split)", () => {
  it("writes the serial straight onto the existing line", async () => {
    const {cart, calls} = makeFakeCart();

    const outcome = await assignSerial(cart, qty1Line, "SN-001", PROPERTY_KEY);

    expect(outcome).toEqual({ok: true});
    expect(calls).toEqual([
      {
        op: "addLineItemProperties",
        uuid: "original-uuid",
        properties: {[PROPERTY_KEY]: "SN-001"},
      },
    ]);
  });

  it("reports the cart intact when the property write throws", async () => {
    const {cart, calls} = makeFakeCart({propertiesThrowFor: new Set(["original-uuid"])});

    const outcome = await assignSerial(cart, qty1Line, "SN-001", PROPERTY_KEY);

    expect(outcome).toEqual({ok: false, reason: "PROPERTY_WRITE_FAILED", cartIntact: true});
    expect(calls.filter((c) => c.op === "removeLineItem")).toEqual([]);
  });
});

describe("assignSerial — quantity > 1 (split)", () => {
  it("marks the original first so the new unit cannot merge back into it", async () => {
    const {cart, calls} = makeFakeCart({addLineItemResults: ["serialized-uuid", "remainder-uuid"]});

    const outcome = await assignSerial(cart, qty3Line, "SN-001", PROPERTY_KEY);

    expect(outcome).toEqual({ok: true});
    expect(calls).toEqual([
      // 1. mark the original — without this, step 2 merges into it
      {
        op: "addLineItemProperties",
        uuid: "original-uuid",
        properties: {[SPLIT_MARKER_KEY]: "1"},
      },
      // 2. wait until the marker is actually visible — without this the add merges
      {op: "waitForProperty", uuid: "original-uuid", key: SPLIT_MARKER_KEY},
      // 3. the serialized unit as its own line
      {op: "addLineItem", variantId: 42, quantity: 1},
      {
        op: "addLineItemProperties",
        uuid: "serialized-uuid",
        properties: {[PROPERTY_KEY]: "SN-001"},
      },
      // 4. the untagged remainder
      {op: "addLineItem", variantId: 42, quantity: 2},
      // 5. original removed last, taking the marker with it
      {op: "removeLineItem", uuid: "original-uuid"},
    ]);
  });

  it("never removes the original before both replacement lines exist", async () => {
    const {cart, calls} = makeFakeCart({addLineItemResults: ["serialized-uuid", "remainder-uuid"]});

    await assignSerial(cart, qty3Line, "SN-001", PROPERTY_KEY);

    const removeOriginalAt = calls.findIndex(
      (c) => c.op === "removeLineItem" && c.uuid === "original-uuid",
    );
    const lastAddAt = calls.map((c) => c.op).lastIndexOf("addLineItem");
    expect(removeOriginalAt).toBeGreaterThan(lastAddAt);
  });

  it("unmarks the original and keeps every unit when the first add is dismissed", async () => {
    const {cart, calls} = makeFakeCart({addLineItemResults: [""]});

    const outcome = await assignSerial(cart, qty3Line, "SN-001", PROPERTY_KEY);

    expect(outcome).toMatchObject({ok: false, cartIntact: true});
    expect(calls).toEqual([
      {op: "addLineItemProperties", uuid: "original-uuid", properties: {[SPLIT_MARKER_KEY]: "1"}},
      {op: "waitForProperty", uuid: "original-uuid", key: SPLIT_MARKER_KEY},
      {op: "addLineItem", variantId: 42, quantity: 1},
      {op: "removeLineItemProperties", uuid: "original-uuid", keys: [SPLIT_MARKER_KEY]},
    ]);
  });

  it("rolls back the serialized line when tagging it throws", async () => {
    const {cart, calls} = makeFakeCart({
      addLineItemResults: ["serialized-uuid"],
      propertiesThrowFor: new Set(["serialized-uuid"]),
    });

    const outcome = await assignSerial(cart, qty3Line, "SN-001", PROPERTY_KEY);

    expect(outcome).toMatchObject({ok: false, cartIntact: true});
    expect(calls).toContainEqual({op: "removeLineItem", uuid: "serialized-uuid"});
    expect(calls).toContainEqual({
      op: "removeLineItemProperties",
      uuid: "original-uuid",
      keys: [SPLIT_MARKER_KEY],
    });
    expect(calls).not.toContainEqual({op: "removeLineItem", uuid: "original-uuid"});
  });

  it("rolls back the serialized line when the remainder add is dismissed", async () => {
    const {cart, calls} = makeFakeCart({addLineItemResults: ["serialized-uuid", ""]});

    const outcome = await assignSerial(cart, qty3Line, "SN-001", PROPERTY_KEY);

    expect(outcome).toMatchObject({ok: false, cartIntact: true});
    expect(calls).toContainEqual({op: "removeLineItem", uuid: "serialized-uuid"});
    expect(calls).not.toContainEqual({op: "removeLineItem", uuid: "original-uuid"});
  });

  it("rolls back both new lines when removing the original throws", async () => {
    const {cart, calls} = makeFakeCart({
      addLineItemResults: ["serialized-uuid", "remainder-uuid"],
      removeThrowsFor: new Set(["original-uuid"]),
    });

    const outcome = await assignSerial(cart, qty3Line, "SN-001", PROPERTY_KEY);

    expect(outcome).toMatchObject({ok: false, cartIntact: true});
    expect(calls).toContainEqual({op: "removeLineItem", uuid: "serialized-uuid"});
    expect(calls).toContainEqual({op: "removeLineItem", uuid: "remainder-uuid"});
  });

  it("reports the cart not intact when a rollback removal also throws", async () => {
    const {cart} = makeFakeCart({
      addLineItemResults: ["serialized-uuid", "remainder-uuid"],
      removeThrowsFor: new Set(["original-uuid", "serialized-uuid"]),
    });

    const outcome = await assignSerial(cart, qty3Line, "SN-001", PROPERTY_KEY);

    expect(outcome).toMatchObject({ok: false, cartIntact: false});
  });

  it("reports the cart not intact when the marker cannot be removed", async () => {
    const {cart} = makeFakeCart({
      addLineItemResults: [""],
      removePropertiesThrowsFor: new Set(["original-uuid"]),
    });

    const outcome = await assignSerial(cart, qty3Line, "SN-001", PROPERTY_KEY);

    expect(outcome).toMatchObject({ok: false, cartIntact: false});
  });

  it("splits a quantity-2 line into one serialized unit and one remainder", async () => {
    const {cart, calls} = makeFakeCart({addLineItemResults: ["serialized-uuid", "remainder-uuid"]});

    const outcome = await assignSerial(
      cart,
      {uuid: "original-uuid", variantId: 42, quantity: 2},
      "SN-001",
      PROPERTY_KEY,
    );

    expect(outcome).toEqual({ok: true});
    expect(calls.filter((c) => c.op === "addLineItem")).toEqual([
      {op: "addLineItem", variantId: 42, quantity: 1},
      {op: "addLineItem", variantId: 42, quantity: 1},
    ]);
  });

  it("refuses and preserves the serial when POS merges the add into the original", async () => {
    // Regression for the on-device failure: addLineItem returned the ORIGINAL
    // line's uuid (a merge). Previously we tagged and then removed that line,
    // destroying the unit holding the serial.
    const {cart, calls} = makeFakeCart({addLineItemResults: ["original-uuid"]});

    const outcome = await assignSerial(cart, qty3Line, "SN-001", PROPERTY_KEY);

    expect(outcome).toMatchObject({ok: false, reason: "LINE_MERGED"});
    // The merged line must never be tagged with the serial...
    expect(calls).not.toContainEqual({
      op: "addLineItemProperties",
      uuid: "original-uuid",
      properties: {[PROPERTY_KEY]: "SN-001"},
    });
    // ...nor removed.
    expect(calls).not.toContainEqual({op: "removeLineItem", uuid: "original-uuid"});
  });

  it("refuses if the remainder add merges instead of creating a line", async () => {
    const {cart, calls} = makeFakeCart({
      addLineItemResults: ["serialized-uuid", "serialized-uuid"],
    });

    const outcome = await assignSerial(cart, qty3Line, "SN-001", PROPERTY_KEY);

    expect(outcome).toMatchObject({ok: false, reason: "LINE_MERGED"});
    expect(calls).not.toContainEqual({op: "removeLineItem", uuid: "original-uuid"});
  });

  it("aborts before adding if the marker never becomes visible", async () => {
    const {cart, calls} = makeFakeCart({
      markerBecomesVisible: false,
      addLineItemResults: ["serialized-uuid", "remainder-uuid"],
    });

    const outcome = await assignSerial(cart, qty3Line, "SN-001", PROPERTY_KEY);

    expect(outcome).toMatchObject({ok: false, reason: "MARKER_NOT_VISIBLE", cartIntact: true});
    expect(calls.filter((c) => c.op === "addLineItem")).toEqual([]);
    expect(calls).toContainEqual({
      op: "removeLineItemProperties",
      uuid: "original-uuid",
      keys: [SPLIT_MARKER_KEY],
    });
  });
});
