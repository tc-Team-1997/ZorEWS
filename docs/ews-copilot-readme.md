# EWS AI Copilot — Operator Guide

The day-to-day reference for analysts and supervisors using the AI Copilot. For the architectural design + the gap analysis vs. the existing `/v1/copilot/chat` surface, see [`ews-copilot-mapping.md`](./ews-copilot-mapping.md).

## What this Copilot does

A context-aware assistant embedded in the EWS SPA. Surfaces 4 EWS-specific intents:

| Intent | Triggered by | Uses |
|---|---|---|
| `why_flagged` | "Why is X flagged?", "explain the risk", "reason for flag" | Customer SHAP drivers + KRI breaches + PD-band-based recommendation |
| `summarize_alert` | "Summarize this alert", "tldr alert", "alert summary" | Severity / customer / rule_name / reason_summary |
| `suggest_case_steps` | "Next steps for this case", "what should I do" | Case state + assignee + SLA progress |
| `explain_kri` | "Explain KRI breakdown", "what KRIs drove this" | Breach-class tally + top driver + per-KRI facts |

Falls through to the legacy templated brain (greeting / risk_score / why_high / recommend_action / summary / fallback) when none of the 4 EWS patterns match. Optional Anthropic LLM path activates when `ANTHROPIC_API_KEY` is set.

## Where things live

| Concern | Path |
|---|---|
| Existing templated brain (legacy) | `services/bff/src/copilot/chat.ts` |
| LLM wrapper (Anthropic SDK + prompt caching) | `services/bff/src/copilot/llm.ts` |
| EWS intent classifier + renderers | `services/bff/src/copilot/ews_intents.ts` |
| PII masker | `services/bff/src/copilot/pii_masker.ts` |
| Rate limiter | `services/bff/src/copilot/rate_limiter.ts` |
| Conversation + audit store | `services/bff/src/copilot/audit_store.ts` |
| Hardened route (Copilot-2) | `services/bff/src/server.ts` (search "Copilot v2") |
| Legacy route | `services/bff/src/server.ts` (search "POST /v1/copilot/chat") |
| DB migration | `data/schema/014_copilot_audit.sql` |
| SPA chat widget | `web/src/components/copilot/ChatWidget.tsx` |
| SPA chat store | `web/src/store/chat.ts` |
| Postman | `docs/ews-copilot-postman.json` |
| Sample conversations | `docs/ews-copilot-sample-conversations.md` |
| Architecture mapping | `docs/ews-copilot-mapping.md` |

## Setup

### Backend

The BFF auto-enables the v2 copilot path on every restart — no installation step. Optional Anthropic LLM:

```bash
# .env (services/bff/)
ANTHROPIC_API_KEY=sk-ant-…              # optional — without this, v2 uses templated + EWS intents only
COPILOT_LLM_MODEL=claude-haiku-4-5-20251001
COPILOT_RATE_LIMIT_PER_HOUR=30          # spec-mandated default; do not raise without compliance review
COPILOT_MAX_MESSAGE_LEN=2000
```

Restart the BFF (`npm run dev` in `services/bff/`) to pick up env changes.

### Frontend (SPA)

To opt the floating ChatWidget into the v2 endpoint:

```bash
# .env (web/)
VITE_COPILOT_API_VERSION=v2             # default: v1 (legacy path stays back-compat)
```

Vite HMR reloads on env changes. Without this flag, the widget continues to call the legacy `/v1/copilot/chat`.

### DB (forward-looking)

Run `data/schema/014_copilot_audit.sql` against PostgreSQL to materialise the persistence tables. The prototype runtime is in-memory; the schema is for the production swap-in.

## Routes

| Method + path | Role | Purpose |
|---|---|---|
| `POST   /v1/copilot/chat`                      | any authenticated | Legacy templated brain (back-compat) |
| `POST   /v1/copilot/v2/chat`                   | `copilot:use` | **Hardened**: rate-limited + PII-masked + audit-logged + persisted |
| `GET    /v1/copilot/v2/conversations`          | `copilot:use` | List current user's conversations |
| `GET    /v1/copilot/v2/conversations/:id`      | `copilot:use` (own only) | Conversation header + messages |
| `GET    /v1/copilot/v2/quota`                  | `copilot:use` | Current rate-limit window state |
| `GET    /v1/copilot/v2/audit`                  | `audit:read`  | Admin compliance review |

`copilot:use` is held by `admin / risk_analyst / supervisor`. `collection_officer` and `field_officer` are excluded per the brief.

## Security model

| Layer | Behavior |
|---|---|
| **Role gate** | `copilot:use` capability required on every v2 route. Non-allowed roles return 403. |
| **Rate limit** | Per-(tenant, user) rolling 1-hour window. Default 30 queries/hour. 31st returns `429 EWS_429_rate_limited` + `Retry-After` header pointing at the next free slot. |
| **PII mask** | Pure function `maskPII(text)` runs BEFORE persistence + LLM. 6 patterns: customer_id (`cust-<x>`), email, pan, aadhaar, phone (10-digit / +CC), account_no (9-18 digit run). Masked text replaces tokens with `[EMAIL]` / `[PHONE]` / etc. Operator-friendly — case numbers (`EWS-2026-00001`), rule IDs (`RULE_*`), alert IDs (`alrt-*`) are NOT masked. |
| **Audit log** | Every query writes a row: `{intent, page, entity_type, entity_id, message_length, masked_pii_kinds[], used_llm, occurred_at}`. Queryable via `GET /v1/copilot/v2/audit?user_id=&since=&until=` (admin). 7-year retention applies in production. |
| **Conversation persistence** | First turn auto-creates a conversation; subsequent turns can reuse `conversation_id`. Cross-user access returns 403 (`EWS_403_conversation_owner_mismatch`). |
| **Closed-tenant isolation** | All routes are tenant-gated; no cross-tenant lookup is possible. |

## Sample request / response

```bash
# Set headers helper for shell
export H="-H X-Tenant-ID:BIL -H X-Channel:API -H X-APEX-USER:jane.analyst -H x-apex-role:risk_analyst -H Content-Type:application/json"

# First turn: auto-create a conversation
curl -X POST http://localhost:8084/v1/copilot/v2/chat $H -d '{
  "message": "Why is this customer high risk?",
  "context": {
    "page": "customer",
    "entity": {
      "type": "customer",
      "id": "cust-001",
      "label": "Acme Pvt Ltd",
      "facts": { "pd": 0.72, "dpd_max_90d": 60, "utilization": 0.95, "top_driver": "dpd_max_90d" }
    }
  }
}'

# Response body:
# {
#   "header": {...},
#   "body": {
#     "conversation_id": "<uuid>",
#     "reply": "**Acme Pvt Ltd** is flagged as high risk.\nDrivers: PD = 72% · max DPD over 90d = 60 · utilization = 0.95 · top SHAP driver = dpd_max_90d\n**Recommended:** escalate to a case, assign to Collection, attempt outreach within 48 hours.",
#     "suggestions": ["Show top SHAP drivers", "Which KRIs are red?", "What is the recommended action?"],
#     "used_intent": "why_flagged",
#     "masked_pii_kinds": [],
#     "used_llm": false,
#     "quota": { "remaining": 29, "reset_at": "2026-05-06T13:00:00.000Z" }
#   }
# }

# Second turn: reuse the conversation_id
curl -X POST http://localhost:8084/v1/copilot/v2/chat $H -d '{
  "message": "what are the next steps for the case?",
  "conversation_id": "<uuid from first turn>",
  "context": {
    "page": "case",
    "entity": { "type": "case", "id": "EWS-2026-00001",
                "facts": { "status": "INVESTIGATING", "priority": "P1" } }
  }
}'
```

## Adding a new intent

1. Edit `services/bff/src/copilot/ews_intents.ts`.
2. Add a regex matcher (e.g. `const MY_RE = /\b…\b/i`).
3. Add an enum value to `EwsIntent`.
4. Add a `renderMyIntent(ctx)` function returning `{ intent, reply, suggestions }`.
5. Wire the new branch in `classifyEwsIntent` and `tryHandleEwsIntent`.
6. Test in `services/bff/__tests__/copilot_ews_intents.test.ts`.

## Compliance audit

An admin can review every copilot query end-to-end:

```bash
curl http://localhost:8084/v1/copilot/v2/audit?user_id=jane.analyst $H
```

Each row carries the masked PII kinds detected, the matched intent, the page + entity context the analyst was looking at, and `used_llm` for cost attribution. See `docs/ews-copilot-sample-conversations.md` for a fully-worked compliance review walkthrough.

## Postman quickstart

Import `docs/ews-copilot-postman.json` into Postman. Variables: `baseUrl`, `tenantId`, `apexUser`, `apexRole`, `conversationId`. Run requests in order to walk through a multi-turn conversation + check quota + read audit.

## Related docs

- [`ews-copilot-mapping.md`](./ews-copilot-mapping.md) — architecture, gap analysis, sub-phase plan
- [`ews-copilot-sample-conversations.md`](./ews-copilot-sample-conversations.md) — 3 fully-worked example conversations
- [`ews-rules-engine-readme.md`](./ews-rules-engine-readme.md) — the rules engine that produces the alerts the copilot explains
- [`ews-cms-readme.md`](./ews-cms-readme.md) — the CMS the copilot's `suggest_case_steps` intent recommends actions for
