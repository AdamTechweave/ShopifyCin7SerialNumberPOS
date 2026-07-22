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
