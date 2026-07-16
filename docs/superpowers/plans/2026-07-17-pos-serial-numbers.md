# POS Serial Number Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Shopify app whose POS smart-grid tile highlights when serial-tracked products (by tag) are in the cart, opens a modal to pick available Cin7 Core serial numbers per unit (tap/search/scan), saves the pick as a line item property, and blocks checkout until every serialized unit has one.

**Architecture:** One app per client store: a POS UI extension (tile + modal, Preact web components), a cart/checkout validation Shopify Function, and a Remix backend that holds per-client Cin7 credentials and proxies serial lookups. Spec: `docs/superpowers/specs/2026-07-17-pos-serial-numbers-design.md`.

**Tech Stack:** Shopify Remix app template (TypeScript, `@shopify/shopify-app-remix` v4), POS UI extensions API `2026-07` (Preact), Cart & Checkout Validation Function (JavaScript), Cin7 Core External API v2, Vitest.

## Global Constraints

- Node/TypeScript throughout; app scaffolded from the Shopify **Remix** template, TypeScript flavor.
- POS UI extension `api_version = "2026-07"`; automatic backend-fetch auth requires extensions targeting ≥ 2025-07 and Shopify POS app ≥ 10.6.0 on devices.
- Compiled POS extension bundle must stay ≤ 64 KB — no dependencies beyond `preact` and `@shopify/ui-extensions` in the extension.
- Serial tag default: `serialized` (server env `SERIAL_TAG`). The validation function's input query hardcodes the tag literal — a per-client tag change means editing `extensions/serial-validation/src/cart_validations_generate_run.graphql` before deploy.
- Line item property key is the literal `Serial Number` everywhere: extension constant `SERIAL_PROPERTY_KEY`, function input query `attribute(key: "Serial Number")`, backend config default. Changing it requires redeploying extension + function together.
- Cin7 Core: base URL `https://inventory.dearsystems.com/ExternalApi/v2/`, auth headers `api-auth-accountid` / `api-auth-applicationkey`, throttled at 60 calls/minute per application key (responds 429 **or** 503). Serial numbers live in the `Batch` field of `ref/productavailability` rows (one row per serial per location); rows with zero available/on-hand/on-order are omitted by Cin7.
- Cin7 availability responses cached server-side for 45 seconds per SKU.
- Validation function target `cart.validations.generate.run`; error target `"$.cart"`.
- Required app scopes: `read_products,write_validations`.
- Never present a serial that Cin7 did not return as available.
- TDD: each logic task writes the failing test first. Commit at the end of every task (and mid-task where marked).
- Human-in-the-loop steps (Partner login, POS device testing) are marked **[HUMAN]** — pause and ask the user to perform them if not automatable.

## File structure (end state)

```
shopify.app.toml                          # app config (scopes edited in Task 1)
vitest.config.ts                          # Task 1
app/
  shopify.server.ts                       # from template
  config.server.ts                        # Task 4 — per-client env config
  services/
    cache.server.ts                       # Task 5 — TTL cache
    cin7.server.ts                        # Task 5 — Cin7 HTTP client
    serials.server.ts                     # Task 6 — grouping + SerialService
    tags.server.ts                        # Task 7 — GID + serialized-map helpers
  routes/
    api.pos.serials.tsx                   # Task 8 — GET serials by SKU
    api.pos.product-tags.tsx              # Task 8 — POST product IDs → serialized map
extensions/
  serial-validation/                      # Task 2 — validation function (JS)
    shopify.extension.toml
    src/cart_validations_generate_run.graphql
    src/cart_validations_generate_run.js
    src/cart_validations_generate_run.test.js
  pos-serials/                            # Task 9 — POS UI extension
    shopify.extension.toml
    src/Tile.tsx                          # Task 11
    src/Modal.tsx                         # Task 12
    src/screens/LineList.tsx              # Task 12
    src/screens/SerialPicker.tsx          # Tasks 12–13
    src/lib/serials.ts                    # Task 10 — pure logic
    src/lib/serials.test.ts               # Task 10
    src/lib/api.ts                        # Task 11 — backend fetch helpers
docs/superpowers/notes/2026-07-pos-validation-spike.md   # Task 3
README.md                                 # Task 14 — runbook
.env.example                              # Task 4
```

---

### Task 1: Scaffold the Shopify app and test tooling

**Files:**
- Create: entire Remix app template at repo root (via CLI, then moved up)
- Create: `vitest.config.ts`
- Modify: `shopify.app.toml` (scopes), `package.json` (test script), `.gitignore` (merge)

**Interfaces:**
- Consumes: nothing (first task).
- Produces: a running Remix app with `authenticate`/`unauthenticated` exported from `app/shopify.server.ts` (template default); `npm test` running Vitest.

- [ ] **Step 1: Scaffold the app** **[HUMAN — requires Shopify Partner login]**

Run from the repo root (the CLI creates a subdirectory; we move its contents up):

```bash
cd /Users/adamstead/gitProjects/ShopifyCin7SerialNumberPOS
shopify app init --template remix --name pos-serials-app
```

When prompted: choose the **TypeScript** flavor, and link/create the app in the user's Partner org (ask the user which org/dev store). If `--template remix` is rejected by the installed CLI version, run plain `shopify app init` and pick Remix + TypeScript interactively.

- [ ] **Step 2: Move the scaffold to the repo root**

```bash
rsync -a pos-serials-app/ ./ --exclude .git
rm -rf pos-serials-app
```

Then merge `.gitignore`: keep the template's ignores and re-add our entries (`.idea/`, `.env.*` with `!.env.example`).

- [ ] **Step 3: Set app scopes**

In `shopify.app.toml`, set:

```toml
[access_scopes]
scopes = "read_products,write_validations"
```

- [ ] **Step 4: Add Vitest**

```bash
npm install --save-dev vitest
```

Create `vitest.config.ts`:

```ts
import {defineConfig} from "vitest/config";

export default defineConfig({
  test: {
    include: ["app/**/*.test.ts", "extensions/**/src/**/*.test.{ts,js}"],
    environment: "node",
    passWithNoTests: true,
  },
});
```

Add to `package.json` scripts: `"test": "vitest run"`.

- [ ] **Step 5: Verify**

Run: `npm test`
Expected: Vitest exits 0 with "No test files found" (passWithNoTests).

Run: `npm run build`
Expected: template builds cleanly.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: scaffold Shopify Remix app template with vitest"
```

---

### Task 2: Cart & checkout validation function

**Files:**
- Create: `extensions/serial-validation/` (scaffold via CLI)
- Create: `extensions/serial-validation/src/cart_validations_generate_run.graphql`
- Create: `extensions/serial-validation/src/cart_validations_generate_run.js`
- Test: `extensions/serial-validation/src/cart_validations_generate_run.test.js`

**Interfaces:**
- Consumes: nothing from other tasks. Property key literal `Serial Number`, tag literal `serialized` (Global Constraints).
- Produces: function handle `serial-validation` (used by Task 3's `validationCreate`). Validation rules: serialized line ⇒ quantity 1 + non-empty `Serial Number` attribute + serial unique in cart.

- [ ] **Step 1: Scaffold the function**

```bash
shopify app generate extension --template cart_checkout_validation --name serial-validation
```

Choose **JavaScript** when prompted for the language.

- [ ] **Step 2: Replace the input query**

`extensions/serial-validation/src/cart_validations_generate_run.graphql`:

```graphql
query CartValidationsGenerateRunInput {
  cart {
    lines {
      quantity
      serialNumber: attribute(key: "Serial Number") {
        value
      }
      merchandise {
        __typename
        ... on ProductVariant {
          product {
            title
            hasAnyTag(tags: ["serialized"])
          }
        }
      }
    }
  }
}
```

- [ ] **Step 3: Run typegen — DECISION POINT**

```bash
cd extensions/serial-validation && shopify app function typegen && cd ../..
```

Expected: types generate cleanly. **If typegen rejects line-level `attribute(key:)`** (it is confirmed on the shared Functions input graph but not shown in validation-specific docs): STOP and report to the user — the fallback (cart-level attributes keyed per line) changes the design and needs sign-off.

- [ ] **Step 4: Write the failing tests**

`extensions/serial-validation/src/cart_validations_generate_run.test.js`:

```js
import {describe, it, expect} from "vitest";
import {cartValidationsGenerateRun} from "./cart_validations_generate_run";

function line({quantity = 1, serial = null, serialized = true, title = "Widget"} = {}) {
  return {
    quantity,
    serialNumber: serial === null ? null : {value: serial},
    merchandise: {
      __typename: "ProductVariant",
      product: {title, hasAnyTag: serialized},
    },
  };
}

function errorsFor(lines) {
  return cartValidationsGenerateRun({cart: {lines}}).operations[0].validationAdd.errors;
}

describe("cartValidationsGenerateRun", () => {
  it("passes a cart with no serialized products", () => {
    expect(errorsFor([line({serialized: false})])).toEqual([]);
  });

  it("passes a serialized line with qty 1 and a serial", () => {
    expect(errorsFor([line({serial: "SN-001"})])).toEqual([]);
  });

  it("blocks a serialized line with no serial", () => {
    const errors = errorsFor([line({title: "iPhone 15"})]);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("iPhone 15");
    expect(errors[0].target).toBe("$.cart");
  });

  it("blocks a serialized line with a blank serial", () => {
    expect(errorsFor([line({serial: "   "})])).toHaveLength(1);
  });

  it("blocks a serialized line with quantity > 1 even when a serial is set", () => {
    const errors = errorsFor([line({quantity: 2, serial: "SN-001"})]);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("one serial number per unit");
  });

  it("blocks duplicate serials across lines", () => {
    const errors = errorsFor([line({serial: "SN-001"}), line({serial: "SN-001"})]);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("SN-001");
  });

  it("ignores custom-sale (non-variant) lines", () => {
    const custom = {quantity: 1, serialNumber: null, merchandise: {__typename: "CustomProduct"}};
    expect(errorsFor([custom])).toEqual([]);
  });
});
```

- [ ] **Step 5: Run tests to verify they fail**

Run: `npx vitest run extensions/serial-validation`
Expected: FAIL — the template's default run function doesn't implement the rules.

- [ ] **Step 6: Implement the run function**

`extensions/serial-validation/src/cart_validations_generate_run.js`:

```js
// @ts-check
/**
 * @typedef {import("../generated/api").CartValidationsGenerateRunInput} CartValidationsGenerateRunInput
 * @typedef {import("../generated/api").CartValidationsGenerateRunResult} CartValidationsGenerateRunResult
 */

/**
 * Blocks checkout unless every line whose product carries the serial tag has
 * quantity 1, a non-empty "Serial Number" attribute, and a cart-unique serial.
 *
 * @param {CartValidationsGenerateRunInput} input
 * @returns {CartValidationsGenerateRunResult}
 */
export function cartValidationsGenerateRun(input) {
  const errors = [];
  const seen = new Set();

  for (const line of input.cart.lines) {
    if (line.merchandise.__typename !== "ProductVariant") continue;
    if (!line.merchandise.product.hasAnyTag) continue;

    const title = line.merchandise.product.title;
    const serial = line.serialNumber?.value?.trim();

    if (line.quantity !== 1) {
      errors.push({
        message: `Assign one serial number per unit of ${title} (tap the Serial numbers tile).`,
        target: "$.cart",
      });
      continue;
    }
    if (!serial) {
      errors.push({
        message: `Select a serial number for ${title} (tap the Serial numbers tile).`,
        target: "$.cart",
      });
      continue;
    }
    if (seen.has(serial)) {
      errors.push({
        message: `Serial number ${serial} is selected more than once in this cart.`,
        target: "$.cart",
      });
    }
    seen.add(serial);
  }

  return {operations: [{validationAdd: {errors}}]};
}
```

If the scaffold generated a different entrypoint filename or a default export wrapper, keep the scaffold's wiring and put this logic in the exported `cartValidationsGenerateRun`.

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run extensions/serial-validation`
Expected: 7 passed.

- [ ] **Step 8: Commit**

```bash
git add extensions/serial-validation
git commit -m "feat: cart/checkout validation function enforcing serial numbers"
```

---

### Task 3: SPIKE — verify the validation blocks POS checkout **[HUMAN]**

**Files:**
- Create: `docs/superpowers/notes/2026-07-pos-validation-spike.md`

**Interfaces:**
- Consumes: function handle `serial-validation` (Task 2).
- Produces: a written GO / NO-GO verdict on POS hard-blocking. NO-GO does not stop the plan — the tile/modal UX is the POS enforcement and the function still guards online channels — but the user must be told immediately.

This is the riskiest unknown in the project; Shopify does not document validation functions running on POS checkout. Do this before building the extension.

- [ ] **Step 1: Deploy** **[HUMAN — needs Partner auth]**

```bash
shopify app deploy
```

Expected: version created including the `serial-validation` function.

- [ ] **Step 2: Prepare a test product** **[HUMAN or via GraphiQL]**

On the dev store: create product "Spike Serial Test", any price, tag `serialized`, tracked SKU optional (not needed for this spike). Make it available to the POS sales channel.

- [ ] **Step 3: Activate the validation**

Start `shopify app dev`, open its GraphiQL (dev console → GraphiQL), and run:

```graphql
mutation {
  validationCreate(validation: {
    functionHandle: "serial-validation"
    enable: true
    blockOnFailure: true
    title: "Serial numbers required"
  }) {
    validation { id enabled blockOnFailure }
    userErrors { field message }
  }
}
```

Expected: `userErrors: []`, validation enabled. Also verify in the store admin: Settings → Checkout → Checkout Rules shows "Serial numbers required" active.

- [ ] **Step 4: Verify online blocking (control test)**

On the dev store's online storefront, add "Spike Serial Test" to the cart and attempt checkout.
Expected: checkout blocked with "Select a serial number for Spike Serial Test…". This proves the function itself works.

- [ ] **Step 5: Verify POS blocking (the actual spike)** **[HUMAN — needs POS app on device/simulator logged into the dev store]**

In Shopify POS: add "Spike Serial Test" to the cart, tap Checkout/Pay, attempt to complete the sale (use a cash payment).
Record exactly what happens: blocked with our message / blocked silently / sale completes.

- [ ] **Step 6: Write the verdict**

`docs/superpowers/notes/2026-07-pos-validation-spike.md` — record: date, POS app version, dev store, online result, POS result, screenshots if available, and the verdict:
- **GO**: POS blocked → hard-block requirement fully met.
- **NO-GO**: POS not blocked → POS enforcement is tile/modal UX only; function stays for online channels. **Report this to the user immediately** — the client chose hard-block deliberately.

- [ ] **Step 7: Commit**

```bash
git add docs/superpowers/notes
git commit -m "docs: record POS validation-function spike result"
```

---

### Task 4: Per-client configuration loader

**Files:**
- Create: `app/config.server.ts`
- Create: `.env.example`
- Test: `app/config.server.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `AppConfig` type and `loadConfig(env?): AppConfig`, `getConfig(): AppConfig` (memoized) — used by Tasks 6–8. Fields: `cin7AccountId: string`, `cin7ApplicationKey: string`, `serialTag: string`, `serialPropertyKey: string`, `locationMap: Record<string, string>` (Shopify numeric location ID as string → Cin7 location name).

- [ ] **Step 1: Write the failing tests**

`app/config.server.test.ts`:

```ts
import {describe, it, expect} from "vitest";
import {loadConfig} from "./config.server";

const BASE_ENV = {
  CIN7_ACCOUNT_ID: "acct-123",
  CIN7_APPLICATION_KEY: "key-456",
};

describe("loadConfig", () => {
  it("loads required Cin7 credentials", () => {
    const config = loadConfig(BASE_ENV);
    expect(config.cin7AccountId).toBe("acct-123");
    expect(config.cin7ApplicationKey).toBe("key-456");
  });

  it("throws when a required var is missing", () => {
    expect(() => loadConfig({CIN7_ACCOUNT_ID: "x"})).toThrow(/CIN7_APPLICATION_KEY/);
  });

  it("applies defaults for tag and property key", () => {
    const config = loadConfig(BASE_ENV);
    expect(config.serialTag).toBe("serialized");
    expect(config.serialPropertyKey).toBe("Serial Number");
  });

  it("parses the location map", () => {
    const config = loadConfig({...BASE_ENV, CIN7_LOCATION_MAP: '{"123":"Auckland Store"}'});
    expect(config.locationMap).toEqual({"123": "Auckland Store"});
  });

  it("defaults the location map to empty and rejects invalid JSON", () => {
    expect(loadConfig(BASE_ENV).locationMap).toEqual({});
    expect(() => loadConfig({...BASE_ENV, CIN7_LOCATION_MAP: "not json"})).toThrow(/CIN7_LOCATION_MAP/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run app/config.server.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`app/config.server.ts`:

```ts
export interface AppConfig {
  cin7AccountId: string;
  cin7ApplicationKey: string;
  serialTag: string;
  serialPropertyKey: string;
  /** Shopify numeric location ID (as string) → Cin7 location name */
  locationMap: Record<string, string>;
}

type EnvLike = Record<string, string | undefined>;

export function loadConfig(env: EnvLike = process.env): AppConfig {
  const required = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`Missing required env var ${name}`);
    return value;
  };

  let locationMap: Record<string, string> = {};
  if (env.CIN7_LOCATION_MAP) {
    try {
      locationMap = JSON.parse(env.CIN7_LOCATION_MAP);
    } catch {
      throw new Error("CIN7_LOCATION_MAP must be valid JSON ({\"<shopify location id>\": \"<Cin7 location name>\"})");
    }
  }

  return {
    cin7AccountId: required("CIN7_ACCOUNT_ID"),
    cin7ApplicationKey: required("CIN7_APPLICATION_KEY"),
    serialTag: env.SERIAL_TAG || "serialized",
    serialPropertyKey: env.SERIAL_PROPERTY_KEY || "Serial Number",
    locationMap,
  };
}

let cached: AppConfig | undefined;

export function getConfig(): AppConfig {
  if (!cached) cached = loadConfig();
  return cached;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run app/config.server.test.ts`
Expected: 5 passed.

- [ ] **Step 5: Create `.env.example`**

```bash
# Cin7 Core credentials (per client) — create at inventory.dearsystems.com/ExternalAPI
CIN7_ACCOUNT_ID=
CIN7_APPLICATION_KEY=
# Product tag marking serial-tracked products (default: serialized)
SERIAL_TAG=serialized
# Line item property key for the chosen serial (default: Serial Number)
SERIAL_PROPERTY_KEY=Serial Number
# Shopify location ID -> Cin7 location name, JSON
CIN7_LOCATION_MAP={"12345678":"Main Warehouse"}
```

- [ ] **Step 6: Commit**

```bash
git add app/config.server.ts app/config.server.test.ts .env.example
git commit -m "feat: per-client config loader for Cin7 credentials and mappings"
```

---

### Task 5: TTL cache and Cin7 HTTP client

**Files:**
- Create: `app/services/cache.server.ts`
- Create: `app/services/cin7.server.ts`
- Test: `app/services/cache.server.test.ts`, `app/services/cin7.server.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `TtlCache<V>` — `constructor(ttlMs: number, now?: () => number)`, `get(key: string): V | undefined`, `set(key: string, value: V): void`.
  - `Cin7AvailabilityRow` — `{ID, SKU, Name, Barcode, Location, Bin, Batch, ExpiryDate, OnHand, Allocated, Available, OnOrder, StockOnHand, InTransit, NextDeliveryDate}`.
  - `Cin7Error` — `error.code: "RATE_LIMITED" | "UNREACHABLE" | "AUTH_FAILED" | "BAD_RESPONSE"`.
  - `Cin7Client` — `constructor(accountId: string, applicationKey: string, fetchFn?: typeof fetch)`, `getAvailability(sku: string): Promise<Cin7AvailabilityRow[]>`, `skuExists(sku: string): Promise<boolean>`.

- [ ] **Step 1: Write the failing cache tests**

`app/services/cache.server.test.ts`:

```ts
import {describe, it, expect} from "vitest";
import {TtlCache} from "./cache.server";

describe("TtlCache", () => {
  it("returns stored values before expiry and undefined after", () => {
    let clock = 1000;
    const cache = new TtlCache<string>(500, () => clock);
    cache.set("k", "v");
    expect(cache.get("k")).toBe("v");
    clock = 1501;
    expect(cache.get("k")).toBeUndefined();
  });

  it("returns undefined for unknown keys", () => {
    const cache = new TtlCache<string>(500);
    expect(cache.get("missing")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run app/services/cache.server.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the cache**

`app/services/cache.server.ts`:

```ts
export class TtlCache<V> {
  private store = new Map<string, {value: V; expires: number}>();

  constructor(private ttlMs: number, private now: () => number = Date.now) {}

  get(key: string): V | undefined {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (this.now() > hit.expires) {
      this.store.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: V): void {
    this.store.set(key, {value, expires: this.now() + this.ttlMs});
  }
}
```

Run: `npx vitest run app/services/cache.server.test.ts` — expected: 2 passed.

- [ ] **Step 4: Write the failing Cin7 client tests**

`app/services/cin7.server.test.ts`:

```ts
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

  it("skuExists checks the product endpoint", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({Total: 1, Products: [{SKU: "WIDGET-001"}]}));
    const client = new Cin7Client("acct", "key", fetchFn);
    expect(await client.skuExists("WIDGET-001")).toBe(true);
    expect(fetchFn.mock.calls[0][0]).toContain("/ExternalApi/v2/product");
  });
});
```

- [ ] **Step 5: Run to verify failure**

Run: `npx vitest run app/services/cin7.server.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 6: Implement the client**

`app/services/cin7.server.ts`:

```ts
export interface Cin7AvailabilityRow {
  ID: string;
  SKU: string;
  Name: string;
  Barcode: string | null;
  Location: string;
  Bin: string | null;
  /** Batch OR serial number; null for non-tracked stock or unpicked allocations */
  Batch: string | null;
  ExpiryDate: string | null;
  OnHand: number;
  Allocated: number;
  Available: number;
  OnOrder: number;
  StockOnHand: number;
  InTransit: number;
  NextDeliveryDate: string | null;
}

export type Cin7ErrorCode = "RATE_LIMITED" | "UNREACHABLE" | "AUTH_FAILED" | "BAD_RESPONSE";

export class Cin7Error extends Error {
  constructor(public code: Cin7ErrorCode, message: string) {
    super(message);
    this.name = "Cin7Error";
  }
}

const BASE_URL = "https://inventory.dearsystems.com/ExternalApi/v2";

export class Cin7Client {
  constructor(
    private accountId: string,
    private applicationKey: string,
    private fetchFn: typeof fetch = fetch,
  ) {}

  private async get<T>(path: string, params: Record<string, string>): Promise<T> {
    const url = new URL(`${BASE_URL}/${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

    let response: Response;
    try {
      response = await this.fetchFn(url.toString(), {
        headers: {
          "api-auth-accountid": this.accountId,
          "api-auth-applicationkey": this.applicationKey,
          "Content-Type": "application/json",
        },
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

  async getAvailability(sku: string): Promise<Cin7AvailabilityRow[]> {
    const data = await this.get<{ProductAvailabilityList?: Cin7AvailabilityRow[]}>(
      "ref/productavailability",
      {Sku: sku, Page: "1", Limit: "1000"},
    );
    return data.ProductAvailabilityList ?? [];
  }

  async skuExists(sku: string): Promise<boolean> {
    const data = await this.get<{Products?: unknown[]}>("product", {Sku: sku, Page: "1", Limit: "1"});
    return (data.Products?.length ?? 0) > 0;
  }
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run app/services`
Expected: cache + cin7 suites pass (7 tests).

- [ ] **Step 8: Commit**

```bash
git add app/services/cache.server.ts app/services/cache.server.test.ts app/services/cin7.server.ts app/services/cin7.server.test.ts
git commit -m "feat: Cin7 Core client with rate-limit handling and TTL cache"
```

---

### Task 6: Serial grouping and lookup service

**Files:**
- Create: `app/services/serials.server.ts`
- Test: `app/services/serials.server.test.ts`

**Interfaces:**
- Consumes: `Cin7Client`, `Cin7AvailabilityRow`, `Cin7Error` (Task 5); `TtlCache` (Task 5); `getConfig` (Task 4).
- Produces:
  - `AvailableSerial` — `{serial: string; locationName: string; available: number; isCurrentLocation: boolean}`.
  - `SerialLookupResult` — `{status: "ok"; serials: AvailableSerial[]; currentLocationName: string | null} | {status: "sku_not_found"} | {status: "no_stock"}`.
  - `groupSerials(rows: Cin7AvailabilityRow[], currentLocationName: string | null): AvailableSerial[]` (pure).
  - `SerialService` — `constructor(client: Cin7Client, locationMap: Record<string, string>)`, `lookup(sku: string, shopifyLocationId: string): Promise<SerialLookupResult>` (throws `Cin7Error` on API failure).
  - `getSerialService(): SerialService` singleton.

- [ ] **Step 1: Write the failing tests**

`app/services/serials.server.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run app/services/serials.server.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`app/services/serials.server.ts`:

```ts
import {Cin7Client, type Cin7AvailabilityRow} from "./cin7.server";
import {TtlCache} from "./cache.server";
import {getConfig} from "../config.server";

export interface AvailableSerial {
  serial: string;
  locationName: string;
  available: number;
  isCurrentLocation: boolean;
}

export type SerialLookupResult =
  | {status: "ok"; serials: AvailableSerial[]; currentLocationName: string | null}
  | {status: "sku_not_found"}
  | {status: "no_stock"};

export function groupSerials(
  rows: Cin7AvailabilityRow[],
  currentLocationName: string | null,
): AvailableSerial[] {
  return rows
    .filter((r) => r.Batch !== null && r.Batch !== "" && r.Available > 0)
    .map((r) => ({
      serial: r.Batch as string,
      locationName: r.Location,
      available: r.Available,
      isCurrentLocation: r.Location === currentLocationName,
    }))
    .sort((a, b) => {
      if (a.isCurrentLocation !== b.isCurrentLocation) return a.isCurrentLocation ? -1 : 1;
      if (a.locationName !== b.locationName) return a.locationName.localeCompare(b.locationName);
      return a.serial.localeCompare(b.serial);
    });
}

const AVAILABILITY_TTL_MS = 45_000;
const SKU_EXISTS_TTL_MS = 10 * 60_000;

export class SerialService {
  private availabilityCache = new TtlCache<Cin7AvailabilityRow[]>(AVAILABILITY_TTL_MS);
  private skuExistsCache = new TtlCache<boolean>(SKU_EXISTS_TTL_MS);

  constructor(
    private client: Cin7Client,
    private locationMap: Record<string, string>,
  ) {}

  async lookup(sku: string, shopifyLocationId: string): Promise<SerialLookupResult> {
    let rows = this.availabilityCache.get(sku);
    if (!rows) {
      rows = await this.client.getAvailability(sku);
      this.availabilityCache.set(sku, rows);
    }

    const currentLocationName = this.locationMap[shopifyLocationId] ?? null;
    const serials = groupSerials(rows, currentLocationName);
    if (serials.length > 0) return {status: "ok", serials, currentLocationName};

    let exists = this.skuExistsCache.get(sku);
    if (exists === undefined) {
      exists = await this.client.skuExists(sku);
      this.skuExistsCache.set(sku, exists);
    }
    return exists ? {status: "no_stock"} : {status: "sku_not_found"};
  }
}

let singleton: SerialService | undefined;

export function getSerialService(): SerialService {
  if (!singleton) {
    const config = getConfig();
    singleton = new SerialService(
      new Cin7Client(config.cin7AccountId, config.cin7ApplicationKey),
      config.locationMap,
    );
  }
  return singleton;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run app/services/serials.server.test.ts`
Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add app/services/serials.server.ts app/services/serials.server.test.ts
git commit -m "feat: serial lookup service with location grouping and caching"
```

---

### Task 7: Product-tag helpers

**Files:**
- Create: `app/services/tags.server.ts`
- Test: `app/services/tags.server.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `toProductGid(productId: number): string`, `buildSerializedMap(nodes: Array<{id: string; tags: string[]} | null>, serialTag: string): Record<string, boolean>` (keys are numeric product IDs as strings) — used by Task 8.

- [ ] **Step 1: Write the failing tests**

`app/services/tags.server.test.ts`:

```ts
import {describe, it, expect} from "vitest";
import {toProductGid, buildSerializedMap} from "./tags.server";

describe("toProductGid", () => {
  it("converts a numeric product ID to an Admin GID", () => {
    expect(toProductGid(123456)).toBe("gid://shopify/Product/123456");
  });
});

describe("buildSerializedMap", () => {
  it("maps numeric ids to whether tags include the serial tag", () => {
    const nodes = [
      {id: "gid://shopify/Product/1", tags: ["serialized", "sale"]},
      {id: "gid://shopify/Product/2", tags: ["sale"]},
      null,
    ];
    expect(buildSerializedMap(nodes, "serialized")).toEqual({"1": true, "2": false});
  });

  it("respects a custom tag", () => {
    const nodes = [{id: "gid://shopify/Product/1", tags: ["track-serial"]}];
    expect(buildSerializedMap(nodes, "track-serial")).toEqual({"1": true});
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run app/services/tags.server.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`app/services/tags.server.ts`:

```ts
export function toProductGid(productId: number): string {
  return `gid://shopify/Product/${productId}`;
}

export function buildSerializedMap(
  nodes: Array<{id: string; tags: string[]} | null>,
  serialTag: string,
): Record<string, boolean> {
  const map: Record<string, boolean> = {};
  for (const node of nodes) {
    if (!node?.id) continue;
    const numericId = node.id.split("/").pop();
    if (!numericId) continue;
    map[numericId] = node.tags.includes(serialTag);
  }
  return map;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run app/services/tags.server.test.ts`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add app/services/tags.server.ts app/services/tags.server.test.ts
git commit -m "feat: product GID and serialized-map helpers"
```

---

### Task 8: Backend API routes for the POS extension

**Files:**
- Create: `app/routes/api.pos.serials.tsx`
- Create: `app/routes/api.pos.product-tags.tsx`

**Interfaces:**
- Consumes: `authenticate.public.pos` + `unauthenticated` from `app/shopify.server.ts` (template); `getSerialService`, `SerialLookupResult` (Task 6); `Cin7Error` (Task 5); `toProductGid`, `buildSerializedMap` (Task 7); `getConfig` (Task 4).
- Produces (contract for Tasks 10–13):
  - `GET /api/pos/serials?sku=<sku>&locationId=<id>` → 200 `SerialLookupResult` JSON, 400 `{error: "MISSING_SKU"}`, 502 `{error: Cin7ErrorCode}`.
  - `POST /api/pos/product-tags` body `{productIds: number[]}` → 200 `{serialized: Record<string, boolean>}`, 400 `{error: "INVALID_PRODUCT_IDS"}`.

All business logic was tested in Tasks 5–7; routes stay thin (auth + parse + delegate) and are verified live in Step 3 and again in Task 11's dev run.

- [ ] **Step 1: Implement the serials route**

`app/routes/api.pos.serials.tsx`:

```tsx
import {json, type LoaderFunctionArgs} from "@remix-run/node";
import {authenticate} from "../shopify.server";
import {getSerialService} from "../services/serials.server";
import {Cin7Error} from "../services/cin7.server";

export const loader = async ({request}: LoaderFunctionArgs) => {
  const {cors} = await authenticate.public.pos(request);

  const url = new URL(request.url);
  const sku = url.searchParams.get("sku");
  const locationId = url.searchParams.get("locationId") ?? "";
  if (!sku) return cors(json({error: "MISSING_SKU"}, {status: 400}));

  try {
    const result = await getSerialService().lookup(sku, locationId);
    return cors(json(result));
  } catch (error) {
    if (error instanceof Cin7Error) {
      return cors(json({error: error.code}, {status: 502}));
    }
    throw error;
  }
};
```

- [ ] **Step 2: Implement the product-tags route**

`app/routes/api.pos.product-tags.tsx`:

```tsx
import {json, type ActionFunctionArgs} from "@remix-run/node";
import {authenticate, unauthenticated} from "../shopify.server";
import {getConfig} from "../config.server";
import {toProductGid, buildSerializedMap} from "../services/tags.server";

export const action = async ({request}: ActionFunctionArgs) => {
  const {sessionToken, cors} = await authenticate.public.pos(request);

  const body = (await request.json().catch(() => null)) as {productIds?: unknown} | null;
  const productIds = body?.productIds;
  if (
    !Array.isArray(productIds) ||
    productIds.length === 0 ||
    productIds.length > 250 ||
    !productIds.every((id) => typeof id === "number")
  ) {
    return cors(json({error: "INVALID_PRODUCT_IDS"}, {status: 400}));
  }

  const shop = new URL(sessionToken.dest as string).hostname;
  const {admin} = await unauthenticated.admin(shop);

  const response = await admin.graphql(
    `#graphql
    query productTags($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on Product { id tags }
      }
    }`,
    {variables: {ids: productIds.map(toProductGid)}},
  );
  const {data} = await response.json();

  return cors(json({serialized: buildSerializedMap(data?.nodes ?? [], getConfig().serialTag)}));
};
```

Note: `authenticate.public.pos` exists in `@shopify/shopify-app-remix` v4 source (`server/authenticate/public/pos/`) though its docs page is unpublished. If the installed version doesn't expose it, check `authenticate.public` exports and report before improvising.

- [ ] **Step 3: Verify build + typecheck and smoke-test auth rejection**

Run: `npm run build`
Expected: clean build, no type errors.

Run (with `shopify app dev` running in another terminal):
`curl -s -o /dev/null -w "%{http_code}" http://localhost:PORT/api/pos/serials?sku=X` (use the dev server port)
Expected: 401/400-range rejection — proves the route exists and unauthenticated calls are refused. Full authenticated verification happens on-device in Task 11.

- [ ] **Step 4: Commit**

```bash
git add app/routes/api.pos.serials.tsx app/routes/api.pos.product-tags.tsx
git commit -m "feat: POS-authenticated API routes for serials and product tags"
```

---

### Task 9: Scaffold the POS UI extension

**Files:**
- Create: `extensions/pos-serials/` (via CLI)
- Modify: `extensions/pos-serials/shopify.extension.toml`
- Create: `extensions/pos-serials/src/Tile.tsx`, `extensions/pos-serials/src/Modal.tsx` (placeholders)

**Interfaces:**
- Consumes: nothing.
- Produces: extension handle `pos-serials` with working tile→modal wiring, replaced with real UI in Tasks 11–13.

- [ ] **Step 1: Scaffold**

```bash
shopify app generate extension
```

Select **POS smart grid** (or the closest "POS UI extension" entry), name it `pos-serials`. The scaffold creates a tile + modal pair.

- [ ] **Step 2: Confirm the TOML**

`extensions/pos-serials/shopify.extension.toml` must contain (adjust the generated file to match):

```toml
api_version = "2026-07"

[[extensions]]
type = "ui_extension"
name = "Serial numbers"
handle = "pos-serials"
description = "Assign Cin7 serial numbers to serialized products at POS"

  [[extensions.targeting]]
  target = "pos.home.tile.render"
  module = "./src/Tile.tsx"

  [[extensions.targeting]]
  target = "pos.home.modal.render"
  module = "./src/Modal.tsx"
```

Keep any generated `uid` line.

- [ ] **Step 3: Placeholder components**

`extensions/pos-serials/src/Tile.tsx`:

```tsx
import {render} from "preact";

export default async () => {
  render(<Tile />, document.body);
};

function Tile() {
  return (
    <s-tile
      heading="Serial numbers"
      subheading="Placeholder"
      onClick={() => shopify.action.presentModal()}
    />
  );
}
```

`extensions/pos-serials/src/Modal.tsx`:

```tsx
import {render} from "preact";

export default async () => {
  render(<Modal />, document.body);
};

function Modal() {
  return (
    <s-page heading="Serial numbers">
      <s-text>Placeholder</s-text>
    </s-page>
  );
}
```

- [ ] **Step 4: Verify in dev** **[HUMAN — needs POS app/simulator]**

Run: `shopify app dev`, open POS on the dev store, add the tile to the smart grid (Settings → Smart grid → Add tile), tap it.
Expected: tile renders "Serial numbers / Placeholder"; tapping opens the placeholder modal.

- [ ] **Step 5: Commit**

```bash
git add extensions/pos-serials
git commit -m "feat: scaffold POS UI extension with tile and modal targets"
```

---

### Task 10: Extension pure logic library

**Files:**
- Create: `extensions/pos-serials/src/lib/serials.ts`
- Test: `extensions/pos-serials/src/lib/serials.test.ts`

**Interfaces:**
- Consumes: nothing (pure; mirrors `AvailableSerial` from the backend contract in Task 6/8).
- Produces (used by Tasks 11–13):
  - `SERIAL_PROPERTY_KEY = "Serial Number"`.
  - `CartLineLike` — `{uuid: string; quantity: number; productId: number; variantId: number; sku: string; title: string; properties: Record<string, string>}`.
  - `AvailableSerial` — `{serial: string; locationName: string; available: number; isCurrentLocation: boolean}`.
  - `serializedLines<T extends CartLineLike>(lines: T[], serializedMap: Record<string, boolean>): T[]`.
  - `unitsNeedingSerial(lines: CartLineLike[], serializedMap: Record<string, boolean>): number`.
  - `excludeInCart(serials: AvailableSerial[], lines: CartLineLike[], exceptUuid?: string): AvailableSerial[]`.
  - `matchScan(serials: AvailableSerial[], scanned: string): AvailableSerial | undefined`.

- [ ] **Step 1: Write the failing tests**

`extensions/pos-serials/src/lib/serials.test.ts`:

```ts
import {describe, it, expect} from "vitest";
import {
  SERIAL_PROPERTY_KEY,
  serializedLines,
  unitsNeedingSerial,
  excludeInCart,
  matchScan,
  type CartLineLike,
  type AvailableSerial,
} from "./serials";

function cartLine(overrides: Partial<CartLineLike> = {}): CartLineLike {
  return {
    uuid: "u1", quantity: 1, productId: 1, variantId: 11,
    sku: "WIDGET-001", title: "Widget", properties: {},
    ...overrides,
  };
}

function serial(value: string, overrides: Partial<AvailableSerial> = {}): AvailableSerial {
  return {serial: value, locationName: "Auckland", available: 1, isCurrentLocation: true, ...overrides};
}

const MAP = {"1": true, "2": false};

describe("serializedLines", () => {
  it("keeps only lines whose product is serialized", () => {
    const lines = [cartLine({productId: 1}), cartLine({uuid: "u2", productId: 2})];
    expect(serializedLines(lines, MAP).map((l) => l.uuid)).toEqual(["u1"]);
  });
});

describe("unitsNeedingSerial", () => {
  it("counts full quantity for lines without a serial", () => {
    expect(unitsNeedingSerial([cartLine({quantity: 3})], MAP)).toBe(3);
  });

  it("counts zero for a qty-1 line with a serial property", () => {
    const satisfied = cartLine({properties: {[SERIAL_PROPERTY_KEY]: "SN-1"}});
    expect(unitsNeedingSerial([satisfied], MAP)).toBe(0);
  });

  it("still counts a qty>1 line that somehow has a serial (needs splitting)", () => {
    const odd = cartLine({quantity: 2, properties: {[SERIAL_PROPERTY_KEY]: "SN-1"}});
    expect(unitsNeedingSerial([odd], MAP)).toBe(2);
  });

  it("ignores non-serialized lines", () => {
    expect(unitsNeedingSerial([cartLine({productId: 2, quantity: 5})], MAP)).toBe(0);
  });
});

describe("excludeInCart", () => {
  it("removes serials already assigned to other lines", () => {
    const lines = [cartLine({uuid: "other", properties: {[SERIAL_PROPERTY_KEY]: "SN-1"}})];
    const result = excludeInCart([serial("SN-1"), serial("SN-2")], lines);
    expect(result.map((s) => s.serial)).toEqual(["SN-2"]);
  });

  it("does not exclude the serial on the line being edited", () => {
    const lines = [cartLine({uuid: "editing", properties: {[SERIAL_PROPERTY_KEY]: "SN-1"}})];
    const result = excludeInCart([serial("SN-1")], lines, "editing");
    expect(result.map((s) => s.serial)).toEqual(["SN-1"]);
  });
});

describe("matchScan", () => {
  const candidates = [serial("SN-ABC-123")];

  it("matches exactly, ignoring surrounding whitespace and case", () => {
    expect(matchScan(candidates, " sn-abc-123 ")?.serial).toBe("SN-ABC-123");
  });

  it("returns undefined for non-matches and empty scans", () => {
    expect(matchScan(candidates, "SN-ABC")).toBeUndefined();
    expect(matchScan(candidates, "  ")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run extensions/pos-serials`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`extensions/pos-serials/src/lib/serials.ts`:

```ts
export const SERIAL_PROPERTY_KEY = "Serial Number";

export interface CartLineLike {
  uuid: string;
  quantity: number;
  productId: number;
  variantId: number;
  sku: string;
  title: string;
  properties: Record<string, string>;
}

export interface AvailableSerial {
  serial: string;
  locationName: string;
  available: number;
  isCurrentLocation: boolean;
}

export function serializedLines<T extends CartLineLike>(
  lines: T[],
  serializedMap: Record<string, boolean>,
): T[] {
  return lines.filter((line) => serializedMap[String(line.productId)]);
}

export function unitsNeedingSerial(
  lines: CartLineLike[],
  serializedMap: Record<string, boolean>,
): number {
  return serializedLines(lines, serializedMap).reduce((sum, line) => {
    const satisfied =
      line.quantity === 1 && Boolean(line.properties[SERIAL_PROPERTY_KEY]?.trim());
    return sum + (satisfied ? 0 : line.quantity);
  }, 0);
}

function serialsInCart(lines: CartLineLike[], exceptUuid?: string): Set<string> {
  const taken = new Set<string>();
  for (const line of lines) {
    if (line.uuid === exceptUuid) continue;
    const value = line.properties[SERIAL_PROPERTY_KEY]?.trim();
    if (value) taken.add(value);
  }
  return taken;
}

export function excludeInCart(
  serials: AvailableSerial[],
  lines: CartLineLike[],
  exceptUuid?: string,
): AvailableSerial[] {
  const taken = serialsInCart(lines, exceptUuid);
  return serials.filter((s) => !taken.has(s.serial));
}

export function matchScan(
  serials: AvailableSerial[],
  scanned: string,
): AvailableSerial | undefined {
  const needle = scanned.trim().toLowerCase();
  if (!needle) return undefined;
  return serials.find((s) => s.serial.trim().toLowerCase() === needle);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run extensions/pos-serials`
Expected: 10 passed.

- [ ] **Step 5: Commit**

```bash
git add extensions/pos-serials/src/lib
git commit -m "feat: pure cart/serial logic for the POS extension"
```

---

### Task 11: Backend fetch helpers and the real tile

**Files:**
- Create: `extensions/pos-serials/src/lib/api.ts`
- Modify: `extensions/pos-serials/src/Tile.tsx`

**Interfaces:**
- Consumes: routes from Task 8 (relative URLs — POS auto-attaches auth headers and resolves against `application_url`); `unitsNeedingSerial` (Task 10); `shopify.cart.current`, `shopify.session.currentSession`, `shopify.action.presentModal` (POS APIs).
- Produces (used by Tasks 12–13):
  - `fetchSerializedMap(productIds: number[]): Promise<Record<string, boolean>>` (module-level cache; throws on HTTP error).
  - `SerialLookup` — backend `SerialLookupResult` plus `{status: "error"; code: string}`.
  - `fetchSerials(sku: string): Promise<SerialLookup>` (never throws; folds failures into `status: "error"`).

- [ ] **Step 1: Implement the API helpers**

`extensions/pos-serials/src/lib/api.ts`:

```ts
import type {AvailableSerial} from "./serials";

const tagCache = new Map<string, boolean>();

export async function fetchSerializedMap(
  productIds: number[],
): Promise<Record<string, boolean>> {
  const unknown = [...new Set(productIds)].filter((id) => !tagCache.has(String(id)));
  if (unknown.length > 0) {
    const response = await fetch("/api/pos/product-tags", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({productIds: unknown}),
    });
    if (!response.ok) throw new Error(`product-tags request failed: ${response.status}`);
    const {serialized} = (await response.json()) as {serialized: Record<string, boolean>};
    for (const [id, value] of Object.entries(serialized)) tagCache.set(id, Boolean(value));
  }
  const map: Record<string, boolean> = {};
  for (const id of productIds) map[String(id)] = tagCache.get(String(id)) ?? false;
  return map;
}

export type SerialLookup =
  | {status: "ok"; serials: AvailableSerial[]; currentLocationName: string | null}
  | {status: "sku_not_found"}
  | {status: "no_stock"}
  | {status: "error"; code: string};

export async function fetchSerials(sku: string): Promise<SerialLookup> {
  try {
    const locationId = shopify.session.currentSession.locationId;
    const response = await fetch(
      `/api/pos/serials?sku=${encodeURIComponent(sku)}&locationId=${locationId}`,
    );
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {error?: string};
      return {status: "error", code: body.error ?? `HTTP_${response.status}`};
    }
    return (await response.json()) as SerialLookup;
  } catch {
    return {status: "error", code: "NETWORK"};
  }
}
```

- [ ] **Step 2: Implement the tile**

`extensions/pos-serials/src/Tile.tsx`:

```tsx
import {render} from "preact";
import {useEffect, useState} from "preact/hooks";
import "@shopify/ui-extensions/preact";
import {unitsNeedingSerial} from "./lib/serials";
import {fetchSerializedMap} from "./lib/api";

export default async () => {
  render(<Tile />, document.body);
};

interface TileState {
  needed: number;
  hasSerialized: boolean;
  error: boolean;
}

function Tile() {
  const [state, setState] = useState<TileState>({needed: 0, hasSerialized: false, error: false});

  useEffect(() => {
    let cancelled = false;

    async function evaluate(cart: typeof shopify.cart.current.value) {
      try {
        const map = await fetchSerializedMap(cart.lineItems.map((l) => l.productId));
        if (cancelled) return;
        setState({
          needed: unitsNeedingSerial(cart.lineItems, map),
          hasSerialized: cart.lineItems.some((l) => map[String(l.productId)]),
          error: false,
        });
      } catch {
        // Fail visible: a backend blip must not hide the workflow.
        if (!cancelled) setState({needed: 0, hasSerialized: true, error: true});
      }
    }

    evaluate(shopify.cart.current.value);
    const unsubscribe = shopify.cart.current.subscribe(evaluate);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const {needed, hasSerialized, error} = state;
  const subheading = error
    ? "Check serials"
    : !hasSerialized
      ? "No serialized items"
      : needed > 0
        ? `${needed} serial${needed === 1 ? "" : "s"} needed`
        : "Serials complete";

  return (
    <s-tile
      heading="Serial numbers"
      subheading={subheading}
      {...(needed > 0 ? {itemCount: needed} : {})}
      tone={needed > 0 || error ? "accent" : "neutral"}
      disabled={!hasSerialized && !error}
      onClick={() => shopify.action.presentModal()}
    />
  );
}
```

- [ ] **Step 3: Run all tests + build**

Run: `npm test && npm run build`
Expected: all suites pass; build clean.

- [ ] **Step 4: Verify on device** **[HUMAN]**

With `shopify app dev` running and the dev store carrying one `serialized`-tagged product (from Task 3) plus one untagged product:
- Empty cart → tile disabled, "No serialized items".
- Add untagged product → still disabled.
- Add tagged product → tile accent, "1 serial needed", itemCount 1.
- Set its quantity to 3 → "3 serials needed".

- [ ] **Step 5: Commit**

```bash
git add extensions/pos-serials/src
git commit -m "feat: live tile with serialized-count badge and backend tag lookup"
```

---

### Task 12: Modal — line list and serial picker screens

**Files:**
- Modify: `extensions/pos-serials/src/Modal.tsx`
- Create: `extensions/pos-serials/src/screens/LineList.tsx`
- Create: `extensions/pos-serials/src/screens/SerialPicker.tsx` (list/search/error states; scanning and saving added in Task 13)

**Interfaces:**
- Consumes: `fetchSerializedMap`, `fetchSerials`, `SerialLookup` (Task 11); `serializedLines`, `excludeInCart`, `SERIAL_PROPERTY_KEY`, `CartLineLike` (Task 10); `shopify.cart.current` (POS API).
- Produces: `LineList({cart, onPick: (lineUuid: string) => void})`, `SerialPicker({line, cart, onDone: () => void, onChoose: (serial: string) => Promise<void>})` — `onChoose` is wired to real cart writes in Task 13.

Screen navigation uses plain component state (not the POS navigation API) — fewer moving parts and every render reads live cart state, which satisfies the spec's "recompute on focus" rule.

- [ ] **Step 1: Implement the modal root**

`extensions/pos-serials/src/Modal.tsx`:

```tsx
import {render} from "preact";
import {useEffect, useState} from "preact/hooks";
import "@shopify/ui-extensions/preact";
import {LineList} from "./screens/LineList";
import {SerialPicker} from "./screens/SerialPicker";
import {SERIAL_PROPERTY_KEY} from "./lib/serials";

type Screen = {name: "lines"} | {name: "picker"; lineUuid: string};

export default async () => {
  render(<Modal />, document.body);
};

function Modal() {
  const [cart, setCart] = useState(shopify.cart.current.value);
  const [screen, setScreen] = useState<Screen>({name: "lines"});
  const [saving, setSaving] = useState(false);

  useEffect(() => shopify.cart.current.subscribe(setCart), []);

  const line =
    screen.name === "picker"
      ? cart.lineItems.find((l) => l.uuid === screen.lineUuid)
      : undefined;

  if (screen.name === "picker" && line) {
    return (
      <SerialPicker
        line={line}
        cart={cart}
        onDone={() => setScreen({name: "lines"})}
        onChoose={async (serial) => {
          if (saving) return;
          setSaving(true);
          try {
            if (line.quantity === 1) {
              await shopify.cart.addLineItemProperties(line.uuid, {
                [SERIAL_PROPERTY_KEY]: serial,
              });
            } else {
              // Split: this unit gets the serial at add time (keeps lines distinct);
              // the remainder stays serial-less for subsequent picks.
              await shopify.cart.removeLineItem(line.uuid);
              await shopify.cart.addLineItem(line.variantId, 1, {
                properties: {[SERIAL_PROPERTY_KEY]: serial},
              });
              await shopify.cart.addLineItem(line.variantId, line.quantity - 1);
            }
            shopify.toast.show(`Serial ${serial} assigned`);
            setScreen({name: "lines"});
          } catch {
            shopify.toast.show("Couldn't save the serial — try again");
          } finally {
            setSaving(false);
          }
        }}
      />
    );
  }

  // Also lands here if the picked line disappeared from the cart mid-flow.
  return <LineList cart={cart} onPick={(lineUuid) => setScreen({name: "picker", lineUuid})} />;
}
```

- [ ] **Step 2: Implement the line list screen**

`extensions/pos-serials/src/screens/LineList.tsx`:

```tsx
import {useEffect, useState} from "preact/hooks";
import {fetchSerializedMap} from "../lib/api";
import {SERIAL_PROPERTY_KEY, serializedLines, type CartLineLike} from "../lib/serials";

interface Props {
  cart: {lineItems: CartLineLike[]};
  onPick: (lineUuid: string) => void;
}

export function LineList({cart, onPick}: Props) {
  const [map, setMap] = useState<Record<string, boolean> | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchSerializedMap(cart.lineItems.map((l) => l.productId))
      .then((m) => {
        if (!cancelled) {
          setMap(m);
          setError(false);
        }
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [cart]);

  if (error) {
    return (
      <s-page heading="Serial numbers">
        <s-banner tone="critical" heading="Couldn't load product data">
          Check the connection, then close and reopen this screen.
        </s-banner>
      </s-page>
    );
  }
  if (!map) {
    return (
      <s-page heading="Serial numbers">
        <s-spinner />
      </s-page>
    );
  }

  const lines = serializedLines(cart.lineItems, map);
  return (
    <s-page heading="Serial numbers">
      <s-scroll-box>
        <s-section heading="Serialized items in cart">
          {lines.length === 0 && <s-text>No serialized products in the cart.</s-text>}
          {lines.map((line) => {
            const serial =
              line.quantity === 1 ? line.properties[SERIAL_PROPERTY_KEY] : undefined;
            return (
              <s-clickable key={line.uuid} onClick={() => onPick(line.uuid)}>
                <s-stack direction="inline" gap="base">
                  <s-stack direction="block">
                    <s-text>{line.title}</s-text>
                    <s-text>{`${line.sku} · qty ${line.quantity}`}</s-text>
                  </s-stack>
                  <s-badge tone={serial ? "success" : "critical"}>
                    {serial ?? "Needs serial"}
                  </s-badge>
                </s-stack>
              </s-clickable>
            );
          })}
        </s-section>
      </s-scroll-box>
    </s-page>
  );
}
```

- [ ] **Step 3: Implement the picker screen (no scanner yet)**

`extensions/pos-serials/src/screens/SerialPicker.tsx`:

```tsx
import {useEffect, useState} from "preact/hooks";
import {fetchSerials, type SerialLookup} from "../lib/api";
import {excludeInCart, type CartLineLike} from "../lib/serials";

interface Props {
  line: CartLineLike;
  cart: {lineItems: CartLineLike[]};
  onDone: () => void;
  onChoose: (serial: string) => Promise<void>;
}

export function SerialPicker({line, cart, onDone, onChoose}: Props) {
  const [result, setResult] = useState<SerialLookup | null>(null);
  const [query, setQuery] = useState("");

  const load = () => {
    setResult(null);
    fetchSerials(line.sku).then(setResult);
  };
  useEffect(load, [line.sku]);

  if (!result) {
    return (
      <s-page heading={line.title}>
        <s-spinner />
      </s-page>
    );
  }

  if (result.status === "error") {
    return (
      <s-page heading={line.title}>
        <s-banner tone="critical" heading="Can't reach Cin7">
          Serial numbers are unavailable right now ({result.code}).
        </s-banner>
        <s-button onClick={load}>Retry</s-button>
        <s-button onClick={onDone}>Back</s-button>
      </s-page>
    );
  }
  if (result.status === "sku_not_found") {
    return (
      <s-page heading={line.title}>
        <s-banner tone="critical" heading="SKU not found in Cin7">
          {`${line.sku} doesn't match any Cin7 product. Fix the SKU mapping before selling this item.`}
        </s-banner>
        <s-button onClick={onDone}>Back</s-button>
      </s-page>
    );
  }
  if (result.status === "no_stock") {
    return (
      <s-page heading={line.title}>
        <s-banner heading="No serials in stock">
          {`Cin7 has no available serial numbers for ${line.sku} at any location.`}
        </s-banner>
        <s-button onClick={onDone}>Back</s-button>
      </s-page>
    );
  }

  const candidates = excludeInCart(result.serials, cart.lineItems, line.uuid);
  const visible = query
    ? candidates.filter((s) => s.serial.toLowerCase().includes(query.toLowerCase()))
    : candidates;
  const current = visible.filter((s) => s.isCurrentLocation);
  const others = visible.filter((s) => !s.isCurrentLocation);
  const otherLocations = [...new Set(others.map((s) => s.locationName))];

  return (
    <s-page heading={line.title}>
      <s-scroll-box>
        <s-section>
          <s-search-field
            placeholder="Search serial numbers"
            value={query}
            onInput={(e: {currentTarget: {value: string}}) => setQuery(e.currentTarget.value)}
          />
        </s-section>
        <s-section
          heading={
            result.currentLocationName
              ? `This store — ${result.currentLocationName}`
              : "This store"
          }
        >
          {current.length === 0 && <s-text>No serials at this location.</s-text>}
          {current.map((s) => (
            <s-clickable key={s.serial} onClick={() => onChoose(s.serial)}>
              <s-text>{s.serial}</s-text>
            </s-clickable>
          ))}
        </s-section>
        {otherLocations.map((location) => (
          <s-section key={location} heading={location}>
            {others
              .filter((s) => s.locationName === location)
              .map((s) => (
                <s-clickable key={s.serial} onClick={() => onChoose(s.serial)}>
                  <s-text>{s.serial}</s-text>
                </s-clickable>
              ))}
          </s-section>
        ))}
        <s-button onClick={onDone}>Back</s-button>
      </s-scroll-box>
    </s-page>
  );
}
```

Component-prop caveat: `s-badge`/`s-text` `tone` values and `s-stack` gap tokens weren't fully enumerated in research. If TypeScript rejects a prop, consult the component's page under https://shopify.dev/docs/api/pos-ui-extensions/latest/web-components and use the documented equivalent — do not remove the semantic (status color, spacing), find the supported prop for it.

- [ ] **Step 4: Run tests + build**

Run: `npm test && npm run build`
Expected: all pass; clean build.

- [ ] **Step 5: Verify on device** **[HUMAN]**

Needs Cin7 sandbox with a serial-tracked product whose SKU matches the dev store's tagged product, stocked with ≥3 serials across ≥2 locations, and `CIN7_LOCATION_MAP` mapping the dev store's location. Then:
- Tap tile → line list shows the tagged line with "Needs serial".
- Tap line → serials listed, current store's section first, other location(s) beneath.
- Search narrows the list.
- Tap a serial → toast, back on line list, badge now shows the serial; tile flips to "Serials complete".
- With qty 2: picking one serial splits the line (one qty-1 line with serial + one qty-1 remainder); pick the second serial; the first serial no longer appears in the picker. **Record whether the remainder line stayed separate (auto-merge check from the spec).**
- Stop the backend (`Ctrl-C` on `shopify app dev`) → picker shows "Can't reach Cin7" with Retry.

- [ ] **Step 6: Commit**

```bash
git add extensions/pos-serials/src
git commit -m "feat: modal line list and location-grouped serial picker with save/split"
```

---

### Task 13: Barcode scanning in the picker

**Files:**
- Modify: `extensions/pos-serials/src/screens/SerialPicker.tsx`

**Interfaces:**
- Consumes: `shopify.scanner.scannerData.current.subscribe`, `shopify.scanner.showCameraScanner()`, `shopify.scanner.hideCameraScanner()` (POS Scanner API — modal target only); `matchScan` (Task 10, already tested).
- Produces: scan-to-select behavior; no new exports.

- [ ] **Step 1: Add scanner wiring**

In `SerialPicker.tsx`, add `matchScan` to the existing `../lib/serials` import, then add inside the component (after the `load` effect):

```tsx
useEffect(() => {
  const unsubscribe = shopify.scanner.scannerData.current.subscribe((scan) => {
    if (!scan.data) return;
    if (!result || result.status !== "ok") return;
    const candidates = excludeInCart(result.serials, cart.lineItems, line.uuid);
    const hit = matchScan(candidates, scan.data);
    if (hit) {
      onChoose(hit.serial);
    } else {
      shopify.toast.show(`${scan.data} is not in available stock`);
    }
  });
  return () => {
    unsubscribe();
    shopify.scanner.hideCameraScanner();
  };
}, [result, cart, line.uuid]);
```

And add a scan button next to the search field (inside the first `<s-section>`):

```tsx
<s-button onClick={() => shopify.scanner.showCameraScanner()}>Scan barcode</s-button>
```

- [ ] **Step 2: Run tests + build**

Run: `npm test && npm run build`
Expected: all pass.

- [ ] **Step 3: Verify on device** **[HUMAN]**

- Tap "Scan barcode", scan a barcode encoding an available serial (generate one at e.g. barcode.tec-it.com from the serial string) → serial saves immediately, toast confirms.
- Scan a random other barcode → toast "… is not in available stock", nothing saved.
- If a hardware scanner is available: scanning without opening the camera also works (external scans flow through the same signal).

- [ ] **Step 4: Commit**

```bash
git add extensions/pos-serials/src/screens/SerialPicker.tsx
git commit -m "feat: scan-to-select serials via POS scanner API"
```

---

### Task 14: README and per-client rollout runbook

**Files:**
- Create/replace: `README.md`

**Interfaces:**
- Consumes: everything above (documents it).
- Produces: the operational doc Techweave uses per client.

- [ ] **Step 1: Write the README**

Replace the template README with sections (write real content, using the exact values from this plan and `.env.example`):

1. **What this app does** — the one-paragraph flow from the spec.
2. **Architecture** — the four parts + repo layout (mirror the file-structure block above).
3. **Environment variables** — table of the five vars from `.env.example` with descriptions and where to obtain each (Cin7: `inventory.dearsystems.com/ExternalAPI`; location IDs: Shopify admin → Settings → Locations, ID from the URL).
4. **Local development** — `npm install`, `.env` from `.env.example`, `shopify app dev`, POS dev-mode notes, `npm test`.
5. **Per-client rollout checklist**:
   - Create the client's app in the Partner org; set distribution to custom; install on the client store.
   - Create a Cin7 application key; fill env vars; build `CIN7_LOCATION_MAP` for every POS location.
   - If the client's serial tag isn't `serialized`: set `SERIAL_TAG` **and** edit the tag literal in `extensions/serial-validation/src/cart_validations_generate_run.graphql`.
   - Tag serialized products; confirm SKUs match Cin7 exactly.
   - `shopify app deploy`; activate the validation via this Admin GraphQL mutation (run from the app's GraphiQL during `shopify app dev`):

     ```graphql
     mutation {
       validationCreate(validation: {
         functionHandle: "serial-validation"
         enable: true
         blockOnFailure: true
         title: "Serial numbers required"
       }) {
         validation { id enabled blockOnFailure }
         userErrors { field message }
       }
     }
     ```
   - Devices: Shopify POS ≥ 10.6.0; add the tile to the smart grid on each register.
6. **Acceptance checklist** (from the spec): scan-to-select, qty split, blocked checkout message (per spike verdict), other-location selection, Cin7-down behavior.
7. **Known limitations**: Cin7 outage blocks serialized checkout (if spike = GO); 45-second staleness window between stores; serials are not reserved until sale completes; phase 2 (merging the standalone allocation service) is out of scope — link the spec.

- [ ] **Step 2: Verify commands in the README are real**

Run each command quoted in the README that can run locally (`npm test`, `npm run build`).
Expected: all succeed.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: README with per-client rollout runbook and acceptance checklist"
```

---

## Spec coverage map

| Spec requirement | Task(s) |
|---|---|
| 1. Tile highlights + count | 10, 11 |
| 2. Modal lists serialized lines + status | 12 |
| 3. Cin7 lookup, all locations, current first | 5, 6, 8, 12 |
| 4. Tap / search / scan selection | 12, 13 |
| 5. Serial saved as line property | 12 |
| 6. One serial per unit (split) | 12 |
| 7. Hard-block checkout (3 rules; POS spike) | 2, 3 |
| 8. In-cart serials excluded | 10, 12 |
| Error handling (Cin7 down, SKU mismatch, no stock, tag-lookup fail, scan miss, mid-flow changes) | 6, 8, 11, 12, 13 |
| Per-client config | 4, 14 |
| Testing (unit / integration / acceptance) | every task / 9, 11–13 / 14 |
