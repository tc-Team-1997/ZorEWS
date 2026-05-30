// DBAC SPA hook smoke test.
//
// Covers:
//   1. admin role → 'both' fast-path (no fetch)
//   2. risk_analyst in BANK_DEMO → 'banking' (inherits tenant vertical)
//   3. risk_analyst in BIL → 'insurance' (inherits tenant vertical)
//   4. useCanSeeDomain composes correctly with the bypass
//   5. unauthenticated → null

import { describe, expect, it, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffectiveDomain, useCanSeeDomain } from '@/lib/useEffectiveDomain';
import { useAuth } from '@/store/auth';

function setUser(role: 'admin' | 'risk_analyst' | null, tenant_id: 'BANK_DEMO' | 'BIL' = 'BANK_DEMO') {
  if (role === null) {
    localStorage.clear();
    useAuth.setState({ status: 'idle', user: null, token: null });
    return;
  }
  const user = {
    id: 'u-001',
    username: role === 'admin' ? 'alice.admin' : 'test.risk_analyst',
    roles: [role] as ('admin' | 'risk_analyst')[],
    tenant_id,
  };
  localStorage.setItem('apex.ews.user', JSON.stringify(user));
  localStorage.setItem('apex.ews.token', 'mock.test.token');
  localStorage.setItem('apex.ews.tenant_id', tenant_id);
  useAuth.setState({ status: 'authenticated', user: user as never, token: 'mock.test.token' });
}

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

beforeEach(() => {
  localStorage.clear();
});

describe('useEffectiveDomain', () => {
  it('admin short-circuits to both (no fetch)', () => {
    setUser('admin');
    const { result } = renderHook(() => useEffectiveDomain(), { wrapper: wrapper() });
    expect(result.current).toBe('both');
  });

  it('risk_analyst in BANK_DEMO → inherits banking', async () => {
    setUser('risk_analyst', 'BANK_DEMO');
    const { result } = renderHook(() => useEffectiveDomain(), { wrapper: wrapper() });
    // First render is loading → null
    await waitFor(() => expect(result.current).toBe('banking'));
  });

  it('risk_analyst in BIL → inherits insurance', async () => {
    setUser('risk_analyst', 'BIL');
    const { result } = renderHook(() => useEffectiveDomain(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current).toBe('insurance'));
  });

  it('unauthenticated → null', () => {
    setUser(null);
    const { result } = renderHook(() => useEffectiveDomain(), { wrapper: wrapper() });
    expect(result.current).toBeNull();
  });
});

describe('useCanSeeDomain', () => {
  it('admin sees both banking + insurance', () => {
    setUser('admin');
    const W = wrapper();
    const { result: banking } = renderHook(() => useCanSeeDomain('banking'), { wrapper: W });
    const { result: insurance } = renderHook(() => useCanSeeDomain('insurance'), { wrapper: W });
    expect(banking.current).toBe(true);
    expect(insurance.current).toBe(true);
  });

  it('banking analyst sees banking but NOT insurance', async () => {
    setUser('risk_analyst', 'BANK_DEMO');
    const W = wrapper();
    const { result: banking } = renderHook(() => useCanSeeDomain('banking'), { wrapper: W });
    const { result: insurance } = renderHook(() => useCanSeeDomain('insurance'), { wrapper: W });
    await waitFor(() => expect(banking.current).toBe(true));
    expect(insurance.current).toBe(false);
  });

  it('insurance analyst sees insurance but NOT banking', async () => {
    setUser('risk_analyst', 'BIL');
    const W = wrapper();
    const { result: banking } = renderHook(() => useCanSeeDomain('banking'), { wrapper: W });
    const { result: insurance } = renderHook(() => useCanSeeDomain('insurance'), { wrapper: W });
    await waitFor(() => expect(insurance.current).toBe(true));
    expect(banking.current).toBe(false);
  });
});
