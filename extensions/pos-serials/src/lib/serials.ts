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
