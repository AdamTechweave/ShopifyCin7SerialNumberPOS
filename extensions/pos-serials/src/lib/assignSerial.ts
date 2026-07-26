export interface CartOps {
  addLineItem(variantId: number, quantity: number): Promise<string>;
  addLineItemProperties(uuid: string, properties: Record<string, string>): Promise<void>;
  removeLineItemProperties(uuid: string, keys: string[]): Promise<void>;
  removeLineItem(uuid: string): Promise<void>;
}

export interface SplitLine {
  uuid: string;
  variantId: number;
  quantity: number;
}

export type AssignOutcome = {ok: true} | {ok: false; cartIntact: boolean};

/**
 * Marks the line being split so POS can't merge a freshly added plain line back
 * into it. Underscore-prefixed so Shopify hides it from order/receipt display;
 * it only exists between the first and last step of a split and is removed with
 * the original line on success.
 */
export const SPLIT_MARKER_KEY = "_serialSplitPending";

/**
 * Assigns a serial to a cart line, splitting qty>1 lines so the serialized unit
 * is its own qty-1 line.
 *
 * The POS Cart API has no `properties` argument on `addLineItem` and no quantity
 * setter, and POS merges same-variant lines that carry identical properties. A
 * naive "add 1, then tag it" therefore merges the new unit straight back into
 * the original line, and removing the original then deletes the serialized unit
 * along with it (observed on device 2026-07-26: a qty-2 line collapsed to a
 * single untagged qty-1 line). To avoid that, the original is marked first so it
 * can no longer absorb a plain add.
 *
 * Ordering keeps the never-lose-units invariant: everything is built while the
 * original is still present, and the original is removed last. Any failure
 * leaves the cart over-counted (obvious to staff) rather than short.
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
      return {ok: false, cartIntact: true};
    }
  }

  let marked = false;
  let serializedUuid = "";
  let remainderUuid = "";

  const rollback = async (): Promise<boolean> => {
    let cartIntact = true;
    for (const uuid of [serializedUuid, remainderUuid]) {
      if (!uuid) continue;
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

  try {
    await cart.addLineItemProperties(line.uuid, {[SPLIT_MARKER_KEY]: "1"});
    marked = true;

    serializedUuid = await cart.addLineItem(line.variantId, 1);
    if (!serializedUuid) return {ok: false, cartIntact: await rollback()};
    await cart.addLineItemProperties(serializedUuid, {[propertyKey]: serial});

    remainderUuid = await cart.addLineItem(line.variantId, line.quantity - 1);
    if (!remainderUuid) return {ok: false, cartIntact: await rollback()};

    // Removing the original also discards its marker.
    await cart.removeLineItem(line.uuid);
    return {ok: true};
  } catch {
    return {ok: false, cartIntact: await rollback()};
  }
}
