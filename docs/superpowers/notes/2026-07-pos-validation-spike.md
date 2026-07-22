# SPIKE — Does the `serial-validation` function block POS checkout?

## VERDICT: PENDING HUMAN TEST

This is the riskiest unknown in the project. Shopify does not document validation
functions running on POS checkout. Steps 1–3 below (deploy, test product,
activation) needed to happen before the online control test and the POS test —
this worksheet exists so the human only has to do the parts that require a
Partner login, a dev store, and a physical/simulated POS device.

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

- [ ] **Step 2: Prepare a test product** **[HUMAN or via GraphiQL]**

  On the dev store: create product "Spike Serial Test", any price, tag
  `serialized`, tracked SKU optional (not needed for this spike). Make it
  available to the POS sales channel.

- [ ] **Step 3: Activate the validation**

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

- [ ] **Step 4: Verify online blocking (control test)**

  On the dev store's online storefront, add "Spike Serial Test" to the cart
  and attempt checkout.
  Expected: checkout blocked with "Select a serial number for Spike Serial
  Test…". This proves the function itself works.
  - Record here: what actually happened = ____________________

- [ ] **Step 5: Verify POS blocking (the actual spike)**
  **[HUMAN — needs POS app on device/simulator logged into the dev store]**

  In Shopify POS: add "Spike Serial Test" to the cart, tap Checkout/Pay,
  attempt to complete the sale (use a cash payment).
  Record exactly what happens: blocked with our message / blocked silently /
  sale completes.
  - Record here: what actually happened = ____________________

- [ ] **Step 6: Write the verdict**

  Fill in the results table below and set the VERDICT header at the top of
  this file to one of:
  - **GO**: POS blocked → hard-block requirement fully met.
  - **NO-GO**: POS not blocked → POS enforcement is tile/modal UX only; the
    function stays for online channels. **Report this to the user
    immediately** — the client chose hard-block deliberately. NO-GO does not
    stop the plan.

- [ ] **Step 7: Commit**

  ```bash
  git add docs/superpowers/notes
  git commit -m "docs: record POS validation-function spike result"
  ```

---

## 3. Results table

| Date | POS app version | Dev store | Online result | POS result | Verdict | Notes |
|------|-----------------|-----------|----------------|-------------|---------|-------|
|      |                 |           |                |             |         |       |

Screenshots (if available), file paths or links:
- Online checkout block screenshot: ____________________
- POS checkout attempt screenshot: ____________________
