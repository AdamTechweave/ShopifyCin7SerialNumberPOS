import {describe, it, expect, vi, afterEach} from "vitest";

const transform = vi.fn();
vi.mock("../services/serial-transform.server", () => ({
  getTransformService: () => ({transform}),
}));
vi.mock("../shopify.server", () => ({
  authenticate: {public: {checkout: async () => ({cors: (r: Response) => r})}},
}));

const {action} = await import("./api.pos.serial-transform");

const post = (body: unknown) =>
  action({
    request: new Request("https://x/api/pos/serial-transform", {
      method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body),
    }),
  } as never);

const VALID = {sku: "BIKE", serial: "BIKE001", locationId: "999", direction: "assemble"};

afterEach(() => transform.mockReset());

describe("POST /api/pos/serial-transform", () => {
  it("returns the service result on success", async () => {
    transform.mockResolvedValue({status: "ok", fromSerial: "BIKE001", toSerial: "A-BIKE001", unitCost: 450, costSource: "average", taskId: "t1"});
    const res = await post(VALID);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({status: "ok", toSerial: "A-BIKE001"});
  });

  it("passes dryRun through", async () => {
    transform.mockResolvedValue({status: "preview", fromSerial: "BIKE001", toSerial: "A-BIKE001", unitCost: 450, costSource: "average"});
    await post({...VALID, dryRun: true});
    expect(transform).toHaveBeenCalledWith(expect.objectContaining({dryRun: true}));
  });

  // The route must not enumerate the result union — it passes every status
  // through generically at 200. Cover a representative spread of statuses
  // (including a guard added after the brief was written) rather than
  // switching on status in the route or the test.
  it.each([
    "already_transformed",
    "not_transformed",
    "too_long",
    "empty_target_serial",
    "unknown_location",
    "serial_not_found",
    "not_single_unit",
    "serial_allocated",
    "target_exists",
    "cost_unresolved",
  ])("returns guard status %s as 200 — it is an outcome, not a failure", async (status) => {
    transform.mockResolvedValue({status});
    const res = await post(VALID);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({status});
  });

  it("passes written_unconfirmed through at 200 with its taskId intact, unchanged and unretried", async () => {
    transform.mockResolvedValue({status: "written_unconfirmed", taskId: "t-123"});
    const res = await post(VALID);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({status: "written_unconfirmed", taskId: "t-123"});
    expect(transform).toHaveBeenCalledTimes(1);
  });

  it("rejects an unknown direction", async () => {
    const res = await post({...VALID, direction: "sideways"});
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({error: "INVALID_REQUEST"});
    expect(transform).not.toHaveBeenCalled();
  });

  it("rejects a missing serial", async () => {
    const res = await post({...VALID, serial: ""});
    expect(res.status).toBe(400);
    expect(transform).not.toHaveBeenCalled();
  });

  it("rejects a missing sku", async () => {
    const res = await post({...VALID, sku: ""});
    expect(res.status).toBe(400);
    expect(transform).not.toHaveBeenCalled();
  });

  it("rejects a non-string locationId", async () => {
    const res = await post({...VALID, locationId: 999});
    expect(res.status).toBe(400);
    expect(transform).not.toHaveBeenCalled();
  });

  it("rejects a non-boolean dryRun", async () => {
    const res = await post({...VALID, dryRun: "yes"});
    expect(res.status).toBe(400);
    expect(transform).not.toHaveBeenCalled();
  });

  it("rejects an unparsable body", async () => {
    const res = await action({
      request: new Request("https://x/api/pos/serial-transform", {
        method: "POST", headers: {"Content-Type": "application/json"}, body: "not json",
      }),
    } as never);
    expect(res.status).toBe(400);
    expect(transform).not.toHaveBeenCalled();
  });

  it("maps a Cin7Error to 502", async () => {
    const {Cin7Error} = await import("../services/cin7.server");
    transform.mockRejectedValue(new Cin7Error("RATE_LIMITED", "429"));
    const res = await post(VALID);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({error: "RATE_LIMITED"});
  });
});
