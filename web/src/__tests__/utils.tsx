import { type ReactElement } from 'react';
import { render, type RenderOptions } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

export function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });
}

export function renderWithProviders(
  ui: ReactElement,
  {
    route = '/',
    routes,
    ...options
  }: RenderOptions & { route?: string; routes?: string[] } = {},
) {
  // Default the country to India in test mode so the new mandatory
  // country selector on LoginPage doesn't block credential-flow tests
  // that don't care about the country choice. Tests that explicitly
  // want the empty state can clear it before rendering.
  try {
    if (typeof window !== 'undefined' && !window.localStorage.getItem('zorews.country')) {
      window.localStorage.setItem('zorews.country', 'IN');
    }
  } catch {
    /* jsdom localStorage polyfill may not be ready — best effort */
  }
  const client = makeQueryClient();
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={routes ?? [route]}>{ui}</MemoryRouter>
      </QueryClientProvider>,
      options,
    ),
  };
}
