# Serial Features v2 — Product Details Lookup & Serial Transform — Design

**Date:** 2026-09-15
**Status:** Approved (built unattended per explicit user authorisation)
**Owner:** Techweave (Adam Stead)

## Overview

Two features on top of the shipped POS serial-number app.

**Feature 1 — serial lookup on the POS product details screen.** Staff viewing a
product in POS can open a modal listing that product's available serial numbers and
the locations holding them — the same information the sale-assignment picker shows,
but read-only and outside any cart context.

**Feature 2 — serial transform.** When a boxed unit is assembled, its serial gains an
`A-` prefix (`BIKE001` → `A-BIKE001`). Staff perform this in POS; the backend expresses
it in Cin7 Core as a single stock adjustment that writes the old serial's quantity to
zero and brings the new serial in at the same location and cost. The reverse
(un-transform, stripping `A-`) is also supported.

## Decisions taken

Answered by the user 2026-09-15 before implementation:

| Question | Decision |
|---|---|
| Is the assembled unit a different SKU? | **No.** Same product and SKU in both Shopify and Cin7. Only the serial string changes. |
| Where does the transform UI live? | **POS extension.** Not the embedded admin app. |
| Feature 1 presentation | **Tap to open a modal**, not an auto-loading inline block — avoids a Cin7 call every time any staff member opens any serialised product. |
| Batch or single? | **One serial at a time.** |
| Prefix rule | **Fixed `A-`**, and a re-transform is **blocked** — refuse if the serial already starts with `A-`. |
| Reversal | **In scope.** An un-transform strips the prefix; refuse if the serial doesn't carry it. |
| Partial failure | **Stop and show a loud error** naming the affected serial. No auto-retry, no automatic rollback. |
| Audit trail | **Cin7's own adjustment history.** No in-app log — that would reintroduce the database removed in `9c8e45c`. |

## Context

- The backend currently exposes exactly one route, `GET /api/pos/serials`, which
  proxies Cin7 because the Cin7 application key must never reach the device-readable
  extension bundle. There is no database; sessions are in-process.
- `Cin7Client` (`app/services/cin7.server.ts`) is **read-only** — two GET methods, a
  private `get<T>()` helper, no POST, no retry, no timeout.
- The extension reads Shopify product tags on-device via POS direct API access. Cin7
  can never be reached that way, so Feature 2 needs a backend route.
- Cin7 Core allows ~60 API calls/minute per application key.

## Feature 1 — Serials on the product details screen

### Targets

Two new entries in the existing `[[extensions]]` block of
`extensions/pos-serials/shopify.extension.toml` — same extension registration, same
`uid`, no new Shopify scope (`read_products` already covers it):

| Target | Module |
|---|---|
| `pos.product-details.action.menu-item.render` | `./src/ProductMenuItem.tsx` |
| `pos.product-details.action.render` | `./src/ProductModal.tsx` |

**A target maps to exactly one module**, so Features 1 and 2 share these two. The menu
item presents both actions ("View serial numbers" and "Transform serial"); the modal
routes between the two screens internally, exactly as the existing `Modal.tsx` routes
between `LineList` and `SerialPicker`. The routing state lives in `ProductModal.tsx`.

### Data path

Confirmed against the installed `@shopify/ui-extensions` types:

```
shopify.product.variantId                                    (ProductApi)
  → shopify.productSearch.fetchProductVariantWithId(variantId) → .sku    (on-device)
  → GET /api/pos/serials?sku=…&locationId=…                    (existing, unchanged)
```

`ActionTargetApi = {…} & StandardApi & ScannerApi`, and `StandardApi` bundles
`SessionApi` + `ProductSearchApi`, so both targets have everything needed.

**No backend change.** `SerialService.lookup()` is already context-agnostic.

### Component structure

`SerialPicker.tsx` mixes presentation with cart mutation. Extract the presentational
half so both screens share it rather than forking it:

- **New** `src/screens/SerialList.tsx` — pure presentation. Props: `state`
  (`SerialLookup`), `onRetry`, and an optional `onSelect`. Renders the loading /
  error / `sku_not_found` / `no_stock` states, the search field, and the
  location-sectioned list (current location first). No cart awareness.
- `SerialPicker.tsx` keeps `excludeInCart`, the `onChoose` cart wiring, and the
  scanner auto-select effect, and renders `SerialList` for the list itself.
- `screens/ProductSerials.tsx` renders `SerialList` with **no** `onSelect` — read-only.

`ProductVariant.sku` is `sku?: string`. A variant with no SKU gets an explicit
"No SKU set for this variant" state, not a failed lookup.

## Feature 2 — Serial transform

### Cin7 mechanism

A **single** `POST /stockadjustment` containing both lines. One document is one atomic
write, which removes the partial-failure window a two-document design would create.

```json
{
  "EffectiveDate": "<now, ISO 8601>",
  "Status": "COMPLETED",
  "Reference": "<deterministic dedupe token>",
  "Comment": "Assembled BIKE001 -> A-BIKE001",
  "UpdateOnHand": true,
  "Lines": [
    {"SKU": "BIKE", "BatchSN": "BIKE001",   "Quantity": 0, "UnitCost": <cost>, "Location": "Main Warehouse"},
    {"SKU": "BIKE", "BatchSN": "A-BIKE001", "Quantity": 1, "UnitCost": <cost>, "Location": "Main Warehouse"}
  ]
}
```

Critical API details, all verified against the API Blueprint
(`https://jsapi.apiary.io/apis/dearinventory.apib`, lastUpdated 2026-04-27):

- **`Quantity` is an absolute target, not a delta** — "New value for QuantityOnHand".
  Zeroing the old serial means `Quantity: 0`, not `-1`.
- **`UpdateOnHand` defaults to `false`**, which adjusts *available* rather than
  *on hand*. We set it `true` explicitly.
- **`BatchSN`** is the serial field — flat on the line, max 50 chars.
- Lines are matched on product + location + batchSN, so two lines differing only by
  `BatchSN` express the swap.
- **`Location`** takes the Cin7 location *name*, so the existing `CIN7_LOCATION_MAP`
  works unchanged.
- The response splits `Lines` into `ExistingStockLines` and `NewStockLines`. We
  **assert on that split** — it is the confirmation Cin7 read our intent correctly.

Un-transform is the same call with the serials swapped.

### Cost resolution

The user's requirement is "same applied cost". Cin7 exposes **no clean per-serial cost
read** — `/ref/productavailability` has a `Batch` filter but no cost field, and
`ExistingStockLineModel` has no cost field at all.

`resolveUnitCost(sku, serial, locationName)` therefore resolves in order:

1. **Movements** — `GET /product?Sku=…&IncludeMovements=true`, filter `Movements[]` by
   `BatchSN` and `Location`, walking matching inbound movements newest-first and taking
   the first that yields a positive unit cost from `Amount / Quantity`. This is the only
   per-serial cost the API exposes.

   > **Superseded during implementation.** This section originally specified a
   > `MAX_MOVEMENTS_SCANNED` cap of 2000, to avoid scanning an unbounded history. Review
   > established the cap was in the wrong place: `getProductWithMovements` has already
   > fetched and parsed the whole payload by the time this pure function runs, so the cap
   > saved no work and only degraded accuracy on exactly the high-traffic SKUs that most
   > need serial-level precision. It was removed. The real mitigation would be a
   > server-side filter, which Cin7's `/product` does not offer — there is no `BatchSN`
   > query parameter. The filter runs before the sort, so the sort only ever sees the
   > matching subset.
2. **`Product.AverageCost`** — product-level fallback.
3. **Fail** — if neither yields a positive number, refuse the transform rather than
   guess. A wrong cost silently corrupts inventory valuation.

The resolved cost **and which source produced it** are returned to the UI and shown in
the confirmation step, so staff see the figure before committing.

### Idempotency

Cin7 has **no idempotency key**, and — per its own documentation — **does not validate
serial uniqueness**. A retried POST therefore creates a second adjustment and a duplicate
serial, with nothing server-side to stop it.

Mitigations:

- A deterministic `Reference`: `POS-SERIAL-XFORM:<sku>:<fromSerial>:<toSerial>:<yyyy-mm-dd>`.
- **No automatic retry on writes, ever** — per the user's decision. A timeout or
  ambiguous failure surfaces as a loud error telling staff to check Cin7, because
  retrying against an unknown state is how stock gets double-counted.
- Before adjusting, re-read availability and refuse if the target serial already
  exists at that location.

### Backend route

`POST /api/pos/serial-transform`, following the existing route conventions exactly —
`authenticate.public.checkout`, every response wrapped in `cors`, no session storage.

Request:
```ts
{sku: string; serial: string; locationId: string; direction: "assemble" | "disassemble"; dryRun?: boolean}
```

Response is a discriminated union mirroring `SerialLookupResult`'s house style. **Updated
to as-built** — this grew from 8 members to 13 during implementation as review added
guards, and `written_unconfirmed` in particular must appear here, since this block is the
only place the spec enumerates outcomes and it is the never-retry status:
```ts
| {status: "ok"; fromSerial; toSerial; unitCost; costSource; taskId: string | null; existingLineCount; newLineCount}
| {status: "preview"; fromSerial; toSerial; unitCost; costSource}   // dryRun — posts nothing
| {status: "already_transformed"}     // serial already carries the prefix
| {status: "not_transformed"}         // un-transform on a serial without it
| {status: "too_long"}                // prefixing would exceed Cin7's 50-char BatchSN
| {status: "empty_target_serial"}     // e.g. disassembling a serial that is just "A-"
| {status: "unknown_location"}        // POS location not in CIN7_LOCATION_MAP
| {status: "serial_not_found"}
| {status: "not_single_unit"}         // not exactly one unit at this location
| {status: "serial_allocated"}        // committed to an open order
| {status: "target_exists"}           // new serial already at that location
| {status: "cost_unresolved"}
| {status: "written_unconfirmed"; taskId: string | null; existingLineCount; newLineCount}
| {status: "error"; code: Cin7ErrorCode; phase: "read" | "write"}   // client-side only
```

**`dryRun` is deliberate — but note precisely what it does and does not prove.**

It runs every guard and resolves the cost without POSTing, returning
`{status: "preview", fromSerial, toSerial, unitCost, costSource}`.

> **Corrected after the whole-branch review.** This section originally claimed a dry run
> "returns the exact payload… so the first real transform can be validated against a Cin7
> sandbox first". That is wrong, and the implementation correctly followed the union rather
> than the prose: `preview` carries **no payload**, and nothing is sent to Cin7. So a dry run
> validates the guards and risk #6 (cost resolution) — and **nothing** about risks #1, #3 or
> #4, all of which concern how Cin7 responds to the POST. Those are discharged only by the
> first live write. The value of `dryRun` is that it lets staff see the resolved cost and
> target before committing, and that re-selecting a serial after a failure runs a fresh dry
> run whose guards reveal whether the earlier attempt landed. It is not pre-flight
> validation of Cin7's behaviour.

### Client changes

`Cin7Client` gains write capability. Generalise `get<T>()` into a private
`request<T>(method, path, {params, body})` preserving the existing status→`Cin7Error`
mapping, and add:

- `POST` support through that helper. (As built there is **no** separate `post<T>()`: `get<T>()` delegates to `request<T>()` and `createStockAdjustment` calls `request("POST", …)` directly.)
- **`AbortSignal.timeout(30_000)` on every request.** There is no timeout today; a hung
  Cin7 response hangs the request indefinitely. Tolerable for a GET, dangerous
  mid-adjustment, where it leaves the outcome genuinely unknown.
- `createStockAdjustment(payload)` → `POST /stockadjustment`
- `getProductWithMovements(sku)` → `GET /product?Sku=…&IncludeMovements=true`

Both 429 **and** 503 already map to `RATE_LIMITED`, which is correct — Cin7's docs use
both codes for the rate limit across versions.

### UI

Feature 2 adds no new targets. It is the second action behind the shared
`ProductMenuItem.tsx`, rendering `./src/screens/SerialTransform.tsx` inside the shared
`ProductModal.tsx`.

Flow: pick or scan a serial from the same `SerialList` component → the app computes the
target serial and resolves cost → a confirmation screen showing from, to, location, cost
and cost source → confirm → result screen. Errors name the affected serial explicitly
and instruct the user to check Cin7 rather than retry in the app.

`TRANSFORM_PREFIX = "A-"` is a build-time constant in
`extensions/pos-serials/src/lib/transform.ts`, mirroring `SERIAL_TAG` — a client bundle
cannot read server env. The same constant is needed server-side for validation, so it is
also defined in `app/services/transform.server.ts`; both carry a comment pointing at the
other, matching the existing deliberate `AvailableSerial` duplication.

## Testing

Following house conventions exactly:

- **Pure logic first** — `transform.ts` / `transform.server.ts` (prefix rules, target
  serial computation, re-transform and not-transformed guards) are pure functions with
  full unit coverage. TDD applies here.
- **`Cin7Client`** — fake `fetchFn` injected via the existing third constructor
  parameter. Assert the POST body exactly: `UpdateOnHand: true`, `Quantity: 0` on the
  outgoing line, `Quantity: 1` on the incoming, correct `BatchSN` and `Location`.
- **`TransformService`** — fake the whole client as a plain object, as
  `serials.server.test.ts` already does.
- **Route** — cover each member of the response union.
- Component rendering stays untested, consistent with the existing extension (no
  `.test.tsx` files exist today).

## Risk register — unverified API behaviour

Documentation could not settle these. Each is called out in the README so the first
production transform is done deliberately.

| # | Assumption | Risk | Mitigation |
|---|---|---|---|
| 1 | `POST` with `Status: "COMPLETED"` completes in one call | Every doc example POSTs `DRAFT` then `PUT`s `COMPLETED` | `dryRun`, then verify on first live call; response asserts on status |
| 2 | How `UnitCost` is treated on the `Quantity: 0` line | Downgraded after reading the blueprint directly: `Lines` on POST is typed `[] New Stock Line Model`, where `UnitCost` is **Required**. `ExistingStockLineModel` (no cost field) is only how Cin7 classifies lines in the *response*, never what we send. So supplying the resolved cost on both lines is mandated, not a guess | Send the resolved cost on both lines; assert on the response's line split |
| 3 | One document accepts two lines differing only by `BatchSN` | Cin7 might merge or reject them | Assert on the `ExistingStockLines`/`NewStockLines` split |
| 4 | `UpdateOnHand: true` behaves correctly for serialised stock | Default `false` adjusts the wrong quantity | Set explicitly; verify on first live call |
| 5 | No serial uniqueness enforcement | A duplicate `A-BIKE001` can be created | Pre-check availability; never auto-retry |
| 6 | No per-serial cost endpoint exists | Cost may be approximate | Two-source resolution, refuse rather than guess, show source in UI |

## Out of scope

- Batch transforms.
- Any in-app audit log (would reintroduce the database).
- Production Order / Finished Goods assembly primitives. These model "assembled" more
  faithfully and preserve cost automatically, but both require the boxed and assembled
  units to be **different SKUs**, which the user ruled out. Revisit only if that changes.
- Enforcing "must be transformed before sale". Validation functions do not run on POS
  checkout — the resolved NO-GO from the 2026-07 spike applies identically here.
