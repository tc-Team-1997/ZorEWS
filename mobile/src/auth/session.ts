// mobile/src/auth/session.ts
//
// Session resolver. Holds the current operator's auth state in-memory
// during the app lifecycle; persistence delegates to native secure
// storage (Keychain on iOS, Keystore on Android).

import { SecureStorage } from '../native/secure_storage';

export interface MobileSession {
  access_token: string;
  refresh_token: string | null;
  expires_at: string;
  tenant_id: string;
  username: string;
  role: string;
}

const STORAGE_KEY = 'zorews_session';

let cached: MobileSession | null = null;

export const SessionStore = {
  /** Hydrate the in-memory cache from secure storage on app boot. */
  async hydrate(): Promise<MobileSession | null> {
    const raw = await SecureStorage.read(STORAGE_KEY);
    if (!raw) return null;
    try {
      cached = JSON.parse(raw) as MobileSession;
      return cached;
    } catch {
      // Corrupt blob — clear to avoid an infinite-401 loop.
      await SecureStorage.remove(STORAGE_KEY);
      cached = null;
      return null;
    }
  },

  /** Persist a freshly-acquired session (after login or refresh). */
  async save(session: MobileSession): Promise<void> {
    cached = session;
    await SecureStorage.write(STORAGE_KEY, JSON.stringify(session));
  },

  /** Clear the session — typically on 401 or explicit logout. */
  async clear(): Promise<void> {
    cached = null;
    await SecureStorage.remove(STORAGE_KEY);
  },

  /** Synchronous accessor for the API client's getAccessToken hook. */
  current(): MobileSession | null {
    return cached;
  },

  isExpired(now: Date = new Date()): boolean {
    if (!cached) return true;
    return new Date(cached.expires_at).getTime() <= now.getTime();
  },
};
