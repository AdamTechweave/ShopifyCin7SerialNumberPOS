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

export interface StockAdjustmentLine {
  SKU: string;
  BatchSN: string;
  /** Cin7 treats this as the NEW absolute QuantityOnHand, not a delta. */
  Quantity: number;
  UnitCost: number;
  Location: string;
}

export interface StockAdjustmentPayload {
  EffectiveDate: string;
  Status: "COMPLETED";
  Reference: string;
  Comment: string;
  /** Defaults to false in Cin7, which adjusts *available* rather than *on hand*. */
  UpdateOnHand: true;
  Lines: StockAdjustmentLine[];
}

export interface StockAdjustmentResponse {
  TaskID?: string;
  ExistingStockLines?: unknown[];
  NewStockLines?: unknown[];
}

export interface Cin7Movement {
  BatchSN: string | null;
  Location: string;
  Quantity: number;
  /** Cost of the whole movement (all `Quantity` units), not a per-unit cost — divide by `Quantity` to get one. */
  Amount: number;
  Date: string;
  Type: string;
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
      const detail = await response.text().catch(() => "");
      throw new Cin7Error(
        "BAD_RESPONSE",
        `Cin7 returned ${response.status}${detail ? `: ${detail.slice(0, 500)}` : ""}`,
      );
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
    // KNOWN ISSUE, deliberately not fixed here: /product's Sku filter is a
    // CONTAINS match (see getProductWithMovements), so this returns true when
    // only a SKU *containing* `sku` exists. Consequence is limited to the
    // picker reporting "no stock" rather than "SKU not found" — and the wrong
    // answer is cached for SKU_EXISTS_TTL_MS (see serials.server.ts). No write
    // path depends on it. The failure is one-directional: a real SKU always
    // contains itself, so this never wrongly reports a genuine product as missing.
    const data = await this.get<{Products?: unknown[]}>("product", {Sku: sku, Page: "1", Limit: "1"});
    return (data.Products?.length ?? 0) > 0;
  }

  async createStockAdjustment(payload: StockAdjustmentPayload): Promise<StockAdjustmentResponse> {
    return this.request<StockAdjustmentResponse>("POST", "stockadjustment", {body: payload});
  }

  async getProductWithMovements(
    sku: string,
  ): Promise<{SKU?: string; AverageCost?: number; Movements?: Cin7Movement[]}> {
    const data = await this.request<{
      Products?: Array<{SKU?: string; AverageCost?: number; Movements?: Cin7Movement[]}>;
    }>("GET", "product", {params: {Sku: sku, IncludeMovements: "true", Page: "1", Limit: "100"}});
    // Cin7's /product Sku filter is a CONTAINS match, not exact: asking for
    // "BIKE" also returns "BIKE-CARBON". Taking [0] would resolve a cost from
    // the wrong product, so match the SKU exactly and fall through to {} —
    // which resolveUnitCost already treats as "refuse to guess".
    return data.Products?.find((p) => p.SKU === sku) ?? {};
  }
}
