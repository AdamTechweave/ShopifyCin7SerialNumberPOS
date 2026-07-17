import {render} from "preact";
import {useEffect, useState} from "preact/hooks";
import type {CartLineLike} from "./lib/serials";
import {unitsNeedingSerial, toCartLine} from "./lib/serials";
import {fetchSerializedMap} from "./lib/api";

export default async () => {
  render(<Tile />, document.body);
};

interface TileState {
  needed: number;
  hasSerialized: boolean;
  error: boolean;
}

// `shopify.cart.current.value.lineItems` entries have optional `productId` /
// `variantId` / `sku` / `title` (custom sales have no product association).
// `toCartLine` (shared with Modal.tsx via `lib/serials.ts`) normalizes them
// into `CartLineLike`, dropping lines without a `productId`.
type PosCart = typeof shopify.cart.current.value;

function Tile() {
  const [state, setState] = useState<TileState>({needed: 0, hasSerialized: false, error: false});

  useEffect(() => {
    let cancelled = false;
    let generation = 0;

    async function evaluate(cart: PosCart) {
      const myGeneration = ++generation;
      try {
        const lines = cart.lineItems
          .map(toCartLine)
          .filter((line): line is CartLineLike => line !== null);
        const map = await fetchSerializedMap(lines.map((l) => l.productId));
        if (cancelled || myGeneration !== generation) return;
        setState({
          needed: unitsNeedingSerial(lines, map),
          hasSerialized: lines.some((l) => map[String(l.productId)]),
          error: false,
        });
      } catch {
        // Fail visible: a backend blip must not hide the workflow.
        if (cancelled || myGeneration !== generation) return;
        setState({needed: 0, hasSerialized: true, error: true});
      }
    }

    evaluate(shopify.cart.current.value);
    const unsubscribe = shopify.cart.current.subscribe(evaluate);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const {needed, hasSerialized, error} = state;
  const subheading = error
    ? "Check serials"
    : !hasSerialized
      ? "No serialized items"
      : needed > 0
        ? `${needed} serial${needed === 1 ? "" : "s"} needed`
        : "Serials complete";

  return (
    <s-tile
      heading="Serial numbers"
      subheading={subheading}
      {...(needed > 0 ? {itemCount: needed} : {})}
      tone={needed > 0 || error ? "accent" : "neutral"}
      disabled={!hasSerialized && !error}
      onClick={() => shopify.action.presentModal()}
    />
  );
}
