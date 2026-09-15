import {describe, it, expect, vi} from "vitest";
import {TransformService, buildReference} from "./serial-transform.server";

const LOCATION_MAP = {"999": "Main Warehouse"};

const row = (batch: string, location = "Main Warehouse", available = 1) => ({
  ID: "x", SKU: "BIKE", Name: "Bike", Barcode: null, Location: location, Bin: null,
  Batch: batch, ExpiryDate: null, OnHand: available, Allocated: 0, Available: available,
  OnOrder: 0, StockOnHand: available, InTransit: 0, NextDeliveryDate: null,
});

// For cases where OnHand/Allocated/Available need to diverge from each
// other — `row` above ties all three to one `available` number, which can't
// express a multi-unit lot or a fully-allocated single unit.
const stockRow = (
  batch: string,
  opts: {location?: string; onHand: number; allocated: number; available: number},
) => ({
  ID: "x", SKU: "BIKE", Name: "Bike", Barcode: null, Location: opts.location ?? "Main Warehouse", Bin: null,
  Batch: batch, ExpiryDate: null, OnHand: opts.onHand, Allocated: opts.allocated, Available: opts.available,
  OnOrder: 0, StockOnHand: opts.onHand, InTransit: 0, NextDeliveryDate: null,
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
    expect(payload.EffectiveDate).not.toContain("Z");
    expect(payload.Reference).toMatch(/^POS-SERIAL-XFORM:BIKE:BIKE001:A-BIKE001:\d{4}-\d{2}-\d{2}$/);
    expect(payload.Comment).toBe("Assembled BIKE001 -> A-BIKE001");
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

  it("refuses when the source serial exists only at a different location", async () => {
    const client = makeClient({getAvailability: vi.fn().mockResolvedValue([row("BIKE001", "Wellington")])});
    const result = await svc(client).transform(input);
    expect(result).toEqual({status: "serial_not_found"});
    expect(client.createStockAdjustment).not.toHaveBeenCalled();
  });

  it("refuses a source row holding more than one unit — Quantity: 0 would zero the whole lot", async () => {
    const client = makeClient({
      getAvailability: vi.fn().mockResolvedValue([stockRow("BIKE001", {onHand: 50, allocated: 0, available: 50})]),
    });
    const result = await svc(client).transform(input);
    expect(result).toEqual({status: "not_single_unit"});
    expect(client.createStockAdjustment).not.toHaveBeenCalled();
  });

  it("refuses a source serial that is allocated to an open order", async () => {
    const client = makeClient({
      getAvailability: vi.fn().mockResolvedValue([stockRow("BIKE001", {onHand: 1, allocated: 1, available: 0})]),
    });
    const result = await svc(client).transform(input);
    expect(result).toEqual({status: "serial_allocated"});
    expect(client.createStockAdjustment).not.toHaveBeenCalled();
  });

  it("refuses when two rows at the same location share the source serial — Cin7 enforces no uniqueness", async () => {
    const client = makeClient({
      getAvailability: vi.fn().mockResolvedValue([
        stockRow("BIKE001", {onHand: 1, allocated: 0, available: 1}),
        stockRow("BIKE001", {onHand: 1, allocated: 0, available: 1}),
      ]),
    });
    const result = await svc(client).transform(input);
    expect(result).toEqual({status: "not_single_unit"});
    expect(client.createStockAdjustment).not.toHaveBeenCalled();
  });

  it("refuses an empty serial before any Cin7 call, even with a blank-Batch row present", async () => {
    const client = makeClient({
      getAvailability: vi.fn().mockResolvedValue([stockRow("", {onHand: 1, allocated: 0, available: 1})]),
    });
    const result = await svc(client).transform({...input, serial: ""});
    expect(result).toEqual({status: "serial_not_found"});
    expect(client.createStockAdjustment).not.toHaveBeenCalled();
    expect(client.getAvailability).not.toHaveBeenCalled();
  });

  it("matches a numeric BatchSN against a string serial — Cin7 can return BatchSN as a JSON number", async () => {
    const client = makeClient({
      getAvailability: vi.fn().mockResolvedValue([{...row("x"), Batch: 12345}]),
    });
    const result = await svc(client).transform({...input, serial: "12345"});
    expect(result).toMatchObject({status: "ok", fromSerial: "12345", toSerial: "A-12345"});
    expect(client.createStockAdjustment).toHaveBeenCalledTimes(1);
  });

  it("refuses shopifyLocationId \"constructor\" rather than resolving an inherited Object.prototype value", async () => {
    const client = makeClient();
    const result = await svc(client).transform({...input, shopifyLocationId: "constructor"});
    expect(result).toEqual({status: "unknown_location"});
    expect(client.getAvailability).not.toHaveBeenCalled();
  });

  it("refuses when the target serial already exists — Cin7 does not enforce uniqueness", async () => {
    const client = makeClient({getAvailability: vi.fn().mockResolvedValue([row("BIKE001"), row("A-BIKE001")])});
    const result = await svc(client).transform(input);
    expect(result).toEqual({status: "target_exists"});
    expect(client.createStockAdjustment).not.toHaveBeenCalled();
  });

  it("still refuses a duplicate target that is fully allocated (Available: 0)", async () => {
    const client = makeClient({
      getAvailability: vi.fn().mockResolvedValue([
        row("BIKE001"),
        stockRow("A-BIKE001", {onHand: 1, allocated: 1, available: 0}),
      ]),
    });
    const result = await svc(client).transform(input);
    expect(result).toEqual({status: "target_exists"});
    expect(client.createStockAdjustment).not.toHaveBeenCalled();
  });

  it("allows the transform when the target serial exists only at a different location", async () => {
    const client = makeClient({
      getAvailability: vi.fn().mockResolvedValue([row("BIKE001"), row("A-BIKE001", "Wellington")]),
    });
    const result = await svc(client).transform(input);
    expect(result).toMatchObject({status: "ok", fromSerial: "BIKE001", toSerial: "A-BIKE001"});
    expect(client.createStockAdjustment).toHaveBeenCalledTimes(1);
  });

  it("refuses a disassemble that would produce an empty serial, without calling Cin7", async () => {
    const client = makeClient();
    const result = await svc(client).transform({...input, serial: "A-", direction: "disassemble"});
    expect(result).toEqual({status: "empty_target_serial"});
    expect(client.getAvailability).not.toHaveBeenCalled();
  });

  it("refuses rather than guessing when cost cannot be resolved", async () => {
    const client = makeClient({getProductWithMovements: vi.fn().mockResolvedValue({})});
    const result = await svc(client).transform(input);
    expect(result).toEqual({status: "cost_unresolved"});
    expect(client.createStockAdjustment).not.toHaveBeenCalled();
  });

  it("reports written_unconfirmed when Cin7 gives no evidence of a new stock line", async () => {
    const client = makeClient({
      createStockAdjustment: vi.fn().mockResolvedValue({TaskID: "task-2", NewStockLines: [], ExistingStockLines: [{}]}),
    });
    const result = await svc(client).transform(input);
    expect(result).toEqual({status: "written_unconfirmed", taskId: "task-2"});
  });

  it("written_unconfirmed carries a null taskId when Cin7 gives no TaskID either", async () => {
    const client = makeClient({createStockAdjustment: vi.fn().mockResolvedValue({})});
    const result = await svc(client).transform(input);
    expect(result).toEqual({status: "written_unconfirmed", taskId: null});
  });

  it("written_unconfirmed treats a truthy but non-array NewStockLines as no evidence", async () => {
    const client = makeClient({
      createStockAdjustment: vi.fn().mockResolvedValue({TaskID: "task-3", NewStockLines: {} as unknown}),
    });
    const result = await svc(client).transform(input);
    expect(result).toEqual({status: "written_unconfirmed", taskId: "task-3"});
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

    expect(result).toEqual({
      status: "ok", fromSerial: "A-BIKE001", toSerial: "BIKE001",
      unitCost: 450, costSource: "average", taskId: "task-1",
    });

    expect(client.createStockAdjustment).toHaveBeenCalledTimes(1);
    const payload = client.createStockAdjustment.mock.calls[0][0];
    expect(payload.UpdateOnHand).toBe(true);
    expect(payload.Status).toBe("COMPLETED");
    expect(payload.EffectiveDate).not.toContain("Z");
    expect(payload.Reference).toMatch(/^POS-SERIAL-XFORM:BIKE:A-BIKE001:BIKE001:\d{4}-\d{2}-\d{2}$/);
    expect(payload.Comment).toBe("Disassembled A-BIKE001 -> BIKE001");
    expect(payload.Lines).toEqual([
      {SKU: "BIKE", BatchSN: "A-BIKE001", Quantity: 0, UnitCost: 450, Location: "Main Warehouse"},
      {SKU: "BIKE", BatchSN: "BIKE001", Quantity: 1, UnitCost: 450, Location: "Main Warehouse"},
    ]);
  });
});

describe("buildReference", () => {
  it("is deterministic for the same transform on the same day", () => {
    const d = new Date("2026-09-15T10:00:00Z");
    expect(buildReference("BIKE", "BIKE001", "A-BIKE001", d))
      .toBe("POS-SERIAL-XFORM:BIKE:BIKE001:A-BIKE001:2026-09-15");
  });
});
