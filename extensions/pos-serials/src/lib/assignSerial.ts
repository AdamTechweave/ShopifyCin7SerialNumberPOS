export interface CartOps {
  addLineItem(variantId: number, quantity: number): Promise<string>;
  addLineItemProperties(uuid: string, properties: Record<string, string>): Promise<void>;
  removeLineItem(uuid: string): Promise<void>;
}

export interface SplitLine {
  uuid: string;
  variantId: number;
  quantity: number;
}

export type AssignOutcome = {ok: true} | {ok: false; cartIntact: boolean};

/**
 * Assigns a serial to a cart line, splitting qty>1 lines so the serialized
 * unit is its own qty-1 line. Builds new lines FIRST and removes the original
 * LAST, so no failure can lose units — a failed rollback leaves the cart
 * over-counted (visible to staff), never under.
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

  let serializedUuid = "";
  let remainderUuid = "";
  try {
    serializedUuid = await cart.addLineItem(line.variantId, 1);
    if (!serializedUuid) return {ok: false, cartIntact: true};
    await cart.addLineItemProperties(serializedUuid, {[propertyKey]: serial});
    remainderUuid = await cart.addLineItem(line.variantId, line.quantity - 1);
    if (!remainderUuid) {
      await cart.removeLineItem(serializedUuid);
      return {ok: false, cartIntact: true};
    }
    await cart.removeLineItem(line.uuid);
    return {ok: true};
  } catch {
    let cartIntact = true;
    for (const uuid of [serializedUuid, remainderUuid]) {
      if (!uuid) continue;
      try {
        await cart.removeLineItem(uuid);
      } catch {
        cartIntact = false;
      }
    }
    return {ok: false, cartIntact};
  }
}
