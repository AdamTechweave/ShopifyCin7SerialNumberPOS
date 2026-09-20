import {useState} from "preact/hooks";
import {type SerialLookup} from "../lib/api";
import {type AvailableSerial} from "../lib/serials";

interface Props {
  state: SerialLookup;
  onRetry: () => void;
  onSelect?: (serial: AvailableSerial) => void;
  searchable?: boolean;
  sku?: string;
}

export function SerialList({state, onRetry, onSelect, searchable, sku}: Props) {
  const scanner = shopify.scanner;
  // Lives here (not in the caller) since it's presentation-only. Note this
  // is a latent behaviour difference from when it lived in the
  // never-unmounting SerialPicker: SerialList unmounts while its caller
  // refetches (SerialPicker's `result === null` loading branch), so a
  // typed query now resets on that remount. Unobservable today — Retry
  // only appears in the `error` branch, which has no search field — but
  // worth flagging if a future caller can reach both at once.
  const [query, setQuery] = useState("");

  if (state.status === "error") {
    return (
      <>
        <s-banner tone="critical" heading="Can't reach Cin7">
          {`Serial numbers are unavailable right now (${state.code}).`}
        </s-banner>
        <s-button onClick={onRetry}>Retry</s-button>
      </>
    );
  }

  if (state.status === "sku_not_found") {
    return (
      <s-banner tone="critical" heading="SKU not found in Cin7">
        {sku
          ? `${sku} doesn't match any Cin7 product. Fix the SKU mapping before selling this item.`
          : "This SKU doesn't match any Cin7 product."}
      </s-banner>
    );
  }

  if (state.status === "no_stock") {
    return (
      <s-banner heading="No serials in stock">
        {sku
          ? `Cin7 has no available serial numbers for ${sku} at any location.`
          : "No available serial numbers at any location."}
      </s-banner>
    );
  }

  const candidates = state.serials;
  const visible =
    searchable && query
      ? candidates.filter((s) => s.serial.toLowerCase().includes(query.toLowerCase()))
      : candidates;
  const current = visible.filter((s) => s.isCurrentLocation);
  const others = visible.filter((s) => !s.isCurrentLocation);
  const otherLocations = [...new Set(others.map((s) => s.locationName))];

  const rows = (list: AvailableSerial[]) => (
    <s-stack direction="block">
      {list.map((s, index) => (
        <s-stack key={s.serial} direction="block">
          {index > 0 && <s-divider />}
          {onSelect ? (
            <s-clickable onClick={() => onSelect(s)}>
              <s-box padding="base">
                <s-stack
                  direction="inline"
                  gap="base"
                  justifyContent="space-between"
                  alignItems="center"
                >
                  <s-text type="strong">{s.serial}</s-text>
                  <s-text type="small" color="subdued">
                    Tap to assign
                  </s-text>
                </s-stack>
              </s-box>
            </s-clickable>
          ) : (
            <s-box padding="base">
              <s-text>{s.serial}</s-text>
            </s-box>
          )}
        </s-stack>
      ))}
    </s-stack>
  );

  return (
    <>
      {searchable && (
        <s-section>
          <s-stack direction="block" gap="base">
            <s-search-field
              placeholder="Search serial numbers"
              value={query}
              onInput={(e) => setQuery(e.currentTarget.value ?? "")}
            />
            <s-button onClick={() => scanner.showCameraScanner()}>Scan barcode</s-button>
          </s-stack>
        </s-section>
      )}
      <s-section
        heading={
          state.currentLocationName ? `This store — ${state.currentLocationName}` : "This store"
        }
      >
        {current.length === 0 && (
          <s-box padding="base">
            <s-text color="subdued">
              {query ? "No matching serials at this location." : "No serials at this location."}
            </s-text>
          </s-box>
        )}
        {rows(current)}
      </s-section>
      {otherLocations.map((location) => (
        <s-section key={location} heading={location}>
          {rows(others.filter((s) => s.locationName === location))}
        </s-section>
      ))}
    </>
  );
}
