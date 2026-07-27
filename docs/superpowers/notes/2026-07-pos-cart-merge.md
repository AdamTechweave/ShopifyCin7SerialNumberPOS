# POS cart line merging — undocumented behaviour (traced on device 2026-07-26)

Splitting a qty>1 line so each unit carries its own serial turned out to be the
hardest part of this app. Shopify documents none of the behaviour below; it was
established by instrumenting the extension and reading traces from a real POS
device. Recorded here because anyone touching `lib/assignSerial.ts` will
otherwise rediscover it the slow way.

## What the Cart API does not give you

- `addLineItem(variantId, quantity)` — **no `properties` argument**. Checked in
  `@shopify/ui-extensions` 2026.4.4 (the docs' `AddLineItemOptions` with
  `properties` does not exist in the shipped types).
- **No quantity setter.** No `updateLineItem`, no `setLineItemQuantity`. The only
  way to change a line's quantity is remove + re-add.
- `bulkCartUpdate` exists and is atomic, but its `lineItems` **completely replace
  cart contents**, so it would drop discounts, custom sales, selling plans and
  staff attribution on unrelated lines. Rejected for that reason.

So a split has to be composed from `addLineItem` / `addLineItemProperties` /
`removeLineItem` — which runs straight into merging.

## Merge rules, as observed

1. **A newly added line merges into an existing same-variant line when both look
   propertyless**, and `addLineItem` then returns **that existing line's uuid**,
   not a new one. This is the trap: code that assumes a fresh uuid will tag the
   merged line and then delete it.

   Trace: original line qty 2 → `addLineItem(variantId, 1)` returned
   `5BF4779F…` (the original's own uuid) and the line became qty 3.

2. **A visible property prevents the merge.** In the same trace, a later
   `addLineItem` against a line carrying `Serial Number` returned a genuinely new
   uuid and created a separate line.

3. **Underscore-prefixed (hidden) properties do NOT prevent the merge.** This one
   cost the most time. A `_serialSplitPending` marker was confirmed present in
   cart state before the add (the extension waited for it and logged
   `waitForProperty → true`, with the property visible in the snapshot), and the
   add *still* merged. Shopify hides underscore-prefixed properties from order and
   receipt display, and POS evidently excludes them from the comparison it uses to
   decide whether two lines are the same.

   Consequence: the split marker **must be a visible key**. It is
   `"Serial assignment": "in progress"` and exists only between the first and last
   step of a split.

4. **`addLineItemProperties` resolving does not mean the property is visible.**
   The returned value is a fulfilled Redux thunk action, and the cart snapshot
   taken immediately afterwards still showed no properties. The merge decision
   reads the visible state, so a tag-then-immediately-add sequence merges even
   though the write "succeeded". `waitForProperty` (in `lib/cartOps.ts`) waits on
   the cart signal before adding.

5. **`removeLineItemProperties` did not clear a hidden key** in the traces — the
   marker persisted on the line afterwards. Untested for visible keys. Rollback
   attempts it and reports `cartIntact: false` if the cart may be left untidy.

## Resulting algorithm

For qty > 1 (`lib/assignSerial.ts`):

1. tag the original with the **visible** split marker
2. wait until that marker is observable in cart state
3. `addLineItem(variantId, 1)` → serialized unit; **verify the returned uuid is
   not the original's** (a merge means refuse, never tag or remove)
4. tag it with the real `Serial Number`
5. `addLineItem(variantId, quantity - 1)` → remainder; verify its uuid too
6. remove the original **last** — this also discards the marker

Everything is built before the original is removed, so any failure leaves the
cart over-counted (obvious to staff) rather than short. The earlier bug did the
opposite and silently destroyed a unit along with its serial.

## Diagnostics

`lib/traceCart.ts` wraps `CartOps`, records every mutation with the cart state
observed after it, and posts to `/api/pos/debug` (`app/routes/api.pos.debug.tsx`),
which prints to the `shopify app dev` output. **Both are temporary** — remove them
once splitting is confirmed stable on device. They are the only way to see what
POS actually does.

## Fallback if splitting proves unreliable

Store multiple serials in a single property on one line
(`"Serial Number": "B2618406, B456852"`). This was considered during the original
brainstorm and needs no splitting at all, so it is immune to every rule above.
The cost is that the phase-2 Cin7 allocation service must parse a delimited list,
and one order line no longer maps to one physical unit.
