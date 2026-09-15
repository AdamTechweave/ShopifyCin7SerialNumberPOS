# Cin7 Serial Products — POS Serial Number Selection

A Shopify app (internal Techweave tool, one deployment per client) that lets retail
staff assign Cin7 Core serial numbers to products at the point of sale. When a
serial-tracked product (identified by a product tag, default `serialized`) is added
to the POS cart, a smart-grid tile highlights and shows how many lines still need a
serial. Tapping the tile opens a modal that looks up available serial numbers from
Cin7 Core by SKU across all warehouse locations (current store first); staff pick one
by tapping, searching, or scanning the unit's barcode, and it is saved as a
`Serial Number` line item property on that cart line. A quantity > 1 serialized line
is split so every unit gets its own line and its own serial.

**Enforcement is prompt-only on POS.** Testing settled this on 2026-07-22: Shopify
cannot hard-block a POS sale (validation functions don't run on POS checkout), and
the client does not want online checkout blocked — online orders get serials at pick
time in Cin7. The tile's count and the picker are what drive compliance; the shipped
`serial-validation` function stays deactivated. See **Known limitations**.

**Two more POS actions build on this (2026-09).** From a product's details screen,
staff can open a read-only list of that product's available Cin7 serial numbers —
no cart involved — and can perform a **serial transform**: renaming a serial with a
fixed `A-` prefix when a boxed unit is assembled, and stripping it back off on
disassembly. Cin7 expresses this as a single stock adjustment. See **Serial
transform** below for the mechanism, and **Known limitations** for what's unverified.

Full design: `docs/superpowers/specs/2026-07-17-pos-serial-numbers-design.md` (v1);
`docs/superpowers/specs/2026-09-15-serial-features-v2-design.md` (product-details
lookup + serial transform, this update).

## 1. What this app does

Retail staff scan or add a serialized product to the POS cart. The **Serial
numbers** smart-grid tile lights up (accent tone) with a count of lines still
missing a serial. Tapping it opens a modal listing every serialized cart line and
its status; tapping a line opens a picker that queries Cin7 Core's
`ref/productavailability` endpoint for that SKU, grouping results by location (the
current POS location's stock first, other locations below) and excluding any
serial already used by another line in the current cart. Staff select a serial by
tap, by typing into the search box, or by scanning the unit's barcode with the
device camera (an exact match auto-selects; a non-matching scan is rejected with an
explanatory message). If the line's quantity is greater than 1, selecting a serial
splits off a quantity-1 sibling line so each unit ends up on its own line with its
own serial. Nothing prevents completing the sale if a serial is still missing —
staff are prompted, not gated (see **Known limitations** for why, and
`docs/superpowers/notes/2026-07-pos-validation-spike.md` for the test that settled
it).

## 2. Architecture

Five parts, one app per client:

1. **POS UI extension — tile** (`pos.home.tile.render`). Subscribes to the live
   POS cart, batches unknown product IDs to the backend to resolve which lines are
   serialized (session-cached in the extension), and renders the tile state
   (disabled/neutral, accent + count, or "Serials complete").
2. **POS UI extension — modal** (`pos.home.modal.render`). A line list screen (always
   re-reads live cart state on focus) and a serial-picker screen per line (fetches
   from the backend by SKU + current POS location ID, groups by location, filters
   out serials already used elsewhere in the cart, supports search and barcode
   scan, and performs the qty-1 split + property write on selection).
3. **POS UI extension — product details actions**
   (`pos.product-details.action.menu-item.render` → `ProductMenuItem.tsx`,
   `pos.product-details.action.render` → `ProductModal.tsx`). Two more targets in the
   same extension registration as the tile/modal above (same `uid`, no new Shopify
   scope — `read_products` already covers it: a target maps to exactly one module, so
   both new actions share these two files). The menu item adds a "Serial numbers"
   action to a product's details screen; tapping it presents `ProductModal.tsx`,
   which routes between two screens: a read-only serial list
   (`screens/ProductSerials.tsx`, sharing the presentational `screens/SerialList.tsx`
   component with the cart picker) and the serial transform flow
   (`screens/SerialTransform.tsx` — see **Serial transform** below). Routing state
   lives in `ProductModal.tsx`.
4. **Checkout validation function** (Shopify Function, Cart & Checkout Validation
   API, handle `serial-validation`) — **built and deployed but deliberately never
   activated.** Its rules (serialized line ⇒ quantity 1, non-empty `Serial Number`
   attribute, cart-unique serial) are unit-tested and would block checkout if
   enabled, but testing proved they only apply to online/web checkout, never POS —
   the inverse of this client's requirement. Retained solely in case Shopify extends
   validation functions to POS later. The tag literal is baked into the function's
   GraphQL input query at deploy time (see rollout notes if a client's tag differs
   from `serialized`).
5. **App backend** (React Router / Node, the Shopify app template server).
   Authenticates POS extension requests via `authenticate.public.checkout`
   (session-token validation; there is no `authenticate.public.pos` helper in this
   CLI/template combination). It makes no Shopify API calls and needs no database
   — the extension reads product tags itself through POS direct API access.
   Exposes two routes:
   - `GET /api/pos/serials?sku=&locationId=` — maps the Shopify location to its
     configured Cin7 location name, queries Cin7 Core, keeps rows with available
     stock > 0, orders current location first.
   - `POST /api/pos/serial-transform` — the write path behind the serial transform
     feature (see **Serial transform** below). `Cin7Client`
     (`app/services/cin7.server.ts`) is no longer read-only for this route. Its
     GET-only helper was generalised into a shared private `request<T>(method, …)`;
     `get<T>()` now delegates to it and `createStockAdjustment` calls it directly with
     `POST`. There is no separate `post<T>()`. `request<T>()` also adds a 30-second
     `AbortSignal.timeout` to every call (GET included — there was no timeout at all
     before this).
   Cin7 availability responses are cached in-process for 45 seconds per SKU to stay
   under Cin7's ~60 calls/minute rate limit; the serial-transform route invalidates
   that cache for the affected SKU after any non-dry-run attempt (see **Serial
   transform** for the caveat on what that invalidation does and doesn't guarantee).

**Phase 2 (out of scope for this app):** an existing standalone Node/TypeScript
service consumes completed Shopify orders and allocates the sold serial number on
the matching Cin7 Core sale. It already works off the `Serial Number` line item
property this app writes; merging it into this backend is a separate, later
effort.

### Repo layout

```
shopify.app.toml                          # app config: name, client_id, scopes
.env.example                              # per-client config template
vitest.config.ts                          # root test runner (app + extensions)
app/
  shopify.server.ts                       # Shopify app template auth setup
  session-storage.server.ts               # in-process sessions (no database)
  config.server.ts                        # per-client env config (getConfig/loadConfig)
  services/
    cache.server.ts                       # generic TTL cache
    cin7.server.ts                        # Cin7 Core HTTP client (read + write)
    serials.server.ts                     # location grouping + SerialService (cached)
    cost.server.ts                        # resolveUnitCost(): movement cost, falls back to product average
    transform.server.ts                   # prefix rule + target-serial computation (pure, mirrors the extension's copy)
    serial-transform.server.ts            # TransformService — the write path (see Serial transform)
  routes/
    api.pos.serials.tsx                   # GET serials by SKU + location
    api.pos.serial-transform.tsx          # POST serial transform (assemble/disassemble)
extensions/
  serial-validation/                      # Cart & Checkout Validation Function
    shopify.extension.toml
    src/cart_validations_generate_run.graphql   # input query; tag literal lives here
    src/cart_validations_generate_run.js
    src/cart_validations_generate_run.test.js
  pos-serials/                            # POS UI extension
    shopify.extension.toml
    src/Tile.tsx
    src/Modal.tsx
    src/ProductMenuItem.tsx               # product-details menu item (both new actions)
    src/ProductModal.tsx                  # product-details modal; routes to the two screens below
    src/screens/LineList.tsx
    src/screens/SerialPicker.tsx
    src/screens/SerialList.tsx            # shared presentational list (SerialPicker + ProductSerials)
    src/screens/ProductSerials.tsx        # read-only serial list on product details
    src/screens/SerialTransform.tsx       # assemble/disassemble flow
    src/lib/serials.ts                    # pure cart/serial logic
    src/lib/assignSerial.ts               # rollback-safe split + property write
    src/lib/api.ts                        # Cin7 backend fetch + direct Admin API tag query
    src/lib/tags.ts                       # SERIAL_TAG + product GID/serialized-map helpers
    src/lib/outcome.ts                    # pure result-status -> staff-facing copy (fail-closed)
    src/lib/cartOps.ts                    # real POS cart ops + property-visibility wait
    src/lib/transform.ts                  # TRANSFORM_PREFIX + computeTargetSerial, mirrors app/services/transform.server.ts
docs/superpowers/specs/2026-07-17-pos-serial-numbers-design.md   # v1 design doc
docs/superpowers/specs/2026-09-15-serial-features-v2-design.md   # v2 design doc (product-details lookup + serial transform)
docs/superpowers/notes/2026-07-pos-validation-spike.md           # POS-block spike (verdict: NO-GO)
docs/superpowers/notes/2026-07-pos-cart-merge.md                 # undocumented POS line-merge rules
README.md                                 # this file
```

## 3. Serial transform

When a boxed unit is assembled, its Cin7 serial gains a fixed `A-` prefix
(`BIKE001` → `A-BIKE001`); disassembly strips it back off. Staff perform this from a
product's details screen in POS
(`extensions/pos-serials/src/screens/SerialTransform.tsx`); the backend
(`POST /api/pos/serial-transform`, `app/services/serial-transform.server.ts`)
expresses it in Cin7 Core as a stock adjustment. The assembled unit is the same
product and the same SKU in both Shopify and Cin7 — only the serial string changes.
Reversal (un-transform) is the same mechanism with the two serials swapped.

**One document, one atomic write.** The old and new serials are both lines on a
single `POST /stockadjustment` — not two separate calls — so there is no
partial-failure window where one side has moved and the other hasn't.

**`Quantity` is an absolute target, not a delta.** The outgoing serial's line
carries `Quantity: 0` (this serial now holds nothing at this location), the
incoming line `Quantity: 1` — not `-1` / `+1`. Cin7 treats `Quantity` as the new
`QuantityOnHand`, so getting this wrong zeroes or doubles real stock.

**`UpdateOnHand` must be `true`.** Cin7 defaults it to `false`, which adjusts
*available* stock rather than *on hand* stock — silently the wrong quantity for
this use case. It is set explicitly on every request.

**Cost is resolved, not asked for, and the transform refuses rather than guess.**
`resolveUnitCost()` (`app/services/cost.server.ts`) tries, in order: (1) Cin7
movements for the SKU, filtered to the matching `BatchSN` and `Location`, walking them
newest-first and taking the first whose `Amount / Quantity` is a positive finite number
— so a zero or malformed recent movement is skipped rather than failing the lookup;
(2) the product's `AverageCost` as a fallback. If neither yields a positive number, the transform returns
`cost_unresolved` instead of guessing — a wrong cost silently corrupts inventory
valuation. The resolved cost and which of the two sources produced it are shown to
staff on the confirmation screen before they commit, not just recorded afterwards.

**Refused unless the serial is exactly one unallocated unit at that location.** The
write sends an absolute quantity, so it can only safely stand in for "this one unit,
right here" — not a batch-tracked lot (multiple units sharing a serial) and not a
serial duplicated across bins, either of which the write would otherwise zero
wholesale. Before writing, the service reads Cin7 availability for the SKU and
requires exactly one matching row at that location with `OnHand === 1` and
`Allocated === 0`; anything else (no match, more than one row, more than one unit
on hand, or an open allocation) is refused (`serial_not_found`, `not_single_unit`,
`serial_allocated`) rather than risking zeroing more than the one unit being
renamed. A non-dry-run attempt also invalidates the SKU's cached serial list so the
next `GET /api/pos/serials` re-reads Cin7 rather than serving pre-write rows for the
rest of the 45-second cache window — see **Known limitations** for why that's
best-effort, not proof.

**Writes are never retried, by design.** Cin7 has no idempotency key on
`/stockadjustment` and does not validate serial uniqueness, so retrying after a
timeout or an ambiguous failure would risk creating a second adjustment and a
duplicate serial, with nothing on the Cin7 side to catch it. There is no auto-retry
anywhere in this path, and the UI never offers one once a write may have happened.

`dryRun` is the de-facto substitute for idempotency. It runs every guard and resolves
the cost without POSTing anything, returning `{status: "preview", ...}`, and the
confirmation screen always runs a fresh dry run before showing staff what it is about
to do. Re-selecting a serial after a failure therefore runs a new dry run first — whose
guards surface `target_exists` or a changed availability state if the previous attempt
actually landed, so staff can tell whether a "failed" transform in fact wrote.

⚠️ **A dry run does not validate Cin7's behaviour.** It never sends anything to Cin7 and
the `preview` response carries no payload, so it proves the guards and the cost
resolution and nothing else. The assumptions about how Cin7 *responds* to the write —
whether a `COMPLETED` POST completes in one call, whether one document accepts two lines
differing only by `BatchSN`, whether `UpdateOnHand` behaves on serialised stock — are
discharged **only by the first live transform**. Treat that first run as the experiment
it is: one disposable unit, supervised, verified in Cin7 rather than in the app.

**`written_unconfirmed` means the write likely succeeded, not that nothing
happened.** Cin7 accepted the POST, but the response's `NewStockLines` didn't
confirm the target serial was actually created. This is surfaced as its own status
carrying the Cin7 `taskId`; staff are told explicitly not to retry and to check that
task in Cin7 directly.

## 4. Environment variables

Copy `.env.example` to `.env` (local) or set them in the host's environment
(production). None have a merchant-facing settings UI in v1 — Techweave manages
them per deployment. The Cin7 variables are listed below; the Shopify variables
are covered in **Production deployment**. There is no database.

| Variable | Description | Where to get it |
|---|---|---|
| `CIN7_ACCOUNT_ID` | Cin7 Core account ID for this client. | Create an application key at `inventory.dearsystems.com/ExternalAPI` (Cin7 Core admin → Integrations & API → API). The account ID is shown alongside the key you create. |
| `CIN7_APPLICATION_KEY` | Cin7 Core application key paired with the account ID above. | Same `inventory.dearsystems.com/ExternalAPI` screen — generate a new application key for this integration. |
| `CIN7_LOCATION_MAP` | JSON object mapping each Shopify location ID (string) to the matching Cin7 Core location name (string), e.g. `{"12345678":"Main Warehouse"}`. | Shopify location ID: Shopify admin → Settings → Locations → open the location → the numeric ID is in the page URL. Cin7 location name: Cin7 Core → Settings → Locations (must match exactly, case-sensitive). |

`CIN7_LOCATION_MAP` is validated on load (`app/config.server.ts`): it must parse as
JSON and be a plain object whose values are all strings — an array, a non-object, or
any non-string value throws at startup rather than failing silently later.

The line item property key the chosen serial is saved under is **not** an env
var — it is a fixed contract, the literal string `Serial Number`, baked into
**three places** that must be kept in sync if it is ever changed (there is no
single source of truth to edit):
- `extensions/pos-serials/src/lib/serials.ts`: the `SERIAL_PROPERTY_KEY`
  constant (read/write side — tile, modal, and picker all import it).
- `extensions/serial-validation/src/cart_validations_generate_run.graphql`:
  the `attribute(key: "Serial Number")` literal in the function's input query.
- The phase-2 order → Cin7 allocation service (a separate, standalone
  repo/service — see **Architecture** above): it reads this same line item
  property key on completed orders and is out of scope for this repo, but
  would also need updating.

## 5. Local development

```bash
npm install
cp .env.example .env      # then fill in Cin7 credentials + location map for this client
npm run dev                # shopify app dev
```

`npm run dev` runs `shopify app dev`: it logs into Partners, connects to the linked
app, opens a tunnel, and prints a URL — press `P` to open it and install on your dev
store. It also starts POS developer mode; open the Shopify POS app on a device or
simulator, sign in with the same store, and enable developer preview to see the
`pos-serials` extension's tile and modal live (POS ≥ 10.6.0 required for the
automatic-auth backend fetches the extension relies on).

Run the test suite:

```bash
npm test
```

This runs `vitest run` across both the app backend (`app/**/*.test.ts`) and the
extensions (`extensions/**/src/**/*.test.{ts,js}`) in one pass — **200 tests across
14 files**, currently all passing.

Typecheck everything with:

```bash
npm run typecheck
```

This runs `react-router typegen && tsc --noEmit && npm run typecheck:extensions` —
the last step typechecks the POS extension's own `tsconfig.json` (Preact JSX,
`strict: true`) as a separate TypeScript project, since it can't join the root one
(different JSX runtime, different target). **This is a new verification gate on this
branch**: before it, `typecheck:extensions` didn't exist, the extension's
`tsconfig.json` had `strict` off, and the extension was never typechecked at all —
not standalone, and not as part of `npm run typecheck`. To typecheck just the
extension on its own (e.g. iterating without re-running the root project):

```bash
npm run typecheck:extensions
```

Run `npm run typecheck` before `shopify app build` / `shopify app deploy`. The
extension's `tsconfig.json` excludes `dist/`, so a previous build's output doesn't
need to be cleared first.

Build the web app (React Router) with:

```bash
npm run build
```

Note: `extensions/pos-serials/shopify.d.ts` is regenerated by the CLI on every
`shopify app build` / `shopify app dev` run (it reappears with ambient type blocks
even after being edited or deleted) — this is expected CLI behavior, not a bug.

## 6. Per-client rollout checklist

1. **Create the client's app** in the Techweave Partner org. Set distribution to
   **custom** (this is never a public/listed app). Install it on the client's store.
2. **Host the backend and point `application_url` at it.** ⚠️ Easy to miss and it
   breaks the extension silently. The POS extension calls its backend with
   *relative* URLs (`/api/pos/serials`), which POS resolves against the app's
   `application_url`. The repo ships the template placeholder
   (`https://shopify.dev/apps/default-app-home`), so a deployed extension will
   fetch from shopify.dev and every lookup fails — the tile renders but shows
   "Check serials" and the picker can't load. Deploy the React Router server
   (alongside the existing standalone allocation service is the intended home),
   set `application_url` in `shopify.app.toml` to that HTTPS origin, and
   `shopify app deploy` again. During local testing `shopify app dev` rewrites this
   for you (`automatically_update_urls_on_dev = true`), which is why the dev session
   must stay running while you test on a device.
3. **Create a Cin7 application key** for this client at
   `inventory.dearsystems.com/ExternalAPI`, then fill in `.env` (or the hosting
   platform's env vars): `CIN7_ACCOUNT_ID`, `CIN7_APPLICATION_KEY`.
4. **Build `CIN7_LOCATION_MAP`** covering every Shopify location that has a POS
   register for this client, mapping each Shopify location ID to the exact Cin7
   Core location name.
5. **If the client's serial tag isn't `serialized`**, change it in **two places**
   (both are required — the function's tag check does not read the env var):
   - `extensions/pos-serials/src/lib/tags.ts`: set `SERIAL_TAG` to their tag. This
     is a build-time constant, not an env var — the tag lookup runs in the POS
     extension via direct API access, and a client bundle cannot read server env.
     Changing it needs `shopify app deploy`, not just an env change.
   - `extensions/serial-validation/src/cart_validations_generate_run.graphql`: edit
     the `hasAnyTag(tags: ["serialized"])` literal to the client's tag.
6. **Tag serialized products** in the client's Shopify catalog with that tag, and
   confirm each serialized product's SKU matches its Cin7 Core SKU **exactly**
   (SKU mismatch is a hard failure mode — see the design doc's error-handling
   table).
7. **Deploy:**
   ```bash
   npm run deploy    # shopify app deploy
   ```
   On this CLI version (`@shopify/cli` 4.5.1) the update flag is `--allow-updates`,
   not `--force` — `shopify app deploy` already applies it as needed; you shouldn't
   need to pass extra flags for a routine per-client deploy.
8. **Do NOT activate the `serial-validation` checkout validation.** ⚠️ Tested
   2026-07-22 (`docs/superpowers/notes/2026-07-pos-validation-spike.md`, verdict
   **NO-GO**): validation functions **do not run on Shopify POS checkout**, and
   they **do** block the online store — the exact inverse of what's wanted.
   Activating it on a client store would break online checkout for every
   serialized product (blocked at add-to-cart) while still letting POS sales
   complete without serials. There is deliberately **no activation step** in this
   runbook. If a validation was activated on a store by mistake, remove it:

   ```graphql
   # 1. find it
   query { validations(first: 10) { nodes { id title enabled } } }
   # 2. delete the one titled "Serial numbers required"
   mutation { validationDelete(id: "gid://shopify/Validation/REPLACE_ME") {
     deletedId
     userErrors { field message }
   } }
   ```

   Then confirm **Settings → Checkout → Checkout Rules** no longer lists it.
9. **Devices:** every register needs Shopify POS **≥ 10.6.0** installed.
   **Add the tile from the Shopify admin, not from the POS app** — verified
   2026-07-26: the in-app "+ Add tile → Apps" list did not offer the extension,
   but adding it via the admin's POS smart-grid configurator (Settings → Point of
   Sale → smart grid / POS app management) worked, after which it appeared on the
   device. Try the admin route first to save time.

   Also note `extensions/pos-serials/shopify.extension.toml` targets
   `api_version = "2026-04"` — shopify.dev's documented stable version for POS UI
   — deliberately, not the newest available. A POS app that predates the declared
   version filters the extension out of the tile list silently, with no error
   anywhere; if a client's registers are on older POS builds and the tile never
   appears, step the api_version down (and match `@shopify/ui-extensions` to it)
   before hunting elsewhere.

## 7. Acceptance checklist

Run this on a real POS device against the client's store before calling rollout
done (from the design spec's acceptance criteria):

- [ ] Adding a serialized product to the cart lights up the tile with an accurate
      "N serials needed" count.
- [ ] Tapping the tile opens the modal with the correct serialized lines listed.
- [ ] Picking a serial for a quantity > 1 line splits it into quantity-1 lines, each
      with its own serial.
- [ ] Scanning a unit's barcode in the picker auto-selects the matching serial; a
      non-matching scan shows an explanatory rejection, not a silent no-op.
- [ ] Serials from other store locations appear in the picker, grouped below the
      current location's stock, and are selectable.
- [ ] A POS sale with a serialized line still missing its serial **can** be
      completed — confirm staff understand the tile/modal is a prompt, not a
      gate. (POS hard-blocking is not achievable; see Known limitations.)
- [ ] With Cin7 unreachable (or credentials wrong), the picker shows a clear
      "Can't reach Cin7" state with retry, and all items — serialized or not —
      still sell normally.
- [ ] The completed order's line items each carry the `Serial Number` property
      (check the order in Shopify admin), ready for the phase-2 Cin7 allocation
      service.

## 8. Known limitations

- **POS enforcement is UX-only — a hard block is not possible.** Tested and
  settled 2026-07-22 (`docs/superpowers/notes/2026-07-pos-validation-spike.md`,
  verdict **NO-GO**): Cart & Checkout Validation Functions do not run on POS
  checkout, and no other Shopify mechanism can prevent a POS sale from
  completing (checkout UI extensions' `block_progress` / buyer-journey intercept
  is web checkout only; POS UI extension targets cannot gate payment). Staff are
  strongly steered — the tile shows an accurate "N serials needed" count and the
  modal makes assignment fast — but a determined or rushed staff member can
  complete a POS sale with serials missing. **Tell the client this explicitly:
  they originally asked for a hard block.** Mitigation is operational (staff
  training, plus catching gaps downstream in the Cin7 allocation flow), and the
  `serialized`-tag + `Serial Number` property data model means a missed serial is
  detectable after the fact rather than silent.
- **`write_validations` was dropped from the app's scopes** before the first
  production install, since the function below is never activated. Re-activating
  it would mean re-adding the scope, which prompts the merchant to re-consent.
- **The `serial-validation` function ships but is never activated.** It is
  retained in the repo (`extensions/serial-validation/`, unit-tested) only in
  case Shopify later extends validation functions to POS. Activating it today
  would block **online** checkout — which this client explicitly does not want,
  since online orders get serials assigned at pick time in Cin7 — while doing
  nothing for POS. See rollout step 7 for how to remove it if activated by
  mistake.
- **Cin7 outage does not stop sales.** If Cin7 Core is unreachable or
  rate-limited, the picker shows "Can't reach Cin7" and staff cannot assign a
  verified serial, but the sale can still be completed (see the POS enforcement
  limitation above) — the serial simply has to be reconciled afterwards. This is
  a change from the original design intent, which assumed a hard block was
  available.
- **45-second staleness window.** Cin7 availability responses are cached per SKU
  for 45 seconds (`app/services/serials.server.ts`) to respect Cin7's ~60
  calls/minute rate limit. Two registers selling the last unit of a SKU within that
  window could both see it as available; Cin7 itself is the source of truth at
  actual allocation time.
- **Serials are not reserved until the sale completes.** Picking a serial in the
  modal does not lock it in Cin7 — another register could pick the same serial
  before either sale finishes. This app does not implement reservation/locking (see
  the design doc's "Approach B" note for a possible future upgrade path).
- **Phase 2 (order → Cin7 allocation) is out of scope here.** This app only writes
  the `Serial Number` line item property; a separate standalone service consumes
  completed orders and applies the sold serial to the Cin7 sale. Merging that
  service into this backend is tracked as its own future effort — see
  `docs/superpowers/specs/2026-07-17-pos-serial-numbers-design.md` ("Phase 2" /
  "Out of scope (v1)").
- **Six Cin7 API behaviours behind the serial transform could not be confirmed
  from documentation before building it** (carried over from the design's risk
  register — `docs/superpowers/specs/2026-09-15-serial-features-v2-design.md`):

  | # | Assumption | Risk if wrong | Mitigation |
  |---|---|---|---|
  | 1 | A single `POST` with `Status: "COMPLETED"` completes the adjustment in one call | Every Cin7 doc example `POST`s `DRAFT` then `PUT`s `COMPLETED` instead | **Not provable before the first live write** — a dry run never POSTs. The response is asserted for a confirmed new stock line before success is reported; verify the adjustment is completed, not draft, in Cin7 after the first run |
  | 2 | `UnitCost` must be sent on both lines, including the `Quantity: 0` one | Downgraded to low risk after reading the API Blueprint directly (not just the docs): `Lines` on `POST` is typed `New Stock Line Model`, where `UnitCost` is *required* — this is what the schema mandates, not a guess | Send the resolved cost on both lines (already implemented) |
  | 3 | One document accepts two lines differing only by `BatchSN` | Cin7 might merge or silently drop one | Response asserted for a non-empty `NewStockLines` (`written_unconfirmed` if absent) |
  | 4 | `UpdateOnHand: true` behaves correctly for serialised stock | Untested combination; the documented default (`false`) is known to adjust the wrong quantity | Set explicitly; verify on the first live transform per client |
  | 5 | Cin7 enforces no serial uniqueness | A duplicate serial could otherwise be created | Pre-write availability check refuses if the target serial already exists at that location (`target_exists`); no auto-retry, ever |
  | 6 | No endpoint exposes cost per serial directly | The two-source cost resolution could be wrong for a SKU with unusual movement history | Refuse rather than guess (`cost_unresolved`); resolved cost and its source are shown to staff before they commit |

  **Risks 1, 3 and 4 can only be discharged by performing a real transform**, because
  they are all about how Cin7 responds to the POST and a dry run never sends one. Do the
  first transform for any client on a **disposable sandbox unit**, supervised, and verify
  the result in Cin7's own UI rather than in the app: one document, both lines, old serial
  at quantity 0, new at 1, same location, cost carried across, status completed. The
  result screen reports Cin7's own `existing` and `new` stock-line counts to make that
  check easier. See `docs/superpowers/notes/2026-09-15-serial-features-v2-uat.md`.
- **The serial list is never proof of what a transform did.** `/api/pos/serials`
  is served from a 45-second in-process cache (`app/services/serials.server.ts`).
  The serial-transform route invalidates that cache for the affected SKU after
  any non-dry-run attempt, but this is best-effort, not a guarantee: Cin7 queues
  the stock adjustment as an async task, so Cin7's own availability read can
  still lag briefly after the invalidation. Staff should treat the transform's
  own result screen — not a re-opened serial list — as the source of truth for
  whether a transform happened.
- **Residual risk: a stale zero-quantity row at another bin can cause a false
  `not_single_unit` refusal.** The pre-write guard sums `OnHand` across every row
  matching the serial at that location and refuses unless the total is exactly
  1 and there's exactly one row — a conservative false refusal (a genuine single
  unit gets blocked), not a data-safety risk. If staff hit this in practice, the
  fix is to filter `r.OnHand !== 0` out of the row-count check in
  `app/services/serial-transform.server.ts` before counting matching rows,
  without reopening the negative-quantity/multi-row hole that check exists to
  close.
- **Residual risk: the write posts no `Bin`.** `StockAdjustmentLine`
  (`app/services/cin7.server.ts`) has no `Bin` field, so a serial transform
  cannot preserve the source row's bin even where Cin7 tracks one — the newly
  created serial lands with no bin recorded. Check the source row's bin in Cin7
  before the first live run on a client that bins stock.
- **A timed-out write leaves the outcome genuinely unknown, and there is no
  reconciliation tooling yet.** If a request to `POST /stockadjustment` times
  out or the connection drops, the app cannot tell whether Cin7 applied it —
  and per the no-retry rule above, it will not guess by retrying. `Reference` on
  every stock adjustment is deterministic
  (`POS-SERIAL-XFORM:<sku>:<fromSerial>:<toSerial>:<yyyy-mm-dd>`,
  `buildReference()` in `app/services/serial-transform.server.ts`), and Cin7
  exposes `GET /stockadjustmentList`, so reconciling a specific transform by its
  reference is possible if this is ever needed — it just isn't built.
- **Known, deliberately unfixed: `skuExists()` matches on substring.** Cin7's
  `/product` endpoint's `Sku` filter is a substring match, not exact (unlike
  `/ref/productavailability`, which `getAvailability()` uses and which *is*
  exact) — so `skuExists("BIKE")` returns `true` if only `BIKE-CARBON` exists in
  the account. The only consequence is the picker reporting "no stock" instead
  of "SKU not found" for a genuinely missing SKU, and that wrong answer is
  cached for 10 minutes (`SKU_EXISTS_TTL_MS`, `app/services/serials.server.ts`).
  No write path depends on `skuExists()`. The failure is one-directional — a
  real SKU always contains itself as a substring, so this never wrongly reports
  a genuine product as missing.
- **`@shopify/ui-extensions` version pin — resolved.**
  `extensions/pos-serials/package.json` now pins `@shopify/ui-extensions` to
  `^2026.4.4`, matching the extension's `api_version` of `2026-04` (commit
  `dd6ac82`). Earlier this was mismatched (`2025.10.x` against `2026-07`),
  which forced a type cast around the scanner camera APIs the barcode-scan
  picker uses; that cast is gone now that the types line up. Keep the two in
  step on any future version bump.
- **No merchant-facing settings UI.** All per-client configuration is env vars,
  managed by Techweave — see the per-client rollout checklist above.

## 9. Production deployment (Vercel)

The backend is developer-hosted — Shopify does not host app servers. Their
[hosting matrix](https://shopify.dev/docs/apps/build/app-surfaces) puts POS UI
extensions and Functions on Shopify's infrastructure but leaves "server-only"
components to you, and notes that an app still needs a developer-hosted backend
"to handle tasks like calling third-party APIs" — exactly our Cin7 case. A
backend is unavoidable here regardless: the Cin7 credentials must never reach the
extension bundle, which is readable on the device.

This app deploys to **Vercel**, alongside the existing Cin7 allocation service.
**It has no database.**

### Why there is no database

The backend is two small routes and nothing else. `/api/pos/serials` proxies Cin7
for reads, `/api/pos/serial-transform` proxies it for the one Cin7 write this app
makes (see **Serial transform**), and both hold the credential that can't ship to
the device. Both authenticate with `authenticate.public.checkout` — a signature
check on the POS session token, with no storage and no network behind the check
itself.

Everything Shopify-side happens on the device. The extension reads product tags
through POS **direct API access** (`fetch("shopify:admin/api/graphql.json")`),
which POS authenticates itself, so the app needs no stored offline token and
therefore no session table. Sessions are held in process
(`app/session-storage.server.ts`); `authenticate.admin` re-mints them from the
request's ID token via token exchange, so a cold start costs one extra exchange.

Direct API access needs POS **10.6.0+**, an extension targeting **2025-07 or
later** (ours is `2026-04`), and the scopes declared in `shopify.app.toml`
(`read_products` covers the tag query).

⚠️ If anything later calls `unauthenticated.admin`, this breaks: it needs a
*stored* session and cannot mint one on demand. That is the one change that
would drag a database back in.

### One-time setup

1. **Vercel**: import the repo. Set every variable from `.env.example` in Project
   Settings → Environment Variables (`CIN7_ACCOUNT_ID`, `CIN7_APPLICATION_KEY`,
   `CIN7_LOCATION_MAP`, `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`,
   `SHOPIFY_APP_URL`, `SCOPES`).
2. **Point the app at the deployment.** Set `application_url` and the
   `redirect_urls` in `shopify.app.toml` to the production Vercel URL, set
   `SHOPIFY_APP_URL` to the same value, then `shopify app deploy`.

   ⚠️ `application_url` and `SHOPIFY_APP_URL` must match. The POS extension calls
   its backend with **relative** URLs, which POS resolves against
   `application_url`; if it points anywhere else, every lookup fails and the tile
   sits on "Check serials" with no other clue.
3. **Verify** before handing to staff:
   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" \
     -A "Mozilla/5.0" "https://<your-app>.vercel.app/api/pos/serials?sku=X&locationId=1"
   ```
   Expect **401** — reachable and correctly demanding a POS session token. A 404
   means the deploy didn't take; a 500 usually means missing env vars.

### Serverless caveat: the Cin7 cache

`SerialService` caches Cin7 availability in process (45s per SKU, plus a 10-minute
SKU-existence cache). On Vercel each invocation may land on a fresh isolate, so
the cache hits far less often than on a long-running server and more requests
reach Cin7.

This is acceptable at POS volume rather than something to engineer around: Cin7
allows **60 calls/minute per application key**, and the app only calls Cin7 when a
staff member opens the serial picker for a line — roughly one call per
assignment. Sustained picker opens across all registers would have to exceed one
per second to approach the limit. Throttling is also handled rather than
crashing: 429 and 503 both map to `RATE_LIMITED` and the picker shows "Can't
reach Cin7" with a Retry button.

If a client's volume ever does approach it, the fix is to move the cache behind a
shared store (Vercel KV / Upstash Redis) — `app/services/cache.server.ts` is a
single small class behind one interface, so only that file changes.

