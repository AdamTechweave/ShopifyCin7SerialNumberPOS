import type {AvailableSerial} from "./serials";
import {SERIAL_TAG, toProductGid, buildSerializedMap} from "./tags";

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
