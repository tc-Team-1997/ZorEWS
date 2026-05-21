// mobile/src/auth/store.ts
//
// T4.3.1 — secure auth/session storage for the RN shell.
//
// Wraps expo-secure-store (uses iOS Keychain + Android Keystore) so
// JWT access + refresh tokens never touch AsyncStorage / disk in
// plaintext. Token decoded once on login to extract tenant_id +
// username (mirrors the BFF `requireTenant` JWT-claim shape).
//
// Pure JS-side — no UI dependency, no React Native imports beyond the
// SecureStore facade. Lets the auth screen call await login(...) then
// the rest of the app reads via getSession().
//
// SecureStore is injected so tests can swap it for an in-memory map.

export interface AuthSession {
  access_token: string;
  refresh_token: string;
  username: string;
  tenant_id: string;
  role: string;
  expires_at: number; // unix ms
}

const KEY_SESSION = 'zorews.auth.session.v1';

/** Minimal interface the store consumes — matches expo-secure-store. */
export interface SecureStoreFacade {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

export class AuthStore {
  private cached: AuthSession | null = null;

  constructor(private store: SecureStoreFacade) {}

  /** Load the session from secure storage. Cached after first read. */
  async getSession(): Promise<AuthSession | null> {
    if (this.cached) return this.cached;
    const raw = await this.store.getItemAsync(KEY_SESSION);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as AuthSession;
      this.cached = parsed;
      return parsed;
    } catch {
      // Corrupted blob — wipe.
      await this.store.deleteItemAsync(KEY_SESSION);
      return null;
    }
  }

  async setSession(s: AuthSession): Promise<void> {
    this.cached = s;
    await this.store.setItemAsync(KEY_SESSION, JSON.stringify(s));
  }

  async clearSession(): Promise<void> {
    this.cached = null;
    await this.store.deleteItemAsync(KEY_SESSION);
  }

  /** True iff cached session token has not expired. Mobile clock vs
   *  server clock drift handled with a 30-second safety margin. */
  isAuthenticated(now: number = Date.now()): boolean {
    if (!this.cached) return false;
    return this.cached.expires_at - 30_000 > now;
  }
}

/** Decode a JWT payload WITHOUT verifying the signature — production
 *  refresh flow re-validates server-side. Mirrors the BFF approach in
 *  services/bff/src/tenant.ts insecure-decode path. */
export function decodeJwtPayload<T = unknown>(token: string): T | null {
  if (typeof token !== 'string' || token.split('.').length < 2) return null;
  const payload = token.split('.')[1];
  try {
    // RN doesn't have atob globally — use Buffer when available, else
    // a JS polyfill.
    const decoded =
      typeof atob === 'function'
        ? atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
        : Buffer.from(payload, 'base64').toString('utf8');
    return JSON.parse(decoded) as T;
  } catch {
    return null;
  }
}

interface JwtClaims {
  sub?: string;
  username?: string;
  tenant_id?: string;
  role?: string;
  exp?: number; // seconds since epoch
}

/** Build an AuthSession from a /auth/login response + the decoded
 *  JWT claims. expires_at = exp claim × 1000. */
export function buildSessionFromLogin(input: {
  access_token: string;
  refresh_token: string;
}): AuthSession | null {
  const claims = decodeJwtPayload<JwtClaims>(input.access_token);
  if (!claims) return null;
  const username = claims.username ?? claims.sub ?? '';
  const tenant_id = claims.tenant_id ?? '';
  const role = claims.role ?? '';
  const exp = typeof claims.exp === 'number' ? claims.exp * 1000 : Date.now() + 60 * 60 * 1000;
  if (!username || !tenant_id) return null;
  return {
    access_token: input.access_token,
    refresh_token: input.refresh_token,
    username,
    tenant_id,
    role,
    expires_at: exp,
  };
}

/** In-memory SecureStore facade for tests. */
export class InMemorySecureStore implements SecureStoreFacade {
  private map = new Map<string, string>();
  async getItemAsync(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }
  async setItemAsync(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }
  async deleteItemAsync(key: string): Promise<void> {
    this.map.delete(key);
  }
}
