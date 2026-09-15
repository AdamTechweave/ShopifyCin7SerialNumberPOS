import {Cin7Client, type Cin7AvailabilityRow} from "./cin7.server";
import {TtlCache} from "./cache.server";
import {getConfig} from "../config.server";

export interface AvailableSerial {
  serial: string;
  locationName: string;
  available: number;
  isCurrentLocation: boolean;
}

export type SerialLookupResult =
  | {status: "ok"; serials: AvailableSerial[]; currentLocationName: string | null}
  | {status: "sku_not_found"}
  | {status: "no_stock"};

export function groupSerials(
  rows: Cin7AvailabilityRow[],
  currentLocationName: string | null,
): AvailableSerial[] {
  return rows
    .filter((r) => r.Batch !== null && r.Batch !== "" && r.Available > 0)
    .map((r) => ({
      // Cin7's Batch can arrive as a JSON number for a purely numeric
      // serial — String() converts it for real, where `as string` would
      // only have relabelled the type and left a number at runtime.
      serial: String(r.Batch),
      locationName: r.Location,
      available: r.Available,
      isCurrentLocation: r.Location === currentLocationName,
    }))
    .sort((a, b) => {
      if (a.isCurrentLocation !== b.isCurrentLocation) return a.isCurrentLocation ? -1 : 1;
      if (a.locationName !== b.locationName) return a.locationName.localeCompare(b.locationName);
      return a.serial.localeCompare(b.serial);
    });
}

const AVAILABILITY_TTL_MS = 45_000;
const SKU_EXISTS_TTL_MS = 10 * 60_000;

export class SerialService {
  private availabilityCache = new TtlCache<Cin7AvailabilityRow[]>(AVAILABILITY_TTL_MS);
  private skuExistsCache = new TtlCache<boolean>(SKU_EXISTS_TTL_MS);

  constructor(
    private client: Cin7Client,
    private locationMap: Record<string, string>,
  ) {}

  async lookup(sku: string, shopifyLocationId: string): Promise<SerialLookupResult> {
    let rows = this.availabilityCache.get(sku);
    if (!rows) {
      rows = await this.client.getAvailability(sku);
      this.availabilityCache.set(sku, rows);
    }

    const currentLocationName = this.locationMap[shopifyLocationId] ?? null;
    const serials = groupSerials(rows, currentLocationName);
    if (serials.length > 0) return {status: "ok", serials, currentLocationName};

    let exists = this.skuExistsCache.get(sku);
    if (exists === undefined) {
      exists = await this.client.skuExists(sku);
      this.skuExistsCache.set(sku, exists);
    }
    return exists ? {status: "no_stock"} : {status: "sku_not_found"};
  }
}

let singleton: SerialService | undefined;

export function getSerialService(): SerialService {
  if (!singleton) {
    const config = getConfig();
    singleton = new SerialService(
      new Cin7Client(config.cin7AccountId, config.cin7ApplicationKey),
      config.locationMap,
    );
  }
  return singleton;
}
