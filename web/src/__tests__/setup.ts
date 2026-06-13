import '@testing-library/jest-dom/vitest';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { server } from '@/mocks/server';
import {
  __resetMswDashboardWidgets,
  __resetMswSavedScenarios,
  __resetMswSavedReportFilters,
  __resetMswEwsRuleVersions,
  __resetMswDispatchLog,
  __resetMswNotificationTemplates,
  __resetMswEscalationRules,
  __resetMswSiu,
  __resetMswExperiments,
  __resetMswDrift,
  __resetMswInsights,
  __resetMswPredictionLogs,
  __resetMswHybridRules,
  __resetMswRiskScore,
  __resetMswAlertClassification,
  __resetMswCaseTypes,
  __resetMswJobScheduler,
  __resetMswExports,
} from '@/mocks/handlers';
import { useAuth } from '@/store/auth';
// Side-effect import: initializes i18next with EN + HI bundles. Pulled in
// here so tests that render translated components have an instance ready.
// EN is the resolved fallback so existing tests that look for English copy
// continue to pass without any per-test setup.
import '@/lib/i18n';

// jsdom in this vitest config exposes a stub `localStorage` without Storage
// methods — install a Map-backed polyfill so http interceptors and the auth
// store work in tests.
function installLocalStoragePolyfill(target: typeof globalThis) {
  const store = new Map<string, string>();
  const stub: Storage = {
    get length() { return store.size; },
    clear() { store.clear(); },
    getItem(key) { return store.has(key) ? store.get(key)! : null; },
    setItem(key, value) { store.set(key, String(value)); },
    removeItem(key) { store.delete(key); },
    key(i) { return Array.from(store.keys())[i] ?? null; },
  };
  Object.defineProperty(target, 'localStorage', { value: stub, configurable: true });
  if ((target as { window?: typeof globalThis }).window) {
    Object.defineProperty((target as { window: typeof globalThis }).window, 'localStorage', { value: stub, configurable: true });
  }
}
installLocalStoragePolyfill(globalThis);

// MSW lifecycle for tests.
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  localStorage.clear();
  __resetMswSavedScenarios();
  __resetMswDashboardWidgets();
  __resetMswSavedReportFilters();
  __resetMswEwsRuleVersions();
  __resetMswDispatchLog();
  __resetMswNotificationTemplates();
  __resetMswEscalationRules();
  __resetMswSiu();
  __resetMswExperiments();
  __resetMswDrift();
  __resetMswInsights();
  __resetMswPredictionLogs();
  __resetMswHybridRules();
  __resetMswRiskScore();
  __resetMswAlertClassification();
  __resetMswCaseTypes();
  __resetMswJobScheduler();
  __resetMswExports();
  useAuth.setState({ status: 'idle', user: null, token: null });
});
afterAll(() => server.close());

// jsdom doesn't ship URL.createObjectURL — install no-op stubs so blob
// download flows can run in tests.
if (!('createObjectURL' in URL)) {
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: () => 'blob:mock',
  });
}
if (!('revokeObjectURL' in URL)) {
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: () => {},
  });
}

// Recharts uses ResizeObserver — jsdom doesn't.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).ResizeObserver = (globalThis as any).ResizeObserver ?? ResizeObserverStub;

// jsdom doesn't ship an EventSource — install a minimal stub that lets
// useNotifications mount + cleanup. Per-test `MockEventSource.lastInstance`
// can call `emit('notification', payload)` to drive the bell.
class MockEventSource extends EventTarget {
  static lastInstance: MockEventSource | null = null;
  url: string;
  readyState = 0;
  withCredentials = false;
  closed = false;
  constructor(url: string, init?: { withCredentials?: boolean }) {
    super();
    this.url = url;
    this.withCredentials = init?.withCredentials ?? false;
    MockEventSource.lastInstance = this;
    // Open on next tick so a `useEffect` cleanup that fires synchronously
    // doesn't race the open.
    queueMicrotask(() => {
      if (!this.closed) {
        this.readyState = 1;
        this.dispatchEvent(new Event('open'));
      }
    });
  }
  emit(eventName: string, data: unknown): void {
    const ev = new MessageEvent(eventName, { data: JSON.stringify(data) });
    this.dispatchEvent(ev);
  }
  close(): void {
    this.closed = true;
    this.readyState = 2;
  }
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).EventSource = MockEventSource;
// Re-export so tests can grab the latest instance.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).MockEventSource = MockEventSource;
