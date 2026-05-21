// mobile/src/auth/interceptor.ts
//
// Wires the ApiClient to the SessionStore. Resolves token, tenant,
// and actor from the current cached session; on 401 it clears the
// session and the screen layer redirects to login.

import { ApiClient, type ApiClientConfig } from '../api/client';
import { SessionStore } from './session';

export interface BuildApiClientOptions {
  baseUrl: string;
  channel?: string;
  onUnauthorised?: () => void;
}

export function buildApiClient(opts: BuildApiClientOptions): ApiClient {
  const cfg: ApiClientConfig = {
    baseUrl: opts.baseUrl,
    channel: opts.channel ?? 'MOBILE',
    getAccessToken: async () => SessionStore.current()?.access_token ?? null,
    getTenantId: async () => SessionStore.current()?.tenant_id ?? null,
    getActor: async () => SessionStore.current()?.username ?? null,
    onUnauthorised: async () => {
      await SessionStore.clear();
      opts.onUnauthorised?.();
    },
  };
  return new ApiClient(cfg);
}
