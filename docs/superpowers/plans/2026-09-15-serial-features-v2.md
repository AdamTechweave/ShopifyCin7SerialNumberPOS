# Serial Features v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only serial list to the POS product details screen, and a serial transform workflow that renames a serial on assembly (`BIKE001` → `A-BIKE001`) and back, via a single atomic Cin7 stock adjustment.

**Architecture:** Feature 1 reuses `GET /api/pos/serials` unchanged and shares an extracted presentational component with the existing picker. Feature 2 adds the first write path to `Cin7Client` and a new `POST /api/pos/serial-transform` route. Both features share two new POS extension targets on the product details screen.

**Tech Stack:** React Router 7 backend on Node, Preact POS UI extension, Vitest, Cin7 Core External API v2.

**Spec:** `docs/superpowers/specs/2026-09-15-serial-features-v2-design.md`

## Global Constraints

- **No database.** Nothing may import Prisma or add persistent storage. Sessions are in-process (`app/session-storage.server.ts`).
- **The Cin7 application key must never reach the extension bundle.** All Cin7 traffic goes through the backend.
- Backend routes authenticate with `authenticate.public.checkout` and wrap **every** response in the returned `cors()` helper — success and error paths alike.
- Cin7 rate limit is **~60 calls/minute per application key**. Treat both `429` and `503` as rate-limited.
- **Never auto-retry a Cin7 write.** Cin7 has no idempotency key and does not validate serial uniqueness, so a retry can create a duplicate serial.
- `TRANSFORM_PREFIX` is exactly `"A-"`, defined as a build-time constant in both `extensions/pos-serials/src/lib/transform.ts` and `app/services/transform.server.ts`. A client bundle cannot read server env.
- Extension `api_version` stays `2026-04`. Do not change it.
- Tests: fake `fetch` via `Cin7Client`'s third constructor parameter; fake whole interfaces as plain objects at the service layer. No mocking library beyond `vi.fn()`.
- Run `npm run typecheck && npm test && npm run lint` before every commit.

---

### Task 1: Pure transform logic (server + extension copies)

**Files:**
- Create: `app/services/transform.server.ts`
- Create: `app/services/transform.server.test.ts`
- Create: `extensions/pos-serials/src/lib/transform.ts`
- Create: `extensions/pos-serials/src/lib/transform.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `TRANSFORM_PREFIX: "A-"`, `type TransformDirection = "assemble" | "disassemble"`, `computeTargetSerial(serial: string, direction: TransformDirection): {ok: true; target: string} | {ok: false; reason: "already_transformed" | "not_transformed" | "too_long"}`. Both copies export identical signatures.

Cin7's `BatchSN` field is **max 50 characters**, so prefixing can overflow. That is the `too_long` case.

- [ ] **Step 1: Write the failing test** — `app/services/transform.server.test.ts`

```ts
import {describe, it, expect} from "vitest";
import {TRANSFORM_PREFIX, computeTargetSerial} from "./transform.server";

describe("TRANSFORM_PREFIX", () => {
  it("is the assembled-unit prefix", () => {
    expect(TRANSFORM_PREFIX).toBe("A-");
  });
});

describe("computeTargetSerial", () => {
  it("prefixes a plain serial when assembling", () => {
    expect(computeTargetSerial("BIKE001", "assemble")).toEqual({ok: true, target: "A-BIKE001"});
  });

  it("refuses to assemble a serial that is already prefixed", () => {
    expect(computeTargetSerial("A-BIKE001", "assemble")).toEqual({ok: false, reason: "already_transformed"});
  });

  it("strips the prefix when disassembling", () => {
    expect(computeTargetSerial("A-BIKE001", "disassemble")).toEqual({ok: true, target: "BIKE001"});
  });

  it("refuses to disassemble a serial that is not prefixed", () => {
    expect(computeTargetSerial("BIKE001", "disassemble")).toEqual({ok: false, reason: "not_transformed"});
  });

  it("refuses when the prefixed serial would exceed Cin7's 50-character BatchSN limit", () => {
    const serial = "X".repeat(49);
    expect(computeTargetSerial(serial, "assemble")).toEqual({ok: false, reason: "too_long"});
  });

  it("accepts a serial that prefixes to exactly 50 characters", () => {
    const serial = "X".repeat(48);
    expect(computeTargetSerial(serial, "assemble")).toEqual({ok: true, target: `A-${serial}`});
  });

  it("is case-sensitive about the prefix", () => {
    expect(computeTargetSerial("a-bike001", "assemble")).toEqual({ok: true, target: "A-a-bike001"});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/services/transform.server.test.ts`
Expected: FAIL — cannot resolve `./transform.server`.

- [ ] **Step 3: Write the implementation** — `app/services/transform.server.ts`

```ts
// Kept deliberately in sync with extensions/pos-serials/src/lib/transform.ts.
// The extension cannot import server code, and a client bundle cannot read
// server env, so the prefix is a build-time constant in both places.

/** Prefix marking an assembled unit. Changing it is a code edit plus `shopify app deploy`. */
export const TRANSFORM_PREFIX = "A-";

/** Cin7's BatchSN column is 50 characters. */
export const MAX_SERIAL_LENGTH = 50;

export type TransformDirection = "assemble" | "disassemble";

export type TargetSerialResult =
  | {ok: true; target: string}
  | {ok: false; reason: "already_transformed" | "not_transformed" | "too_long"};

export function computeTargetSerial(
  serial: string,
  direction: TransformDirection,
): TargetSerialResult {
  const hasPrefix = serial.startsWith(TRANSFORM_PREFIX);

  if (direction === "assemble") {
    if (hasPrefix) return {ok: false, reason: "already_transformed"};
    const target = `${TRANSFORM_PREFIX}${serial}`;
    if (target.length > MAX_SERIAL_LENGTH) return {ok: false, reason: "too_long"};
    return {ok: true, target};
  }

  if (!hasPrefix) return {ok: false, reason: "not_transformed"};
  return {ok: true, target: serial.slice(TRANSFORM_PREFIX.length)};
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/services/transform.server.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Create the extension copy**

Create `extensions/pos-serials/src/lib/transform.ts` with **identical body**, changing only the header comment to point back at `app/services/transform.server.ts`.

Create `extensions/pos-serials/src/lib/transform.test.ts` as a copy of the server test with the import changed to `./transform`.

- [ ] **Step 6: Verify both suites pass**

Run: `npm test`
Expected: all files pass; 14 new tests.

- [ ] **Step 7: Commit**

```bash
git add app/services/transform.server.ts app/services/transform.server.test.ts \
        extensions/pos-serials/src/lib/transform.ts extensions/pos-serials/src/lib/transform.test.ts
git commit -m "feat: pure serial-transform prefix logic, server and extension copies"
```

---

### Task 2: Generalise `Cin7Client` to support writes and time out

**Files:**
- Modify: `app/services/cin7.server.ts:38-78`
- Modify: `app/services/cin7.server.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: private `request<T>(method, path, opts)`; public `getAvailability`/`skuExists` unchanged in signature. Adds `REQUEST_TIMEOUT_MS = 30_000`.

There is no timeout today — a hung Cin7 response hangs the request indefinitely. Tolerable on a GET, dangerous mid-adjustment where it leaves the outcome unknown.

- [ ] **Step 1: Write the failing tests** — append to `app/services/cin7.server.test.ts`

```ts
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
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run app/services/cin7.server.test.ts`
Expected: FAIL — `init.signal` is `undefined`.

- [ ] **Step 3: Refactor `get` into `request`**

Replace lines 38-65 of `app/services/cin7.server.ts`:

```ts
const REQUEST_TIMEOUT_MS = 30_000;

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    opts: {params?: Record<string, string>; body?: unknown} = {},
  ): Promise<T> {
    const url = new URL(`${BASE_URL}/${path}`);
    for (const [key, value] of Object.entries(opts.params ?? {})) {
      url.searchParams.set(key, value);
    }

    let response: Response;
    try {
      response = await this.fetchFn(url.toString(), {
        method,
        headers: {
          "api-auth-accountid": this.accountId,
          "api-auth-applicationkey": this.applicationKey,
          "Content-Type": "application/json",
        },
        ...(opts.body === undefined ? {} : {body: JSON.stringify(opts.body)}),
        // Node's fetch has no default timeout. Without this a stalled Cin7
        // connection hangs the request forever — and mid-stock-adjustment that
        // leaves the write's outcome genuinely unknown.
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new Cin7Error("UNREACHABLE", `Cin7 request failed: ${error}`);
    }

    if (response.status === 429 || response.status === 503) {
      throw new Cin7Error("RATE_LIMITED", `Cin7 rate limit hit (${response.status})`);
    }
    if (response.status === 401 || response.status === 403) {
      throw new Cin7Error("AUTH_FAILED", `Cin7 rejected credentials (${response.status})`);
    }
    if (!response.ok) {
      throw new Cin7Error("BAD_RESPONSE", `Cin7 returned ${response.status}`);
    }
    return response.json() as Promise<T>;
  }

  private get<T>(path: string, params: Record<string, string>): Promise<T> {
    return this.request<T>("GET", path, {params});
  }
```

Leave `getAvailability` and `skuExists` exactly as they are — they call `this.get` and keep working.

- [ ] **Step 4: Run the full Cin7 suite**

Run: `npx vitest run app/services/cin7.server.test.ts`
Expected: PASS — existing tests plus the two new ones.

- [ ] **Step 5: Commit**

```bash
git add app/services/cin7.server.ts app/services/cin7.server.test.ts
git commit -m "refactor: generalise Cin7Client.get into request(), add a 30s timeout"
```

---

### Task 3: Cin7 write methods

**Files:**
- Modify: `app/services/cin7.server.ts` (append to the class)
- Modify: `app/services/cin7.server.test.ts`

**Interfaces:**
- Consumes: `request<T>` from Task 2.
- Produces:
  - `interface StockAdjustmentLine {SKU: string; BatchSN: string; Quantity: number; UnitCost: number; Location: string}`
  - `interface StockAdjustmentPayload {EffectiveDate: string; Status: "COMPLETED"; Reference: string; Comment: string; UpdateOnHand: true; Lines: StockAdjustmentLine[]}`
  - `interface StockAdjustmentResponse {TaskID?: string; ExistingStockLines?: unknown[]; NewStockLines?: unknown[]}`
  - `interface Cin7Movement {BatchSN: string | null; Location: string; Quantity: number; Amount: number; Date: string; Type: string}`
  - `createStockAdjustment(payload): Promise<StockAdjustmentResponse>`
  - `getProductWithMovements(sku): Promise<{AverageCost?: number; Movements?: Cin7Movement[]}>`

- [ ] **Step 1: Write the failing tests**

```ts
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
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run app/services/cin7.server.test.ts`
Expected: FAIL — `createStockAdjustment is not a function`.

- [ ] **Step 3: Implement** — append inside the `Cin7Client` class, and the interfaces above it

```ts
export interface StockAdjustmentLine {
  SKU: string;
  BatchSN: string;
  /** Cin7 treats this as the NEW absolute QuantityOnHand, not a delta. */
  Quantity: number;
  UnitCost: number;
  Location: string;
}

export interface StockAdjustmentPayload {
  EffectiveDate: string;
  Status: "COMPLETED";
  Reference: string;
  Comment: string;
  /** Defaults to false in Cin7, which adjusts *available* rather than *on hand*. */
  UpdateOnHand: true;
  Lines: StockAdjustmentLine[];
}

export interface StockAdjustmentResponse {
  TaskID?: string;
  ExistingStockLines?: unknown[];
  NewStockLines?: unknown[];
}

export interface Cin7Movement {
  BatchSN: string | null;
  Location: string;
  Quantity: number;
  /** Cost of the moved goods, per Cin7's docs. */
  Amount: number;
  Date: string;
  Type: string;
}
```

```ts
  async createStockAdjustment(payload: StockAdjustmentPayload): Promise<StockAdjustmentResponse> {
    return this.request<StockAdjustmentResponse>("POST", "stockadjustment", {body: payload});
  }

  async getProductWithMovements(
    sku: string,
  ): Promise<{AverageCost?: number; Movements?: Cin7Movement[]}> {
    const data = await this.request<{
      Products?: Array<{AverageCost?: number; Movements?: Cin7Movement[]}>;
    }>("GET", "product", {params: {Sku: sku, IncludeMovements: "true", Page: "1", Limit: "1"}});
    return data.Products?.[0] ?? {};
  }
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run app/services/cin7.server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/services/cin7.server.ts app/services/cin7.server.test.ts
git commit -m "feat: Cin7 stock-adjustment write and product-movements read"
```

---

### Task 4: Cost resolution

**Files:**
- Create: `app/services/cost.server.ts`
- Create: `app/services/cost.server.test.ts`

**Interfaces:**
- Consumes: `Cin7Movement` from Task 3.
- Produces: `type CostResult = {ok: true; unitCost: number; source: "movement" | "average"} | {ok: false}`, and `resolveUnitCost(product: {AverageCost?: number; Movements?: Cin7Movement[]}, serial: string, locationName: string): CostResult`.

Cin7 exposes no per-serial cost endpoint. Movements are the only per-serial cost data; `AverageCost` is the fallback. Refuse rather than guess — a wrong cost silently corrupts inventory valuation.

- [ ] **Step 1: Write the failing test**

```ts
import {describe, it, expect} from "vitest";
import {resolveUnitCost} from "./cost.server";

const movement = (over: Partial<import("./cin7.server").Cin7Movement> = {}) => ({
  BatchSN: "BIKE001", Location: "Main Warehouse", Quantity: 1,
  Amount: 450, Date: "2026-09-01T00:00:00", Type: "Purchase", ...over,
});

describe("resolveUnitCost", () => {
  it("uses the matching inbound movement, divided to a unit cost", () => {
    const product = {AverageCost: 999, Movements: [movement({Quantity: 2, Amount: 900})]};
    expect(resolveUnitCost(product, "BIKE001", "Main Warehouse")).toEqual({ok: true, unitCost: 450, source: "movement"});
  });

  it("prefers the most recent matching movement", () => {
    const product = {Movements: [
      movement({Amount: 400, Date: "2026-01-01T00:00:00"}),
      movement({Amount: 500, Date: "2026-06-01T00:00:00"}),
    ]};
    expect(resolveUnitCost(product, "BIKE001", "Main Warehouse")).toEqual({ok: true, unitCost: 500, source: "movement"});
  });

  it("ignores movements for another serial or another location", () => {
    const product = {AverageCost: 120, Movements: [
      movement({BatchSN: "BIKE002"}), movement({Location: "Other Store"}),
    ]};
    expect(resolveUnitCost(product, "BIKE001", "Main Warehouse")).toEqual({ok: true, unitCost: 120, source: "average"});
  });

  it("ignores outbound movements", () => {
    const product = {AverageCost: 120, Movements: [movement({Quantity: -1, Amount: -450})]};
    expect(resolveUnitCost(product, "BIKE001", "Main Warehouse")).toEqual({ok: true, unitCost: 120, source: "average"});
  });

  it("falls back to AverageCost when there are no movements", () => {
    expect(resolveUnitCost({AverageCost: 75}, "BIKE001", "Main Warehouse")).toEqual({ok: true, unitCost: 75, source: "average"});
  });

  it("refuses when neither source yields a positive cost", () => {
    expect(resolveUnitCost({AverageCost: 0}, "BIKE001", "Main Warehouse")).toEqual({ok: false});
    expect(resolveUnitCost({}, "BIKE001", "Main Warehouse")).toEqual({ok: false});
  });

  it("abandons the movement scan rather than walk an unbounded history", () => {
    const many = Array.from({length: 2001}, () => movement({BatchSN: "OTHER"}));
    many.push(movement({Amount: 450}));
    expect(resolveUnitCost({AverageCost: 75, Movements: many}, "BIKE001", "Main Warehouse")).toEqual({ok: true, unitCost: 75, source: "average"});
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run app/services/cost.server.test.ts`
Expected: FAIL — cannot resolve `./cost.server`.

- [ ] **Step 3: Implement** — `app/services/cost.server.ts`

```ts
import type {Cin7Movement} from "./cin7.server";

/**
 * Cin7 exposes no per-serial cost endpoint — `/ref/productavailability` has a
 * Batch filter but carries no cost field, and ExistingStockLineModel has no
 * cost at all. Movements are the only per-serial cost data available.
 */

/** Movement history is unbounded and has no BatchSN filter. Cap the scan. */
export const MAX_MOVEMENTS_SCANNED = 2000;

export type CostResult =
  | {ok: true; unitCost: number; source: "movement" | "average"}
  | {ok: false};

export function resolveUnitCost(
  product: {AverageCost?: number; Movements?: Cin7Movement[]},
  serial: string,
  locationName: string,
): CostResult {
  const movements = product.Movements ?? [];

  if (movements.length > 0 && movements.length <= MAX_MOVEMENTS_SCANNED) {
    const inbound = movements
      .filter((m) => m.BatchSN === serial && m.Location === locationName && m.Quantity > 0)
      .sort((a, b) => a.Date.localeCompare(b.Date));

    const latest = inbound[inbound.length - 1];
    if (latest) {
      const unitCost = latest.Amount / latest.Quantity;
      if (Number.isFinite(unitCost) && unitCost > 0) {
        return {ok: true, unitCost, source: "movement"};
      }
    }
  }

  const average = product.AverageCost;
  if (typeof average === "number" && Number.isFinite(average) && average > 0) {
    return {ok: true, unitCost: average, source: "average"};
  }

  return {ok: false};
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run app/services/cost.server.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add app/services/cost.server.ts app/services/cost.server.test.ts
git commit -m "feat: resolve a serial's unit cost from Cin7 movements, falling back to average"
```

---

### Task 5: `TransformService`

**Files:**
- Create: `app/services/serial-transform.server.ts`
- Create: `app/services/serial-transform.server.test.ts`

**Interfaces:**
- Consumes: `computeTargetSerial`/`TransformDirection` (Task 1), `Cin7Client` write methods (Task 3), `resolveUnitCost` (Task 4), `groupSerials` and `AvailableSerial` from `./serials.server`.
- Produces:

```ts
export type TransformResult =
  | {status: "ok"; fromSerial: string; toSerial: string; unitCost: number; costSource: "movement" | "average"; taskId: string | null}
  | {status: "preview"; fromSerial: string; toSerial: string; unitCost: number; costSource: "movement" | "average"}
  | {status: "already_transformed"}
  | {status: "not_transformed"}
  | {status: "too_long"}
  | {status: "target_exists"}
  | {status: "serial_not_found"}
  | {status: "unknown_location"}
  | {status: "cost_unresolved"};

export class TransformService {
  constructor(client: Cin7Client, locationMap: Record<string, string>);
  transform(input: {sku: string; serial: string; shopifyLocationId: string; direction: TransformDirection; dryRun?: boolean}): Promise<TransformResult>;
}
export function getTransformService(): TransformService;
export function buildReference(sku: string, from: string, to: string, date: Date): string;
```

Order of operations — each guard before the irreversible write:

1. `computeTargetSerial` → map `already_transformed` / `not_transformed` / `too_long` straight out.
2. Resolve the Cin7 location name from `locationMap`; unmapped → `unknown_location`.
3. `getAvailability(sku)` → `groupSerials`. Source serial must exist at that location with `available > 0`, else `serial_not_found`.
4. Target serial must **not** already exist at that location, else `target_exists`. (Cin7 does not enforce serial uniqueness — this is our only guard against duplicates.)
5. `getProductWithMovements(sku)` → `resolveUnitCost`; `{ok: false}` → `cost_unresolved`.
6. If `dryRun`, return `preview` **without posting**.
7. `createStockAdjustment` with both lines. Return `ok` with `TaskID ?? null`.

- [ ] **Step 1: Write the failing test** — `app/services/serial-transform.server.test.ts`

```ts
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
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run app/services/serial-transform.server.test.ts`
Expected: FAIL — cannot resolve module.

- [ ] **Step 3: Implement** — `app/services/serial-transform.server.ts`

Follow the ordered guards above. Notes for the implementer:

- Build the client the same way `serials.server.ts` does (`getConfig()` for credentials and `locationMap`); export a memoised `getTransformService()` mirroring `getSerialService()`.
- `EffectiveDate`: `new Date().toISOString().replace("Z", "")` — Cin7 wants `yyyy-MM-ddTHH:mm:ss.fff` with no zone suffix.
- `Comment`: `` `${direction === "assemble" ? "Assembled" : "Disassembled"} ${fromSerial} -> ${toSerial}` ``.
- Send the resolved `UnitCost` on **both** lines. Cin7's `ExistingStockLineModel` has no cost field, so it is probably ignored on the `Quantity: 0` line — but that is inference, not documentation, and sending the correct value is right under either interpretation.
- Do **not** retry `createStockAdjustment`. Let `Cin7Error` propagate to the route.

- [ ] **Step 4: Run tests**

Run: `npx vitest run app/services/serial-transform.server.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add app/services/serial-transform.server.ts app/services/serial-transform.server.test.ts
git commit -m "feat: TransformService — guarded, single-document Cin7 serial transform"
```

---

### Task 6: `POST /api/pos/serial-transform`

**Files:**
- Create: `app/routes/api.pos.serial-transform.tsx`
- Create: `app/routes/api.pos.serial-transform.test.ts`

**Interfaces:**
- Consumes: `getTransformService()`, `TransformResult` (Task 5).
- Produces: the HTTP contract the extension calls.

Mirror `app/routes/api.pos.serials.tsx` exactly: `authenticate.public.checkout`, `cors()` on every response, `Cin7Error` → 502 `{error: code}`.

Validation: `sku` and `serial` non-empty strings, `direction` one of `"assemble" | "disassemble"`, `locationId` a string, `dryRun` optional boolean. Anything else → 400 `{error: "INVALID_REQUEST"}`.

Map service results to HTTP: `ok`/`preview` → 200 with the result; every guard status → 200 with the result (they are expected outcomes the UI renders, not transport failures); `Cin7Error` → 502.

- [ ] **Step 1: Write the failing test**

Extract the service via a module mock, following the existing route-test style in the repo. Cover: a successful transform, a dry run, each guard status passing through with 200, an invalid body → 400, and a `Cin7Error` → 502 with `{error: "RATE_LIMITED"}`.

```ts
import {describe, it, expect, vi, beforeEach} from "vitest";

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

beforeEach(() => transform.mockReset());

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

  it("returns guard statuses as 200 — they are outcomes, not failures", async () => {
    transform.mockResolvedValue({status: "target_exists"});
    const res = await post(VALID);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({status: "target_exists"});
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
  });

  it("maps a Cin7Error to 502", async () => {
    const {Cin7Error} = await import("../services/cin7.server");
    transform.mockRejectedValue(new Cin7Error("RATE_LIMITED", "429"));
    const res = await post(VALID);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({error: "RATE_LIMITED"});
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run app/routes/api.pos.serial-transform.test.ts`
Expected: FAIL — route module does not exist.

- [ ] **Step 3: Implement the route**

```tsx
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
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run app/routes/api.pos.serial-transform.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Full check and commit**

```bash
npm run typecheck && npm test && npm run lint
git add app/routes/api.pos.serial-transform.tsx app/routes/api.pos.serial-transform.test.ts
git commit -m "feat: POST /api/pos/serial-transform"
```

---

### Task 7: Extract `SerialList` from `SerialPicker` (no behaviour change)

**Files:**
- Create: `extensions/pos-serials/src/screens/SerialList.tsx`
- Modify: `extensions/pos-serials/src/screens/SerialPicker.tsx`

**Interfaces:**
- Consumes: `SerialLookup` from `../lib/api`, `AvailableSerial` from `../lib/serials`.
- Produces: `SerialList` — props `{state: SerialLookup; onRetry: () => void; onSelect?: (serial: AvailableSerial) => void; searchable?: boolean}`.

This is a **pure refactor**. Read `SerialPicker.tsx` first and move the render logic verbatim — the loading / error / `sku_not_found` / `no_stock` states, the search field, and the current-location-first sectioned list. Do not change wording, components, or ordering.

What must stay in `SerialPicker`: `excludeInCart`, the `onChoose` cart wiring, the scanner auto-select effect. `SerialList` must have **no cart awareness**. When `onSelect` is omitted, rows render as non-interactive.

- [ ] **Step 1: Read the current implementation**

Run: `sed -n '1,160p' extensions/pos-serials/src/screens/SerialPicker.tsx`

- [ ] **Step 2: Create `SerialList.tsx`** with the moved render logic.

- [ ] **Step 3: Rewrite `SerialPicker.tsx`** to render `<SerialList …>` for the list while keeping its own cart and scanner behaviour.

- [ ] **Step 4: Verify nothing broke**

Run: `npm run typecheck && npm test && npm run lint`
Expected: all pass. There are no component tests, so typecheck and lint are the safety net — read the diff carefully.

- [ ] **Step 5: Commit**

```bash
git add extensions/pos-serials/src/screens/SerialList.tsx extensions/pos-serials/src/screens/SerialPicker.tsx
git commit -m "refactor: extract SerialList presentation from SerialPicker"
```

---

### Task 8: Extension API client additions

**Files:**
- Modify: `extensions/pos-serials/src/lib/api.ts`

**Interfaces:**
- Consumes: `TransformDirection` from `./transform`.
- Produces:

```ts
export type TransformResponse =
  | {status: "ok"; fromSerial: string; toSerial: string; unitCost: number; costSource: "movement" | "average"; taskId: string | null}
  | {status: "preview"; fromSerial: string; toSerial: string; unitCost: number; costSource: "movement" | "average"}
  | {status: "already_transformed"} | {status: "not_transformed"} | {status: "too_long"}
  | {status: "target_exists"} | {status: "serial_not_found"} | {status: "unknown_location"}
  | {status: "cost_unresolved"} | {status: "error"; code: string};

export function postSerialTransform(input: {sku: string; serial: string; locationId: string; direction: TransformDirection; dryRun?: boolean}): Promise<TransformResponse>;
export function fetchVariantSku(variantId: number): Promise<string | null>;
```

- [ ] **Step 1: Implement `fetchVariantSku`**

```ts
/**
 * The product-details targets give a variantId, but the serials endpoint keys
 * off SKU. `fetchProductVariantWithId` is an on-device POS lookup — no network
 * cost to us — and `sku` is optional on the variant.
 */
export async function fetchVariantSku(variantId: number): Promise<string | null> {
  try {
    const variant = await shopify.productSearch.fetchProductVariantWithId(variantId);
    return variant?.sku ?? null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 2: Implement `postSerialTransform`**

Follow the shape of the existing `fetchSerials` — relative URL, catch transport failure and map it to `{status: "error", code: "NETWORK"}`, and map a non-ok response to `{status: "error", code}` using the body's `error` field when present.

```ts
export async function postSerialTransform(input: {
  sku: string; serial: string; locationId: string;
  direction: TransformDirection; dryRun?: boolean;
}): Promise<TransformResponse> {
  try {
    const response = await fetch("/api/pos/serial-transform", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(input),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {error?: string};
      return {status: "error", code: body.error ?? `HTTP_${response.status}`};
    }
    return (await response.json()) as TransformResponse;
  } catch {
    return {status: "error", code: "NETWORK"};
  }
}
```

- [ ] **Step 3: Verify and commit**

```bash
npm run typecheck && npm run lint
git add extensions/pos-serials/src/lib/api.ts
git commit -m "feat: extension client for serial transform and variant SKU lookup"
```

---

### Task 9: Product details menu item and modal shell (Feature 1 complete)

**Files:**
- Create: `extensions/pos-serials/src/ProductMenuItem.tsx`
- Create: `extensions/pos-serials/src/ProductModal.tsx`
- Create: `extensions/pos-serials/src/screens/ProductSerials.tsx`
- Modify: `extensions/pos-serials/shopify.extension.toml`

**Interfaces:**
- Consumes: `fetchVariantSku`, `fetchSerials` (Task 8), `SerialList` (Task 7).
- Produces: the two registered targets.

A target maps to exactly one module, so these two modules serve **both** features. `ProductModal` owns routing state: `"menu" | "serials" | "transform"`.

- [ ] **Step 1: Add the targets to the TOML**

Append inside the existing `[[extensions]]` block — same block, same `uid`, do not create a second `[[extensions]]`:

```toml
  [[extensions.targeting]]
  target = "pos.product-details.action.menu-item.render"
  module = "./src/ProductMenuItem.tsx"

  [[extensions.targeting]]
  target = "pos.product-details.action.render"
  module = "./src/ProductModal.tsx"
```

- [ ] **Step 2: Write `ProductMenuItem.tsx`**

Follow `Tile.tsx`'s structure (`render(<X />, document.body)` from a default async export). A single button labelled "Serial numbers" that calls `shopify.action.presentModal()`.

- [ ] **Step 3: Write `ProductSerials.tsx`**

Resolve the SKU from `shopify.product.variantId` via `fetchVariantSku`, read `shopify.session.currentSession.locationId`, call `fetchSerials(sku)`, and render `<SerialList state={…} onRetry={…} />` with **no** `onSelect` — read-only.

If `fetchVariantSku` returns `null`, render "No SKU set for this variant" rather than attempting a lookup.

- [ ] **Step 4: Write `ProductModal.tsx`**

Routing shell holding `screen` state. Start on a small menu offering "View serial numbers" and "Transform serial", routing to `ProductSerials` and (Task 10) `SerialTransform`. Until Task 10 lands, the transform entry renders a placeholder — **replace it in Task 10, do not ship it**.

- [ ] **Step 5: Verify and commit**

```bash
npm run typecheck && npm test && npm run lint
git add extensions/pos-serials/src/ProductMenuItem.tsx extensions/pos-serials/src/ProductModal.tsx \
        extensions/pos-serials/src/screens/ProductSerials.tsx extensions/pos-serials/shopify.extension.toml
git commit -m "feat: serial list on the POS product details screen"
```

---

### Task 10: Serial transform screen (Feature 2 complete)

**Files:**
- Create: `extensions/pos-serials/src/screens/SerialTransform.tsx`
- Modify: `extensions/pos-serials/src/ProductModal.tsx`

**Interfaces:**
- Consumes: `SerialList` (Task 7), `postSerialTransform` (Task 8), `computeTargetSerial`/`TRANSFORM_PREFIX` (Task 1).

Three sub-steps inside the screen: **pick** → **confirm** → **result**.

- **Pick.** Render `SerialList` with `onSelect`. Direction is inferred from the chosen serial: one carrying `TRANSFORM_PREFIX` offers "Disassemble", one without offers "Assemble". Use `computeTargetSerial` locally to preview the target and to disable an impossible action before any network call.
- **Confirm.** Call `postSerialTransform` with `dryRun: true`. Show from-serial, to-serial, location, resolved unit cost, and **which source the cost came from** ("from last movement" / "product average"). A confirm button commits.
- **Result.** On `ok`, a success summary. On any guard status, a plain-language message. On `{status: "error"}`, a loud failure naming the serial and instructing the user to **check Cin7 before retrying** — per the spec, never offer a one-tap retry on a write.

Message copy for each guard status:

| Status | Message |
|---|---|
| `already_transformed` | "{serial} is already assembled." |
| `not_transformed` | "{serial} is not an assembled serial." |
| `too_long` | "{serial} is too long to prefix — Cin7 allows 50 characters." |
| `target_exists` | "{target} already exists at this location." |
| `serial_not_found` | "{serial} is not in stock at this location." |
| `unknown_location` | "This POS location isn't mapped to a Cin7 location." |
| `cost_unresolved` | "Couldn't determine this unit's cost in Cin7. Transform it in Cin7 directly." |
| `error` | "Transform failed ({code}). Check Cin7 before trying again — the adjustment may have been written." |

- [ ] **Step 1: Write `SerialTransform.tsx`** per the above.

- [ ] **Step 2: Wire it into `ProductModal.tsx`**, replacing the Task 9 placeholder.

- [ ] **Step 3: Verify and commit**

```bash
npm run typecheck && npm test && npm run lint
git add extensions/pos-serials/src/screens/SerialTransform.tsx extensions/pos-serials/src/ProductModal.tsx
git commit -m "feat: serial transform screen in POS"
```

---

### Task 11: Documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document both features** — extend the architecture section with the two new targets and the `POST /api/pos/serial-transform` route.

- [ ] **Step 2: Add a "Serial transform" section** covering: the single-document stock adjustment, why `UpdateOnHand: true` matters, how cost is resolved and what happens when it can't be, and that writes are never auto-retried.

- [ ] **Step 3: Copy the spec's risk register into Known Limitations** — the six unverified Cin7 behaviours — and state that `dryRun` exists so the first production transform can be validated against a sandbox first.

- [ ] **Step 4: Fix the stale version note.** README §7 claims `@shopify/ui-extensions` is pinned to `2025.10.x` against `api_version = "2026-07"`. Actual: `^2026.4.4` and `2026-04`.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: product-details serial lookup and serial transform"
```

---

## Self-Review

**Spec coverage:** Feature 1 targets → Task 9; data path → Tasks 8, 9; `SerialList` extraction → Task 7; Cin7 mechanism → Tasks 2, 3, 5; cost resolution → Task 4; idempotency guards → Task 5; backend route → Task 6; UI → Task 10; prefix constants → Task 1; risk register → Task 11. No gaps.

**Placeholders:** None. The only deliberate temporary is Task 9 Step 4's transform placeholder, explicitly replaced in Task 10.

**Type consistency:** `TransformResult` (Task 5) and `TransformResponse` (Task 8) carry matching members, with `error` added client-side only — the same split the existing `SerialLookupResult` / `SerialLookup` pair already uses. `computeTargetSerial` keeps one signature across both copies. `costSource` is `"movement" | "average"` everywhere.
