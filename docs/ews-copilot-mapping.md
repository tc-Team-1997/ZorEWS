# EWS AI Copilot — Migration & Architecture Map

**Status:** RFC — informs Copilot-1. Sign-off needed on §4 before Copilot-2 lands.
**Date:** 2026-05-06.
**Brief:** Migrate apex_aml's AI Copilot into ZorEWS, adapt for EWS use cases (risk explanation / alert investigation / case suggestions). 5-task brief: scan + report + adapt + generate + security.

---

## 1. Source-repo access

**`apex_aml` is NOT on this filesystem.** Searched `/Users/taniya/`, `/Users/taniya/Documents/`, `/`; no apex_aml. Same situation as the CMS migration (`docs/ews-cms-mapping.md` §1). Task #1 (inventory apex_aml's copilot files) is **deferred** — building from the spec instead. If you share apex_aml (zip / paste / repo URL) I'll fold its specific patterns in via a follow-up commit.

---

## 2. What ZorEWS already has — existing copilot surface

A surprisingly complete copilot vertical is already shipped. Any new work must coexist with it (additive only).

### Backend modules

| File | Concern |
|---|---|
| `services/bff/src/copilot/chat.ts` (359 LOC) | Templated copilot brain — pattern-match intent classifier (greeting / help / risk_score / why_high / recommend_action / summary / thanks / fallback / llm) + page-aware response templates. Falls through to LLM when `ANTHROPIC_API_KEY` is set, otherwise returns templated. |
| `services/bff/src/copilot/llm.ts` | Real LLM path via `@anthropic-ai/sdk` with prompt caching on a static APEX-EWS primer. Per-request context is APPENDED after the cache breakpoint so role/page/entity changes don't invalidate the primer. |
| `services/ai-copilot-svc/` | Standalone Python (FastAPI) copilot service with `app/main.py`, `app/scoring.py`, Dockerfile, requirements.txt, tests. Looks like an earlier-generation copilot — not currently the path the SPA uses. |

### Routes

```
POST /v1/copilot/chat
  body: { message, context?: { page?, entity?, role? } }
  Tenant-gated. Authenticated role required (no specific capability).
  Returns { reply, suggestions[], used_context }.
  Message cap 2000 chars.
  Falls through to LLM when ANTHROPIC_API_KEY is set.
```

### Frontend

- `web/src/components/copilot/ChatWidget.tsx` (257 LOC) — floating chat widget
- `web/src/store/chat.ts` — client-side chat state
- `web/src/__tests__/ChatWidget.test.tsx` — component test

### Tests

- `services/bff/__tests__/copilot.test.ts` — covers the templated brain + route surface

---

## 3. Brief vs. existing — gap analysis

| Brief requirement | Existing | Gap |
|---|---|---|
| Frontend chat UI | `ChatWidget.tsx` | ✅ already there |
| Backend service / API routes | `/v1/copilot/chat` | ✅ exists, but missing security gates |
| LLM client wrapper | `copilot/llm.ts` (Anthropic SDK) | ✅ done; prompt caching wired |
| Prompt templates | Templated brain + LLM primer | ✅ for the existing intents; **need EWS-specific intents per the brief** ("why X flagged", "summarize alert", "suggest next steps for case", "explain KRI breakdown") |
| **Conversation history storage** | NOT persisted — replies are stateless | **Build new — `copilot_conversations` table** |
| Streaming response handlers | Async response, not chunked stream | Spec doesn't require streaming for v1 — defer |
| Authentication | Tenant + authenticated role | Partial — **need role gate (analyst/admin only)** |
| **Rate limiting** | NOT present | **Build new — 30 queries / user / hour** |
| **PII masking before LLM** | NOT present | **Build new — mask emails / phone / pan / aadhaar / account numbers** |
| **Audit logging** | NOT present | **Build new — every query logged with metadata** |
| EWS-specific use cases | Generic risk + case templates | **Add intents for the 4 brief-mandated questions** |

**Net new code:** 4 modules (audit store, PII masker, rate limiter, EWS intents), 1 hardened route, 1 DB migration. ~80 tests on top of the existing copilot tests.

---

## 4. Proposed architecture

### 4.1 Naming + namespace

To stay additive, the hardened layer lives at **`/v1/copilot/v2/chat`** alongside the existing `/v1/copilot/chat`. The legacy entry stays available; new SPA traffic goes through v2.

- BFF modules: `services/bff/src/copilot/audit_store.ts`, `pii_masker.ts`, `rate_limiter.ts`, `ews_intents.ts`
- DB schema: `app_copilot.*` tables (`conversations`, `audit_log`)

### 4.2 Conversation persistence

```ts
interface CopilotConversation {
  conversation_id: string;        // UUID
  tenant_id: string;
  user_id: string;
  started_at: string;
  last_message_at: string;
  message_count: number;
  /** Echoed page from first message — useful for "find my case-related conversations". */
  initial_page: string | null;
  initial_entity_id: string | null;
}

interface CopilotMessage {
  message_id: string;
  conversation_id: string;
  tenant_id: string;
  role: 'user' | 'assistant';
  /** ALREADY MASKED text for the user role. */
  text: string;
  matched_intent: string | null;  // assistant only
  ts: string;
}
```

Per-tenant cap 1000 conversations + 5000 messages, FIFO eviction.

### 4.3 Audit log

Every copilot query writes an `audit_trail` event (`copilot.query`) with metadata: `{conversation_id, intent, page, entity_type, entity_id, message_length, masked_pii_kinds, used_llm}`. Queryable via `/v1/audit/events?action=copilot.query`.

### 4.4 PII masker

Pure-function `maskPII(text)` returns `{masked: string, hits: PiiKind[]}`. Detects:

| Kind | Regex (loose) | Replacement |
|---|---|---|
| email | `/\S+@\S+\.\S+/g` | `[EMAIL]` |
| phone (IN) | `/\+?\d{1,3}[\s-]?\d{10}/g` | `[PHONE]` |
| pan | `/\b[A-Z]{5}\d{4}[A-Z]\b/g` | `[PAN]` |
| aadhaar | `/\b\d{4}\s?\d{4}\s?\d{4}\b/g` | `[AADHAAR]` |
| account_no | `/\b\d{9,18}\b/g` | `[ACCOUNT]` (heuristic — long-digit run) |
| customer_id | `/\bcust-[a-z0-9-]+\b/gi` | `[CUSTOMER_ID]` |

Order matters — most-specific regex first so account_no doesn't eat aadhaar.

### 4.5 Rate limiter

Per-`(tenant, user_id)` token bucket. 30 queries / hour rolling window. Pure: `checkAndConsume(state, key, now, limit, windowMs)` returns `{ok, remaining, reset_at}`. 429 response code on overflow with `Retry-After` header.

### 4.6 RBAC

| Role | Can use copilot? |
|---|---|
| `risk_analyst` | ✅ (`copilot:use`) |
| `supervisor` | ✅ |
| `admin` | ✅ |
| `collection_officer` | ❌ (deferred — case-level data only) |
| `field_officer` | ❌ |

The new `copilot:use` capability is added to the role matrix; the route `requireRole('copilot:use')` gates access. The legacy `/v1/copilot/chat` stays open to any authenticated role for back-compat.

### 4.7 EWS-specific intents

4 new intents added to `ews_intents.ts` (additive; existing chat.ts not touched):

| Intent | Trigger pattern | Response uses |
|---|---|---|
| `why_flagged` | `why is.*flagged|why.*high risk|explain.*risk` | Customer SHAP reasons + KRI breaches |
| `summarize_alert` | `summari[zs]e.*alert|tl;?dr.*alert|alert.*summary` | Alert classification + indicators_fired + recommended_action |
| `suggest_case_steps` | `next step|what.*do.*case|how.*close|case.*action` | Case state + assignment status + open SLA + checklist progress |
| `explain_kri` | `kri.*breakdown|explain.*indicator|what.*kri|kri.*score` | Per-customer KRI scan from M4.5 (red→green ranked) |

Each intent has a TYPED context fetcher that reads from the BFF's existing in-memory stores (no new I/O). Falls back to the LLM when context can't be filled (e.g. no entity supplied).

### 4.8 New DB tables — `data/schema/014_copilot_audit.sql`

```sql
CREATE SCHEMA IF NOT EXISTS app_copilot;

CREATE TABLE app_copilot.conversations (
    conversation_id    UUID         PRIMARY KEY,
    tenant_id          TEXT         NOT NULL,
    user_id            TEXT         NOT NULL,
    started_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
    last_message_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    message_count      INTEGER      NOT NULL DEFAULT 0,
    initial_page       TEXT,
    initial_entity_id  TEXT
);
CREATE INDEX ix_copilot_conv_tenant_user
  ON app_copilot.conversations (tenant_id, user_id, last_message_at DESC);

CREATE TABLE app_copilot.messages (
    message_id        UUID         PRIMARY KEY,
    conversation_id   UUID         NOT NULL REFERENCES app_copilot.conversations(conversation_id) ON DELETE CASCADE,
    tenant_id         TEXT         NOT NULL,
    role              TEXT         NOT NULL,    -- user / assistant
    text              TEXT         NOT NULL,    -- masked
    matched_intent    TEXT,
    ts                TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CHECK (role IN ('user','assistant'))
);
CREATE INDEX ix_copilot_msg_conv_ts
  ON app_copilot.messages (conversation_id, ts);

CREATE TABLE app_copilot.audit_log (
    audit_id           UUID         PRIMARY KEY,
    tenant_id          TEXT         NOT NULL,
    user_id            TEXT         NOT NULL,
    conversation_id    UUID,
    intent             TEXT,
    page               TEXT,
    entity_type        TEXT,
    entity_id          TEXT,
    message_length     INTEGER      NOT NULL,
    masked_pii_kinds   TEXT[]       NOT NULL DEFAULT '{}',
    used_llm           BOOLEAN      NOT NULL DEFAULT FALSE,
    occurred_at        TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX ix_copilot_audit_tenant_time
  ON app_copilot.audit_log (tenant_id, occurred_at DESC);
CREATE INDEX ix_copilot_audit_user_time
  ON app_copilot.audit_log (tenant_id, user_id, occurred_at DESC);
```

Same forward-looking-schema posture as M9.4 / CMS / EWS Rules — runtime stays in-memory in the prototype.

---

## 5. Implementation sub-phases

| Commit | Scope | Tests |
|---|---|---|
| **Copilot-1** (this commit) | Arch doc + audit/conversation store + PII masker + rate limiter + DB migration. NO route changes. | ~50 |
| **Copilot-2** | Hardened route POST `/v1/copilot/v2/chat` + role gate + rate limit + PII mask + audit + 4 EWS intents. | ~30 |
| **Copilot-3** | README + Postman + 3 sample test conversations + SPA opt-in to v2 endpoint. | ~10 |

Total ≈ 90 new tests. Existing 3338 BFF + 19 SPA copilot tests stay untouched.

---

## 6. Open questions for sign-off (defaulting if no reply)

| # | Question | Default |
|---|---|---|
| Q1 | Path: `/v1/copilot/v2/chat` vs deprecate `/v1/copilot/chat`? | New v2 path; legacy stays for back-compat |
| Q2 | Streaming response chunks? | Defer — spec didn't explicitly require streaming |
| Q3 | LLM provider: continue with Anthropic or add OpenAI? | Continue Anthropic (existing wrapper); OpenAI swap can come via a `LlmAdapter` interface in Copilot-2 if needed |
| Q4 | Conversation TTL (auto-archive after N days)? | None for prototype — FIFO cap is the only retention; production can wire a sweeper |
| Q5 | Rate limit response: 429 + `Retry-After` vs custom envelope code? | 429 with the envelope error_code `EWS_429_rate_limited` + `Retry-After` header |
| Q6 | PII masker confidence: aggressive vs minimal? | **Minimal** — only the 6 patterns listed in §4.4 to avoid breaking valid IDs (e.g. case numbers); operators can submit a feedback issue if a pattern over-masks |
| Q7 | Should the M9.4 case event journal also receive a `copilot.query` event? | NO — that journal is case-scoped; copilot queries cross cases. Audit log only. |

If any default needs to change, redirect before Copilot-2.
