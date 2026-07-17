import {render} from "preact";
import {useEffect, useState} from "preact/hooks";
import type {CartLineLike} from "./lib/serials";
import {unitsNeedingSerial} from "./lib/serials";
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
// `variantId` / `sku` / `title` (custom sales have no product association),
// while `CartLineLike` (shared with the serials lib) requires them. Only
// lines tied to a real product can ever be serialized, so lines without a
// `productId` are dropped here rather than widening `CartLineLike`.
type PosCart = typeof shopify.cart.current.value;
type PosLineItem = PosCart["lineItems"][number];

function toCartLine(line: PosLineItem): CartLineLike | null {
  if (line.productId === undefined) return null;
  return {
    uuid: line.uuid,
    quantity: line.quantity,
    productId: line.productId,
    variantId: line.variantId ?? 0,
    sku: line.sku ?? "",
    title: line.title ?? "",
    properties: line.properties,
  };
}

function Tile() {
  const [state, setState] = useState<TileState>({needed: 0, hasSerialized: false, error: false});

  useEffect(() => {
    let cancelled = false;

    async function evaluate(cart: PosCart) {
      try {
        const lines = cart.lineItems
          .map(toCartLine)
          .filter((line): line is CartLineLike => line !== null);
        const map = await fetchSerializedMap(lines.map((l) => l.productId));
        if (cancelled) return;
        setState({
          needed: unitsNeedingSerial(lines, map),
          hasSerialized: lines.some((l) => map[String(l.productId)]),
          error: false,
        });
      } catch {
        // Fail visible: a backend blip must not hide the workflow.
        if (!cancelled) setState({needed: 0, hasSerialized: true, error: true});
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
