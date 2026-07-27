import type {ActionFunctionArgs} from "react-router";
import {authenticate} from "../shopify.server";

/**
 * TEMPORARY diagnostic sink for on-device investigation of POS cart-merge
 * behaviour. The extension posts a trace of each cart mutation plus the cart
 * state it observed afterwards; it lands in the `shopify app dev` output where
 * it can be read. Remove once the split behaviour is settled.
 */
export const action = async ({request}: ActionFunctionArgs) => {
  const {cors} = await authenticate.public.checkout(request);
  const body = await request.json().catch(() => null);
  console.log("\n=== POS SPLIT TRACE ===\n" + JSON.stringify(body, null, 2) + "\n=== END ===\n");
  return cors(Response.json({ok: true}));
};
