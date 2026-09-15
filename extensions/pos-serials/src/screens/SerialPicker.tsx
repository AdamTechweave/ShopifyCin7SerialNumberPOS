import {useEffect, useRef, useState} from "preact/hooks";
import {fetchSerials, type SerialLookup} from "../lib/api";
import {excludeInCart, matchScan, type CartLineLike} from "../lib/serials";
import {SerialList} from "./SerialList";

interface Props {
  line: CartLineLike;
  cart: {lineItems: CartLineLike[]};
  onDone: () => void;
  onChoose: (serial: string) => Promise<void>;
}

export function SerialPicker({line, cart, onDone, onChoose}: Props) {
  const scanner = shopify.scanner;
  const [result, setResult] = useState<SerialLookup | null>(null);
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
  if (result.status === "error") {
    return (
      <s-page heading={line.title}>
        <SerialList state={result} onRetry={() => setReload((n) => n + 1)} />
        <s-button onClick={onDone}>Back</s-button>
      </s-page>
    );
  }

  const candidates = excludeInCart(result.serials, cart.lineItems, line.uuid);

  return (
    <s-page heading={line.title}>
      <s-scroll-box>
        <SerialList
          state={{...result, serials: candidates}}
          onRetry={() => setReload((n) => n + 1)}
          onSelect={(s) => onChoose(s.serial)}
          searchable
        />
        <s-button onClick={onDone}>Back</s-button>
      </s-scroll-box>
    </s-page>
  );
}
