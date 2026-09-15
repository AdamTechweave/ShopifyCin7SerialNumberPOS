import {useEffect, useState} from "preact/hooks";
import {fetchSerials, fetchVariantSku, type SerialLookup} from "../lib/api";
import {SerialList} from "./SerialList";

// Mirrors the three non-"ok" members of `VariantSkuLookup` (lib/api.ts) plus
// a local "loading" state. Kept distinct from `SerialLookup` below — one
// resolves a variant to a SKU, the other resolves a SKU to serials — so a
// failure in either step gets its own screen and its own copy.
type SkuState =
  | {status: "loading"}
  | {status: "ready"; sku: string}
  | {status: "no_sku"}
  | {status: "not_found"}
  | {status: "error"};

interface Props {
  onDone: () => void;
}

// Read-only: this is the product-details view of a product's Cin7 serial
// numbers, not the assign-to-cart flow (that's SerialPicker.tsx). No
// `onSelect`, no search — just what's in stock.
export function ProductSerials({onDone}: Props) {
  const [skuState, setSkuState] = useState<SkuState>({status: "loading"});
  const [result, setResult] = useState<SerialLookup | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setSkuState({status: "loading"});
    fetchVariantSku(shopify.product.variantId).then((lookup) => {
      if (cancelled) return;
      setSkuState(lookup.status === "ok" ? {status: "ready", sku: lookup.sku} : lookup);
    });
    return () => {
      cancelled = true;
    };
  }, [reload]);

  useEffect(() => {
    if (skuState.status !== "ready") return;
    let cancelled = false;
    setResult(null);
    fetchSerials(skuState.sku).then((r) => {
      if (!cancelled) setResult(r);
    });
    return () => {
      cancelled = true;
    };
  }, [skuState]);

  if (skuState.status === "loading") {
    return (
      <s-page heading="Serial numbers">
        <s-text>Loading…</s-text>
      </s-page>
    );
  }

  if (skuState.status === "no_sku") {
    return (
      <s-page heading="Serial numbers">
        <s-banner heading="No SKU set for this variant">
          {"This variant has no SKU, so its Cin7 serial numbers can't be looked up."}
        </s-banner>
        <s-button onClick={onDone}>Back</s-button>
      </s-page>
    );
  }

  if (skuState.status === "not_found" || skuState.status === "error") {
    return (
      <s-page heading="Serial numbers">
        <s-banner tone="critical" heading="Couldn't check this product">
          {skuState.status === "not_found"
            ? "Couldn't find this product variant on this device."
            : "Something went wrong looking up this variant."}
        </s-banner>
        <s-button onClick={() => setReload((n) => n + 1)}>Retry</s-button>
        <s-button onClick={onDone}>Back</s-button>
      </s-page>
    );
  }

  if (!result) {
    return (
      <s-page heading="Serial numbers">
        <s-text>Loading…</s-text>
      </s-page>
    );
  }

  return (
    <s-page heading="Serial numbers">
      <s-scroll-box>
        <SerialList state={result} sku={skuState.sku} onRetry={() => setReload((n) => n + 1)} />
        <s-button onClick={onDone}>Back</s-button>
      </s-scroll-box>
    </s-page>
  );
}
