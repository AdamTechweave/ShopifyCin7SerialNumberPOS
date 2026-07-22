import {useEffect, useState} from "preact/hooks";
import {fetchSerializedMap} from "../lib/api";
import {SERIAL_PROPERTY_KEY, serializedLines, type CartLineLike} from "../lib/serials";

interface Props {
  cart: {lineItems: CartLineLike[]};
  onPick: (lineUuid: string) => void;
}

export function LineList({cart, onPick}: Props) {
  const [map, setMap] = useState<Record<string, boolean> | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchSerializedMap(cart.lineItems.map((l) => l.productId))
      .then((m) => {
        if (!cancelled) {
          setMap(m);
          setError(false);
        }
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [cart]);

  if (error) {
    return (
      <s-page heading="Serial numbers">
        <s-banner tone="critical" heading="Couldn't load product data">
          Check the connection, then close and reopen this screen.
        </s-banner>
      </s-page>
    );
  }
  if (!map) {
    return (
      <s-page heading="Serial numbers">
        <s-text>Loading…</s-text>
      </s-page>
    );
  }

  const lines = serializedLines(cart.lineItems, map);
  return (
    <s-page heading="Serial numbers">
      <s-scroll-box>
        <s-section heading="Serialized items in cart">
          {lines.length === 0 && <s-text>No serialized products in the cart.</s-text>}
          {lines.map((line) => {
            const serial =
              line.quantity === 1 ? line.properties[SERIAL_PROPERTY_KEY] : undefined;
            return (
              <s-clickable key={line.uuid} onClick={() => onPick(line.uuid)}>
                <s-stack direction="inline" gap="base">
                  <s-stack direction="block">
                    <s-text>{line.title}</s-text>
                    <s-text>{`${line.sku} · qty ${line.quantity}`}</s-text>
                  </s-stack>
                  <s-badge tone={serial ? "success" : "critical"}>
                    {serial ?? "Needs serial"}
                  </s-badge>
                </s-stack>
              </s-clickable>
            );
          })}
        </s-section>
      </s-scroll-box>
    </s-page>
  );
}
