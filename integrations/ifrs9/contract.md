# Integration contract — IFRS 9 ECL Engine

**Owner:** agent-integration
**Counterpart system owner:** Bank — Risk / Finance
**Status:** DRAFT v0.1 (Phase 0)

## Scope

Bidirectional integration with the bank's IFRS 9 staging engine:

- **Inbound to APEX EWS:** stage migration signals (Stage 1 → 2 → 3) and ECL
  inputs per loan.
- **Outbound from APEX EWS:** PD overrides + behavioural indicators that may
  influence stage assignment in the next monthly run.

## Transport

| Channel | Mode | Frequency |
|---------|------|-----------|
| REST (this contract) | Pull | Per-loan on demand + monthly batch |
| S3 dump              | Push  | Monthly (T+5 working days) |

No Kafka. IFRS 9 cycle is monthly; real-time events do not apply.

## Inbound payload

`GET /ifrs9/stages/{customer_id}` returns:

```json
{
  "customer_id": "...",
  "as_of": "2026-04-30",
  "loans": [
    {
      "loan_id": "...",
      "stage": 2,
      "stage_prev": 1,
      "stage_changed_at": "2026-04-22",
      "ecl_12m": 1234.56,
      "ecl_lifetime": null,
      "pd_12m": 0.07,
      "lgd": 0.45,
      "ead": 50000.0
    }
  ]
}
```

## Outbound payload

`POST /ifrs9/inputs` — APEX EWS publishes a per-customer feature pack the IFRS
9 engine reads at month-end:

```json
{
  "as_of": "2026-04-30",
  "customer_id": "...",
  "behavioural_score": 0.62,
  "indicator_signals": [
    {"id": "BEH_DEPOSIT_DROP_60D", "value": 0.71, "severity": 0.8}
  ],
  "pd_apex": 0.12
}
```

## Security

- mTLS + OAuth 2.0 client-credentials (`ifrs9.read`, `ifrs9.write`).
- All payloads signed with detached JWS (RS256) using KMS-resident key
  `alias/apex-ews-secret`.
- No PII; loan_id and customer_id are opaque CBS identifiers.

## SLA

- `GET /ifrs9/stages/{id}` P95 ≤ 800 ms.
- Monthly batch outbound completes by working day +5; outbound API expects
  2xx within 10 min.

## Hand-offs

- agent-data — consumes monthly batch into `mart.ifrs9_stage`.
- agent-ai — feature pack consumed by PD model retraining run.
