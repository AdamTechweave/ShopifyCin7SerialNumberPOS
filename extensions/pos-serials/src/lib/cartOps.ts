import type {CartOps} from "./assignSerial";

/** How long to wait for a property write to become visible in cart state. */
const PROPERTY_VISIBLE_TIMEOUT_MS = 4000;

/**
 * Builds the real `CartOps` from the POS cart API.
 *
 * `waitForProperty` exists because a resolved `addLineItemProperties` does not
 * mean the property is visible in cart state yet, and POS decides whether an
 * `addLineItem` merges into an existing line by comparing properties. Observed
 * on device 2026-07-26: adding immediately after tagging merged into the
 * still-apparently-plain line and returned that line's uuid. Waiting for the
 * property to actually appear removes the race.
 */
export function createCartOps(): CartOps {
  return {
    addLineItem: (variantId, quantity) => shopify.cart.addLineItem(variantId, quantity),
    addLineItemProperties: (uuid, properties) =>
      shopify.cart.addLineItemProperties(uuid, properties),
    removeLineItemProperties: (uuid, keys) => shopify.cart.removeLineItemProperties(uuid, keys),
    removeLineItem: (uuid) => shopify.cart.removeLineItem(uuid),

    waitForProperty: (uuid, key) =>
      new Promise<boolean>((resolve) => {
        const hasProperty = () =>
          shopify.cart.current.value.lineItems.some(
            (l) => l.uuid === uuid && l.properties?.[key] !== undefined,
          );

        if (hasProperty()) {
          resolve(true);
          return;
        }

        let settled = false;
        const finish = (result: boolean) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          unsubscribe();
          resolve(result);
        };

        const timer = setTimeout(() => finish(false), PROPERTY_VISIBLE_TIMEOUT_MS);
        const unsubscribe = shopify.cart.current.subscribe(() => {
          if (hasProperty()) finish(true);
        });
      }),
  };
}
