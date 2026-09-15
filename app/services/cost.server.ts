import type {Cin7Movement} from "./cin7.server";

/**
 * Cin7 exposes no per-serial cost endpoint — `/ref/productavailability` has a
 * Batch filter but carries no cost field, and ExistingStockLineModel has no
 * cost at all. Movements are the only per-serial cost data available.
 */

export type CostResult =
  | {ok: true; unitCost: number; source: "movement" | "average"}
  | {ok: false};

/**
 * An unparseable `Date` is treated as the oldest possible movement (rather
 * than `NaN`, which would corrupt the sort) so it sorts last in preference —
 * it is never chosen over a movement with a valid date.
 */
function parsedTime(date: string): number {
  const t = Date.parse(date);
  return Number.isNaN(t) ? -Infinity : t;
}

export function resolveUnitCost(
  product: {AverageCost?: number; Movements?: Cin7Movement[]},
  serial: string,
  locationName: string,
): CostResult {
  const movements = product.Movements ?? [];

  // Scanning is unbounded deliberately: getProductWithMovements has already
  // fetched and parsed the full payload by the time this runs, so a cap here
  // would save no work — it would only silently and permanently degrade
  // accuracy on exactly the high-traffic SKUs that most need serial-level
  // precision. The real mitigation would be a server-side filter, but
  // Cin7's `/product` endpoint takes no BatchSN query parameter.
  //
  // Cin7's API Blueprint types BatchSN as Decimal while its own sample
  // response quotes it as a string (and the New Stock Line Model types it
  // String) — a purely numeric serial can arrive as a JSON number, so
  // normalise both sides to string before comparing. The filter runs before
  // the sort, so the sort only ever sees the matching subset.
  const inbound = movements
    .filter((m) => String(m.BatchSN) === serial && m.Location === locationName && m.Quantity > 0)
    .sort((a, b) => parsedTime(b.Date) - parsedTime(a.Date));

  // Walk newest-first and take the first movement that yields usable
  // evidence — a bad value (zero, negative, non-finite) on the most recent
  // movement is still worse evidence than an older real one, so don't drop
  // straight to the product-wide average.
  for (const m of inbound) {
    const unitCost = m.Amount / m.Quantity;
    if (Number.isFinite(unitCost) && unitCost > 0) {
      return {ok: true, unitCost, source: "movement"};
    }
  }

  const average = product.AverageCost;
  if (typeof average === "number" && Number.isFinite(average) && average > 0) {
    return {ok: true, unitCost: average, source: "average"};
  }

  return {ok: false};
}
