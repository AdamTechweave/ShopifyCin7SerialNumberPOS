export interface CartOps {
  addLineItem(variantId: number, quantity: number): Promise<string>;
  addLineItemProperties(uuid: string, properties: Record<string, string>): Promise<void>;
  removeLineItemProperties(uuid: string, keys: string[]): Promise<void>;
  removeLineItem(uuid: string): Promise<void>;
  /**
   * Resolves true once the given line is observed carrying `key` in cart state,
   * false if it doesn't become visible in time.
   */
  waitForProperty(uuid: string, key: string): Promise<boolean>;
}

export interface SplitLine {
  uuid: string;
  variantId: number;
  quantity: number;
}

export type AssignFailure =
  | "PROPERTY_WRITE_FAILED"
  | "MARKER_NOT_VISIBLE"
  | "LINE_MERGED"
  | "ADD_DISMISSED";

export type AssignOutcome =
  | {ok: true}
  | {ok: false; reason: AssignFailure; cartIntact: boolean};

/**
 * Marks the line being split so POS won't merge a freshly added plain line into
 * it.
 *
 * Deliberately NOT underscore-prefixed. An underscore-prefixed key is hidden
 * from order/receipt display, which was the original choice — but device traces
 * (2026-07-26) proved POS ignores hidden properties when deciding whether to
 * merge: the marker was confirmed visible in cart state and the add still merged
 * into the marked line. The same traces show an add does NOT merge into a line
 * carrying a visible property. So the marker has to be visible to do its job.
 *
 * It exists only between the first and last step of a split and disappears with
 * the original line on success, so staff see it briefly at most.
 */
export const SPLIT_MARKER_KEY = "Serial assignment";

/**
 * Assigns a serial to a cart line, splitting qty>1 lines so the serialized unit
 * is its own qty-1 line.
 *
 * Why this is more than "add a line and tag it" — all observed on device
 * 2026-07-26 (see docs/superpowers/notes/2026-07-pos-cart-merge.md):
 *
 *  - The Cart API has no `properties` argument on `addLineItem` and no quantity
 *    setter, so a split has to be built from add/remove calls.
 *  - POS merges a newly added line into an existing same-variant line when both
 *    carry the same properties, and `addLineItem` then returns the EXISTING
 *    line's uuid rather than a new one.
 *  - A resolved `addLineItemProperties` does NOT mean the property is visible in
 *    cart state yet, and the merge decision reads that state — so tagging the
 *    original and immediately adding still merged.
 *
 * Hence: tag the original, wait until the tag is actually visible, then add. Both
 * adds are checked against the uuids we already know, so an unexpected merge is
 * reported instead of silently destroying units. The original is removed last,
 * so any failure leaves the cart over-counted (visible to staff) rather than
 * short.
 */
export async function assignSerial(
  cart: CartOps,
  line: SplitLine,
  serial: string,
  propertyKey: string,
): Promise<AssignOutcome> {
  if (line.quantity === 1) {
    try {
      await cart.addLineItemProperties(line.uuid, {[propertyKey]: serial});
      return {ok: true};
    } catch {
      return {ok: false, reason: "PROPERTY_WRITE_FAILED", cartIntact: true};
    }
  }

  let marked = false;
  let serializedUuid = "";
  let remainderUuid = "";

  const rollback = async (): Promise<boolean> => {
    let cartIntact = true;
    for (const uuid of [serializedUuid, remainderUuid]) {
      if (!uuid || uuid === line.uuid) continue;
      try {
        await cart.removeLineItem(uuid);
      } catch {
        cartIntact = false;
      }
    }
    if (marked) {
      try {
        await cart.removeLineItemProperties(line.uuid, [SPLIT_MARKER_KEY]);
      } catch {
        cartIntact = false;
      }
    }
    return cartIntact;
  };

  const fail = async (reason: AssignFailure, cartIntact = true): Promise<AssignOutcome> => {
    const rolledBackClean = await rollback();
    return {ok: false, reason, cartIntact: cartIntact && rolledBackClean};
  };

  try {
    await cart.addLineItemProperties(line.uuid, {[SPLIT_MARKER_KEY]: "in progress"});
    marked = true;

    // Without this the add below merges into the original line.
    if (!(await cart.waitForProperty(line.uuid, SPLIT_MARKER_KEY))) {
      return await fail("MARKER_NOT_VISIBLE");
    }

    serializedUuid = await cart.addLineItem(line.variantId, 1);
    if (!serializedUuid) return await fail("ADD_DISMISSED");
    if (serializedUuid === line.uuid) {
      // Merged anyway: the original absorbed the unit, so the cart is now one
      // unit over. Never tag or remove it — that's what destroyed units before.
      serializedUuid = "";
      return await fail("LINE_MERGED", false);
    }

    await cart.addLineItemProperties(serializedUuid, {[propertyKey]: serial});

    remainderUuid = await cart.addLineItem(line.variantId, line.quantity - 1);
    if (!remainderUuid) return await fail("ADD_DISMISSED");
    if (remainderUuid === line.uuid || remainderUuid === serializedUuid) {
      remainderUuid = "";
      return await fail("LINE_MERGED", false);
    }

    // Removing the original also discards its marker.
    await cart.removeLineItem(line.uuid);
    return {ok: true};
  } catch {
    return await fail("PROPERTY_WRITE_FAILED");
  }
}
