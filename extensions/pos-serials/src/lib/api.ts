import type {AvailableSerial} from "./serials";

const tagCache = new Map<string, boolean>();

export async function fetchSerializedMap(
  productIds: number[],
): Promise<Record<string, boolean>> {
  const unknown = [...new Set(productIds)].filter((id) => !tagCache.has(String(id)));
  if (unknown.length > 0) {
    const response = await fetch("/api/pos/product-tags", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({productIds: unknown}),
    });
    if (!response.ok) throw new Error(`product-tags request failed: ${response.status}`);
    const {serialized} = (await response.json()) as {serialized: Record<string, boolean>};
    for (const [id, value] of Object.entries(serialized)) tagCache.set(id, Boolean(value));
  }
  const map: Record<string, boolean> = {};
  for (const id of productIds) map[String(id)] = tagCache.get(String(id)) ?? false;
  return map;
}

export type SerialLookup =
  | {status: "ok"; serials: AvailableSerial[]; currentLocationName: string | null}
  | {status: "sku_not_found"}
  | {status: "no_stock"}
  | {status: "error"; code: string};

export async function fetchSerials(sku: string): Promise<SerialLookup> {
  try {
    const locationId = shopify.session.currentSession.locationId;
    const response = await fetch(
      `/api/pos/serials?sku=${encodeURIComponent(sku)}&locationId=${locationId}`,
    );
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {error?: string};
      return {status: "error", code: body.error ?? `HTTP_${response.status}`};
    }
    return (await response.json()) as SerialLookup;
  } catch {
    return {status: "error", code: "NETWORK"};
  }
}
