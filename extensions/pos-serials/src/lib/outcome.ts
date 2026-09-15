import type {TransformResponse} from "./api";

// Pure, deliberately: this file encodes the entire post-write contract with
// staff — which outcomes mean "do not retry", which mean a write may
// already have landed, and the `written_unconfirmed` copy that is the one
// place wording itself is the safety mechanism. Kept out of
// SerialTransform.tsx and free of the `shopify` global (no `declare module`
// block needed in shopify.d.ts) specifically so it can be unit-tested like
// lib/transform.ts — see outcome.test.ts. Adding a 14th `TransformResponse`
// member, or moving one between `nothingWasWritten`'s branches, must break a
// test here; it must not be something only a human reviewer catches.

export interface Outcome {
  tone: "success" | "warning" | "critical";
  heading: string;
  message: string;
  /**
   * Plain, factual supplementary line — currently just the Cin7
   * ExistingStockLines/NewStockLines split on `ok`/`written_unconfirmed`.
   * Kept out of `message` so the primary sentence stays the same wording
   * whether or not this is available.
   */
  detail?: string;
}

export const COST_SOURCE_LABEL: Record<"movement" | "average", string> = {
  movement: "from last movement",
  average: "product average",
};

// Every member of `TransformResponse` gets a plain-language outcome here.
// The union has grown from 8 to 13 statuses during review, so this switches
// exhaustively over it and the `default` branch fails closed: `response` is
// an unvalidated cast of backend JSON, so an unrecognised status is
// reachable at runtime even though it's unreachable at the type level. It
// must never be read as success.
export function describeOutcome(
  response: TransformResponse,
  ctx: {serial: string; target: string},
): Outcome {
  switch (response.status) {
    case "ok":
      return {
        tone: "success",
        heading: "Transform complete",
        message: `${response.fromSerial} is now ${response.toSerial}.`,
        detail: `Cin7 lines: ${response.existingLineCount} existing, ${response.newLineCount} new`,
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
        detail: `Cin7 lines: ${response.existingLineCount} existing, ${response.newLineCount} new`,
      };
    case "error":
      // `phase` distinguishes a failed pre-write lookup (nothing written,
      // safe to retry) from a failure during the write itself (may have
      // written, never retry) — see Cin7Error's phase comment server-side.
      // A dry-run failure is always "read": the server can't reach its
      // write call on a dry run, and the client forces it too when this
      // never even reached the server (see postSerialTransform).
      return response.phase === "read"
        ? {
            tone: "warning",
            heading: "Couldn't reach Cin7",
            message: `The check failed (${response.code}). Nothing was written — safe to try again.`,
          }
        : {
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

// Whether a pick-list entry is still trustworthy after this result. The
// pick list is a cached read (serials.server.ts, up to 45s stale) that the
// server best-effort invalidates after a non-dry-run attempt — but that
// invalidation happens for every non-dry-run outcome, not just these, so it
// cannot tell us here which responses are safe. Only the guards below (and
// a read-phase "error") are: every one of them fires — or, for "error",
// provably failed — before Cin7 is ever touched for a write, whether
// detected locally (no network call at all) or returned by the real commit
// call itself (the server checks every guard before writing). `ok`,
// `written_unconfirmed`, and a write-phase "error" all mean a write may
// have happened, and `preview`/unrecognized statuses reaching a *result*
// are already anomalies — none of those are safe to imply "pick another
// serial" against the same list.
export function nothingWasWritten(response: TransformResponse): boolean {
  switch (response.status) {
    case "already_transformed":
    case "not_transformed":
    case "too_long":
    case "empty_target_serial":
    case "unknown_location":
    case "serial_not_found":
    case "not_single_unit":
    case "serial_allocated":
    case "target_exists":
    case "cost_unresolved":
      return true;
    case "error":
      return response.phase === "read";
    default:
      return false;
  }
}
