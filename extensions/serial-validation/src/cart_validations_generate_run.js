// @ts-check
/**
 * @typedef {import("../generated/api").CartValidationsGenerateRunInput} CartValidationsGenerateRunInput
 * @typedef {import("../generated/api").CartValidationsGenerateRunResult} CartValidationsGenerateRunResult
 */

/**
 * Blocks checkout unless every line whose product carries the serial tag has
 * quantity 1, a non-empty "Serial Number" attribute, and a cart-unique serial.
 *
 * @param {CartValidationsGenerateRunInput} input
 * @returns {CartValidationsGenerateRunResult}
 */
export function cartValidationsGenerateRun(input) {
  const errors = [];
  const seen = new Set();

  for (const line of input.cart.lines) {
    if (line.merchandise.__typename !== "ProductVariant") continue;
    if (!line.merchandise.product.hasAnyTag) continue;

    const title = line.merchandise.product.title;
    const serial = line.serialNumber?.value?.trim();

    if (line.quantity !== 1) {
      errors.push({
        message: `Assign one serial number per unit of ${title} (tap the Serial numbers tile).`,
        target: "$.cart",
      });
      continue;
    }
    if (!serial) {
      errors.push({
        message: `Select a serial number for ${title} (tap the Serial numbers tile).`,
        target: "$.cart",
      });
      continue;
    }
    if (seen.has(serial)) {
      errors.push({
        message: `Serial number ${serial} is selected more than once in this cart.`,
        target: "$.cart",
      });
    }
    seen.add(serial);
  }

  return {operations: [{validationAdd: {errors}}]};
}
