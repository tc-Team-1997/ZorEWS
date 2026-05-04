# notification-svc

Email + SMS fan-out for the APEX EWS alert pipeline (T1.11).

Subscribes (logically) to `apex.regulatory.events`. Routes each alert by
severity through one or more adapters, with credential-driven fallback to a
local logging adapter so the prototype runs end-to-end with zero AWS / vendor
state.

## Severity → channel matrix (FR-ALERT-4)

| Wire severity | SMS (Africa's Talking) | Email (SES) | In-app |
|---------------|------------------------|-------------|--------|
| `CRITICAL`    | yes                    | yes         | yes    |
| `HIGH`        | —                      | yes         | yes    |
| `MEDIUM`      | —                      | yes         | yes    |
| `LOW`         | —                      | —           | yes (no fan-out from this service) |

`HIGH` is not in the original FR-ALERT-4 sentence ("Critical: SMS+email;
Medium: email; Low: in-app") — we treat it like `MEDIUM` (email only) so
analyst inboxes still surface it without paging on every borderline case.
Easy to flip on if Ops decide otherwise.

## Adapters

| Adapter | Channel | When used | Fallback to LoggingAdapter when… |
|---------|---------|-----------|-----------------------------------|
| `SESAdapter` (`@aws-sdk/client-sesv2`) | email | `AWS_REGION` set | `AWS_REGION` unset |
| `AfricasTalkingAdapter` (REST) | sms | `AT_API_KEY` and `AT_USERNAME` set | either unset |
| `LoggingAdapter` | email \| sms | always available | n/a — final sink |

The logging adapter writes to stdout AND to `services/notification-svc/.outbox/<channel>-<YYYY-MM-DD>.ndjson`
so dev runs are deterministic and tests can read back what was "sent".

## Endpoints

| Method | Path | Body | Notes |
|--------|------|------|-------|
| `POST` | `/notify` | `{alert: AlertSummary, target: NotifyTarget}` | Direct fan-out test hook. |
| `POST` | `/events` | same | Alias used to mimic the Kafka subscriber path. |
| `GET`  | `/healthz` | — | Returns adapter names so callers can confirm whether real SES / AT is wired. |

`AlertSummary` mirrors `apex.regulatory.events.v2.json` (alert_id, customer_id,
severity, rule_id, reason_summary, pd, risk_level, raised_at).

## Configuration (env)

| Var | Default | Meaning |
|-----|---------|---------|
| `PORT` | `8083` | HTTP listener |
| `AWS_REGION` | unset → logging | SES region (defaults to IRSA / SDK chain for creds) |
| `APEX_SES_FROM` | `ews-alerts@apex-ews.example.com` | SES verified sender |
| `APEX_SES_DEFAULT_TO` | unset | Optional default recipient when target.email missing |
| `AT_API_KEY` | unset → logging | Africa's Talking API key |
| `AT_USERNAME` | unset → logging | AT account username |
| `AT_FROM` | unset | Sender id / short code |
| `AT_USE_SANDBOX` | unset | `1` → use AT sandbox endpoint |
| `AT_DEFAULT_TO` | unset | Optional default recipient |
| `APEX_NOTIFY_OUTBOX_DIR` | `services/notification-svc/.outbox` | Logging-adapter sink |

**No raw keys are ever read from disk.** All credentials are env-only; if a
required variable is missing the adapter quietly degrades to logging.

## Templates

* `src/templates/email.ts` — minimal HTML email with DMS navy header and a
  property table (id / severity / customer / rule / pd / risk-level).
  `${alert.summary}` is mapped to `alert.reason_summary` from agent-alert.
* `src/templates/sms.ts` — `[APEX EWS][<SEV>] <reason> id:<short>` truncated
  hard at 160 chars (single SMS segment).

## Run

```bash
cd services/notification-svc
npm install
npm run dev          # ts-node src/server.ts
# Send a test alert (logging fallback because no AWS_REGION / AT_API_KEY):
curl -sX POST localhost:8083/notify -H 'content-type: application/json' -d '{
  "alert": {
    "alert_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "customer_id":"CUST0000001",
    "severity":"CRITICAL",
    "rule_id":"RULE-014",
    "reason_summary":"Salary inflow stopped 60d",
    "raised_at":"2026-04-26T08:00:00Z",
    "pd":0.42,
    "risk_level":"High"
  },
  "target":{"email":"risk@example.com","phone":"+254700000000","display_name":"Ravi"}
}'
```

## Tests

```bash
cd services/notification-svc
npm install
npm test
```

Covers:

* Severity → channel matrix (CRITICAL / HIGH / MEDIUM / LOW).
* SES + AT factory fallback to LoggingAdapter when env is bare.
* SES adapter shape (rejects no-recipient; injected client returns SendResult).
* AT adapter posts to endpoint, parses `Recipients`, truncates body to 160.
* Template substitution (`${alert.summary}` → `reason_summary`; SMS contains
  short alert id).

## Docker

```bash
docker build -f services/notification-svc/Dockerfile -t apex-notification-svc:dev services/notification-svc
docker run --rm -p 8083:8083 apex-notification-svc:dev
```

## Blocked / TODO

* `npm install` / `npm test` not run in the build sandbox (no network). Run
  locally to verify.
* Real Kafka subscriber is a stub — `subscriber.ts` only exposes `onAlert()`;
  agent-integration owns the kafkajs consumer wiring once MSK is reachable
  from the EKS pod (IRSA SA already provisioned per
  `infra/k8s/`).
* In-app channel for LOW alerts is delivered through the web SPA's
  subscription on `apex.regulatory.events` (agent-ui / agent-integration),
  not from this service.
