export interface Cin7AvailabilityRow {
  ID: string;
  SKU: string;
  Name: string;
  Barcode: string | null;
  Location: string;
  Bin: string | null;
  /** Batch OR serial number; null for non-tracked stock or unpicked allocations */
  Batch: string | null;
  ExpiryDate: string | null;
  OnHand: number;
  Allocated: number;
  Available: number;
  OnOrder: number;
  StockOnHand: number;
  InTransit: number;
  NextDeliveryDate: string | null;
}

export type Cin7ErrorCode = "RATE_LIMITED" | "UNREACHABLE" | "AUTH_FAILED" | "BAD_RESPONSE";

export class Cin7Error extends Error {
  constructor(public code: Cin7ErrorCode, message: string) {
    super(message);
    this.name = "Cin7Error";
  }
}

const BASE_URL = "https://inventory.dearsystems.com/ExternalApi/v2";
const REQUEST_TIMEOUT_MS = 30_000;

export class Cin7Client {
  constructor(
    private accountId: string,
    private applicationKey: string,
    private fetchFn: typeof fetch = fetch,
  ) {}

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    opts: {params?: Record<string, string>; body?: unknown} = {},
  ): Promise<T> {
    const url = new URL(`${BASE_URL}/${path}`);
    for (const [key, value] of Object.entries(opts.params ?? {})) {
      url.searchParams.set(key, value);
    }

    let response: Response;
    try {
      response = await this.fetchFn(url.toString(), {
        method,
        headers: {
          "api-auth-accountid": this.accountId,
          "api-auth-applicationkey": this.applicationKey,
          "Content-Type": "application/json",
        },
        ...(opts.body === undefined ? {} : {body: JSON.stringify(opts.body)}),
        // Node's fetch has no default timeout. Without this a stalled Cin7
        // connection hangs the request forever — and mid-stock-adjustment that
        // leaves the write's outcome genuinely unknown.
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new Cin7Error("UNREACHABLE", `Cin7 request failed: ${error}`);
    }

    if (response.status === 429 || response.status === 503) {
      throw new Cin7Error("RATE_LIMITED", `Cin7 rate limit hit (${response.status})`);
    }
    if (response.status === 401 || response.status === 403) {
      throw new Cin7Error("AUTH_FAILED", `Cin7 rejected credentials (${response.status})`);
    }
    if (!response.ok) {
      throw new Cin7Error("BAD_RESPONSE", `Cin7 returned ${response.status}`);
    }
    return response.json() as Promise<T>;
  }

  private get<T>(path: string, params: Record<string, string>): Promise<T> {
    return this.request<T>("GET", path, {params});
  }

  async getAvailability(sku: string): Promise<Cin7AvailabilityRow[]> {
    const data = await this.get<{ProductAvailabilityList?: Cin7AvailabilityRow[]}>(
      "ref/productavailability",
      {Sku: sku, Page: "1", Limit: "1000"},
    );
    return data.ProductAvailabilityList ?? [];
  }

  async skuExists(sku: string): Promise<boolean> {
    const data = await this.get<{Products?: unknown[]}>("product", {Sku: sku, Page: "1", Limit: "1"});
    return (data.Products?.length ?? 0) > 0;
  }
}
