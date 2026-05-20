# ZorEWS — Vendor Account Provisioning

**Owner:** CTO + agent-integration · **Last reviewed:** 2026-05-20

> Authoritative stub list of third-party vendor accounts the prototype + production deployment depend on. Each entry covers what the account is for, who owns it, where secrets are stored, rotation cadence, and the minimum SLA. Pair with `docs/compliance-mapping.md` (data-processing addendum requirements) + `docs/risk-register.md` R-010 (vendor lock-in).

---

## 1. Provisioning checklist

For each vendor:

- [ ] Account created under `ews-vendors@apex-ews.example` (shared mailbox with 2FA via Risk-IT TOTP token).
- [ ] Owner role assigned to CTO + secondary owner to agent-integration lead.
- [ ] Billing contact = finance@apex-ews.example with monthly cap alert.
- [ ] DPA (Data Processing Addendum) signed when handling personal data.
- [ ] Secrets stored in AWS Secrets Manager under `apex-ews/<env>/vendor/<vendor-name>` with KMS envelope encryption.
- [ ] IAM role / token rotation cadence documented + on quarterly checklist.
- [ ] Vendor security review completed (annual cadence per `docs/bau-runbook.md` §5).
- [ ] Vendor referenced in `docs/risk-register.md` if exposure > Low/Low.

---

## 2. Active vendor accounts

### 2.1 Anthropic (Claude API)

| Field | Value |
|---|---|
| Purpose | AI Copilot (T2.9 stub today; production NL→SQL + alert triage assistant) |
| Owner | CTO |
| Secondary owner | agent-ai |
| Secret path | `apex-ews/prod/vendor/anthropic` |
| Auth | API key (Bearer header) |
| Rotation | Quarterly (per BAU monthly checklist + AWS Secrets Manager rotation lambda) |
| SLA | 99.5% per Anthropic terms |
| DPA | Required (handles tenant queries; signed via Anthropic Trust Center) |
| Monthly cap | $1,500 (alert at 80%) |
| Status | **Stub** — placeholder key in dev; real key provisioning blocked on first NL→SQL production use case |
| Risk register link | n/a (cost cap mitigates Low/Medium exposure) |

**Notes:**
- ai-copilot-svc consumes the key via `ANTHROPIC_API_KEY` env var.
- Production should use Anthropic's region-specific endpoints once available in `ap-south-1`.
- Year-2 Theme E mentions Anthropic-mediated retraining workflows — re-evaluate scope when that lands.

### 2.2 Amazon SES (transactional email)

| Field | Value |
|---|---|
| Purpose | Outbound transactional email — M10.1 (alerts, OTP, KYC reminders, report-ready) |
| Owner | CTO |
| Secondary owner | agent-alert |
| Secret path | `apex-ews/prod/vendor/aws-ses` (IAM role instead of static creds — preferred) |
| Auth | IAM role with `ses:SendEmail` scoped to verified domain |
| Rotation | n/a (IAM role; KMS rotation per BAU annual) |
| SLA | 99.9% per AWS SES SLA |
| DPA | Covered by AWS Customer Agreement |
| Monthly cap | $500 (alert at 80%) |
| Status | **Stub** — Stub adapter in notification-svc; SES sender domain (`alerts.apex-ews.example`) needs DKIM + SPF + DMARC records once procured |
| Risk register link | n/a |

**Notes:**
- Email sender domain MUST be verified in SES console before first send.
- DMARC `p=quarantine` initially → `p=reject` after 30 days clean.
- Production should provision SES in same region as primary (af-south-1).

### 2.3 Africa's Talking (SMS gateway)

| Field | Value |
|---|---|
| Purpose | Outbound SMS — M10.2 (alert digests, OTP, KYC reminders, payment reminders) |
| Owner | CTO |
| Secondary owner | agent-alert |
| Secret path | `apex-ews/prod/vendor/africas-talking` |
| Auth | API key + username (header `apiKey` + `username`) |
| Rotation | Quarterly (per BAU monthly checklist) |
| SLA | Best-effort per AT terms (no formal SLA) |
| DPA | Required (handles E.164 numbers; sign during onboarding) |
| Monthly cap | $300 (alert at 80%) |
| Status | **Stub** — Stub adapter in notification-svc; AT sandbox account needed for first dev test |
| Risk register link | R-011 webhook/notification subscriber outage class |

**Notes:**
- Production deployment in Kenya region; reach to India tenants via fallback (e.g. MSG91).
- AT sandbox lets us validate the integration without burning real cost.
- Year-2 may swap to per-country SMS gateway aggregator (cost optimisation).

### 2.4 Firebase Cloud Messaging (FCM) — Android push

| Field | Value |
|---|---|
| Purpose | Outbound push notifications — M10.3 (Android devices) |
| Owner | CTO |
| Secondary owner | agent-ui |
| Secret path | `apex-ews/prod/vendor/firebase-fcm` (service account JSON) |
| Auth | Service account JSON via Firebase Admin SDK |
| Rotation | Annual (per service account best practice) |
| SLA | 99.9% per Google Cloud FCM SLA |
| DPA | Covered by Google Cloud Terms + DPA |
| Monthly cap | $0 (FCM is free at our volumes; Cloud Messaging API has free tier) |
| Status | **Stub** — Stub adapter in notification-svc; Firebase project needed before mobile RN release |
| Risk register link | n/a |

**Notes:**
- Tied to Year-2 Theme F (Mobile RN shell).
- Firebase project under `apex-ews-prod-fcm` Google Cloud project.

### 2.5 Apple Push Notification Service (APNS) — iOS push

| Field | Value |
|---|---|
| Purpose | Outbound push notifications — M10.3 (iOS devices) |
| Owner | CTO |
| Secondary owner | agent-ui |
| Secret path | `apex-ews/prod/vendor/apns` (APNs auth key .p8) |
| Auth | Token-based authentication via .p8 key |
| Rotation | Annual |
| SLA | Best-effort per Apple terms |
| DPA | Covered by Apple Developer Program License Agreement |
| Monthly cap | $0 (APNS is free) + Apple Developer Program $99/year |
| Status | **Stub** — Stub adapter; Apple Developer Program enrollment needed before mobile RN release |
| Risk register link | n/a |

**Notes:**
- Tied to Year-2 Theme F (Mobile RN shell).
- App Store Connect access needed by 1 Apple ID (CTO).

### 2.6 PagerDuty (on-call paging)

| Field | Value |
|---|---|
| Purpose | On-call rotation + incident paging (per `docs/on-call-rota.md`) |
| Owner | SRE lead |
| Secondary owner | agent-integration |
| Secret path | `apex-ews/prod/vendor/pagerduty` (API key) |
| Auth | API key (Bearer header) |
| Rotation | Quarterly |
| SLA | 99.99% per PagerDuty terms |
| DPA | Required (handles incident timeline + actor metadata) |
| Monthly cap | $250 (Business plan ~$21/user × 12 engineers) |
| Status | **Stub** — Slack-only paging in prototype; PagerDuty integration planned with on-call rotation roll-out |
| Risk register link | n/a |

### 2.7 Slack (incident comms + daily ops)

| Field | Value |
|---|---|
| Purpose | `#apex-ews-alerts` + `#apex-ews-oncall` + `#apex-ews-security` + DR-WAR-ROOM |
| Owner | CTO |
| Secondary owner | SRE lead |
| Secret path | `apex-ews/prod/vendor/slack` (webhook + bot token) |
| Auth | Incoming-webhook URL per channel + bot OAuth token for cross-channel posts |
| Rotation | Annual (bot token); webhook URL rotated on accidental disclosure |
| SLA | Per Slack Business+ |
| DPA | Required (incident timeline includes actor + customer metadata) |
| Monthly cap | $500 (Business+ plan ~$15/user × 20 users) |
| Status | **Stub** — Provisioned + webhook URLs configured for non-production env; production set-up alongside PagerDuty go-live |
| Risk register link | n/a |

### 2.8 DefectDojo (security finding tracking)

| Field | Value |
|---|---|
| Purpose | Pentest finding intake + SARIF import (per `docs/pentest-remediation-playbook.md`) |
| Owner | CISO |
| Secondary owner | agent-integration |
| Secret path | `apex-ews/prod/vendor/defectdojo` (API key) |
| Auth | API key (Bearer header) |
| Rotation | Quarterly |
| SLA | n/a (self-hosted or SaaS cloud edition) |
| DPA | Required (finding metadata may include sensitive details) |
| Monthly cap | $100 (cloud) OR $0 (self-hosted) |
| Status | **Stub** — Not yet provisioned; first pentest engagement triggers DefectDojo setup |
| Risk register link | R-005 pentest finds Critical |

### 2.9 Grafana Cloud (observability)

| Field | Value |
|---|---|
| Purpose | Dashboards + alert rules + on-call timeline (replaces self-hosted Grafana if cost wins) |
| Owner | SRE lead |
| Secondary owner | agent-integration |
| Secret path | `apex-ews/prod/vendor/grafana-cloud` (API key) |
| Auth | API key (Bearer header) |
| Rotation | Annual |
| SLA | 99.9% per Grafana Cloud terms |
| DPA | Required (custom metrics may include tenant_id) |
| Monthly cap | $500 (Pro plan; tier'd by metric ingestion volume) |
| Status | **Stub** — Self-hosted Grafana planned in EKS; cloud option evaluated in Year-2 Theme H cost optimisation |
| Risk register link | n/a |

### 2.10 GitHub (source + CI + container registry)

| Field | Value |
|---|---|
| Purpose | Source-of-truth + Actions CI + GHCR container registry |
| Owner | CTO |
| Secondary owner | agent-integration |
| Secret path | `apex-ews/prod/vendor/github` (PAT + GHCR token) |
| Auth | OIDC for AWS IAM federation (preferred) + PAT for service accounts |
| Rotation | Quarterly (PAT); OIDC token short-lived |
| SLA | 99.9% per GitHub Enterprise terms |
| DPA | Covered by GitHub Customer Agreement + DPA |
| Monthly cap | $200 (Team plan ~$4/user × 30 + Actions minutes overage) |
| Status | **Live** — repo + Actions + GHCR already wired; only secret-rotation cadence formalisation pending |
| Risk register link | n/a |

---

## 3. Vendor security review (annual)

For every vendor in §2, the annual review (per `docs/bau-runbook.md` §5 + CISO ownership) checks:

- [ ] SOC 2 Type II report current (or ISO 27001 equivalent).
- [ ] DPA still in force (post-merger, post-divestment, post-terms-change).
- [ ] Sub-processor list reviewed (no surprise additions handling tenant data).
- [ ] Incident history (any vendor-side breach in last 12 months).
- [ ] Pricing trend (any unexpected cost growth).
- [ ] Alternatives evaluated (lock-in mitigation — Year-2 Theme H).

Findings logged in `docs/vendor-review-history.md` (to be authored on first review).

---

## 4. Sub-processor disclosure

When ZorEWS handles tenant personal data, the following sub-processors are disclosed in the tenant DPA:

| Sub-processor | Data flow | Region |
|---|---|---|
| AWS (Aurora, MSK, S3, SES, EKS, KMS) | All data | af-south-1 + ap-south-1 (DR) |
| Anthropic (Claude API) | Copilot queries (no raw PII) | us-east-1 (region-pinned via API config) |
| Africa's Talking | E.164 phone numbers + SMS body | Kenya |
| Google Cloud (FCM) | Android device tokens (no PII payload) | us |
| Apple (APNS) | iOS device tokens (no PII payload) | us |
| PagerDuty | Incident timeline + actor metadata | us |
| Slack | Incident timeline + actor metadata | us |
| GitHub | Source code + CI artefacts (no tenant data) | us |

Updated within 30 days of any sub-processor change per DPA terms.

---

## 5. References

- `docs/charter.md` — programme governance.
- `docs/raci.md` — accountability for vendor onboarding.
- `docs/risk-register.md` R-010 (vendor lock-in), R-011 (subscriber outage), R-012 (KMS).
- `docs/bau-runbook.md` §5 — annual vendor security review.
- `docs/compliance-mapping.md` — DPA + sub-processor obligations.
- `docs/year-2-backlog.md` Theme H — cost optimisation incl. vendor consolidation.
