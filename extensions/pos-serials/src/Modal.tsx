import {render} from "preact";
import {useEffect, useMemo, useState} from "preact/hooks";
import {LineList} from "./screens/LineList";
import {SerialPicker} from "./screens/SerialPicker";
import {SERIAL_PROPERTY_KEY, toCartLine, type CartLineLike} from "./lib/serials";
import {assignSerial} from "./lib/assignSerial";

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
          try {
            const outcome = await assignSerial(shopify.cart, line, serial, SERIAL_PROPERTY_KEY);
            if (outcome.ok === true) {
              shopify.toast.show(`Serial ${serial} assigned`);
              setScreen({name: "lines"});
            } else if (outcome.cartIntact) {
              shopify.toast.show("Couldn't save the serial — try again");
            } else {
              shopify.toast.show("Couldn't save the serial — check item quantities in the cart");
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
