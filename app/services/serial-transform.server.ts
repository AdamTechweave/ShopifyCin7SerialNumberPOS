import {Cin7Client, type Cin7AvailabilityRow} from "./cin7.server";
import {computeTargetSerial, type TransformDirection} from "./transform.server";
import {resolveUnitCost} from "./cost.server";
import {getConfig} from "../config.server";

export type TransformResult =
  | {
      status: "ok";
      fromSerial: string;
      toSerial: string;
      unitCost: number;
      costSource: "movement" | "average";
      taskId: string | null;
      /**
       * Counts from the write response's `ExistingStockLines`/`NewStockLines`
       * split — the confirmation the spec calls for that Cin7 read our
       * intent correctly (one line zeroed, one created), not just that
       * `NewStockLines` was non-empty. Surfaced to staff rather than
       * enforced as a guard: if Cin7 ever misclassifies the zeroed source
       * line as "new" instead of "existing", a hard `existingLineCount > 0`
       * requirement would fail every transform rather than reveal the
       * mismatch.
       */
      existingLineCount: number;
      newLineCount: number;
    }
  | {status: "preview"; fromSerial: string; toSerial: string; unitCost: number; costSource: "movement" | "average"}
  | {status: "already_transformed"}
  | {status: "not_transformed"}
  | {status: "too_long"}
  | {status: "empty_target_serial"}
  | {status: "unknown_location"}
  | {status: "serial_not_found"}
  | {status: "not_single_unit"}
  | {status: "serial_allocated"}
  | {status: "target_exists"}
  | {status: "cost_unresolved"}
  /**
   * The write already succeeded at the HTTP level by the time this is
   * returned — Cin7 accepted `createStockAdjustment` — but the response
   * carried no evidence (a non-empty `NewStockLines`) that the target
   * serial was actually created. Never retry on this: retrying re-sends an
   * adjustment Cin7 may have already applied, and Cin7 has neither an
   * idempotency key nor serial-uniqueness checking to catch the duplicate.
   * Find and verify the adjustment in Cin7 by `taskId` instead.
   */
  | {status: "written_unconfirmed"; taskId: string | null; existingLineCount: number; newLineCount: number};

/**
 * Stable, human-legible reference for the stock adjustment. Not used for
 * idempotency — Cin7 has no idempotency key on this endpoint, so it cannot
 * prevent a duplicate write on retry (see the no-retry note on `transform`).
 * It exists purely so a Cin7 audit trail can be traced back to the transform
 * that produced it.
 */
export function buildReference(sku: string, from: string, to: string, date: Date): string {
  const day = date.toISOString().slice(0, 10);
  return `POS-SERIAL-XFORM:${sku}:${from}:${to}:${day}`;
}

export class TransformService {
  constructor(
    private client: Cin7Client,
    private locationMap: Record<string, string>,
  ) {}

  async transform(input: {
    sku: string;
    serial: string;
    shopifyLocationId: string;
    direction: TransformDirection;
    dryRun?: boolean;
  }): Promise<TransformResult> {
    const {sku, serial, shopifyLocationId, direction, dryRun} = input;

    // Guard 0: cheap, local. Cin7 uses a blank Batch to mean "not
    // serial/batch tracked", not a real serial — without this, an empty
    // `serial` on assemble computes a target of just the bare prefix and can
    // match a blank-Batch row on the raw-rows filters below.
    if (serial === "") return {status: "serial_not_found"};

    // Guard 1: cheap, local, no Cin7 call — must short-circuit before any I/O.
    const target = computeTargetSerial(serial, direction);
    if (!target.ok) return {status: target.reason};
    const toSerial = target.target;

    // Guard 1b: also local. Disassembling a serial that is *only* the bare
    // prefix (e.g. "A-") computes to an empty string. groupSerials would
    // have dropped an empty Batch as a non-serial row, hiding it from
    // target_exists entirely — refuse it explicitly instead of ever posting
    // BatchSN: "".
    if (toSerial === "") return {status: "empty_target_serial"};

    // Guard 2: also local. Object.hasOwn, not a truthy `[key]` lookup, so a
    // shopifyLocationId of "constructor" can't inherit a non-string value
    // off Object.prototype and slip past this guard.
    if (!Object.hasOwn(this.locationMap, shopifyLocationId)) return {status: "unknown_location"};
    const locationName = this.locationMap[shopifyLocationId];

    // Raw rows, not groupSerials: groupSerials filters to Available > 0,
    // which would hide (a) a batch-tracked lot or otherwise multi-unit row
    // that still has stock available, and (b) a fully-allocated existing
    // target serial (Available: 0) — both of which the guards below must be
    // able to see. We do restore groupSerials' null/"" Batch filter, though:
    // Cin7 uses a blank Batch for non-tracked stock, never for a real
    // serial. Cin7's BatchSN can also arrive as a JSON number for a purely
    // numeric serial (see cost.server.ts), so compare via String(r.Batch).
    const rows = await this.client.getAvailability(sku);
    const isTrackedAt = (r: Cin7AvailabilityRow, wanted: string) =>
      r.Batch !== null && r.Batch !== "" && String(r.Batch) === wanted && r.Location === locationName;

    // Cin7 enforces no serial uniqueness, so the same serial can legitimately
    // appear as more than one row at a location (e.g. split across bins).
    // Guard on the SUM across all matching rows, not just rows[0] — taking
    // only the first row would let two rows of OnHand: 1 each pass the
    // single-unit check while the location actually holds 2 units, and the
    // write below would zero both while recreating only one.
    const sourceRows = rows.filter((r) => isTrackedAt(r, serial));
    if (sourceRows.length === 0) return {status: "serial_not_found"};

    // The write below sends Quantity: 0 for the source line, which Cin7
    // treats as an ABSOLUTE new OnHand, not a delta — it zeroes whatever is
    // on hand. Refuse anything but a single, fully unallocated unit so the
    // write can never destroy more than the one unit it is renaming, and
    // never orphan an allocation an open order is depending on.
    const totalOnHand = sourceRows.reduce((n, r) => n + r.OnHand, 0);
    const totalAllocated = sourceRows.reduce((n, r) => n + r.Allocated, 0);
    if (totalOnHand !== 1) return {status: "not_single_unit"};
    if (totalAllocated !== 0) return {status: "serial_allocated"};

    // The write posts a single binless line, and Cin7 may apply it per-bin,
    // so a source split across rows cannot be expressed safely. Requiring
    // exactly one row also stops a negative quantity hiding inside the sums
    // above (OnHand [2, -1] sums to 1 while a 2-unit row would be zeroed).
    if (sourceRows.length !== 1) return {status: "not_single_unit"};

    // target_exists is our only defence against duplicate serials — Cin7
    // enforces no uniqueness of its own — so this must catch a target
    // serial even when it is fully allocated (Available: 0) at this
    // location, which is why it runs against the raw rows too. Scoped to
    // this location deliberately: Cin7 permits the same serial at another
    // location, and our uniqueness guarantee is per-location, not global.
    const targetExists = rows.some((r) => isTrackedAt(r, toSerial));
    if (targetExists) return {status: "target_exists"};

    // Guard 5: resolve cost before committing to a write; refuse rather than guess.
    const product = await this.client.getProductWithMovements(sku);
    const cost = resolveUnitCost(product, serial, locationName);
    if (!cost.ok) return {status: "cost_unresolved"};

    if (dryRun) {
      return {status: "preview", fromSerial: serial, toSerial, unitCost: cost.unitCost, costSource: cost.source};
    }

    const now = new Date();
    // Do not retry this call: Cin7 has no idempotency key and does not
    // validate serial uniqueness, so a retry after a timeout/network error
    // could silently create a duplicate serial and double-adjust stock. Let
    // Cin7Error propagate to the route untouched.
    const response = await this.client.createStockAdjustment({
      EffectiveDate: now.toISOString().replace("Z", ""),
      Status: "COMPLETED",
      Reference: buildReference(sku, serial, toSerial, now),
      Comment: `${direction === "assemble" ? "Assembled" : "Disassembled"} ${serial} -> ${toSerial}`,
      UpdateOnHand: true,
      Lines: [
        {SKU: sku, BatchSN: serial, Quantity: 0, UnitCost: cost.unitCost, Location: locationName},
        {SKU: sku, BatchSN: toSerial, Quantity: 1, UnitCost: cost.unitCost, Location: locationName},
      ],
    });

    const taskId = response.TaskID ?? null;

    // Array.isArray guards against a truthy-but-non-array
    // ExistingStockLines/NewStockLines, whose `.length` would be `undefined`.
    const existingLineCount = Array.isArray(response.ExistingStockLines)
      ? response.ExistingStockLines.length
      : 0;
    const newLineCount = Array.isArray(response.NewStockLines) ? response.NewStockLines.length : 0;

    // Cin7 might merge or reject two lines that differ only by BatchSN — a
    // 2xx alone doesn't prove the target serial was actually created. Require
    // evidence of a new stock line before reporting success back to staff,
    // since there is no undo against a real warehouse.
    if (newLineCount === 0) return {status: "written_unconfirmed", taskId, existingLineCount, newLineCount};

    return {
      status: "ok",
      fromSerial: serial,
      toSerial,
      unitCost: cost.unitCost,
      costSource: cost.source,
      taskId,
      existingLineCount,
      newLineCount,
    };
  }
}

let singleton: TransformService | undefined;

export function getTransformService(): TransformService {
  if (!singleton) {
    const config = getConfig();
    singleton = new TransformService(
      new Cin7Client(config.cin7AccountId, config.cin7ApplicationKey),
      config.locationMap,
    );
  }
  return singleton;
}
