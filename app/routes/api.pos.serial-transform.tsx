import type {ActionFunctionArgs} from "react-router";
import {authenticate} from "../shopify.server";
import {getTransformService} from "../services/serial-transform.server";
import {Cin7Error} from "../services/cin7.server";
import type {TransformDirection} from "../services/transform.server";

const DIRECTIONS: TransformDirection[] = ["assemble", "disassemble"];

export const action = async ({request}: ActionFunctionArgs) => {
  const {cors} = await authenticate.public.checkout(request);

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const sku = body?.sku;
  const serial = body?.serial;
  const locationId = body?.locationId;
  const direction = body?.direction;
  const dryRun = body?.dryRun;

  if (
    typeof sku !== "string" || sku === "" ||
    typeof serial !== "string" || serial === "" ||
    typeof locationId !== "string" ||
    typeof direction !== "string" || !DIRECTIONS.includes(direction as TransformDirection) ||
    (dryRun !== undefined && typeof dryRun !== "boolean")
  ) {
    return cors(Response.json({error: "INVALID_REQUEST"}, {status: 400}));
  }

  try {
    // Every result status — ok, preview, and every guard — is an expected
    // outcome the UI renders, not a transport failure. Pass it through
    // generically rather than switching on `status`: the union has grown
    // several times during review and a route that enumerates it silently
    // drops new statuses (including `written_unconfirmed`, which carries a
    // taskId for a write that already succeeded and must never be retried).
    const result = await getTransformService().transform({
      sku,
      serial,
      shopifyLocationId: locationId,
      direction: direction as TransformDirection,
      dryRun: dryRun === true,
    });
    return cors(Response.json(result));
  } catch (error) {
    if (error instanceof Cin7Error) {
      return cors(Response.json({error: error.code}, {status: 502}));
    }
    throw error;
  }
};
