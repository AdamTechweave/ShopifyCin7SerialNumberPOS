import {describe, it, expect, vi, beforeEach, afterEach} from "vitest";

const lookup = vi.fn();
vi.mock("../services/serials.server", () => ({
  getSerialService: () => ({lookup}),
}));
vi.mock("../shopify.server", () => ({
  authenticate: {public: {checkout: async () => ({cors: (r: Response) => r})}},
}));

const {loader} = await import("./api.pos.serials");

const get = (query: string) =>
  loader({request: new Request(`https://x/api/pos/serials?${query}`)} as never);

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // Block body, not an arrow expression — see the matching note in
  // api.pos.serial-transform.test.ts.
  lookup.mockReset();
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
});

describe("GET /api/pos/serials", () => {
  it("returns the lookup result on success", async () => {
    lookup.mockResolvedValue({status: "no_stock"});
    const res = await get("sku=BIKE&locationId=999");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({status: "no_stock"});
    expect(lookup).toHaveBeenCalledWith("BIKE", "999");
  });

  it("rejects a missing sku without calling Cin7", async () => {
    const res = await get("locationId=999");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({error: "MISSING_SKU"});
    expect(lookup).not.toHaveBeenCalled();
  });

  it("maps a Cin7Error to 502 with only its code", async () => {
    const {Cin7Error} = await import("../services/cin7.server");
    lookup.mockRejectedValue(new Cin7Error("AUTH_FAILED", "Cin7 rejected credentials (403)"));
    const res = await get("sku=BIKE&locationId=999");
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({error: "AUTH_FAILED"});
  });

  // The device only ever sees the code, so the log is the only place the
  // reason survives. Without it every Cin7 failure on this route is a bare
  // 502 with nothing but the Shopify auth INFO line beside it.
  it("logs the Cin7 failure code and message on a 502", async () => {
    const {Cin7Error} = await import("../services/cin7.server");
    lookup.mockRejectedValue(new Cin7Error("AUTH_FAILED", "Cin7 rejected credentials (403)"));
    await get("sku=BIKE&locationId=999");
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("AUTH_FAILED — Cin7 rejected credentials (403)"),
      expect.objectContaining({sku: "BIKE", locationId: "999"}),
    );
  });
});
