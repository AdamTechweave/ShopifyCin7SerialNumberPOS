# Cin7 Serial Products — POS Serial Number Selection

A Shopify app (internal Techweave tool, one deployment per client) that lets retail
staff assign Cin7 Core serial numbers to products at the point of sale. When a
serial-tracked product (identified by a product tag, default `serialized`) is added
to the POS cart, a smart-grid tile highlights and shows how many lines still need a
serial. Tapping the tile opens a modal that looks up available serial numbers from
Cin7 Core by SKU across all warehouse locations (current store first); staff pick one
by tapping, searching, or scanning the unit's barcode, and it is saved as a
`Serial Number` line item property on that cart line. A quantity > 1 serialized line
is split so every unit gets its own line and its own serial. A Shopify Function on
the Cart & Checkout Validation API is deployed alongside the POS extension to block
checkout until every serialized line has exactly one unit, a serial, and no serial
duplicated in the cart — see the **Known limitations** section below for the current
verification status of that block (all channels pending the spike).

Full design: `docs/superpowers/specs/2026-07-17-pos-serial-numbers-design.md`.

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
own serial. A Cart & Checkout Validation Function (`serial-validation`) enforces
server-side that every serialized line has quantity 1, a non-empty serial, and no
serial repeated in the cart — live blocking behavior (online and POS channels) is
verified during the spike tracked below (see docs/superpowers/notes/2026-07-pos-validation-spike.md,
verdict pending).

## 2. Architecture

Four parts, one app per client:

1. **POS UI extension — tile** (`pos.home.tile.render`). Subscribes to the live
   POS cart, batches unknown product IDs to the backend to resolve which lines are
   serialized (session-cached in the extension), and renders the tile state
   (disabled/neutral, accent + count, or "Serials complete").
2. **POS UI extension — modal** (`pos.home.modal.render`). A line list screen (always
   re-reads live cart state on focus) and a serial-picker screen per line (fetches
   from the backend by SKU + current POS location ID, groups by location, filters
   out serials already used elsewhere in the cart, supports search and barcode
   scan, and performs the qty-1 split + property write on selection).
3. **Checkout validation function** (Shopify Function, Cart & Checkout Validation
   API, handle `serial-validation`). Runs on Shopify's servers with no dependency on
   the app backend. Its logic blocks checkout unless every line whose product
   carries the serial tag has quantity 1, a non-empty `Serial Number` attribute, and
   a cart-unique serial — the unit-tested rules are embedded; live blocking behavior
   across channels is verified during the spike (see **Known limitations**). The tag
   literal is baked into the function's GraphQL input query at deploy time (see the
   per-client rollout checklist below for what to edit if a client's tag differs
   from `serialized`).
4. **App backend** (React Router / Node, the Shopify app template server).
   Authenticates POS extension requests via `authenticate.public.checkout`
   (session-token validation; there is no `authenticate.public.pos` helper in this
   CLI/template combination). Exposes:
   - `POST /api/pos/product-tags` — batched product ID → is-serialized map, via the
     Admin API.
   - `GET /api/pos/serials?sku=&locationId=` — maps the Shopify location to its
     configured Cin7 location name, queries Cin7 Core, keeps rows with available
     stock > 0, orders current location first.
   Cin7 availability responses are cached in-process for 45 seconds per SKU to stay
   under Cin7's ~60 calls/minute rate limit.

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
  config.server.ts                        # per-client env config (getConfig/loadConfig)
  services/
    cache.server.ts                       # generic TTL cache
    cin7.server.ts                        # Cin7 Core HTTP client
    serials.server.ts                     # location grouping + SerialService (cached)
    tags.server.ts                        # product GID + serialized-map helpers
  routes/
    api.pos.serials.tsx                   # GET serials by SKU + location
    api.pos.product-tags.tsx              # POST product IDs -> serialized map
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
    src/screens/LineList.tsx
    src/screens/SerialPicker.tsx
    src/lib/serials.ts                    # pure cart/serial logic
    src/lib/assignSerial.ts               # rollback-safe split + property write
    src/lib/api.ts                        # backend fetch helpers
docs/superpowers/specs/2026-07-17-pos-serial-numbers-design.md   # design doc
docs/superpowers/notes/2026-07-pos-validation-spike.md           # POS-block spike (verdict pending)
README.md                                 # this file
```

## 3. Environment variables

All four live in `.env.example`; copy it to `.env` and fill in per client. None have
a merchant-facing settings UI in v1 — Techweave manages them per deployment.

| Variable | Description | Where to get it |
|---|---|---|
| `CIN7_ACCOUNT_ID` | Cin7 Core account ID for this client. | Create an application key at `inventory.dearsystems.com/ExternalAPI` (Cin7 Core admin → Integrations & API → API). The account ID is shown alongside the key you create. |
| `CIN7_APPLICATION_KEY` | Cin7 Core application key paired with the account ID above. | Same `inventory.dearsystems.com/ExternalAPI` screen — generate a new application key for this integration. |
| `SERIAL_TAG` | Product tag marking a serial-tracked product. Default `serialized`. | Agreed with the client; must match the tag they apply to serialized products in Shopify admin. |
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

## 4. Local development

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
extensions (`extensions/**/src/**/*.test.{ts,js}`) in one pass — **48 tests across 8
files**, currently all passing.

The POS extension has its own `tsconfig.json` (Preact JSX, non-strict) excluded from
the root TypeScript project. Typecheck it standalone before building:

```bash
npx tsc --noEmit -p extensions/pos-serials
```

Run this before `shopify app build` / `shopify app deploy`. The extension's
`tsconfig.json` excludes `dist/`, so a previous build's output doesn't need to
be cleared first.

Build the web app (React Router) with:

```bash
npm run build
```

Note: `extensions/pos-serials/shopify.d.ts` is regenerated by the CLI on every
`shopify app build` / `shopify app dev` run (it reappears with ambient type blocks
even after being edited or deleted) — this is expected CLI behavior, not a bug.

## 5. Per-client rollout checklist

1. **Create the client's app** in the Techweave Partner org. Set distribution to
   **custom** (this is never a public/listed app). Install it on the client's store.
2. **Create a Cin7 application key** for this client at
   `inventory.dearsystems.com/ExternalAPI`, then fill in `.env` (or the hosting
   platform's env vars): `CIN7_ACCOUNT_ID`, `CIN7_APPLICATION_KEY`.
3. **Build `CIN7_LOCATION_MAP`** covering every Shopify location that has a POS
   register for this client, mapping each Shopify location ID to the exact Cin7
   Core location name.
4. **If the client's serial tag isn't `serialized`**, change it in **two places**
   (both are required — the function's tag check does not read the env var):
   - `.env`: set `SERIAL_TAG=<their tag>` (used by the backend's tag lookup).
   - `extensions/serial-validation/src/cart_validations_generate_run.graphql`: edit
     the `hasAnyTag(tags: ["serialized"])` literal to the client's tag.
5. **Tag serialized products** in the client's Shopify catalog with that tag, and
   confirm each serialized product's SKU matches its Cin7 Core SKU **exactly**
   (SKU mismatch is a hard failure mode — see the design doc's error-handling
   table).
6. **Deploy:**
   ```bash
   npm run deploy    # shopify app deploy
   ```
   On this CLI version (`@shopify/cli` 4.5.1) the update flag is `--allow-updates`,
   not `--force` — `shopify app deploy` already applies it as needed; you shouldn't
   need to pass extra flags for a routine per-client deploy.
7. **Activate the validation.** While `shopify app dev` is running, open its
   GraphiQL (dev console link in the CLI output) against the client's store and run
   this mutation exactly as written:

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

   Expect `userErrors: []`. Confirm in the client's Shopify admin under
   **Settings → Checkout → Checkout Rules** that "Serial numbers required" shows as
   active.
8. **Devices:** every register needs Shopify POS **≥ 10.6.0** installed. Add the
   "Serial numbers" tile to the smart grid on each register (POS app → smart grid
   layout → add tile).

## 6. Acceptance checklist

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
- [ ] Attempting checkout with a missing/duplicate serial or quantity > 1 on a
      serialized line is **blocked with the expected message** — *this step's
      outcome across channels is the subject of the pending spike; see Known
      limitations.* (Verdict pending — see docs/superpowers/notes/2026-07-pos-validation-spike.md)
- [ ] With Cin7 unreachable (or credentials wrong), the picker shows a clear
      "Can't reach Cin7" state with retry, and non-serialized items still sell
      normally.

## 7. Known limitations

- **Hard-block verification pending (all channels).** Shopify does not document whether Cart &
  Checkout Validation Functions run on POS checkout at all — this is the single
  riskiest unknown in the project. `docs/superpowers/notes/2026-07-pos-validation-spike.md`
  tracks it; as of this writing its verdict is **PENDING HUMAN TEST** (deploy is
  done, but the online control test and the real-device POS test have not been
  run/recorded yet). Until that spike lands with a **GO**, do not tell a client that checkout is hard-blocked on ANY channel — the validation rules are unit-tested and deployed, but neither the online control test nor the POS device test has been recorded. POS enforcement today is the tile/modal UX (staff are strongly steered but not
  technically prevented from completing a POS sale without a serial). If the
  eventual verdict is **NO-GO**, that UX-only behavior becomes the permanent POS
  story and should be called out to the client explicitly.
- **Cin7 outage blocks serialized checkout.** This is a deliberate trade-off, not a
  bug: if Cin7 Core is unreachable or rate-limited, serialized lines cannot get a
  verified serial, so those sales cannot complete (non-serialized items are
  unaffected). A staff emergency override is a possible future addition, out of
  scope for v1.
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
- **`@shopify/ui-extensions` version pin.** `extensions/pos-serials/package.json`
  pins `@shopify/ui-extensions` to `2025.10.x` while the extension's
  `api_version` is `2026-07`; the scanner camera APIs used by the barcode-scan
  picker are bridged with a type cast because the pinned package's types predate
  `2026-07`. A deliberate version bump (with a re-check of the scanner types) is
  recommended before this becomes a maintenance burden.
- **No merchant-facing settings UI.** All per-client configuration is env vars,
  managed by Techweave — see the per-client rollout checklist above.
