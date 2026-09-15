import {Cin7Client} from "./cin7.server";
import {computeTargetSerial, type TransformDirection} from "./transform.server";
import {resolveUnitCost} from "./cost.server";
import {groupSerials} from "./serials.server";
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
  | {status: "target_exists"}
  | {status: "serial_not_found"}
  | {status: "unknown_location"}
  | {status: "cost_unresolved"};

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

    // Guard 2: also local.
    const locationName = this.locationMap[shopifyLocationId];
    if (!locationName) return {status: "unknown_location"};

    const rows = await this.client.getAvailability(sku);
    const available = groupSerials(rows, locationName);

    // Guard 3: source serial must exist, in stock, at this location.
    const source = available.find((s) => s.serial === serial && s.locationName === locationName);
    if (!source) return {status: "serial_not_found"};

    // Guard 4: target serial must not already exist at this location — Cin7
    // enforces no serial uniqueness of its own, so this is the only defence
    // against silently creating a duplicate.
    const targetExists = available.some((s) => s.serial === toSerial && s.locationName === locationName);
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

    return {
      status: "ok",
      fromSerial: serial,
      toSerial,
      unitCost: cost.unitCost,
      costSource: cost.source,
      taskId: response.TaskID ?? null,
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
