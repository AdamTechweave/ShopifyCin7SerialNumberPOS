import {useEffect, useRef, useState} from "preact/hooks";
import {fetchSerials, type SerialLookup} from "../lib/api";
import {excludeInCart, matchScan, type CartLineLike} from "../lib/serials";

interface Props {
  line: CartLineLike;
  cart: {lineItems: CartLineLike[]};
  onDone: () => void;
  onChoose: (serial: string) => Promise<void>;
}

export function SerialPicker({line, cart, onDone, onChoose}: Props) {
  const scanner = shopify.scanner;
  const [result, setResult] = useState<SerialLookup | null>(null);
  const [query, setQuery] = useState("");
  const [reload, setReload] = useState(0);
  const choosingRef = useRef(false);

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
        if (choosingRef.current) return;
        choosingRef.current = true;
        onChoose(hit.serial).finally(() => {
          choosingRef.current = false;
        });
      } else {
        shopify.toast.show(`${scan.data} is not in available stock`);
      }
    });
    return unsubscribe;
  }, [result, cart, line.uuid, onChoose]);

  // Camera scanner lifecycle is independent of the subscribe/unsubscribe
  // effect above: only close it when the screen actually unmounts, not on
  // every dep change of that effect (e.g. a fresh `result` after fetching).
  useEffect(() => {
    return () => {
      scanner.hideCameraScanner();
    };
  }, []);

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
