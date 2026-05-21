// T4.3.1 — Mobile auth store tests.

import {
  AuthStore,
  InMemorySecureStore,
  buildSessionFromLogin,
  decodeJwtPayload,
} from '../src/auth/store';

// Hand-crafted JWT payload: { username: 'alice.field', tenant_id: 'BIL', role: 'field_officer', exp: 2_000_000_000 }
const SAMPLE_TOKEN = (() => {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64');
  const payload = Buffer.from(
    JSON.stringify({
      username: 'alice.field',
      tenant_id: 'BIL',
      role: 'field_officer',
      exp: 2_000_000_000,
    }),
  ).toString('base64');
  return `${header}.${payload}.fake-signature`;
})();

describe('decodeJwtPayload', () => {
  test('decodes a valid token', () => {
    const claims = decodeJwtPayload<{ username: string; tenant_id: string; role: string; exp: number }>(
      SAMPLE_TOKEN,
    );
    expect(claims).not.toBeNull();
    expect(claims!.username).toBe('alice.field');
    expect(claims!.tenant_id).toBe('BIL');
    expect(claims!.role).toBe('field_officer');
  });

  test('returns null for malformed token', () => {
    expect(decodeJwtPayload('not.a.real.token')).toBeNull();
    expect(decodeJwtPayload('only-one-segment')).toBeNull();
    expect(decodeJwtPayload('')).toBeNull();
  });
});

describe('buildSessionFromLogin', () => {
  test('extracts username + tenant + role + expires_at from JWT', () => {
    const session = buildSessionFromLogin({
      access_token: SAMPLE_TOKEN,
      refresh_token: 'refresh-xyz',
    });
    expect(session).not.toBeNull();
    expect(session!.username).toBe('alice.field');
    expect(session!.tenant_id).toBe('BIL');
    expect(session!.role).toBe('field_officer');
    expect(session!.expires_at).toBe(2_000_000_000_000);
    expect(session!.refresh_token).toBe('refresh-xyz');
  });

  test('returns null when JWT lacks username + tenant_id', () => {
    const headerOnly = Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64');
    const payload = Buffer.from(JSON.stringify({ exp: 1_000_000_000 })).toString('base64');
    expect(buildSessionFromLogin({ access_token: `${headerOnly}.${payload}.x`, refresh_token: 'r' })).toBeNull();
  });

  test('returns null on un-decodable token', () => {
    expect(buildSessionFromLogin({ access_token: 'garbage', refresh_token: 'r' })).toBeNull();
  });
});

describe('AuthStore', () => {
  test('setSession + getSession round-trips through secure storage', async () => {
    const fac = new InMemorySecureStore();
    const store = new AuthStore(fac);
    const s = buildSessionFromLogin({ access_token: SAMPLE_TOKEN, refresh_token: 'r' })!;
    await store.setSession(s);
    const back = await store.getSession();
    expect(back).toEqual(s);
  });

  test('getSession returns null when no session stored', async () => {
    const store = new AuthStore(new InMemorySecureStore());
    expect(await store.getSession()).toBeNull();
  });

  test('clearSession wipes secure storage', async () => {
    const store = new AuthStore(new InMemorySecureStore());
    const s = buildSessionFromLogin({ access_token: SAMPLE_TOKEN, refresh_token: 'r' })!;
    await store.setSession(s);
    await store.clearSession();
    expect(await store.getSession()).toBeNull();
  });

  test('isAuthenticated honours 30s safety margin', async () => {
    const store = new AuthStore(new InMemorySecureStore());
    const s = buildSessionFromLogin({ access_token: SAMPLE_TOKEN, refresh_token: 'r' })!;
    await store.setSession(s);
    // Hydrate cache.
    await store.getSession();
    // Well within expiry.
    expect(store.isAuthenticated(1_000_000_000_000)).toBe(true);
    // Past expiry.
    expect(store.isAuthenticated(2_000_000_000_001)).toBe(false);
    // Within the 30s safety margin.
    expect(store.isAuthenticated(2_000_000_000_000 - 10_000)).toBe(false);
  });

  test('corrupted blob is wiped + returns null', async () => {
    const fac = new InMemorySecureStore();
    await fac.setItemAsync('zorews.auth.session.v1', 'not-json-at-all');
    const store = new AuthStore(fac);
    expect(await store.getSession()).toBeNull();
    // Wiped.
    expect(await fac.getItemAsync('zorews.auth.session.v1')).toBeNull();
  });

  test('cache is populated after first read', async () => {
    const fac = new InMemorySecureStore();
    const store = new AuthStore(fac);
    const s = buildSessionFromLogin({ access_token: SAMPLE_TOKEN, refresh_token: 'r' })!;
    await fac.setItemAsync('zorews.auth.session.v1', JSON.stringify(s));
    // First read hits secure store.
    expect(await store.getSession()).not.toBeNull();
    // Second read should be from cache — wipe the underlying store and
    // confirm the cached session is still returned.
    await fac.deleteItemAsync('zorews.auth.session.v1');
    expect(await store.getSession()).not.toBeNull();
  });
});
