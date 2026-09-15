import {useCallback, useEffect, useRef, useState} from "preact/hooks";
import {
  fetchSerials,
  fetchVariantSku,
  postSerialTransform,
  type SerialLookup,
  type TransformResponse,
} from "../lib/api";
import {matchScan, type AvailableSerial} from "../lib/serials";
import {computeTargetSerial, TRANSFORM_PREFIX, type TransformDirection} from "../lib/transform";
import {COST_SOURCE_LABEL, describeOutcome, nothingWasWritten} from "../lib/outcome";
import {SerialList} from "./SerialList";

interface Props {
  onDone: () => void;
}

// Mirrors `ProductSerials.tsx`'s SKU resolution — kept local rather than
// shared since the two screens have unrelated failure handling once past
// this point (read-only list vs. a stock-adjusting workflow).
type SkuState =
  | {status: "loading"}
  | {status: "ready"; sku: string}
  | {status: "no_sku"}
  | {status: "not_found"}
  | {status: "error"};

type Step =
  | {name: "pick"}
  | {name: "confirm"; serial: string; direction: TransformDirection; target: string}
  | {name: "result"; serial: string; target: string; response: TransformResponse};

// `computeTargetSerial`'s three failure reasons are exactly three members of
// `TransformResponse` (same shape, no extra fields), so a locally-detected
// failure can be routed through the same `describeOutcome` the network path
// uses. Built via a switch, not a cast — `{status: reason}` with a
// union-typed `reason` doesn't structurally match the `TransformResponse`
// union (TS won't distribute across it), but each individual case does.
function localGuardResponse(
  reason: "already_transformed" | "not_transformed" | "too_long",
): TransformResponse {
  switch (reason) {
    case "already_transformed":
      return {status: "already_transformed"};
    case "not_transformed":
      return {status: "not_transformed"};
    case "too_long":
      return {status: "too_long"};
  }
}

function directionFor(serial: string): TransformDirection {
  return serial.startsWith(TRANSFORM_PREFIX) ? "disassemble" : "assemble";
}

function actionLabel(direction: TransformDirection): string {
  return direction === "assemble" ? "Assemble" : "Disassemble";
}

export function SerialTransform({onDone}: Props) {
  const scanner = shopify.scanner;
  const [skuState, setSkuState] = useState<SkuState>({status: "loading"});
  const [result, setResult] = useState<SerialLookup | null>(null);
  const [reload, setReload] = useState(0);
  const [step, setStep] = useState<Step>({name: "pick"});

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

  // useCallback (not a plain function) so the scanner effect below can list
  // it as a dependency and still only resubscribe when it actually changes
  // — it closes over nothing but `setStep`, which is stable, so this
  // identity never changes across renders.
  const handleSelect = useCallback((s: AvailableSerial) => {
    const direction = directionFor(s.serial);
    const targetResult = computeTargetSerial(s.serial, direction);
    if (!targetResult.ok) {
      // Detected locally — no network call for an action that can never
      // succeed (e.g. a serial too long to prefix).
      setStep({
        name: "result",
        serial: s.serial,
        target: "",
        response: localGuardResponse(targetResult.reason),
      });
      return;
    }
    setStep({name: "confirm", serial: s.serial, direction, target: targetResult.target});
  }, []);

  // Scan-to-select, mirroring SerialPicker.tsx: subscribe while a serial can
  // actually be chosen (the pick step, with a loaded list), and only close
  // the camera when this screen unmounts — not on every dep change here,
  // e.g. a fresh `result` after a retry.
  useEffect(() => {
    const unsubscribe = scanner.scannerData.current.subscribe((scan) => {
      if (!scan.data) return;
      if (step.name !== "pick") return;
      if (!result || result.status !== "ok") return;
      const hit = matchScan(result.serials, scan.data);
      if (hit) {
        handleSelect(hit);
      } else {
        shopify.toast.show(`${scan.data} is not in available stock`);
      }
    });
    return unsubscribe;
  }, [step, result, handleSelect, scanner.scannerData]);

  useEffect(() => {
    return () => {
      scanner.hideCameraScanner();
    };
  }, [scanner]);

  if (skuState.status === "loading") {
    return (
      <s-page heading="Transform serial">
        <s-text>Loading…</s-text>
      </s-page>
    );
  }

  if (skuState.status === "no_sku") {
    return (
      <s-page heading="Transform serial">
        <s-banner heading="No SKU set for this variant">
          {"This variant has no SKU, so its Cin7 serial numbers can't be looked up."}
        </s-banner>
        <s-button onClick={onDone}>Back</s-button>
      </s-page>
    );
  }

  if (skuState.status === "not_found" || skuState.status === "error") {
    return (
      <s-page heading="Transform serial">
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
      <s-page heading="Transform serial">
        <s-text>Loading…</s-text>
      </s-page>
    );
  }

  const locationName = result.status === "ok" ? result.currentLocationName : null;

  if (step.name === "confirm") {
    return (
      <ConfirmStep
        sku={skuState.sku}
        serial={step.serial}
        direction={step.direction}
        target={step.target}
        locationName={locationName}
        onBack={() => setStep({name: "pick"})}
        onResult={(response) =>
          setStep({name: "result", serial: step.serial, target: step.target, response})
        }
      />
    );
  }

  if (step.name === "result") {
    const outcome = describeOutcome(step.response, {serial: step.serial, target: step.target});
    return (
      <s-page heading="Transform serial">
        <s-banner tone={outcome.tone} heading={outcome.heading}>
          {outcome.message}
        </s-banner>
        {outcome.detail && <s-text>{outcome.detail}</s-text>}
        {nothingWasWritten(step.response) && (
          <s-button onClick={() => setStep({name: "pick"})}>Pick another serial</s-button>
        )}
        <s-button onClick={onDone}>Done</s-button>
      </s-page>
    );
  }

  return (
    <s-page heading="Transform serial">
      <s-scroll-box>
        <SerialList
          state={result}
          sku={skuState.sku}
          onRetry={() => setReload((n) => n + 1)}
          onSelect={handleSelect}
          searchable
        />
        <s-button onClick={onDone}>Back</s-button>
      </s-scroll-box>
    </s-page>
  );
}

interface ConfirmStepProps {
  sku: string;
  serial: string;
  direction: TransformDirection;
  target: string;
  locationName: string | null;
  onBack: () => void;
  onResult: (response: TransformResponse) => void;
}

// Isolated from `SerialTransform` so its own dry-run/submit state doesn't
// leak into the parent's step machine — entering this step always starts a
// fresh dry run, and unmounting it (going back to pick) simply discards it.
function ConfirmStep({sku, serial, direction, target, locationName, onBack, onResult}: ConfirmStepProps) {
  const [preview, setPreview] = useState<TransformResponse | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    const locationId = String(shopify.session.currentSession.locationId);
    postSerialTransform({sku, serial, locationId, direction, dryRun: true}).then((r) => {
      if (!cancelled) setPreview(r);
    });
    return () => {
      cancelled = true;
    };
  }, [sku, serial, direction]);

  if (!preview) {
    return (
      <s-page heading="Transform serial">
        <s-text>Checking with Cin7…</s-text>
      </s-page>
    );
  }

  if (preview.status !== "preview") {
    // The dry run itself hit a guard (or failed) — nothing to confirm.
    // Same no-retry rule applies here as anywhere else past the pick list:
    // go back and pick again rather than re-run the same check.
    const outcome = describeOutcome(preview, {serial, target});
    return (
      <s-page heading="Transform serial">
        <s-banner tone={outcome.tone} heading={outcome.heading}>
          {outcome.message}
        </s-banner>
        {outcome.detail && <s-text>{outcome.detail}</s-text>}
        <s-button onClick={onBack}>Back</s-button>
      </s-page>
    );
  }

  // `groupSerials` sorts alphabetically, so every "A-" serial sorts above
  // its plain counterpart and the two cluster together in the pick list —
  // easy to mis-tap the row above the one meant. Direction can't be picked
  // wrong (it's inferred from the serial), but the *row* can be, and
  // disassemble is the one direction where that mistake reverses real
  // assembly work. Give it a visibly different confirm screen — a warning
  // banner leading with the consequence rather than the serials, and a
  // de-emphasized Confirm button — rather than growing friction on the
  // common assemble path too.
  const details = (
    <>
      <s-text>{`From: ${preview.fromSerial}`}</s-text>
      <s-text>{`To: ${preview.toSerial}`}</s-text>
      <s-text>{`Location: ${locationName ?? "this location"}`}</s-text>
      <s-text>{`Unit cost: ${preview.unitCost.toFixed(2)} (${COST_SOURCE_LABEL[preview.costSource]})`}</s-text>
    </>
  );

  return (
    <s-page heading="Transform serial">
      {direction === "disassemble" ? (
        <>
          <s-banner tone="warning" heading="This will un-assemble a built unit">
            {"Double check these are the serials you meant to pick before confirming."}
          </s-banner>
          <s-section>{details}</s-section>
        </>
      ) : (
        <s-section heading={`${actionLabel(direction)} this serial?`}>{details}</s-section>
      )}
      <s-button
        onClick={async () => {
          // Ref, not state: `submitting` is captured at render time, so two
          // taps in the same frame would both see `false` and both fire the
          // write. Cin7 has no idempotency key, so both would land as
          // separate stock adjustments.
          if (submittingRef.current) return;
          submittingRef.current = true;
          setSubmitting(true);
          const locationId = String(shopify.session.currentSession.locationId);
          try {
            const response = await postSerialTransform({sku, serial, locationId, direction});
            onResult(response);
          } finally {
            submittingRef.current = false;
            setSubmitting(false);
          }
        }}
        loading={submitting}
        variant={direction === "disassemble" ? "secondary" : undefined}
      >
        Confirm
      </s-button>
      <s-button onClick={onBack} disabled={submitting}>
        Cancel
      </s-button>
    </s-page>
  );
}
