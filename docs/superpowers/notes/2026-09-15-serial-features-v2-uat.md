# Serial Features v2 — UAT

**Date:** 2026-09-15
**Branch:** `feat/serial-features-v2`
**Covers:** serial list on the POS product-details screen, and the serial transform (`BIKE001` → `A-BIKE001`).

Work through the phases in order. **Phase 2 is the first time anything is written to
Cin7, and the write cannot be undone from the app.** Do it on a disposable unit.

---

## Phase 0 — Prerequisites

- [ ] Branch deployed, and `application_url` in `shopify.app.toml` points at that deployment.
      The POS extension resolves `/api/pos/serials` and `/api/pos/serial-transform` as
      **relative** URLs, so a wrong `application_url` makes every call fail.
- [ ] `shopify app deploy` run, so the two new product-details targets are registered.
- [ ] POS app on the device is **10.6.0 or newer** — direct API access needs it.
- [ ] A **sandbox / test** Cin7 product with:
  - at least 3 serials across 2 locations (for the list), and
  - one serial you are willing to permanently rename (for the transform).
- [ ] That product tagged `serialized` in Shopify, with a SKU set.
- [ ] Cin7 admin open in a browser, so you can verify writes independently of the app.
- [ ] Know the expected unit cost of the test serial before you start.

---

## Phase 1 — Read-only. Nothing is written.

### 1.1 Serial list on product details

- [ ] POS → find the test product → open product details → the action menu shows **Serial numbers**.
- [ ] Tap it. The modal opens on a menu offering **View serial numbers** and **Transform serial**.
- [ ] **View serial numbers** lists the serials, grouped by location, **current location first**.
- [ ] The serials and locations match Cin7.

Then the states that matter more than the happy path:

- [ ] **A product with no SKU set** → "No SKU set for this variant". It must *not* say the
      lookup failed.
- [ ] **A SKU Cin7 doesn't know** → "doesn't match any Cin7 product", naming the SKU.
- [ ] **A serialised product with no stock** → "No available serial numbers", not a blank screen.
- [ ] **Airplane mode** → "Can't reach Cin7" with a working **Retry**.

> A **blank screen** in any of these is a bug — report it. An earlier build returned
> nothing for two of these states and it was specifically fixed.

### 1.2 Confirm screen as a dry run

This exercises every guard and the cost lookup **without writing anything**. Tap through
to the confirm screen and **do not confirm**.

> **What this phase cannot tell you.** A dry run never sends anything to Cin7. It proves
> the guards and the cost resolution — it proves **nothing** about how Cin7 handles the
> write itself. Whether a `COMPLETED` POST completes in one call, whether one document
> accepts two lines differing only by serial, and whether `UpdateOnHand` behaves on
> serialised stock are all answered for the first time in **Phase 2**. Do not treat a clean
> Phase 1 as clearance; it de-risks the inputs, not the write.

- [ ] **Transform serial** → pick a serial without an `A-` prefix → the action offered is **Assemble**.
- [ ] The confirm screen shows: from-serial, to-serial (`A-` prefixed), location, **unit cost**,
      and **where the cost came from** ("from last movement" or "product average").
- [ ] **The cost matches what you expect.** If it doesn't, stop — do not proceed to Phase 2.
- [ ] Press **Cancel**. Confirm in Cin7 that **nothing changed**.

Now force each refusal and check the wording. None of these writes anything:

| Set up | Expected |
|---|---|
| Pick a serial already starting with `A-`, choose Assemble | "already assembled" |
| Pick a non-prefixed serial, choose Disassemble | "is not an assembled serial" |
| A serial whose location isn't in `CIN7_LOCATION_MAP` | "isn't mapped to a Cin7 location" |
| A serial allocated to an open Cin7 order | "is allocated to an order" |
| A **batch** line holding more than one unit | "doesn't hold exactly one unit … Check it in Cin7" |
| A product whose Cin7 cost can't be resolved | "Couldn't determine this unit's cost … Transform it in Cin7 directly" |

- [ ] After each refusal, verify in Cin7 that **no stock adjustment was created.**

---

## Phase 2 — First live write. Irreversible. Sandbox unit only.

Have Cin7 open. Do one unit, then stop and verify before doing another.

- [ ] Pick the disposable serial → confirm the dry-run figures → press **Confirm**.

**Expected:** a success banner naming the new `A-` prefixed serial.

Then verify **in Cin7, not in the app**:

- [ ] A stock adjustment exists with reference `POS-SERIAL-XFORM:<sku>:<from>:<to>:<date>`.
- [ ] It is a **single document containing both lines** — not two documents.
- [ ] The old serial is at quantity **0**; the new serial at quantity **1**.
- [ ] Both are at the **same location**.
- [ ] The unit cost on the new serial **matches what the confirm screen showed**.
- [ ] The adjustment is **completed**, not sitting in draft.

> These six checks are the point of Phase 2. Six Cin7 behaviours could not be settled from
> its documentation — in particular whether it accepts two lines differing only by serial
> in one document, and whether a `COMPLETED` POST completes in one call. **This is where
> you find out.** See README Known Limitations.

### If the result says "Confirm in Cin7 — do not retry"

That is `written_unconfirmed`. It means **the adjustment was sent and Cin7 accepted it**,
but the response carried no confirmation the new serial was created.

- [ ] **Do not retry.** Cin7 has no idempotency key; a retry would adjust stock twice.
- [ ] Look up the Cin7 task id shown on screen and check what actually happened.
- [ ] Report it — if it appears on a *normal* success, the confirmation check needs changing,
      and it would otherwise show on every single transform.

### 2.1 Reverse it

- [ ] Transform the new `A-` serial back → the action offered is **Disassemble**.
- [ ] Confirm. The serial returns to its original form.
- [ ] In Cin7, the cost is unchanged from the original.

### 2.2 Double-tap

- [ ] On the confirm screen, **tap Confirm twice in quick succession.**
- [ ] Exactly **one** adjustment appears in Cin7.

> A second adjustment here is a **serious** bug — report immediately and stop testing.

---

## Phase 3 — Regression. The existing sale flow must be unaffected.

- [ ] Add a serialised product to a POS cart → the **Serial numbers** tile highlights as before.
- [ ] Open it, pick a serial, complete the sale → `Serial Number` appears on the completed order.
- [ ] Barcode **scan-to-select** still works in the picker.
- [ ] Quantity > 1 still splits the line correctly.
- [ ] A serial already chosen on another cart line is still excluded from the list.

### 3.1 The transform/sale interaction

- [ ] Transform a serial, then **immediately** add that product to a cart and open the picker.
- [ ] The picker should show the **new** serial and not the old one.

> The list is served from a 45-second cache. The transform now invalidates it, but this is
> best-effort — Cin7 queues the adjustment as a task, so a brief lag is possible. If the old
> serial lingers, wait 45 seconds and re-open. **Lingering is a known limitation, not a
> stock error** — every guard reads Cin7 directly, so a stale list can never cause a bad write.

---

## Phase 4 — Staff login

- [ ] Repeat **1.1** and one **dry run** from **1.2** while signed in as a **POS staff member
      with a PIN**, not a full Shopify account.

> This is genuinely untested. Shopify's docs note that POS staff aren't authenticated users
> in the sense the backend-auth path relies on. Direct API access (the serial *list*) is
> documented not to carry that constraint and has been confirmed working on a device, but
> `/api/pos/serials` and `/api/pos/serial-transform` both call the backend. If staff logins
> fail here, it affects the **existing** sale flow too, not just these features.

---

## Report back

For each failure: the phase, what you saw, what you expected, the serial and location, and
— if Cin7 was touched — the task id.

**Stop testing immediately** if: a double-tap produces two adjustments; an adjustment appears
after a *refusal*; or a transform changes stock for any serial other than the two on screen.
