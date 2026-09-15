import type {AvailableSerial} from "./serials";
import {SERIAL_TAG, toProductGid, buildSerializedMap} from "./tags";
import type {TransformDirection} from "./transform";

const tagCache = new Map<string, boolean>();

let inflight: Promise<void> = Promise.resolve();

// `nodes` takes at most 250 ids per request. The backend used to reject a
// larger batch outright; chunking keeps a big cart working instead.
const MAX_IDS_PER_REQUEST = 250;

const PRODUCT_TAGS_QUERY = `
  query productTags($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product { id tags }
    }
  }`;

// The Admin response can carry a top-level `errors` array alongside `data`
// per the GraphQL-over-HTTP spec, so a 200 alone doesn't mean success.
type ProductTagsResponse = {
  data?: {nodes: Array<{id: string; tags: string[]} | null>};
  errors?: unknown[];
};

async function loadTags(productIds: number[]): Promise<void> {
  // Direct API access — POS authenticates this against the Admin API itself.
  // No credential in the bundle, and no round trip through our backend.
  const response = await fetch("shopify:admin/api/graphql.json", {
    method: "POST",
    body: JSON.stringify({
      query: PRODUCT_TAGS_QUERY,
      variables: {ids: productIds.map(toProductGid)},
    }),
  });
  if (!response.ok) throw new Error(`product tags request failed: ${response.status}`);
  const json = (await response.json()) as ProductTagsResponse;
  if (json.errors?.length || !json.data?.nodes) {
    throw new Error("product tags request returned errors");
  }
  const serialized = buildSerializedMap(json.data.nodes, SERIAL_TAG);
  for (const [id, value] of Object.entries(serialized)) tagCache.set(id, value);
}

export async function fetchSerializedMap(
  productIds: number[],
): Promise<Record<string, boolean>> {
  const request = inflight.then(async () => {
    const unknown = [...new Set(productIds)].filter((id) => !tagCache.has(String(id)));
    for (let i = 0; i < unknown.length; i += MAX_IDS_PER_REQUEST) {
      await loadTags(unknown.slice(i, i + MAX_IDS_PER_REQUEST));
    }
  });
  inflight = request.catch(() => {});
  await request;
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

// Mirrors `TransformResult` in app/services/serial-transform.server.ts, plus
// the client-only `error` member — the same split `SerialLookup` makes on
// top of the server's `SerialLookupResult`. Keep this in sync with the
// server union; the screens switch on every member.
export type TransformResponse =
  | {
      status: "ok";
      fromSerial: string;
      toSerial: string;
      unitCost: number;
      costSource: "movement" | "average";
      taskId: string | null;
      /** ExistingStockLines/NewStockLines counts — see server-side TransformResult. */
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
  // The write already succeeded — Cin7 accepted the adjustment — but the
  // response carried no evidence the target serial was created. Not "nothing
  // happened": never retry on this, since Cin7 has no idempotency key and a
  // retry would double-adjust stock. `taskId` lets staff trace the write in
  // Cin7 by hand.
  | {status: "written_unconfirmed"; taskId: string | null; existingLineCount: number; newLineCount: number}
  // `phase` distinguishes a failed pre-write lookup (nothing written, safe
  // to retry) from a failure during the write itself (may have written,
  // never retry) — see Cin7Error's phase comment server-side.
  | {status: "error"; code: string; phase: "read" | "write"};

export async function postSerialTransform(input: {
  sku: string;
  serial: string;
  locationId: string;
  direction: TransformDirection;
  dryRun?: boolean;
}): Promise<TransformResponse> {
  // A dry run can never reach the server's write call (it returns "preview"
  // before that), so any failure on one is read-phase by definition,
  // regardless of what the server says or whether it was even reached.
  const isDryRun = input.dryRun === true;
  try {
    const response = await fetch("/api/pos/serial-transform", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(input),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {error?: string; phase?: string};
      // Trust the server's tag when it says "read"; otherwise default to the
      // more cautious "write" — fail closed, since an ambiguous failure is
      // exactly when staff must not be told a retry is safe.
      const phase: "read" | "write" = isDryRun || body.phase === "read" ? "read" : "write";
      return {status: "error", code: body.error ?? `HTTP_${response.status}`, phase};
    }
    return (await response.json()) as TransformResponse;
  } catch {
    return {status: "error", code: "NETWORK", phase: isDryRun ? "read" : "write"};
  }
}

/**
 * The product-details targets give a variantId, but the serials endpoint keys
 * off SKU. `fetchProductVariantWithId` is an on-device POS lookup — no network
 * cost to us — and `sku` is optional on the variant.
 *
 * Three distinct outcomes collapse to `null` if this just returns
 * `string | null`: the variant isn't found on-device, it has no SKU set, or
 * the lookup itself failed. Those tell very different stories to staff (a
 * device sync issue vs. a data-entry gap vs. a transient error), so callers
 * get a discriminated result instead and choose their own copy.
 */
export type VariantSkuLookup =
  | {status: "ok"; sku: string}
  | {status: "no_sku"}
  | {status: "not_found"}
  | {status: "error"};

export async function fetchVariantSku(variantId: number): Promise<VariantSkuLookup> {
  try {
    const variant = await shopify.productSearch.fetchProductVariantWithId(variantId);
    if (!variant) return {status: "not_found"};
    return variant.sku ? {status: "ok", sku: variant.sku} : {status: "no_sku"};
  } catch {
    return {status: "error"};
  }
}
