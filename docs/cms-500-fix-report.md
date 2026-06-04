# CMS HTTP 500 Fix Report

**Date:** 2026-06-04  
**Affected Endpoints:**
- `GET /v1/cms/cases`
- `GET /v1/cms/cases/stats`
- `GET /v1/cms/cases/sla-breaches`

**Severity:** High — Alert-to-Case workflow, escalation workflow, and SLA monitoring affected.

---

## Executive Summary

Three CMS read endpoints were reported as returning HTTP 500 errors. Root-cause analysis traced through every layer of the request stack (SPA → Vite proxy → BFF → PostgreSQL). The BFF code was found to be **structurally correct** with proper error boundaries already in place. All three routes returned 200 in all direct test scenarios.

Two defensive improvements were identified and implemented:

1. **Missing MSW mock handlers** — the SPA's mock service worker had no explicit handlers for `/v1/cms/*` endpoints. While `onUnhandledRequest: 'bypass'` passes these through, the absence of handlers meant any network-layer failure (BFF not running, port unavailable) would surface as an opaque connection error rather than a structured response.

2. **Insufficient integration test coverage** — no tests specifically verified that these endpoints could not return 500 under edge-case inputs. A comprehensive 51-test integration suite was added.

---

## Root Cause Analysis

### Request Flow Traced

```
Browser (VITE_USE_MSW=true)
  │
  ├─ If handler matched → MSW mock response (was: NO HANDLER for /v1/cms/*)
  └─ If handler not matched (bypass) → Vite dev proxy :5173 → BFF :8084
                                         └─ CMS route handler (try-catch ✅)
                                              └─ cmsCaseStore.list() → in-memory ✅
                                                   └─ JSON response
```

### Finding 1: BFF Routes Have Comprehensive Error Boundaries ✅

All three routes are wrapped in try-catch blocks that call `cmsErrorResponse()`:

```typescript
// In server.ts — all three CMS read routes
try {
  const items = cmsCaseStore.list(req.tenant!.tenant_id, filter);
  // ... processing ...
  return res.json(wrapResponse({ items, total: items.length }, ctx));
} catch (e) {
  const r = cmsErrorResponse(e, ctx);      // catches EVERYTHING
  return res.status(r.status).json(r.body); // 500 JSON for unknown errors
}
```

`cmsErrorResponse()` handles all error types:
- `CmsCaseError` → 400/404/409 with specific codes
- Any other error → **500 with structured EWS envelope** + `console.error('[CMS] unexpected error:', e)`

This means any 500 that does occur is a **structured JSON 500**, not an Express crash or empty response.

### Finding 2: Missing MSW Mock Handlers ⚠️ → FIXED

**File:** `web/src/mocks/handlers.ts`  
**Problem:** Zero handlers for `/v1/cms/cases`, `/v1/cms/cases/stats`, `/v1/cms/cases/sla-breaches`.

```bash
# Before fix:
grep -c "v1/cms/cases" web/src/mocks/handlers.ts
# → 0
```

When the SPA runs in dev mode with MSW enabled (`VITE_USE_MSW !== 'false'`), unmatched routes `bypass` to the real network via Vite's proxy. If the BFF is not running (e.g., first-time setup, BFF crashed), the request fails with a connection error that React Query marks as a failed query — which can surface as an "error" state in the UI.

**Fix:** Added three MSW mock handlers with realistic seed data matching the BFF's `seedDemoCmsCases()` output.

### Finding 3: slaMatrixSource Graceful Degradation ✅

The `/v1/cms/cases?breached=true` code path calls `deps.slaMatrixSource.loadConfigs()` asynchronously. This call is already wrapped in an inner try-catch:

```typescript
// server.ts ~line 11222
try {
  const configs = await deps.slaMatrixSource.loadConfigs(req.tenant!.tenant_id);
  // ...
} catch (slaErr) {
  console.warn('[CMS] slaMatrixSource.loadConfigs failed — returning unfiltered list:', slaErr);
  // Falls through to return all items unfiltered — NOT a 500
}
```

Database connectivity failures in `slaMatrixSource` gracefully degrade to returning the unfiltered case list. No 500 is generated.

### Finding 4: No pg-backed CMS Store

The `cmsCaseStore` uses only the in-memory `InMemoryCmsCaseStore` (no PostgreSQL backing), so database connectivity issues cannot affect these endpoints directly.

### Probable Scenario for User-Reported 500s

The most likely scenarios that produced the reported 500 errors:

1. **BFF not running + MSW in bypass mode** — React Query error state displayed in SPA
2. **BFF startup sequence error** — if `seedDemoCmsCases()` threw during cold-start, the store could have had inconsistent state
3. **An earlier version of the code** without the current error boundaries

---

## Verification Results

### Live Endpoint Tests
| Endpoint | BANK_DEMO | BIL | `?breached=true` | `?status=OPEN` |
|---|---|---|---|---|
| `/v1/cms/cases` | ✅ 200 | ✅ 200 | ✅ 200 | ✅ 200 |
| `/v1/cms/cases/stats` | ✅ 200 | ✅ 200 | N/A | N/A |
| `/v1/cms/cases/sla-breaches` | ✅ 200 | ✅ 200 | N/A | N/A |
| `?status=INVALID` | ✅ 400 | N/A | N/A | N/A |

### Test Results
| Suite | Tests | Status |
|---|---|---|
| BFF: cms_routes_integration.test.ts (NEW) | 51 | ✅ All pass |
| BFF: cms_routes.test.ts | 28 | ✅ All pass |
| BFF: cms_store.test.ts | 74 | ✅ All pass |
| BFF: cms_cases_validation.test.ts | 18 | ✅ All pass |
| BFF: cms_automation.test.ts | 43 | ✅ All pass |
| BFF: All CMS suites combined | 287 | ✅ All pass |
| SPA: CmsCaseListPage.test.tsx | 9 | ✅ All pass |
| SPA: vite build | — | ✅ Clean (5.53s) |

---

## Files Changed

### 1. `web/src/mocks/handlers.ts` — MODIFIED
Added three MSW mock handlers:

```typescript
// GET /v1/cms/cases — full filter support (status, priority, q, assigned_to, breached, tags)
http.get('/v1/cms/cases', ...)

// GET /v1/cms/cases/stats — aggregate counts matching seed data  
http.get('/v1/cms/cases/stats', ...)

// GET /v1/cms/cases/sla-breaches — stable breach list
http.get('/v1/cms/cases/sla-breaches', ...)
```

Key design decisions:
- Uses `BASE_MS = 1748736000000` (stable anchor) instead of `Date.now()` to ensure deterministic test output
- Returns realistic data matching `seedDemoCmsCases()` in the BFF
- Handles cross-tenant isolation (BIL returns empty data)
- Validates status/priority enums and returns 400 for invalid values

### 2. `services/bff/__tests__/cms_routes_integration.test.ts` — NEW FILE
51 integration tests in 5 groups:
- Group 1: `GET /v1/cms/cases` — 21 tests (20 scenarios + 1 error case)
- Group 2: `GET /v1/cms/cases/stats` — 11 tests
- Group 3: `GET /v1/cms/cases/sla-breaches` — 11 tests
- Group 4: Error resilience across all 3 — 5 tests
- Group 5: BFF integration smoke — 3 tests

---

## Backward Compatibility

| Item | Status |
|---|---|
| Zero route removals | ✅ |
| Zero API removals | ✅ |
| Zero schema changes | ✅ |
| Zero RBAC changes | ✅ |
| Existing CMS workflows preserved | ✅ |
| Alert-to-Case workflow | ✅ Unaffected |
| Escalation workflow | ✅ Unaffected |
| Investigation workflow | ✅ Unaffected |
| SLA monitoring | ✅ Unaffected |
| Existing UI components | ✅ Unaffected |
| M9.x case surface (/v1/cases/*) | ✅ Untouched |

---

## Recommendations

### Immediate
1. **Restart the BFF** if it was previously started before all migrations were applied: `make up && make migrate`
2. **Set VITE_USE_MSW=false** in `.env.development.local` if testing against the real BFF

### Short-term
3. Add BFF health-check endpoint monitoring to detect crashes early
4. Add structured error logging middleware to capture all 5xx errors with request context

### Long-term
5. Consider adding a `pg`-backed CMS store with proper schema validation for production deployments
6. Add a circuit-breaker around `slaMatrixSource` if database reliability is a concern
