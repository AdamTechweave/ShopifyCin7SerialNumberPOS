// Kept deliberately in sync with app/services/transform.server.ts.
// The extension cannot import server code, and a client bundle cannot read
// server env, so the prefix is a build-time constant in both places.

/** Prefix marking an assembled unit. Changing it is a code edit plus `shopify app deploy`. */
export const TRANSFORM_PREFIX = "A-";

/** Cin7's BatchSN column is 50 characters. */
export const MAX_SERIAL_LENGTH = 50;

export type TransformDirection = "assemble" | "disassemble";

export type TargetSerialResult =
  | {ok: true; target: string}
  | {ok: false; reason: "already_transformed" | "not_transformed" | "too_long"};

export function computeTargetSerial(
  serial: string,
  direction: TransformDirection,
): TargetSerialResult {
  const hasPrefix = serial.startsWith(TRANSFORM_PREFIX);

  if (direction === "assemble") {
    if (hasPrefix) return {ok: false, reason: "already_transformed"};
    const target = `${TRANSFORM_PREFIX}${serial}`;
    if (target.length > MAX_SERIAL_LENGTH) return {ok: false, reason: "too_long"};
    return {ok: true, target};
  }

  if (!hasPrefix) return {ok: false, reason: "not_transformed"};
  return {ok: true, target: serial.slice(TRANSFORM_PREFIX.length)};
}
