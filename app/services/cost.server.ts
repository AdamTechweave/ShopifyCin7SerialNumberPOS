import type {Cin7Movement} from "./cin7.server";

/**
 * Cin7 exposes no per-serial cost endpoint — `/ref/productavailability` has a
 * Batch filter but carries no cost field, and ExistingStockLineModel has no
 * cost at all. Movements are the only per-serial cost data available.
 */

/** Movement history is unbounded and has no BatchSN filter. Cap the scan. */
export const MAX_MOVEMENTS_SCANNED = 2000;

export type CostResult =
  | {ok: true; unitCost: number; source: "movement" | "average"}
  | {ok: false};

export function resolveUnitCost(
  product: {AverageCost?: number; Movements?: Cin7Movement[]},
  serial: string,
  locationName: string,
): CostResult {
  const movements = product.Movements ?? [];

  if (movements.length > 0 && movements.length <= MAX_MOVEMENTS_SCANNED) {
    // Cin7's API Blueprint types BatchSN as Decimal while its own sample
    // response quotes it as a string (and the New Stock Line Model types it
    // String) — a purely numeric serial can arrive as a JSON number, so
    // normalise both sides to string before comparing.
    const inbound = movements
      .filter((m) => String(m.BatchSN) === serial && m.Location === locationName && m.Quantity > 0)
      .sort((a, b) => a.Date.localeCompare(b.Date));

    const latest = inbound[inbound.length - 1];
    if (latest) {
      const unitCost = latest.Amount / latest.Quantity;
      if (Number.isFinite(unitCost) && unitCost > 0) {
        return {ok: true, unitCost, source: "movement"};
      }
    }
  }

  const average = product.AverageCost;
  if (typeof average === "number" && Number.isFinite(average) && average > 0) {
    return {ok: true, unitCost: average, source: "average"};
  }

  return {ok: false};
}
