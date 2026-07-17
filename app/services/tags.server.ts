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
