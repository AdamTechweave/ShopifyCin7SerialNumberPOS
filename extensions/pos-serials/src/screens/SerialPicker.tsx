import {useEffect, useState} from "preact/hooks";
import {fetchSerials, type SerialLookup} from "../lib/api";
import {excludeInCart, matchScan, type CartLineLike} from "../lib/serials";

interface Props {
  line: CartLineLike;
  cart: {lineItems: CartLineLike[]};
  onDone: () => void;
  onChoose: (serial: string) => Promise<void>;
}

// `showCameraScanner`/`hideCameraScanner` are part of the POS Scanner API at
// api_version 2026-07 (this extension's declared version — see
// shopify.extension.toml), but the installed @shopify/ui-extensions types are
// pinned to 2025.10.x (see package.json) and predate them: compare
// node_modules/@shopify/ui-extensions/build/ts/surfaces/point-of-sale/api/scanner-api/scanner-api.d.ts
// (only `scannerData` and `sources`) against the 2026.7.x release, which adds
// both methods to `ScannerApiContent`. Cast locally until the dependency is
// bumped to a version whose types include them; `scannerData`/`sources` are
// unaffected and used as typed.
type ScannerWithCamera = typeof shopify.scanner & {
  showCameraScanner(): void;
  hideCameraScanner(): void;
};
const scanner = shopify.scanner as ScannerWithCamera;

export function SerialPicker({line, cart, onDone, onChoose}: Props) {
  const [result, setResult] = useState<SerialLookup | null>(null);
  const [query, setQuery] = useState("");
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setResult(null);
    fetchSerials(line.sku).then((r) => {
      if (!cancelled) setResult(r);
    });
    return () => {
      cancelled = true;
    };
  }, [line.sku, reload]);

  useEffect(() => {
    const unsubscribe = scanner.scannerData.current.subscribe((scan) => {
      if (!scan.data) return;
      if (!result || result.status !== "ok") return;
      const candidates = excludeInCart(result.serials, cart.lineItems, line.uuid);
      const hit = matchScan(candidates, scan.data);
      if (hit) {
        onChoose(hit.serial);
      } else {
        shopify.toast.show(`${scan.data} is not in available stock`);
      }
    });
    return () => {
      unsubscribe();
      scanner.hideCameraScanner();
    };
  }, [result, cart, line.uuid]);

  if (!result) {
    return (
      <s-page heading={line.title}>
        <s-text>Loading…</s-text>
      </s-page>
    );
  }

  if (result.status === "error") {
    return (
      <s-page heading={line.title}>
        <s-banner tone="critical" heading="Can't reach Cin7">
          {`Serial numbers are unavailable right now (${result.code}).`}
        </s-banner>
        <s-button onClick={() => setReload((n) => n + 1)}>Retry</s-button>
        <s-button onClick={onDone}>Back</s-button>
      </s-page>
    );
  }
  if (result.status === "sku_not_found") {
    return (
      <s-page heading={line.title}>
        <s-banner tone="critical" heading="SKU not found in Cin7">
          {`${line.sku} doesn't match any Cin7 product. Fix the SKU mapping before selling this item.`}
        </s-banner>
        <s-button onClick={onDone}>Back</s-button>
      </s-page>
    );
  }
  if (result.status === "no_stock") {
    return (
      <s-page heading={line.title}>
        <s-banner heading="No serials in stock">
          {`Cin7 has no available serial numbers for ${line.sku} at any location.`}
        </s-banner>
        <s-button onClick={onDone}>Back</s-button>
      </s-page>
    );
  }

  const candidates = excludeInCart(result.serials, cart.lineItems, line.uuid);
  const visible = query
    ? candidates.filter((s) => s.serial.toLowerCase().includes(query.toLowerCase()))
    : candidates;
  const current = visible.filter((s) => s.isCurrentLocation);
  const others = visible.filter((s) => !s.isCurrentLocation);
  const otherLocations = [...new Set(others.map((s) => s.locationName))];

  return (
    <s-page heading={line.title}>
      <s-scroll-box>
        <s-section>
          <s-search-field
            placeholder="Search serial numbers"
            value={query}
            onInput={(e) => setQuery(e.currentTarget.value ?? "")}
          />
          <s-button onClick={() => scanner.showCameraScanner()}>Scan barcode</s-button>
        </s-section>
        <s-section
          heading={
            result.currentLocationName
              ? `This store — ${result.currentLocationName}`
              : "This store"
          }
        >
          {current.length === 0 && <s-text>No serials at this location.</s-text>}
          {current.map((s) => (
            <s-clickable key={s.serial} onClick={() => onChoose(s.serial)}>
              <s-text>{s.serial}</s-text>
            </s-clickable>
          ))}
        </s-section>
        {otherLocations.map((location) => (
          <s-section key={location} heading={location}>
            {others
              .filter((s) => s.locationName === location)
              .map((s) => (
                <s-clickable key={s.serial} onClick={() => onChoose(s.serial)}>
                  <s-text>{s.serial}</s-text>
                </s-clickable>
              ))}
          </s-section>
        ))}
        <s-button onClick={onDone}>Back</s-button>
      </s-scroll-box>
    </s-page>
  );
}
