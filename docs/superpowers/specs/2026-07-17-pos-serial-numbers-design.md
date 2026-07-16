# POS Serial Number Selection — Design

**Date:** 2026-07-17
**Status:** Approved (pending final spec review)
**Owner:** Techweave (Adam Stead)

## Overview

A Shopify app that lets retail staff assign Cin7 Core serial numbers to products at
the point of sale. When a serial-tracked product (identified by product tag) is added
to the POS cart, a smart-grid tile highlights. Tapping it opens a modal that fetches
available serial numbers from Cin7 Core by SKU; the staff member picks one (tap,
search, or barcode scan) and it is saved as a line item property on that cart line.
Checkout is blocked until every serialized line has a serial.

## Context

- Techweave deploys this app to **a few client stores** (not a public app). Each
  client gets their own deployment with their own Cin7 Core credentials.
- An existing **standalone Node/TypeScript service** already consumes completed
  Shopify orders and allocates the sold serial number on the corresponding Cin7 Core
  sale. That service will be **merged into this app's backend in a later phase**;
  v1 only needs the order line item property to be present for it to consume.
- This repo starts empty; the app is scaffolded fresh from the Shopify app template
  (Node/TypeScript).

## Requirements

1. POS smart-grid tile highlights when the cart contains at least one line whose
   product carries the serial tag (default `serialized`, configurable per client).
   The tile shows how many serialized lines still need serials.
2. Tapping the tile opens a modal listing each serialized cart line and its status
   (serial assigned or missing).
3. Selecting a line queries Cin7 Core for available serial numbers for that SKU.
   **All locations are shown**: the current store's location first, then other
   locations grouped and labelled beneath (staff may sell a unit held at another store).
4. Staff pick a serial by tapping it in the list, narrowing with a search box, or
   **scanning the unit's barcode** — a scan matching an available serial selects it;
   a non-matching scan is rejected with an explanatory message.
5. The chosen serial is saved to the cart line as a line item property
   (default key `Serial Number`, configurable).
6. **One serial per unit.** A serialized line with quantity > 1 is split so each
   unit is its own quantity-1 line with its own serial.
7. **Checkout is hard-blocked** (server-side, unbypassable) until every serialized
   line has quantity 1, a serial property, and no serial appears twice in the cart.
8. Serials already assigned to another line in the current cart are excluded from
   the picker.

## Architecture (chosen: Approach A — live Cin7 lookups)

One Shopify app per client, four parts:

### 1. POS UI extension — tile (`pos.home.tile.render`)
Subscribes to the cart. Resolves which cart products are serialized by sending
unknown product IDs to the backend in one batched call (backend reads tags via the
Admin API); results are cached in the extension for the session. Tile states:
- No serialized items → disabled, neutral.
- Serialized lines missing serials → enabled, accent tone, count shown
  (e.g. "2 serials needed").
- All serialized lines satisfied → enabled, neutral, "Serials complete".

### 2. POS UI extension — modal (`pos.home.modal.render`)
Opened from the tile. Screens:
- **Line list**: each serialized cart line with status. Always re-reads live cart
  state when (re)gaining focus — never trusts remembered state.
- **Serial picker** (per line): fetches available serials from the backend by SKU +
  current POS location ID. Renders current location's serials first, other locations
  grouped beneath. Serials already assigned to another line in the current cart are
  filtered out here, in the modal (the backend is stateless and never sees the
  cart). Search box filters client-side; the device scanner API auto-selects on
  exact match. On selection: split line if quantity > 1 (reduce to
  qty 1, add sibling lines for the remainder), then write the serial property, then
  return to the line list.

### 3. Checkout validation function (Shopify Function, Cart & Checkout Validation API)
Runs on Shopify's servers during POS checkout (no backend dependency). For every
cart line whose product has the serial tag, blocks checkout unless:
- quantity is exactly 1, and
- a non-empty `Serial Number` property is present, and
- that serial is unique within the cart.

Error messages name the product: "Select a serial number for {product title}
(tap the Serial Numbers tile)". The tag name is baked in at deploy time (the app is
deployed per client), avoiding runtime config plumbing in the function.

### 4. App backend (Node/TypeScript, Shopify app template server)
- Authenticates POS extension requests via session tokens.
- `POST /api/pos/product-tags` — batched product ID → is-serialized map (Admin API).
- `GET /api/pos/serials?sku=&locationId=` — maps the Shopify location to its Cin7
  location (per-client config), queries Cin7 Core `ProductAvailability` for the SKU,
  keeps serial rows with available stock > 0, orders current location first, and
  returns `{ serial, locationName, available }[]`.
- Caches Cin7 responses for 30–60 seconds to respect Cin7 Core rate limits
  (~60 calls/minute).
- **Phase 2 (separate effort):** absorb the standalone allocation service — an
  `orders/create` webhook applies each line's serial to the Cin7 sale.

## Data flow summary

```
Cart change ──► tile: batch-resolve tags via backend (cached) ──► highlight + count
Tap tile ──► modal: list serialized lines
Tap line ──► backend ──► Cin7 ProductAvailability (SKU) ──► grouped serial list
Pick serial (tap / search / scan) ──► split line if qty > 1 ──► set line property
Checkout ──► validation function: tag ⇒ qty 1 + property + unique ──► allow / block
Order created ──► line item properties on order ──► allocation service (phase 2: merged)
```

## Error handling

Guiding rule: never save a serial that wasn't verified against Cin7; always tell
staff exactly what is wrong.

| Failure | Behaviour |
|---|---|
| Cin7 unreachable / rate-limited | Modal shows "Can't reach Cin7" + retry. Serialized checkout stays blocked (accepted trade-off); other products sell normally. |
| No serials in stock for SKU | Explicit empty state; staff resolve stock in Cin7 or remove the item. |
| SKU not found in Cin7 | Distinct message flagging a Shopify↔Cin7 SKU mismatch (data hygiene — escalate, don't retry). |
| Tag lookup fails | Tile enables in a generic "check serials" state rather than staying dark. Enforcement unaffected (validation reads tags natively on Shopify's servers). |
| Scan doesn't match available serial | "Not in available stock" — never silently accepted. |
| Cart changed mid-flow / partial split | Modal recomputes from live cart state on focus. |
| Session token/auth failure | One retry, then error toast. |

Accepted trade-off: a Cin7 outage prevents completing serialized sales (hard-block
was chosen deliberately). A staff emergency override is a possible later addition.

## Configuration (per client deployment)

Env vars / single JSON config, agency-managed (no merchant settings UI in v1):
- Shopify app credentials (from the per-client app install)
- Cin7 Core account ID + application key
- Serial tag name (default `serialized`)
- Line property key (default `Serial Number`)
- Shopify location ID → Cin7 location name mapping

Hosting: alongside the existing standalone allocation service, which also eases the
phase-2 merge.

## Testing

- **Unit:** Cin7 response mapping (location grouping/ordering, caching) in the
  backend; in-cart serial exclusion in the modal's picker logic; validation
  function via the function runner against fixture
  carts (tagged line without serial, qty > 1, duplicate serials, happy path).
- **Integration:** `shopify app dev` against a development store; tile and modal in
  the POS app's developer mode with a Cin7 sandbox account.
- **Acceptance (per client rollout):** scripted checklist on a real POS device —
  scan-to-select, qty split, blocked checkout message, other-location selection,
  Cin7-down behaviour.

## Out of scope (v1)

- Merging the standalone allocation service (phase 2, own spec/plan).
- Server-side serial cache with sync (Approach B) — documented upgrade path if Cin7
  rate limits or outages bite in practice.
- Staff override for blocked checkout during Cin7 outages.
- Merchant-facing settings UI.
- Online store / non-POS channels (serialized enforcement applies to POS workflows;
  the validation function's channel scoping is confirmed during implementation).

## To verify during implementation planning

- Exact scanner API surface in the current POS UI extensions API version.
- POS cart behaviour when splitting lines (identical variants may auto-merge until
  distinct properties are set — set properties immediately after split).
- Minimum POS app version for checkout validation on POS.
- Cin7 `ProductAvailability` filter parameters (SKU + location) and the exact field
  carrying the serial number.

## References

- POS UI extensions: https://shopify.dev/docs/api/pos-ui-extensions/latest
- POS Cart API: https://shopify.dev/docs/api/pos-ui-extensions/latest/target-apis/contextual-apis/cart-api
- Cart & Checkout Validation Function API: https://shopify.dev/docs/api/functions/latest/cart-and-checkout-validation
- Checkout validation on POS (changelog): https://changelog.shopify.com/posts/checkout-validation-for-pos-checkout
- Cin7 Core ProductAvailability: https://help.core.cin7.com/hc/en-us/articles/9034523140879-ProductAvailability
- Cin7 Core batch/serial numbers: https://help.core.cin7.com/hc/en-us/articles/9034605081231-Working-with-batch-and-serial-numbers
