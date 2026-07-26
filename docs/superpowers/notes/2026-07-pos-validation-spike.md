# SPIKE — Does the `serial-validation` function block POS checkout?

## VERDICT: **NO-GO** (tested 2026-07-22)

**Cart & checkout validation functions do not run on Shopify POS checkout.**
Same store, same active validation: online checkout was blocked (Step 4), and a
POS cash sale of the same untagged-serial product completed with no block, no
message, nothing (Step 5). The POS UI extension was not installed on the device
during this test, which does not affect the result — validation functions
execute server-side from cart line properties and product tags, independently
of any UI extension.

**Compounding requirement change (from the client, same session):** online
checkout must NOT be blocked at all. Online orders get their serials assigned
at pick time in Cin7; only POS needs enforcement, because that is where the
physical unit is handed to the customer.

**Consequence:** the validation function blocks only the channel the client
wants left alone, and cannot block the channel they care about. It has no
remaining use for this client and **must never be activated on a client
store.** POS enforcement is the tile + modal UX (badge count, "N serials
needed", picker) — a hard block is not achievable on POS with any current
Shopify mechanism (checkout UI extensions' `block_progress` / buyer-journey
intercept is web checkout only; POS UI extension targets cannot prevent
payment).

This was the riskiest unknown in the project — Shopify does not document whether
validation functions run on POS checkout. It is now settled by direct test. The
record of how it was tested is preserved below.

---

## 1. Deploy result (automated attempt — done by agent)

**Environment:** `shopify` CLI 4.5.1, app `Cin7SerialProducts`
(`client_id = 8e72081fdb833e699b901d79864fca91`), org `Techweave`. Auth was
already cached (no login prompt).

**Blocker (fixed):** the template's demo scaffold blocks —
`[product.metafields.app.demo_info]` and `[metaobjects.app.example]` — were
still present in `shopify.app.toml` and required `write_products`, which
conflicts with the plan's mandated scopes (`read_products,write_validations`
only). Both blocks have been deleted; they were unused by the actual
serial-number feature.

**Deploy succeeded** on retry (`shopify app deploy --allow-updates` — the
CLI 4.5.1 flag that replaces the brief's `--force`, since `--force` no longer
exists on this CLI version). The `serial-validation` function built and
bundled cleanly, and a new version was released:

```
New version released to users.
cin7serialproducts-2
https://dev.shopify.com/dashboard/129007199/apps/398568587265/versions/1054740217857
```

The human checklist below now starts at **Step 2 (create the test
product)** — deploy is done.

---

## 2. Remaining human steps (verbatim from the task brief)

Do these in order. Steps 2–6 all require things the agent doesn't have:
a dev store to create a product in, and a POS app on a device or simulator.

- [x] **Step 1: Deploy** — done by the agent. Demo config removed, version
  `cin7serialproducts-2` released (see Section 1 above).

- [x] **Step 2: Prepare a test product** **[HUMAN or via GraphiQL]**

  On the dev store: create product "Spike Serial Test", any price, tag
  `serialized`, tracked SKU optional (not needed for this spike). Make it
  available to the POS sales channel.

- [x] **Step 3: Activate the validation** — done; validation created and confirmed active (online block in Step 4 proves it)

  Start `shopify app dev`, open its GraphiQL (dev console → GraphiQL), and run
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

  Expected: `userErrors: []`, validation enabled. Also verify in the store
  admin: **Settings → Checkout → Checkout Rules** shows "Serial numbers
  required" active.
  - Record here: `userErrors` returned = ____________________
  - Record here: Checkout Rules shows it active? Y / N

- [x] **Step 4: Verify online blocking (control test)**

  On the dev store's online storefront, add "Spike Serial Test" to the cart
  and attempt checkout.
  Expected: checkout blocked with "Select a serial number for Spike Serial
  Test…". This proves the function itself works.
  - Record here: what actually happened = **BLOCKED at add-to-cart with
    "Select a serial number for Spike Serial Test (tap the Serial numbers
    tile)." (2026-07-22, dev store). Function confirmed working online.**
  - **⚠️ REQUIREMENT CHANGE surfaced by this test:** the client does NOT want
    online checkout blocked — online orders get serials assigned at pick time
    in Cin7. Enforcement must apply to POS only (product handed over at point
    of sale). A channel-scoping fix was considered (POS extension stamps a
    cart-level marker; the function enforces only when the marker is present,
    since the function input exposes no native channel/source field) — but
    Step 5 made it moot: with POS unenforceable, scoping the function to POS
    would leave it doing nothing at all. The validation stays deactivated.

- [x] **Step 5: Verify POS blocking (the actual spike)**
  **[HUMAN — needs POS app on device/simulator logged into the dev store]**

  In Shopify POS: add "Spike Serial Test" to the cart, tap Checkout/Pay,
  attempt to complete the sale (use a cash payment).
  Record exactly what happens: blocked with our message / blocked silently /
  sale completes.
  - Record here: what actually happened = **SALE COMPLETED. No validation
    fired, no message, no block** (2026-07-22, dev store, validation active
    and confirmed working online in Step 4). Cart & checkout validation
    functions do NOT run on Shopify POS checkout.

- [x] **Step 6: Write the verdict** — NO-GO, recorded at the top of this file

  Fill in the results table below and set the VERDICT header at the top of
  this file to one of:
  - **GO**: POS blocked → hard-block requirement fully met.
  - **NO-GO**: POS not blocked → POS enforcement is tile/modal UX only.
    (Original wording said "the function stays for online channels" — void:
    the client does not want online blocked either, so the function is left
    deactivated entirely.) **Report to the user immediately** — the client
    chose hard-block deliberately. NO-GO does not stop the plan.

- [x] **Step 7: Commit**

  ```bash
  git add docs/superpowers/notes
  git commit -m "docs: record POS validation-function spike result"
  ```

---

## 3. Results table

| Date | Dev store | Online result | POS result | Verdict |
|---|---|---|---|---|
| 2026-07-22 | Techweave dev store | **Blocked** at add-to-cart: "Select a serial number for Spike Serial Test (tap the Serial numbers tile)." | **Sale completed** — no block, no message | **NO-GO** |

Notes: POS UI extension tile was not installed on the device during the POS test.
This does not invalidate the result — validation functions run server-side from
cart line properties and product tags, with no dependency on any UI extension, and
the same validation demonstrably fired online moments earlier.

Follow-up actions taken: validation must never be activated on a client store
(README rollout step 7 rewritten as a warning + removal mutation); spec
requirement 7 marked superseded; POS enforcement is prompt-only.

Screenshots (if available), file paths or links:
- Online checkout block screenshot: ____________________
- POS checkout attempt screenshot: ____________________
