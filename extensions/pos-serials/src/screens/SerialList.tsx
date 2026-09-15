import {useState} from "preact/hooks";
import {type SerialLookup} from "../lib/api";
import {type AvailableSerial} from "../lib/serials";

interface Props {
  state: SerialLookup;
  onRetry: () => void;
  onSelect?: (serial: AvailableSerial) => void;
  searchable?: boolean;
}

export function SerialList({state, onRetry, onSelect, searchable}: Props) {
  const scanner = shopify.scanner;
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

  if (state.status !== "ok") {
    // `sku_not_found` / `no_stock` copy embeds the queried SKU, which
    // `SerialLookup` doesn't carry on these variants. Callers that need
    // those two states render them inline themselves (see SerialPicker)
    // rather than through SerialList.
    return null;
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
