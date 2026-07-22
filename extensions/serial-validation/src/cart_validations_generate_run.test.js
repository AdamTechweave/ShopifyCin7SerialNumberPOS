import {describe, it, expect} from "vitest";
import {cartValidationsGenerateRun} from "./cart_validations_generate_run";

function line({quantity = 1, serial = null, serialized = true, title = "Widget"} = {}) {
  return {
    quantity,
    serialNumber: serial === null ? null : {value: serial},
    merchandise: {
      __typename: "ProductVariant",
      product: {title, hasAnyTag: serialized},
    },
  };
}

function errorsFor(lines) {
  return cartValidationsGenerateRun({cart: {lines}}).operations[0].validationAdd.errors;
}

describe("cartValidationsGenerateRun", () => {
  it("passes a cart with no serialized products", () => {
    expect(errorsFor([line({serialized: false})])).toEqual([]);
  });

  it("passes a serialized line with qty 1 and a serial", () => {
    expect(errorsFor([line({serial: "SN-001"})])).toEqual([]);
  });

  it("blocks a serialized line with no serial", () => {
    const errors = errorsFor([line({title: "iPhone 15"})]);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("iPhone 15");
    expect(errors[0].target).toBe("$.cart");
  });

  it("blocks a serialized line with a blank serial", () => {
    expect(errorsFor([line({serial: "   "})])).toHaveLength(1);
  });

  it("blocks a serialized line with quantity > 1 even when a serial is set", () => {
    const errors = errorsFor([line({quantity: 2, serial: "SN-001"})]);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("one serial number per unit");
  });

  it("blocks duplicate serials across lines", () => {
    const errors = errorsFor([line({serial: "SN-001"}), line({serial: "SN-001"})]);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("SN-001");
  });

  it("ignores custom-sale (non-variant) lines", () => {
    const custom = {quantity: 1, serialNumber: null, merchandise: {__typename: "CustomProduct"}};
    expect(errorsFor([custom])).toEqual([]);
  });
});
