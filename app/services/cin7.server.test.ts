import {describe, it, expect, vi} from "vitest";
import {Cin7Client, Cin7Error} from "./cin7.server";

const ROW = {
  ID: "guid", SKU: "WIDGET-001", Name: "Widget", Barcode: null,
  Location: "Main Warehouse", Bin: null, Batch: "SN-001", ExpiryDate: null,
  OnHand: 1, Allocated: 0, Available: 1, OnOrder: 0,
  StockOnHand: 42.5, InTransit: 0, NextDeliveryDate: null,
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {status, headers: {"Content-Type": "application/json"}});
}

describe("Cin7Client", () => {
  it("sends auth headers and the exact-match Sku parameter", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({Total: 1, Page: 1, ProductAvailabilityList: [ROW]}));
    const client = new Cin7Client("acct", "key", fetchFn);

    const rows = await client.getAvailability("WIDGET-001");

    expect(rows).toEqual([ROW]);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toContain("/ExternalApi/v2/ref/productavailability");
    expect(url).toContain("Sku=WIDGET-001");
    expect(url).toContain("Limit=1000");
    expect(url).toContain("Page=1");
    expect(init.headers["api-auth-accountid"]).toBe("acct");
    expect(init.headers["api-auth-applicationkey"]).toBe("key");
  });

  it("returns [] when Cin7 omits the list (no matching rows)", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({Total: 0, Page: 1, ProductAvailabilityList: []}));
    const client = new Cin7Client("acct", "key", fetchFn);
    expect(await client.getAvailability("NOPE")).toEqual([]);
  });

  it("throws RATE_LIMITED on 429 and on 503", async () => {
    for (const status of [429, 503]) {
      const fetchFn = vi.fn().mockResolvedValue(new Response("", {status}));
      const client = new Cin7Client("acct", "key", fetchFn);
      await expect(client.getAvailability("X")).rejects.toMatchObject({code: "RATE_LIMITED"});
    }
  });

  it("throws AUTH_FAILED on 401/403 and UNREACHABLE on network error", async () => {
    const authFetch = vi.fn().mockResolvedValue(new Response("", {status: 403}));
    await expect(new Cin7Client("a", "k", authFetch).getAvailability("X"))
      .rejects.toMatchObject({code: "AUTH_FAILED"});

    const downFetch = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    await expect(new Cin7Client("a", "k", downFetch).getAvailability("X"))
      .rejects.toMatchObject({code: "UNREACHABLE"});
  });

  it("throws BAD_RESPONSE on other non-OK statuses", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response("", {status: 500}));
    const client = new Cin7Client("acct", "key", fetchFn);
    const error = await client.getAvailability("X").catch((e) => e);
    expect(error).toBeInstanceOf(Cin7Error);
    expect(error).toMatchObject({code: "BAD_RESPONSE"});
  });

  it("skuExists checks the product endpoint", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({Total: 1, Products: [{SKU: "WIDGET-001"}]}));
    const client = new Cin7Client("acct", "key", fetchFn);
    expect(await client.skuExists("WIDGET-001")).toBe(true);
    expect(fetchFn.mock.calls[0][0]).toContain("/ExternalApi/v2/product");
  });

  it("sends an abort signal so a hung Cin7 response cannot hang the request", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ProductAvailabilityList: []}));
    const client = new Cin7Client("acct", "key", fetchFn);
    await client.getAvailability("WIDGET-001");
    const [, init] = fetchFn.mock.calls[0];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("maps an aborted request to UNREACHABLE", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new DOMException("aborted", "TimeoutError"));
    const client = new Cin7Client("acct", "key", fetchFn);
    await expect(client.getAvailability("WIDGET-001")).rejects.toMatchObject({code: "UNREACHABLE"});
  });

  it("posts a stock adjustment with both lines and UpdateOnHand set", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({TaskID: "task-1", NewStockLines: [], ExistingStockLines: []}));
    const client = new Cin7Client("acct", "key", fetchFn);

    await client.createStockAdjustment({
      EffectiveDate: "2026-09-15T00:00:00.000",
      Status: "COMPLETED",
      Reference: "POS-SERIAL-XFORM:BIKE:BIKE001:A-BIKE001:2026-09-15",
      Comment: "Assembled BIKE001 -> A-BIKE001",
      UpdateOnHand: true,
      Lines: [
        {SKU: "BIKE", BatchSN: "BIKE001", Quantity: 0, UnitCost: 450, Location: "Main Warehouse"},
        {SKU: "BIKE", BatchSN: "A-BIKE001", Quantity: 1, UnitCost: 450, Location: "Main Warehouse"},
      ],
    });

    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toContain("/ExternalApi/v2/stockadjustment");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body);
    expect(body.UpdateOnHand).toBe(true);
    expect(body.Status).toBe("COMPLETED");
    expect(body.Lines[0]).toMatchObject({BatchSN: "BIKE001", Quantity: 0});
    expect(body.Lines[1]).toMatchObject({BatchSN: "A-BIKE001", Quantity: 1});
  });

  it("requests product movements for cost lookup", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({Products: [{AverageCost: 12, Movements: []}]}));
    const client = new Cin7Client("acct", "key", fetchFn);
    await client.getProductWithMovements("BIKE");
    const [url] = fetchFn.mock.calls[0];
    expect(url).toContain("/ExternalApi/v2/product");
    expect(url).toContain("Sku=BIKE");
    expect(url).toContain("IncludeMovements=true");
  });

  it("returns an empty product shape when Cin7 knows no such SKU", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({Products: []}));
    const client = new Cin7Client("acct", "key", fetchFn);
    expect(await client.getProductWithMovements("NOPE")).toEqual({});
  });

  it("ignores a substring SKU match and refuses to guess", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({
      Products: [{SKU: "BIKE-CARBON", AverageCost: 4500}, {SKU: "BIKE", AverageCost: 450}],
    }));
    const client = new Cin7Client("acct", "key", fetchFn);
    expect(await client.getProductWithMovements("BIKE")).toEqual({SKU: "BIKE", AverageCost: 450});
  });
});
