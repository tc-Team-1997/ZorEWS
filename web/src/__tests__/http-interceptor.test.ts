import { afterEach, describe, expect, it } from 'vitest';
import { http as msw, HttpResponse } from 'msw';
import { http as client } from '@/lib/http';
import { server } from '@/mocks/server';

afterEach(() => {
  localStorage.clear();
  server.resetHandlers();
});

describe('http interceptor — Bearer + x-apex-role', () => {
  it('sends Bearer token when apex.ews.token is set', async () => {
    let captured: { authorization?: string | null } = {};
    server.use(
      msw.get('https://example.test/check', ({ request }) => {
        captured.authorization = request.headers.get('authorization');
        return HttpResponse.json({ ok: true });
      }),
    );
    localStorage.setItem('apex.ews.token', 'tok-123');
    await client.get('https://example.test/check');
    expect(captured.authorization).toBe('Bearer tok-123');
  });

  it('sends x-apex-role from the auth store user blob', async () => {
    let captured: { role?: string | null } = {};
    server.use(
      msw.get('https://example.test/role', ({ request }) => {
        captured.role = request.headers.get('x-apex-role');
        return HttpResponse.json({ ok: true });
      }),
    );
    localStorage.setItem(
      'apex.ews.user',
      JSON.stringify({ id: 'u', username: 'fiona.field', roles: ['field_officer'] }),
    );
    await client.get('https://example.test/role');
    expect(captured.role).toBe('field_officer');
  });

  it('omits x-apex-role when no user is in localStorage', async () => {
    let captured: { role?: string | null } = {};
    server.use(
      msw.get('https://example.test/no-role', ({ request }) => {
        captured.role = request.headers.get('x-apex-role');
        return HttpResponse.json({ ok: true });
      }),
    );
    await client.get('https://example.test/no-role');
    expect(captured.role).toBeNull();
  });

  it('survives a malformed user blob without throwing', async () => {
    let captured: { role?: string | null } = {};
    server.use(
      msw.get('https://example.test/bad', ({ request }) => {
        captured.role = request.headers.get('x-apex-role');
        return HttpResponse.json({ ok: true });
      }),
    );
    localStorage.setItem('apex.ews.user', 'not-json');
    await client.get('https://example.test/bad');
    expect(captured.role).toBeNull();
  });

  it('sends both headers when both are present (admin scenario)', async () => {
    let captured: { token?: string | null; role?: string | null } = {};
    server.use(
      msw.get('https://example.test/both', ({ request }) => {
        captured.token = request.headers.get('authorization');
        captured.role = request.headers.get('x-apex-role');
        return HttpResponse.json({ ok: true });
      }),
    );
    localStorage.setItem('apex.ews.token', 'tok-admin');
    localStorage.setItem(
      'apex.ews.user',
      JSON.stringify({ id: 'u-001', username: 'alice.admin', roles: ['admin'] }),
    );
    await client.get('https://example.test/both');
    expect(captured.token).toBe('Bearer tok-admin');
    expect(captured.role).toBe('admin');
  });
});
