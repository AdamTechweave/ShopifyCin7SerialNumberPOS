export interface AppConfig {
  cin7AccountId: string;
  cin7ApplicationKey: string;
  serialTag: string;
  serialPropertyKey: string;
  /** Shopify numeric location ID (as string) → Cin7 location name */
  locationMap: Record<string, string>;
}

type EnvLike = Record<string, string | undefined>;

export function loadConfig(env: EnvLike = process.env): AppConfig {
  const required = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`Missing required env var ${name}`);
    return value;
  };

  let locationMap: Record<string, string> = {};
  if (env.CIN7_LOCATION_MAP) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(env.CIN7_LOCATION_MAP);
    } catch {
      throw new Error(
        "CIN7_LOCATION_MAP must be valid JSON ({\"<shopify location id>\": \"<Cin7 location name>\"})",
      );
    }
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      !Object.values(parsed).every((value) => typeof value === "string")
    ) {
      throw new Error(
        "CIN7_LOCATION_MAP must be a JSON object mapping Shopify location IDs to Cin7 location names",
      );
    }
    locationMap = parsed as Record<string, string>;
  }

  return {
    cin7AccountId: required("CIN7_ACCOUNT_ID"),
    cin7ApplicationKey: required("CIN7_APPLICATION_KEY"),
    serialTag: env.SERIAL_TAG || "serialized",
    serialPropertyKey: env.SERIAL_PROPERTY_KEY || "Serial Number",
    locationMap,
  };
}

let cached: AppConfig | undefined;

export function getConfig(): AppConfig {
  if (!cached) cached = loadConfig();
  return cached;
}
