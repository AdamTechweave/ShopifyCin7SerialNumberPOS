// Moved here from the backend (`app/services/tags.server.ts`) when the tag
// lookup switched to POS direct API access — the extension now queries the
// Admin API itself, so it needs the mapping logic on-device.

// The product tag marking serial-tracked products. This was the `SERIAL_TAG`
// env var while the lookup lived on the backend; a client bundle can't read
// server env, so it is a build-time constant now. Same trade as the
// `Serial Number` property key: one app deployment per client, so changing it
// for a client is a code edit plus `shopify app deploy` rather than an env
// change. If a client ever needs a different tag, change it here.
export const SERIAL_TAG = "serialized";

export function toProductGid(productId: number): string {
  return `gid://shopify/Product/${productId}`;
}

export function buildSerializedMap(
  nodes: Array<{id: string; tags: string[]} | null>,
  serialTag: string,
): Record<string, boolean> {
  const map: Record<string, boolean> = {};
  for (const node of nodes) {
    if (!node?.id) continue;
    const numericId = node.id.split("/").pop();
    if (!numericId) continue;
    map[numericId] = node.tags.includes(serialTag);
  }
  return map;
}
