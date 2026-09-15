export class TtlCache<V> {
  private store = new Map<string, {value: V; expires: number}>();

  constructor(private ttlMs: number, private now: () => number = Date.now) {}

  get(key: string): V | undefined {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (this.now() > hit.expires) {
      this.store.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: V): void {
    this.store.set(key, {value, expires: this.now() + this.ttlMs});
  }

  delete(key: string): void {
    this.store.delete(key);
  }
}
