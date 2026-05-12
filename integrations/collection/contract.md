# Integration contract — Collection System

**Owner:** agent-integration
**Counterpart system owner:** Bank — Collections
**Status:** DRAFT v0.1 (Phase 0)

## Scope

Auto-routing of high-severity ZorEWS cases into the bank's existing
collection workflow + status callbacks for closed-loop outcomes.

## Transport

| Direction | Channel | Frequency |
|-----------|---------|-----------|
| EWS → Collection | REST (`POST /collection/cases`) | Real-time (≤ 60s after alert) |
| Collection → EWS | Webhook (`POST /ews/collection/callback`) | On status change |
| Reconciliation   | S3 daily snapshot | Daily 03:00 EAT |

## Outbound (EWS → Collection)

```json
{
  "case_id": "EWS-CASE-2026-04-00041",
  "alert_id": "...",
  "customer_id": "...",
  "loan_id": "...",
  "severity": "HIGH",
  "indicators": ["BEH_DEPOSIT_DROP_60D", "FIN_REPAY_RATIO_DROP"],
  "pd": 0.41,
  "recommended_action": "FIELD_VISIT",
  "raised_at": "2026-04-26T10:00:00Z"
}
```

Required for: `severity in [HIGH, CRITICAL]` (FR-CASE-2). Idempotent — same
`case_id` is a no-op if already created.

## Inbound (Collection → EWS callback)

```json
{
  "case_id": "EWS-CASE-2026-04-00041",
  "collection_case_id": "COL-77231",
  "status": "ASSIGNED|IN_PROGRESS|CONTACTED|PROMISE_TO_PAY|CURED|CURED_TEMP|DEFAULTED|RETURNED",
  "officer_id": "off-441",
  "occurred_at": "2026-04-26T11:34:00Z",
  "notes": "Customer promised payment by 30-04-2026."
}
```

Drives the case state machine state transitions in `agent-case`.

## Security

- mTLS + OAuth 2.0 (`collection.write`, `collection.callback`).
- HMAC signature on the callback (`X-APEX-Signature`).
- Personal field-officer notes (free text) field-encrypted at rest.

## SLA

- Outbound P95 ≤ 5s; ≥ 95% of HIGH/CRITICAL cases routed within 60s of alert
  (Phase 3 acceptance).
- Reconciliation breaks > 0.05% trigger an EWS alert (`RECON_002`).

## Hand-offs

- agent-case calls this contract on every state transition into `ASSIGNED`.
- agent-ui (Mobile) displays Collection-system case URL deep-link in field
  officer's view.
