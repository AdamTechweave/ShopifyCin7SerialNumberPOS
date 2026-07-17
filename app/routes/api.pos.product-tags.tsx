import type {ActionFunctionArgs} from "react-router";
import {authenticate, unauthenticated} from "../shopify.server";
import {getConfig} from "../config.server";
import {toProductGid, buildSerializedMap} from "../services/tags.server";

// The admin client's `.json()` is typed as `FetchResponseBody` (data /
// extensions / headers only), but the raw GraphQL response it wraps can also
// carry a top-level `errors` array per the GraphQL-over-HTTP spec — the type
// just doesn't declare it. Assert the shape we actually need to check.
type ProductTagsResponseBody = {
  data?: {nodes: Array<{id: string; tags: string[]} | null>};
  errors?: unknown[];
};

export const action = async ({request}: ActionFunctionArgs) => {
  const {sessionToken, cors} = await authenticate.public.checkout(request);

  const body = (await request.json().catch(() => null)) as {productIds?: unknown} | null;
  const productIds = body?.productIds;
  if (
    !Array.isArray(productIds) ||
    productIds.length === 0 ||
    productIds.length > 250 ||
    !productIds.every((id) => typeof id === "number")
  ) {
    return cors(Response.json({error: "INVALID_PRODUCT_IDS"}, {status: 400}));
  }

  const shop = new URL(sessionToken.dest as string).hostname;
  const {admin} = await unauthenticated.admin(shop);

  let nodes;
  try {
    const response = await admin.graphql(
      `#graphql
      query productTags($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on Product { id tags }
        }
      }`,
      {variables: {ids: productIds.map(toProductGid)}},
    );
    const json = (await response.json()) as ProductTagsResponseBody;
    if (json.errors?.length || !json.data?.nodes) {
      return cors(Response.json({error: "TAG_LOOKUP_FAILED"}, {status: 502}));
    }
    nodes = json.data.nodes;
  } catch {
    return cors(Response.json({error: "TAG_LOOKUP_FAILED"}, {status: 502}));
  }

  return cors(Response.json({serialized: buildSerializedMap(nodes, getConfig().serialTag)}));
};
