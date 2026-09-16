import "@shopify/ui-extensions/preact";
import {render} from "preact";
import {useRef, useState} from "preact/hooks";
import {parsePrice, PRICE_ERROR} from "./lib/price";

/** Fixed line-item title. Every spare part reads the same on a receipt. */
const TITLE = "Spare Parts";

export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  const [entry, setEntry] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  // Ref, not state: `adding` is captured at render time, so two taps in the
  // same frame would both add a line item. Same guard as the serial transform.
  const addingRef = useRef(false);

  async function add() {
    if (addingRef.current) return;

    const parsed = parsePrice(entry);
    if (parsed.ok === false) {
      setError(PRICE_ERROR[parsed.reason]);
      return;
    }

    addingRef.current = true;
    setAdding(true);
    setError(null);
    try {
      await shopify.cart.addCustomSale({
        quantity: 1,
        title: TITLE,
        price: parsed.price,
        // Always taxable. Whether the amount typed is treated as tax-inclusive
        // is the store's own Shopify tax setting, which an extension can't
        // override — see the README.
        taxable: true,
      });
      shopify.toast.show(`${TITLE} ${parsed.price} added`);
      setEntry("");
    } catch {
      setError("Couldn't add the item — try again.");
    } finally {
      addingRef.current = false;
      setAdding(false);
    }
  }

  return (
    <s-page heading={TITLE}>
      <s-section>
        <s-number-field
          label="Price"
          inputMode="decimal"
          placeholder="0.00"
          value={entry}
          // Native field error, rather than a separate text node: it sits with
          // the field and is announced with it.
          error={error ?? undefined}
          onInput={(e) => {
            setEntry(e.currentTarget.value ?? "");
            if (error) setError(null);
          }}
        />
        <s-button onClick={add} loading={adding}>
          Add to cart
        </s-button>
      </s-section>
    </s-page>
  );
}
