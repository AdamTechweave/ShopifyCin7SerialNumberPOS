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
already cached (no login prompt) — confirms Task 1's `config link` persisted.

**Attempt 1** — `shopify app deploy --force`
The brief's suggested flag does not exist on this CLI version:

```
Nonexistent flag: --force
```

**Attempt 2** — `shopify app deploy --allow-updates --no-color` (the CLI 4.5.1
equivalent of "skip the release confirmation prompt")
Auth was fine (no prompt). The build step succeeded — `serial-validation`
compiled and bundled cleanly:

```
serial-validation │ Building function serial-validation...
serial-validation │ Building GraphQL types...
serial-validation │ Bundling JS function...
serial-validation │ Running javy...
serial-validation │ Done!
```

But version creation failed with a **real, deterministic config error** — not
an auth/TTY issue, so a third identical attempt would not help:

```
Version couldn't be created.
[product]: Requires the following access scope: write_products
```

**Root cause:** `shopify.app.toml` still carries the React Router template's
demo scaffold blocks (`[product.metafields.app.demo_info]` and
`[metaobjects.app.example]`, used only by the default `app._index.tsx` demo
page). Task 1 deliberately set `access_scopes` to `read_products,write_validations`
only (no `write_products`) and deliberately left the demo blocks in place as
YAGNI. Newer CLI versions now force "include config on deploy" for everything
in `shopify.app.toml`, so the demo product-metafield definition's
`merchant_read_write` access now gets validated against scopes at deploy time
and fails.

**This blocks Step 1 (Deploy) below until a human decides one of:**
- **(a)** Add `write_products` to `access_scopes` in `shopify.app.toml` (scope
  creep for demo-only functionality — will show up as a new permission on the
  merchant's app-scope consent screen), or
- **(b)** Delete the `[product.metafields.app.demo_info]` and
  `[metaobjects.app.example]` blocks from `shopify.app.toml` (and the matching
  demo code in `app/routes/app._index.tsx` if you don't want it to break) since
  neither is used by the actual serial-number feature.

I did not make this change myself — it's a scope/product decision, not a
mechanical fix, and it reverses a deliberate choice from Task 1.

**Side effect (uncommitted, not part of this commit):** running `deploy` also
auto-stripped a deprecated field from `shopify.app.toml`:

```
The `include_config_on_deploy` field is no longer supported, since all
apps must now include configuration on deploy. It has been removed from
your configuration file.
```

That single-line removal (`[build] include_config_on_deploy = true`) is
currently sitting as an unstaged, uncommitted diff in the working tree. It's
harmless and the CLI will keep re-stripping it on every future deploy attempt
regardless — left as-is for the human to fold into whichever commit fixes (a)
or (b) above.

**No version was created.** Nothing to report as a version id/number.

---

## 2. Remaining human steps (verbatim from the task brief)

Do these in order. Steps 2–6 all require things the agent doesn't have:
Partner/store auth for a live deploy, a dev store to create a product in, and
a POS app on a device or simulator.

- [ ] **Step 0 (new, found by the agent): unblock the deploy.** Either add
  `write_products` to `access_scopes` in `shopify.app.toml`, or delete the
  `[product.metafields.app.demo_info]` / `[metaobjects.app.example]` blocks
  (see root cause above). Then re-run deploy per Step 1.

- [ ] **Step 1: Deploy** **[HUMAN — needs Partner auth]**

  ```bash
  shopify app deploy
  ```

  Expected: version created including the `serial-validation` function.

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
