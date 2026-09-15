import {describe, it, expect, vi} from "vitest";
import {TransformService, buildReference} from "./serial-transform.server";

const LOCATION_MAP = {"999": "Main Warehouse"};

const row = (batch: string, location = "Main Warehouse", available = 1) => ({
  ID: "x", SKU: "BIKE", Name: "Bike", Barcode: null, Location: location, Bin: null,
  Batch: batch, ExpiryDate: null, OnHand: available, Allocated: 0, Available: available,
  OnOrder: 0, StockOnHand: available, InTransit: 0, NextDeliveryDate: null,
});

function makeClient(over: Record<string, unknown> = {}) {
  return {
    getAvailability: vi.fn().mockResolvedValue([row("BIKE001")]),
    getProductWithMovements: vi.fn().mockResolvedValue({AverageCost: 450}),
    createStockAdjustment: vi.fn().mockResolvedValue({TaskID: "task-1", NewStockLines: [{}], ExistingStockLines: [{}]}),
    ...over,
  };
}

const svc = (client: ReturnType<typeof makeClient>) =>
  new TransformService(client as never, LOCATION_MAP);

const input = {sku: "BIKE", serial: "BIKE001", shopifyLocationId: "999", direction: "assemble" as const};

describe("TransformService.transform", () => {
  it("posts one adjustment with both lines and returns ok", async () => {
    const client = makeClient();
    const result = await svc(client).transform(input);

    expect(result).toEqual({
      status: "ok", fromSerial: "BIKE001", toSerial: "A-BIKE001",
      unitCost: 450, costSource: "average", taskId: "task-1",
    });

    expect(client.createStockAdjustment).toHaveBeenCalledTimes(1);
    const payload = client.createStockAdjustment.mock.calls[0][0];
    expect(payload.UpdateOnHand).toBe(true);
    expect(payload.Status).toBe("COMPLETED");
    expect(payload.Lines).toEqual([
      {SKU: "BIKE", BatchSN: "BIKE001", Quantity: 0, UnitCost: 450, Location: "Main Warehouse"},
      {SKU: "BIKE", BatchSN: "A-BIKE001", Quantity: 1, UnitCost: 450, Location: "Main Warehouse"},
    ]);
  });

  it("refuses a serial that is already assembled, without calling Cin7", async () => {
    const client = makeClient();
    const result = await svc(client).transform({...input, serial: "A-BIKE001"});
    expect(result).toEqual({status: "already_transformed"});
    expect(client.getAvailability).not.toHaveBeenCalled();
  });

  it("refuses to disassemble a serial with no prefix", async () => {
    const client = makeClient();
    expect(await svc(client).transform({...input, direction: "disassemble"})).toEqual({status: "not_transformed"});
  });

  it("refuses an unmapped Shopify location", async () => {
    const client = makeClient();
    expect(await svc(client).transform({...input, shopifyLocationId: "404"})).toEqual({status: "unknown_location"});
  });

  it("refuses when the source serial is not in stock at that location", async () => {
    const client = makeClient({getAvailability: vi.fn().mockResolvedValue([row("OTHER")])});
    expect(await svc(client).transform(input)).toEqual({status: "serial_not_found"});
  });

  it("refuses when the target serial already exists — Cin7 does not enforce uniqueness", async () => {
    const client = makeClient({getAvailability: vi.fn().mockResolvedValue([row("BIKE001"), row("A-BIKE001")])});
    const result = await svc(client).transform(input);
    expect(result).toEqual({status: "target_exists"});
    expect(client.createStockAdjustment).not.toHaveBeenCalled();
  });

  it("refuses rather than guessing when cost cannot be resolved", async () => {
    const client = makeClient({getProductWithMovements: vi.fn().mockResolvedValue({})});
    const result = await svc(client).transform(input);
    expect(result).toEqual({status: "cost_unresolved"});
    expect(client.createStockAdjustment).not.toHaveBeenCalled();
  });

  it("writes nothing on a dry run", async () => {
    const client = makeClient();
    const result = await svc(client).transform({...input, dryRun: true});
    expect(result).toEqual({
      status: "preview", fromSerial: "BIKE001", toSerial: "A-BIKE001",
      unitCost: 450, costSource: "average",
    });
    expect(client.createStockAdjustment).not.toHaveBeenCalled();
  });

  it("disassembles back to the bare serial", async () => {
    const client = makeClient({getAvailability: vi.fn().mockResolvedValue([row("A-BIKE001")])});
    const result = await svc(client).transform({...input, serial: "A-BIKE001", direction: "disassemble"});
    expect(result).toMatchObject({status: "ok", fromSerial: "A-BIKE001", toSerial: "BIKE001"});
  });
});

describe("buildReference", () => {
  it("is deterministic for the same transform on the same day", () => {
    const d = new Date("2026-09-15T10:00:00Z");
    expect(buildReference("BIKE", "BIKE001", "A-BIKE001", d))
      .toBe("POS-SERIAL-XFORM:BIKE:BIKE001:A-BIKE001:2026-09-15");
  });
});
