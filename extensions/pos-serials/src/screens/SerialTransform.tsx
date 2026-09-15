import {useCallback, useEffect, useState} from "preact/hooks";
import {
  fetchSerials,
  fetchVariantSku,
  postSerialTransform,
  type SerialLookup,
  type TransformResponse,
} from "../lib/api";
import {matchScan, type AvailableSerial} from "../lib/serials";
import {computeTargetSerial, TRANSFORM_PREFIX, type TransformDirection} from "../lib/transform";
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

interface Outcome {
  tone: "success" | "warning" | "critical";
  heading: string;
  message: string;
}

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

// Every member of `TransformResponse` gets a plain-language outcome here.
// The union has grown from 8 to 13 statuses during review, so this switches
// exhaustively over it and the `default` branch fails closed: `response` is
// an unvalidated cast of backend JSON, so an unrecognised status is
// reachable at runtime even though it's unreachable at the type level. It
// must never be read as success.
function describeOutcome(response: TransformResponse, ctx: {serial: string; target: string}): Outcome {
  switch (response.status) {
    case "ok":
      return {
        tone: "success",
        heading: "Transform complete",
        message: `${response.fromSerial} is now ${response.toSerial}.`,
      };
    case "preview":
      // The confirm step consumes "preview" itself to render the confirm
      // details — reaching here means a dry-run response leaked into a
      // final result. Fail closed rather than treat it as success.
      return {
        tone: "critical",
        heading: "Unexpected response",
        message:
          "Transform failed (UNEXPECTED_PREVIEW). Check Cin7 before trying again — the adjustment may have been written.",
      };
    case "already_transformed":
      return {
        tone: "warning",
        heading: "Already assembled",
        message: `${ctx.serial} is already assembled.`,
      };
    case "not_transformed":
      return {
        tone: "warning",
        heading: "Not assembled",
        message: `${ctx.serial} is not an assembled serial.`,
      };
    case "too_long":
      return {
        tone: "warning",
        heading: "Serial too long",
        message: `${ctx.serial} is too long to prefix — Cin7 allows 50 characters.`,
      };
    case "empty_target_serial":
      return {
        tone: "warning",
        heading: "Nothing to disassemble to",
        message: `${ctx.serial} has nothing left after removing the prefix.`,
      };
    case "unknown_location":
      return {
        tone: "critical",
        heading: "Location not mapped",
        message: "This POS location isn't mapped to a Cin7 location.",
      };
    case "serial_not_found":
      return {
        tone: "warning",
        heading: "Not in stock here",
        message: `${ctx.serial} is not in stock at this location.`,
      };
    case "not_single_unit":
      return {
        tone: "warning",
        heading: "Can't transform here",
        message: `${ctx.serial} doesn't hold exactly one unit at this location, so it can't be transformed here. Check it in Cin7.`,
      };
    case "serial_allocated":
      return {
        tone: "warning",
        heading: "Serial allocated",
        message: `${ctx.serial} is allocated to an order, so it can't be transformed.`,
      };
    case "target_exists":
      return {
        tone: "warning",
        heading: "Target already exists",
        message: `${ctx.target} already exists at this location.`,
      };
    case "cost_unresolved":
      return {
        tone: "critical",
        heading: "Cost unresolved",
        message: "Couldn't determine this unit's cost in Cin7. Transform it in Cin7 directly.",
      };
    case "written_unconfirmed":
      // The write already succeeded — Cin7 accepted the adjustment — but
      // the response carried no confirmation the new serial was created.
      // Not "nothing happened": retrying re-sends an adjustment Cin7 may
      // have already applied, and Cin7 has no idempotency key to catch the
      // duplicate. Never offer a retry here.
      return {
        tone: "critical",
        heading: "Confirm in Cin7 — do not retry",
        message: `The adjustment was sent to Cin7 but couldn't be confirmed. Do not retry — check Cin7 task ${
          response.taskId ?? "(task id unavailable)"
        } to see whether ${ctx.target} was created.`,
      };
    case "error":
      return {
        tone: "critical",
        heading: "Transform failed",
        message: `Transform failed (${response.code}). Check Cin7 before trying again — the adjustment may have been written.`,
      };
    default: {
      // Assigning to a `never`-typed binding — and then actually reading it
      // below — is what makes this fail closed twice over: at compile time,
      // adding a 14th member without a case above breaks this assignment;
      // at runtime, a status this union doesn't even know about still lands
      // here rather than falling through as success.
      const unrecognized: never = response;
      return {
        tone: "critical",
        heading: "Unexpected response",
        message: `Transform failed (unrecognized status "${String(
          (unrecognized as {status: unknown}).status,
        )}"). Check Cin7 before trying again — the adjustment may have been written.`,
      };
    }
  }
}

function directionFor(serial: string): TransformDirection {
  return serial.startsWith(TRANSFORM_PREFIX) ? "disassemble" : "assemble";
}

function actionLabel(direction: TransformDirection): string {
  return direction === "assemble" ? "Assemble" : "Disassemble";
}

const COST_SOURCE_LABEL: Record<"movement" | "average", string> = {
  movement: "from last movement",
  average: "product average",
};

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
        <s-button onClick={() => setStep({name: "pick"})}>Pick another serial</s-button>
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
        <s-button onClick={onBack}>Back</s-button>
      </s-page>
    );
  }

  return (
    <s-page heading="Transform serial">
      <s-section heading={`${actionLabel(direction)} this serial?`}>
        <s-text>{`From: ${preview.fromSerial}`}</s-text>
        <s-text>{`To: ${preview.toSerial}`}</s-text>
        <s-text>{`Location: ${locationName ?? "this location"}`}</s-text>
        <s-text>{`Unit cost: ${preview.unitCost.toFixed(2)} (${COST_SOURCE_LABEL[preview.costSource]})`}</s-text>
      </s-section>
      <s-button
        onClick={async () => {
          if (submitting) return;
          setSubmitting(true);
          const locationId = String(shopify.session.currentSession.locationId);
          try {
            const response = await postSerialTransform({sku, serial, locationId, direction});
            onResult(response);
          } finally {
            setSubmitting(false);
          }
        }}
        loading={submitting}
      >
        Confirm
      </s-button>
      <s-button onClick={onBack} disabled={submitting}>
        Cancel
      </s-button>
    </s-page>
  );
}
