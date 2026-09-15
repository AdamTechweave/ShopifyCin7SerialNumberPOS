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

  const row = (s: AvailableSerial) =>
    onSelect ? (
      <s-clickable key={s.serial} onClick={() => onSelect(s)}>
        <s-text>{s.serial}</s-text>
      </s-clickable>
    ) : (
      <s-text key={s.serial}>{s.serial}</s-text>
    );

  return (
    <>
      {searchable && (
        <s-section>
          <s-search-field
            placeholder="Search serial numbers"
            value={query}
            onInput={(e) => setQuery(e.currentTarget.value ?? "")}
          />
          <s-button onClick={() => scanner.showCameraScanner()}>Scan barcode</s-button>
        </s-section>
      )}
      <s-section
        heading={
          state.currentLocationName ? `This store — ${state.currentLocationName}` : "This store"
        }
      >
        {current.length === 0 && <s-text>No serials at this location.</s-text>}
        {current.map(row)}
      </s-section>
      {otherLocations.map((location) => (
        <s-section key={location} heading={location}>
          {others.filter((s) => s.locationName === location).map(row)}
        </s-section>
      ))}
    </>
  );
}
