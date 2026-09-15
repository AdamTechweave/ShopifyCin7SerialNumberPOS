import {Cin7Client} from "./cin7.server";
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
  | {status: "write_unconfirmed"; taskId: string | null};

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
    // able to see. Cin7's BatchSN can arrive as a JSON number for a purely
    // numeric serial (see cost.server.ts), so compare via String(r.Batch).
    const rows = await this.client.getAvailability(sku);

    const sourceRows = rows.filter((r) => String(r.Batch) === serial && r.Location === locationName);
    if (sourceRows.length === 0) return {status: "serial_not_found"};
    const source = sourceRows[0];

    // The write below sends Quantity: 0 for the source line, which Cin7
    // treats as an ABSOLUTE new OnHand, not a delta — it zeroes whatever is
    // on hand. Refuse anything but a single, fully unallocated unit so the
    // write can never destroy more than the one unit it is renaming, and
    // never orphan an allocation an open order is depending on.
    if (source.OnHand !== 1) return {status: "not_single_unit"};
    if (source.Allocated !== 0) return {status: "serial_allocated"};

    // target_exists is our only defence against duplicate serials — Cin7
    // enforces no uniqueness of its own — so this must catch a target
    // serial even when it is fully allocated (Available: 0) at this
    // location, which is why it runs against the raw rows too.
    const targetExists = rows.some((r) => String(r.Batch) === toSerial && r.Location === locationName);
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

    // Cin7 might merge or reject two lines that differ only by BatchSN — a
    // 2xx alone doesn't prove the target serial was actually created. Require
    // evidence of a new stock line before reporting success back to staff,
    // since there is no undo against a real warehouse.
    const newLines = response.NewStockLines ?? [];
    if (newLines.length === 0) return {status: "write_unconfirmed", taskId};

    return {
      status: "ok",
      fromSerial: serial,
      toSerial,
      unitCost: cost.unitCost,
      costSource: cost.source,
      taskId,
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
