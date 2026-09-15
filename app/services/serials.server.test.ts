import {describe, it, expect, vi} from "vitest";
import {groupSerials, SerialService} from "./serials.server";
import type {Cin7AvailabilityRow} from "./cin7.server";

function row(overrides: Partial<Cin7AvailabilityRow>): Cin7AvailabilityRow {
  return {
    ID: "guid", SKU: "WIDGET-001", Name: "Widget", Barcode: null,
    Location: "Main Warehouse", Bin: null, Batch: "SN-001", ExpiryDate: null,
    OnHand: 1, Allocated: 0, Available: 1, OnOrder: 0,
    StockOnHand: 0, InTransit: 0, NextDeliveryDate: null,
    ...overrides,
  };
}

describe("groupSerials", () => {
  it("drops rows without a serial or without availability", () => {
    const rows = [
      row({Batch: null}),
      row({Batch: "SN-GONE", Available: 0}),
      row({Batch: "SN-OK"}),
    ];
    expect(groupSerials(rows, null).map((s) => s.serial)).toEqual(["SN-OK"]);
  });

  it("orders current location first, then other locations alphabetically, serials ascending", () => {
    const rows = [
      row({Batch: "SN-C1", Location: "Christchurch"}),
      row({Batch: "SN-A2", Location: "Auckland"}),
      row({Batch: "SN-W1", Location: "Wellington"}),
      row({Batch: "SN-A1", Location: "Auckland"}),
    ];
    const result = groupSerials(rows, "Wellington");
    expect(result.map((s) => `${s.locationName}:${s.serial}`)).toEqual([
      "Wellington:SN-W1",
      "Auckland:SN-A1",
      "Auckland:SN-A2",
      "Christchurch:SN-C1",
    ]);
    expect(result[0].isCurrentLocation).toBe(true);
    expect(result[1].isCurrentLocation).toBe(false);
  });

  it("converts a numeric Batch to a string serial", () => {
    const rows = [row({Batch: 12345})];
    const result = groupSerials(rows, null);
    expect(result[0].serial).toEqual("12345");
    expect(typeof result[0].serial).toBe("string");
  });

  it("does not throw sorting two same-location serials when one Batch is numeric", () => {
    // Cin7 can return Batch as a JSON number for a purely numeric serial.
    // `r.Batch as string` would relabel it without converting, and the sort
    // below (a.serial.localeCompare(b.serial)) throws a TypeError on the
    // real number — which escaped SerialService.lookup as an uncaught 500
    // in the deployed picker. String(r.Batch) is what prevents that.
    const rows = [
      row({Batch: "SN-001", Location: "Auckland"}),
      row({Batch: 12345, Location: "Auckland"}),
    ];
    let result: ReturnType<typeof groupSerials> = [];
    expect(() => {
      result = groupSerials(rows, null);
    }).not.toThrow();
    expect(result.every((s) => typeof s.serial === "string")).toBe(true);
  });
});

describe("SerialService.lookup", () => {
  const okRows = [row({Batch: "SN-001", Location: "Auckland"})];

  it("returns ok with grouped serials and the mapped current location", async () => {
    const client = {getAvailability: vi.fn().mockResolvedValue(okRows), skuExists: vi.fn()};
    const service = new SerialService(client as never, {"123": "Auckland"});

    const result = await service.lookup("WIDGET-001", "123");

    expect(result).toMatchObject({status: "ok", currentLocationName: "Auckland"});
    if (result.status === "ok") expect(result.serials[0].isCurrentLocation).toBe(true);
  });

  it("caches availability responses per SKU", async () => {
    const client = {getAvailability: vi.fn().mockResolvedValue(okRows), skuExists: vi.fn()};
    const service = new SerialService(client as never, {});
    await service.lookup("WIDGET-001", "123");
    await service.lookup("WIDGET-001", "123");
    expect(client.getAvailability).toHaveBeenCalledTimes(1);
  });

  it("distinguishes no_stock from sku_not_found when no serial rows exist", async () => {
    const client = {
      getAvailability: vi.fn().mockResolvedValue([]),
      skuExists: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false),
    };
    const service = new SerialService(client as never, {});
    expect((await service.lookup("IN-CIN7", "1")).status).toBe("no_stock");
    expect((await service.lookup("NOT-IN-CIN7", "1")).status).toBe("sku_not_found");
  });

  it("returns null currentLocationName for unmapped locations", async () => {
    const client = {getAvailability: vi.fn().mockResolvedValue(okRows), skuExists: vi.fn()};
    const service = new SerialService(client as never, {});
    const result = await service.lookup("WIDGET-001", "999");
    expect(result).toMatchObject({status: "ok", currentLocationName: null});
  });
});

describe("SerialService.invalidate", () => {
  const okRows = [row({Batch: "SN-001", Location: "Auckland"})];

  it("clears the cached availability for that SKU, so the next lookup refetches", async () => {
    const client = {getAvailability: vi.fn().mockResolvedValue(okRows), skuExists: vi.fn()};
    const service = new SerialService(client as never, {});
    await service.lookup("WIDGET-001", "123");
    service.invalidate("WIDGET-001");
    await service.lookup("WIDGET-001", "123");
    expect(client.getAvailability).toHaveBeenCalledTimes(2);
  });

  it("clears the cached sku-exists result for that SKU too", async () => {
    const client = {
      getAvailability: vi.fn().mockResolvedValue([]),
      skuExists: vi.fn().mockResolvedValue(false),
    };
    const service = new SerialService(client as never, {});
    await service.lookup("NOT-IN-CIN7", "1");
    service.invalidate("NOT-IN-CIN7");
    await service.lookup("NOT-IN-CIN7", "1");
    expect(client.skuExists).toHaveBeenCalledTimes(2);
  });

  it("does not affect other SKUs' cached entries", async () => {
    const client = {getAvailability: vi.fn().mockResolvedValue(okRows), skuExists: vi.fn()};
    const service = new SerialService(client as never, {});
    await service.lookup("WIDGET-001", "123");
    await service.lookup("OTHER-SKU", "123");
    service.invalidate("WIDGET-001");
    await service.lookup("OTHER-SKU", "123");
    expect(client.getAvailability).toHaveBeenCalledTimes(2);
  });
});
