import {render} from "preact";
import {useEffect, useMemo, useState} from "preact/hooks";
import {LineList} from "./screens/LineList";
import {SerialPicker} from "./screens/SerialPicker";
import {SERIAL_PROPERTY_KEY, toCartLine, type CartLineLike} from "./lib/serials";
import {assignSerial} from "./lib/assignSerial";
import {traceCart} from "./lib/traceCart";
import {createCartOps} from "./lib/cartOps";

type Screen = {name: "lines"} | {name: "picker"; lineUuid: string};

export default async () => {
  render(<Modal />, document.body);
};

function Modal() {
  const [cart, setCart] = useState(shopify.cart.current.value);
  const [screen, setScreen] = useState<Screen>({name: "lines"});
  const [saving, setSaving] = useState(false);

  useEffect(() => shopify.cart.current.subscribe(setCart), []);

  // `cart.lineItems` is the raw POS `LineItem[]` (optional productId /
  // variantId / sku / title — see `toCartLine` in lib/serials.ts). Normalize
  // whenever the cart signal actually fires, not on every render — the `cart`
  // prop object's reference must stay stable across unrelated re-renders
  // (e.g. `saving`/`screen` state churn), or downstream effects keyed on it
  // (like the camera scanner subscription) will spuriously re-run.
  const cartForScreens = useMemo(() => {
    const lines: CartLineLike[] = cart.lineItems
      .map(toCartLine)
      .filter((line): line is CartLineLike => line !== null);
    return {lineItems: lines};
  }, [cart]);
  const lines = cartForScreens.lineItems;

  const line =
    screen.name === "picker" ? lines.find((l) => l.uuid === screen.lineUuid) : undefined;

  if (screen.name === "picker" && line) {
    return (
      <SerialPicker
        line={line}
        cart={cartForScreens}
        onDone={() => setScreen({name: "lines"})}
        onChoose={async (serial) => {
          if (saving) return;
          setSaving(true);
          // TEMPORARY: traced cart ops so on-device merge behaviour lands in the
          // dev server log. Revert to passing `shopify.cart` directly once the
          // split behaviour is settled.
          const traced = traceCart(createCartOps());
          try {
            const outcome = await assignSerial(traced.ops, line, serial, SERIAL_PROPERTY_KEY);
            traced.flush({
              serial,
              pickedLine: {uuid: line.uuid, variantId: line.variantId, quantity: line.quantity},
              outcome,
            });
            if (outcome.ok === true) {
              shopify.toast.show(`Serial ${serial} assigned`);
              setScreen({name: "lines"});
            } else if (!outcome.cartIntact) {
              shopify.toast.show("Serial not saved — check item quantities in the cart");
            } else if (outcome.reason === "LINE_MERGED") {
              shopify.toast.show("POS merged the line — set quantity to 1 and try again");
            } else {
              shopify.toast.show("Couldn't save the serial — try again");
            }
          } finally {
            setSaving(false);
          }
        }}
      />
    );
  }

  // Also lands here if the picked line disappeared from the cart mid-flow.
  return <LineList cart={cartForScreens} onPick={(lineUuid) => setScreen({name: "picker", lineUuid})} />;
}
