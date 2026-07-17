export const SERIAL_PROPERTY_KEY = "Serial Number";

export interface CartLineLike {
  uuid: string;
  quantity: number;
  productId: number;
  variantId: number;
  sku: string;
  title: string;
  properties: Record<string, string>;
}

export interface AvailableSerial {
  serial: string;
  locationName: string;
  available: number;
  isCurrentLocation: boolean;
}

// The real POS `LineItem` type (`@shopify/ui-extensions`) has OPTIONAL
// `productId` / `variantId` / `sku` / `title` (custom sales have no product
// association). `CartLineLike` requires them because only lines tied to a
// real product can ever be serialized. This structural type only names the
// fields the normalizer reads, so both `Tile.tsx` and `Modal.tsx` can pass
// their (differently-aliased) POS line item objects straight through
// without an extra cast.
export interface RawPosLineItem {
  uuid: string;
  quantity: number;
  productId?: number;
  variantId?: number;
  sku?: string;
  title?: string;
  properties: Record<string, string>;
}

// Shared by Tile.tsx and Modal.tsx: drops lines that aren't tied to a real
// product (e.g. custom sales) rather than widening `CartLineLike`.
export function toCartLine(line: RawPosLineItem): CartLineLike | null {
  if (line.productId === undefined) return null;
  return {
    uuid: line.uuid,
    quantity: line.quantity,
    productId: line.productId,
    variantId: line.variantId ?? 0,
    sku: line.sku ?? "",
    title: line.title ?? "",
    properties: line.properties,
  };
}

export function serializedLines<T extends CartLineLike>(
  lines: T[],
  serializedMap: Record<string, boolean>,
): T[] {
  return lines.filter((line) => serializedMap[String(line.productId)]);
}

export function unitsNeedingSerial(
  lines: CartLineLike[],
  serializedMap: Record<string, boolean>,
): number {
  return serializedLines(lines, serializedMap).reduce((sum, line) => {
    const satisfied =
      line.quantity === 1 && Boolean(line.properties[SERIAL_PROPERTY_KEY]?.trim());
    return sum + (satisfied ? 0 : line.quantity);
  }, 0);
}

function serialsInCart(lines: CartLineLike[], exceptUuid?: string): Set<string> {
  const taken = new Set<string>();
  for (const line of lines) {
    if (line.uuid === exceptUuid) continue;
    const value = line.properties[SERIAL_PROPERTY_KEY]?.trim();
    if (value) taken.add(value);
  }
  return taken;
}

export function excludeInCart(
  serials: AvailableSerial[],
  lines: CartLineLike[],
  exceptUuid?: string,
): AvailableSerial[] {
  const taken = serialsInCart(lines, exceptUuid);
  return serials.filter((s) => !taken.has(s.serial));
}

export function matchScan(
  serials: AvailableSerial[],
  scanned: string,
): AvailableSerial | undefined {
  const needle = scanned.trim().toLowerCase();
  if (!needle) return undefined;
  return serials.find((s) => s.serial.trim().toLowerCase() === needle);
}
