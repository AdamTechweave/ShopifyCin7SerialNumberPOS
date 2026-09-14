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
own serial. Nothing prevents completing the sale if a serial is still missing —
staff are prompted, not gated (see **Known limitations** for why, and
`docs/superpowers/notes/2026-07-pos-validation-spike.md` for the test that settled
it).

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
   API, handle `serial-validation`) — **built and deployed but deliberately never
   activated.** Its rules (serialized line ⇒ quantity 1, non-empty `Serial Number`
   attribute, cart-unique serial) are unit-tested and would block checkout if
   enabled, but testing proved they only apply to online/web checkout, never POS —
   the inverse of this client's requirement. Retained solely in case Shopify extends
   validation functions to POS later. The tag literal is baked into the function's
   GraphQL input query at deploy time (see rollout notes if a client's tag differs
   from `serialized`).
4. **App backend** (React Router / Node, the Shopify app template server).
   Authenticates POS extension requests via `authenticate.public.checkout`
   (session-token validation; there is no `authenticate.public.pos` helper in this
   CLI/template combination). It makes no Shopify API calls and needs no database
   — the extension reads product tags itself through POS direct API access.
   Exposes one route:
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
  session-storage.server.ts               # in-process sessions (no database)
  config.server.ts                        # per-client env config (getConfig/loadConfig)
  services/
    cache.server.ts                       # generic TTL cache
    cin7.server.ts                        # Cin7 Core HTTP client
    serials.server.ts                     # location grouping + SerialService (cached)
  routes/
    api.pos.serials.tsx                   # GET serials by SKU + location
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
    src/lib/api.ts                        # Cin7 backend fetch + direct Admin API tag query
    src/lib/tags.ts                       # SERIAL_TAG + product GID/serialized-map helpers
    src/lib/cartOps.ts                    # real POS cart ops + property-visibility wait
docs/superpowers/specs/2026-07-17-pos-serial-numbers-design.md   # design doc
docs/superpowers/notes/2026-07-pos-validation-spike.md           # POS-block spike (verdict: NO-GO)
docs/superpowers/notes/2026-07-pos-cart-merge.md                 # undocumented POS line-merge rules
README.md                                 # this file
```

## 3. Environment variables

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
- [ ] A POS sale with a serialized line still missing its serial **can** be
      completed — confirm staff understand the tile/modal is a prompt, not a
      gate. (POS hard-blocking is not achievable; see Known limitations.)
- [ ] With Cin7 unreachable (or credentials wrong), the picker shows a clear
      "Can't reach Cin7" state with retry, and all items — serialized or not —
      still sell normally.
- [ ] The completed order's line items each carry the `Serial Number` property
      (check the order in Shopify admin), ready for the phase-2 Cin7 allocation
      service.

## 7. Known limitations

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
- **`@shopify/ui-extensions` version pin.** `extensions/pos-serials/package.json`
  pins `@shopify/ui-extensions` to `2025.10.x` while the extension's
  `api_version` is `2026-07`; the scanner camera APIs used by the barcode-scan
  picker are bridged with a type cast because the pinned package's types predate
  `2026-07`. A deliberate version bump (with a re-check of the scanner types) is
  recommended before this becomes a maintenance burden.
- **No merchant-facing settings UI.** All per-client configuration is env vars,
  managed by Techweave — see the per-client rollout checklist above.

## 8. Production deployment (Vercel)

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

The backend is one route. `/api/pos/serials` proxies Cin7, holding the credential
that can't ship to the device, and authenticates with
`authenticate.public.checkout` — a signature check on the POS session token, with
no storage and no network behind it.

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

