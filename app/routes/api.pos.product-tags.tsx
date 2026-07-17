import type {ActionFunctionArgs} from "react-router";
import {authenticate, unauthenticated} from "../shopify.server";
import {getConfig} from "../config.server";
import {toProductGid, buildSerializedMap} from "../services/tags.server";

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

  const response = await admin.graphql(
    `#graphql
    query productTags($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on Product { id tags }
      }
    }`,
    {variables: {ids: productIds.map(toProductGid)}},
  );
  const {data} = await response.json();

  return cors(Response.json({serialized: buildSerializedMap(data?.nodes ?? [], getConfig().serialTag)}));
};
