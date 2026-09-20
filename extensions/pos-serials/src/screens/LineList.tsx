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
        <s-box padding="base">
          <s-text color="subdued">Loading…</s-text>
        </s-box>
      </s-page>
    );
  }

  const lines = serializedLines(cart.lineItems, map);
  return (
    <s-page heading="Serial numbers">
      <s-scroll-box>
        <s-section heading="Serialized items in cart">
          {lines.length === 0 && (
            <s-box padding="base">
              <s-text color="subdued">No serialized products in the cart.</s-text>
            </s-box>
          )}
          <s-stack direction="block">
            {lines.map((line, index) => {
              const serial =
                line.quantity === 1 ? line.properties[SERIAL_PROPERTY_KEY] : undefined;
              return (
                <s-stack key={line.uuid} direction="block">
                  {index > 0 && <s-divider />}
                  <s-clickable onClick={() => onPick(line.uuid)}>
                    <s-box padding="base">
                      <s-stack
                        direction="inline"
                        gap="base"
                        justifyContent="space-between"
                        alignItems="center"
                      >
                        <s-stack direction="block" gap="small-300">
                          <s-text type="strong">{line.title}</s-text>
                          <s-text type="small" color="subdued">
                            {`${line.sku} · Qty ${line.quantity}`}
                          </s-text>
                        </s-stack>
                        <s-badge tone={serial ? "success" : "critical"}>
                          {serial ?? "Needs serial"}
                        </s-badge>
                      </s-stack>
                    </s-box>
                  </s-clickable>
                </s-stack>
              );
            })}
          </s-stack>
        </s-section>
      </s-scroll-box>
    </s-page>
  );
}
