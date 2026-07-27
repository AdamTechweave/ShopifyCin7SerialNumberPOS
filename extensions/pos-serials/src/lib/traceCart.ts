import type {CartOps} from "./assignSerial";

/**
 * TEMPORARY diagnostic wrapper for on-device investigation of POS cart-merge
 * behaviour. Wraps the real cart API, recording every mutation, its return
 * value, and the cart state observed immediately afterwards, then posts the
 * trace to /api/pos/debug where it surfaces in the `shopify app dev` output.
 * Remove along with the debug route once split behaviour is settled.
 */

interface Snapshot {
  uuid: string;
  variantId?: number;
  quantity: number;
  properties: Record<string, string>;
}

interface TraceEntry {
  step: string;
  args?: unknown;
  returned?: unknown;
  error?: string;
  cartAfter: Snapshot[];
}

function snapshot(): Snapshot[] {
  try {
    return shopify.cart.current.value.lineItems.map((l) => ({
      uuid: l.uuid,
      variantId: l.variantId,
      quantity: l.quantity,
      properties: l.properties ?? {},
    }));
  } catch (e) {
    return [{uuid: `snapshot failed: ${e}`, quantity: -1, properties: {}}];
  }
}

export function traceCart(cart: CartOps): {ops: CartOps; flush: (context: unknown) => void} {
  const trace: TraceEntry[] = [];

  async function record<T>(step: string, args: unknown, run: () => Promise<T>): Promise<T> {
    try {
      const returned = await run();
      trace.push({step, args, returned, cartAfter: snapshot()});
      return returned;
    } catch (e) {
      trace.push({step, args, error: String(e), cartAfter: snapshot()});
      throw e;
    }
  }

  const ops: CartOps = {
    addLineItem: (variantId, quantity) =>
      record("addLineItem", {variantId, quantity}, () => cart.addLineItem(variantId, quantity)),
    addLineItemProperties: (uuid, properties) =>
      record("addLineItemProperties", {uuid, properties}, () =>
        cart.addLineItemProperties(uuid, properties),
      ),
    removeLineItemProperties: (uuid, keys) =>
      record("removeLineItemProperties", {uuid, keys}, () =>
        cart.removeLineItemProperties(uuid, keys),
      ),
    removeLineItem: (uuid) => record("removeLineItem", {uuid}, () => cart.removeLineItem(uuid)),
    waitForProperty: (uuid, key) =>
      record("waitForProperty", {uuid, key}, () => cart.waitForProperty(uuid, key)),
  };

  return {
    ops,
    flush: (context) => {
      void fetch("/api/pos/debug", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({context, cartBefore: undefined, trace, cartFinal: snapshot()}),
      }).catch(() => {});
    },
  };
}
