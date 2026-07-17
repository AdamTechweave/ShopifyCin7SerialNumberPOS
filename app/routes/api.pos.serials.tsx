import type {LoaderFunctionArgs} from "react-router";
import {authenticate} from "../shopify.server";
import {getSerialService} from "../services/serials.server";
import {Cin7Error} from "../services/cin7.server";

export const loader = async ({request}: LoaderFunctionArgs) => {
  const {cors} = await authenticate.public.checkout(request);

  const url = new URL(request.url);
  const sku = url.searchParams.get("sku");
  const locationId = url.searchParams.get("locationId") ?? "";
  if (!sku) return cors(Response.json({error: "MISSING_SKU"}, {status: 400}));

  try {
    const result = await getSerialService().lookup(sku, locationId);
    return cors(Response.json(result));
  } catch (error) {
    if (error instanceof Cin7Error) {
      return cors(Response.json({error: error.code}, {status: 502}));
    }
    throw error;
  }
};
