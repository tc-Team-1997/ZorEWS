# EWS Copilot — Sample Conversations

3 fully-worked end-to-end examples covering the brief's mandated EWS use cases. Each shows the request / response cycle through `POST /v1/copilot/v2/chat`, the conversation log via `GET /v1/copilot/v2/conversations/:id`, and the compliance audit row via `GET /v1/copilot/v2/audit`.

Reproduce these against the live BFF on `:8084` once you've run `npm run dev` in `services/bff/`.

---

## Conversation 1 — "Why is customer X flagged as high risk?"

**Persona:** `jane.analyst`, role `risk_analyst`, currently looking at the **Customer 360** page for `cust-001`.

### Turn 1 — analyst opens the chat and asks why

**Request:**

```http
POST /v1/copilot/v2/chat
X-Tenant-ID: BIL
X-Channel: API
X-APEX-USER: jane.analyst
x-apex-role: risk_analyst
Content-Type: application/json

{
  "message": "Why is this customer flagged as high risk?",
  "context": {
    "page": "customer",
    "entity": {
      "type": "customer",
      "id": "cust-001",
      "label": "Acme Pvt Ltd",
      "facts": {
        "pd": 0.72,
        "dpd_max_90d": 60,
        "utilization": 0.95,
        "exposure_kes": "1,250,000",
        "top_driver": "dpd_max_90d"
      }
    }
  }
}
```

**Response (200):**

```json
{
  "header": { "status": "SUCCESS", "code": "EWS_200", "...": "..." },
  "body": {
    "conversation_id": "8a3f2c41-d7b5-4e62-9a18-2f1e3b4d5c6a",
    "reply": "**Acme Pvt Ltd** is flagged as high risk.\nDrivers: PD = 72% · max DPD over 90d = 60 · utilization = 0.95 · exposure = 1,250,000 · top SHAP driver = dpd_max_90d\n**Recommended:** escalate to a case, assign to Collection, attempt outreach within 48 hours.",
    "suggestions": ["Show top SHAP drivers", "Which KRIs are red?", "What is the recommended action?"],
    "used_intent": "why_flagged",
    "masked_pii_kinds": [],
    "used_llm": false,
    "quota": { "remaining": 29, "reset_at": "2026-05-06T13:00:00.000Z" }
  }
}
```

### Turn 2 — analyst follows up about the KRI breakdown

**Request:** (note `conversation_id` reuse for continuity)

```http
POST /v1/copilot/v2/chat
{
  "message": "Explain the KRI breakdown for this score",
  "conversation_id": "8a3f2c41-d7b5-4e62-9a18-2f1e3b4d5c6a",
  "context": {
    "page": "customer",
    "entity": {
      "type": "customer",
      "id": "cust-001",
      "label": "Acme Pvt Ltd",
      "facts": {
        "red_count": 4,
        "orange_count": 6,
        "yellow_count": 3,
        "green_count": 12,
        "top_driver": "FIN-001",
        "kri_FIN_001": 0.88,
        "kri_BEH_002": 0.71,
        "kri_TXN_005": 0.65
      }
    }
  }
}
```

**Response body:**

```json
{
  "conversation_id": "8a3f2c41-d7b5-4e62-9a18-2f1e3b4d5c6a",
  "reply": "KRI breakdown for **Acme Pvt Ltd**:\n- Breach classes: red 4 · orange 6 · yellow 3 · green 12\n- Top contributor: FIN-001\n- Individual KRIs: FIN_001=0.88, BEH_002=0.71, TXN_005=0.65\nFor the full per-customer breach scan call `POST /v1/indicators/scan-customer { customer_id }`.",
  "suggestions": ["Why is this customer flagged?", "What rule fired?", "Suggest next steps"],
  "used_intent": "explain_kri",
  "masked_pii_kinds": [],
  "used_llm": false,
  "quota": { "remaining": 28, "reset_at": "2026-05-06T13:00:00.000Z" }
}
```

### Audit row (admin view)

```http
GET /v1/copilot/v2/audit?user_id=jane.analyst
x-apex-role: admin
```

```json
{
  "items": [
    { "sequence_no": 2, "intent": "explain_kri", "page": "customer",
      "entity_type": "customer", "entity_id": "cust-001",
      "message_length": 38, "masked_pii_kinds": [], "used_llm": false,
      "occurred_at": "2026-05-06T12:00:30.000Z" },
    { "sequence_no": 1, "intent": "why_flagged", "page": "customer",
      "entity_type": "customer", "entity_id": "cust-001",
      "message_length": 49, "masked_pii_kinds": [], "used_llm": false,
      "occurred_at": "2026-05-06T12:00:00.000Z" }
  ],
  "total": 2
}
```

---

## Conversation 2 — "Summarize this alert in 2 lines"

**Persona:** `bob.supervisor`, role `supervisor`, opening **Alerts** queue.

### Turn 1

**Request:**

```http
POST /v1/copilot/v2/chat
X-APEX-USER: bob.supervisor
x-apex-role: supervisor
Content-Type: application/json

{
  "message": "Summarize this alert in 2 lines",
  "context": {
    "page": "alerts",
    "entity": {
      "type": "alert",
      "id": "alrt-payment-bounce-007",
      "label": "Payment bounce alert",
      "facts": {
        "severity": "high",
        "customer_id": "cust-002",
        "rule_name": "High EMI Bounce Risk",
        "reason_summary": "5 EMI bounces in last 90 days; balance erosion 42%"
      }
    }
  }
}
```

**Response body:**

```json
{
  "conversation_id": "f1d2c3b4-a5e6-4789-9012-3456789abcde",
  "reply": "**Payment bounce alert** (high · cust-002 · rule: High EMI Bounce Risk)\nReason: 5 EMI bounces in last 90 days; balance erosion 42%",
  "suggestions": ["Why was it flagged?", "What rule fired?", "Suggest next steps"],
  "used_intent": "summarize_alert",
  "masked_pii_kinds": ["customer_id"],
  "used_llm": false,
  "quota": { "remaining": 29, "reset_at": "..." }
}
```

**Notes:**
- `cust-002` in the **message** would be masked → `[CUSTOMER_ID]`. Here the analyst didn't mention it in the typed text — the customer_id appears only in `context.entity.facts`, which is rendered into the response. The `masked_pii_kinds: ["customer_id"]` is empty in this turn because the message itself contains no PII.
- Actually the rendered reply includes `cust-002` from the context facts — that's intentional, the SPA already shows it. The masker only acts on the user's typed message.

---

## Conversation 3 — "Suggest next steps for this case"

**Persona:** `alice.analyst`, role `risk_analyst`, viewing case `EWS-2026-00001` mid-investigation with SLA at 87%.

### Turn 1

**Request:**

```http
POST /v1/copilot/v2/chat
X-APEX-USER: alice.analyst
x-apex-role: risk_analyst
Content-Type: application/json

{
  "message": "What are the next steps for this case?",
  "context": {
    "page": "case",
    "entity": {
      "type": "case",
      "id": "EWS-2026-00001",
      "label": "EWS-2026-00001 — Acme EMI bounce",
      "facts": {
        "status": "INVESTIGATING",
        "priority": "P1",
        "assigned_to": "alice.analyst",
        "sla_progress_pct": 87,
        "sla_breached": "false"
      }
    }
  }
}
```

**Response body:**

```json
{
  "conversation_id": "12345678-90ab-cdef-1234-567890abcdef",
  "reply": "**EWS-2026-00001 — Acme EMI bounce** — status: INVESTIGATING · P1\n1. Add notes documenting the customer interaction + evidence.\n2. When ready, transition to **PENDING_APPROVAL** for supervisor sign-off.\n3. If risk worsens, **escalate** with a reason (one click).\n⏰ SLA at 87% — close out within the next few hours.",
  "suggestions": ["Explain the KRI breakdown", "Why was it flagged?", "Show the SLA timer"],
  "used_intent": "suggest_case_steps",
  "masked_pii_kinds": [],
  "used_llm": false,
  "quota": { "remaining": 29, "reset_at": "..." }
}
```

### Audit row

The compliance audit log captures `intent: "suggest_case_steps"`, `entity_type: "case"`, `entity_id: "EWS-2026-00001"`. A supervisor reviewing alice's copilot use can see exactly which case she queried at what time.

---

## What the masker catches — one more example

```http
POST /v1/copilot/v2/chat
{ "message": "Email jane@bil.com about cust-001 (PAN ABCDE1234F, phone +91 9876543210)" }
```

**Response body:**

```json
{
  "reply": "...templated brain reply...",
  "masked_pii_kinds": ["customer_id", "email", "pan", "phone"]
}
```

The PERSISTED `messages.text` for the user role becomes:

```
Email [EMAIL] about [CUSTOMER_ID] (PAN [PAN], phone [PHONE])
```

— so re-reading the conversation log later (for compliance review or to debug a misfiring intent) is safe.

---

## Hitting the rate limit

```http
# 31st query in the same hour
POST /v1/copilot/v2/chat
…

HTTP/1.1 429 Too Many Requests
Retry-After: 1842
Content-Type: application/json

{
  "header": { "status": "ERROR", "code": "EWS_429_rate_limited", ... },
  "error": {
    "code": "EWS_429_rate_limited",
    "message": "30 queries/hour exceeded. Try again at 2026-05-06T13:00:00.000Z.",
    "severity": "MEDIUM"
  }
}
```

The SPA can read `Retry-After` (seconds) and gray out the input until the window opens.
