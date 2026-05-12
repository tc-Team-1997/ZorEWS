# Integration contract — AML

**Owner:** agent-integration
**Counterpart system owner:** Bank — Financial Crime
**Status:** DRAFT v0.1 (Phase 0)

## Scope

Bidirectional alert correlation:

- **Inbound:** AML transaction monitoring alerts that may correlate with EWS
  signals (e.g. unusual repayment source).
- **Outbound:** EWS-detected anomalies that may indicate financial-crime
  exposure (e.g. account behaviour suggesting third-party repayment funding).

## Transport

REST webhooks both directions + a shared correlation_id.

## Inbound webhook

`POST /aml/inbound` — AML system → ZorEWS.

```json
{
  "aml_alert_id": "AML-2026-04-00123",
  "customer_id": "...",
  "scenario": "STR_HIGH_VELOCITY",
  "severity": "HIGH",
  "raised_at": "2026-04-26T10:14:00Z",
  "correlation_id": "..."
}
```

## Outbound webhook

`POST /aml/outbound` — ZorEWS → AML.

```json
{
  "ews_alert_id": "...",
  "customer_id": "...",
  "indicators": ["BEH_REPAY_FROM_NEW_ACCT", "TXN_ROUNDED_DEPOSITS"],
  "severity": "MEDIUM",
  "correlation_id": "..."
}
```

## Security

- mTLS, HMAC-SHA256 request signature in `X-APEX-Signature`, replay window 5 min.
- Webhook secret rotated quarterly via Secrets Manager.
- No PII — opaque `customer_id` only.

## SLA

- Webhook delivery P95 ≤ 2s. 3 retries with exponential back-off (1s/4s/16s).
- Dead-letter queue: SQS FIFO `apex-ews-aml-dlq`, alert fires if depth > 0 for > 5 min.

## Hand-offs

- agent-alert produces the outbound webhook from `apex.regulatory.events`
  consumer.
- agent-case enriches case timeline with the inbound `aml_alert_id`.
