/**
 * Parsing and normalising the price a staff member types for a custom sale.
 *
 * `CustomSale.price` is a currency *string*, so this returns a normalised
 * string rather than a number — it is what gets sent verbatim, and money
 * should not make a round trip through a float on the way.
 */

export type PriceParse =
  | {ok: true; price: string}
  | {ok: false; reason: "empty" | "not_a_number" | "not_positive" | "too_many_decimals"};

/** Optional currency symbol, optional thousands separators, optional decimals. */
const NUMERIC = /^-?\d+(\.\d+)?$/;

export function parsePrice(input: string): PriceParse {
  // Strip whitespace, a leading currency symbol, and thousands separators.
  // Deliberately a narrow symbol set, not "any leading non-digit": a greedy
  // strip reduces "abc" and "Infinity" to an empty string, which would then
  // report as "enter a price" rather than "that isn't a valid amount".
  const cleaned = input.trim().replace(/^[\s$£€¥]+/, "").replace(/,/g, "");

  if (cleaned === "") return {ok: false, reason: "empty"};
  if (!NUMERIC.test(cleaned)) return {ok: false, reason: "not_a_number"};

  const decimals = cleaned.split(".")[1];
  // Reject rather than round: silently turning 12.345 into 12.35 changes what
  // the customer is charged without anyone seeing it happen.
  if (decimals !== undefined && decimals.length > 2) {
    return {ok: false, reason: "too_many_decimals"};
  }

  const value = Number(cleaned);
  if (!Number.isFinite(value)) return {ok: false, reason: "not_a_number"};
  if (value <= 0) return {ok: false, reason: "not_positive"};

  return {ok: true, price: value.toFixed(2)};
}

/** Staff-facing copy for each rejection. */
export const PRICE_ERROR: Record<Exclude<PriceParse, {ok: true}>["reason"], string> = {
  empty: "Enter a price.",
  not_a_number: "That isn't a valid amount.",
  not_positive: "Enter an amount greater than zero.",
  too_many_decimals: "Use at most two decimal places.",
};
