import type {Session} from "@shopify/shopify-api";
import type {SessionStorage} from "@shopify/shopify-app-session-storage";

/**
 * Sessions live in process, not in a database.
 *
 * Nothing in this app needs a session to survive a restart. The POS endpoints
 * authenticate with `authenticate.public.checkout`, which only verifies the
 * session token's signature, and the extension queries the Admin API through
 * POS direct API access rather than through a stored offline token. What is
 * left — the OAuth callback and the embedded admin pages — goes through
 * `authenticate.admin`, which mints a token from the request's ID token via
 * token exchange, so a cold start costs one extra exchange and nothing else.
 *
 * This is what lets the app run with no database at all. Do not reach for a
 * persistent store again without first checking whether something has started
 * calling `unauthenticated.admin`, which needs a *stored* session and cannot
 * mint one on demand.
 */
class MemorySessionStorage implements SessionStorage {
  private sessions = new Map<string, Session>();

  async storeSession(session: Session): Promise<boolean> {
    this.sessions.set(session.id, session);
    return true;
  }

  async loadSession(id: string): Promise<Session | undefined> {
    return this.sessions.get(id);
  }

  async deleteSession(id: string): Promise<boolean> {
    this.sessions.delete(id);
    return true;
  }

  async deleteSessions(ids: string[]): Promise<boolean> {
    for (const id of ids) this.sessions.delete(id);
    return true;
  }

  async findSessionsByShop(shop: string): Promise<Session[]> {
    return [...this.sessions.values()].filter((session) => session.shop === shop);
  }
}

// Reused across hot reloads in dev, the same way the Prisma client was.
declare global {
  // eslint-disable-next-line no-var
  var sessionStorageGlobal: MemorySessionStorage | undefined;
}

const sessionStorage = global.sessionStorageGlobal ?? new MemorySessionStorage();

if (process.env.NODE_ENV !== "production") {
  global.sessionStorageGlobal = sessionStorage;
}

export default sessionStorage;
