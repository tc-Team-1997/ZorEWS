# ZorEWS — Threat Model

**Phase:** [Security validation flow](operationalization/go-live-gating.md) Stage 2 (pre-pentest, W3-W4)
**Owner:** CISO + SRE-lead + per-service owners
**Methodology:** STRIDE-per-element, mapped against OWASP API Top 10 (2023)
**Last updated:** 2026-05-21
**Status:** Draft — to be finalised at the W3 threat-model workshop

> Identifies threats to the ZorEWS production deployment ahead of the formal pentest (T7). STRIDE is applied to every architectural element; each threat is rated severity (Critical/High/Medium/Low) and mapped to its mitigation (existing control OR new task). **This document is an input to `docs/pentest-brief.md` — it tells the vendor where we believe our blind spots are.**

## STRIDE legend

| Letter | Threat category | What it means |
|---|---|---|
| **S** | Spoofing | Impersonating an identity (user, service, tenant) |
| **T** | Tampering | Modifying data in transit or at rest without authorisation |
| **R** | Repudiation | Denying an action took place (audit gap) |
| **I** | Information disclosure | Reading data without authorisation |
| **D** | Denial of service | Making a resource unavailable |
| **E** | Elevation of privilege | Gaining capabilities beyond authorised scope |

Severity per CVSS 3.1 + banking-tighter internal mapping (per `docs/pentest-brief.md` §5):
- **Critical (9.0+):** auth bypass / tenant isolation breach / audit forge / mass-PII disclosure
- **High (7.0-8.9):** privilege escalation / SQL injection / cryptographic weakness
- **Medium (4.0-6.9):** session fixation / XSS / weak rate-limit / IDOR-not-tenant
- **Low (<4.0):** info disclosure of low-value data / brute-force at slow rate

## 1. Data flow diagram (DFD) — element inventory

The threat surface is decomposed into 11 architectural elements:

| ID | Element | Trust boundary | Owner |
|---|---|---|---|
| E1 | Mobile RN app (iOS/Android) | UNTRUSTED (user device) | UI |
| E2 | Web SPA (browser) | UNTRUSTED (user device) | UI |
| E3 | CloudFront + WAF + ALB (edge) | EXTERNAL→INTERNAL boundary | SRE |
| E4 | auth-svc | TRUSTED (cluster-internal) | INT |
| E5 | BFF API gateway | TRUSTED (cluster-internal, public-fronted) | INT |
| E6 | regulatory-svc family (4 services) | TRUSTED | RULE+ALRT+CASE+IND |
| E7 | audit-svc + audit.event_log hash-chain | TRUSTED (write-once-from-services) | INT |
| E8 | Aurora PostgreSQL cluster | TRUSTED (network-isolated db-tier subnet) | DATA |
| E9 | MSK Kafka cluster | TRUSTED | DATA |
| E10 | External integrations (CBS, IFRS9, AML, Bureau, DMS, Insurance, Agent, Finance, HR — via VPN) | SEMI-TRUSTED (bank-controlled upstream) | INT |
| E11 | Vendor channels (SES, Africa's Talking, FCM, APNS, Anthropic Claude API) | SEMI-TRUSTED (third-party) | INT |

Trust boundaries — anything crossing one must be validated, authenticated, encrypted, and logged.

## 2. Threats — STRIDE per element

### E1 + E2: Mobile + SPA (UNTRUSTED user devices)

| ID | Threat | STRIDE | Severity | Existing control | Status | New action |
|---|---|---|---|---|---|---|
| T1.1 | User clones session token + replays on another device | S | High | M1.1 TOTP 2FA enforced on sensitive actions; SessionStore denylist on revoke; idle timeout 15min | OK | — |
| T1.2 | Stolen JWT used after expiry (clock skew bypass) | S | Medium | 30s skew margin in mobile `useLocation` JWT decode; auth-svc refuses expired tokens; SessionStore denylist | OK | — |
| T1.3 | XSS in SPA leaks JWT from localStorage | I+E | High | CSP with `script-src 'self'`; X-Frame-Options DENY; OWASP headers via Fastify onSend hook | OK | Pentest must validate CSP completeness against React-bundled assets |
| T1.4 | CSRF on state-changing routes | S | Medium | All mutating routes require `Authorization: Bearer`; SameSite cookies; no cookie-only auth | OK | — |
| T1.5 | Mobile app reverse-engineered → extract API URLs / signing logic | I | Low (BFF endpoints public + RBAC-gated regardless) | All security depends on BFF auth, not client secrets | OK | — |
| T1.6 | SQLite offline queue (T6-P3) corruption → action loss | T+D | Medium | SQLite WAL mode; per-action transaction; replay on next sync | TODO | Test in T6-P3 acceptance |
| T1.7 | Deep-link arbitrary URL injection | I+E | Low | M10.3 push transport rejects `http://`; universal-link config restricts schemes to `https://` and known app-link prefixes | OK | — |

### E3: CloudFront + WAF + ALB (EXTERNAL→INTERNAL boundary)

| ID | Threat | STRIDE | Severity | Existing control | Status | New action |
|---|---|---|---|---|---|---|
| T3.1 | DDoS exhausts ALB or downstream BFF | D | High | AWS Shield Standard (free) + WAF rate-limit 1000/s/IP; HPAs auto-scale BFF; CloudFront edge caching | OK (Shield Advanced is Year-2) | — |
| T3.2 | WAF false-negative — attack reaches BFF | I+E | Medium | OWASP Top 10 ruleset; rate-limit; pentest validates rules | OK | T7-P2 dedicated WAF test |
| T3.3 | TLS downgrade attack (1.0/1.1 acceptance) | I | High | ALB SecurityPolicy `TLSPolicy-2022-10` (TLS 1.2+ only) | TODO | Verify in T3-P5 |
| T3.4 | Cert expiry on api.apex-ews.example | D | Medium | cert-manager + ACM auto-rotation; 30d expiry alarm | TODO | T3-P5 wires cert-manager |

### E4: auth-svc

| ID | Threat | STRIDE | Severity | Existing control | Status | New action |
|---|---|---|---|---|---|---|
| T4.1 | Brute-force login (5+ attempts/min) | S | Medium | M1.1 rate-limit 5/15min; CAPTCHA gate after 2 failures; auto-lockout at 5 wrong-pwds | OK | — |
| T4.2 | TOTP backup-code replay | S+E | High | M1.1 backup codes single-use (argon2 hash; consumed on first use) | OK | — |
| T4.3 | JWT alg=none / RS256→HS256 confusion | S+E | Critical | M1.3 BFF JwksVerifier rejects unknown alg + verifies signature; jose@5 hardened | OK | T7-P2 dedicated JWT alg test |
| T4.4 | Stale JWKS — old key still valid | E | Medium | JWKS cache TTL=process lifetime; key rotation requires BFF restart | TODO | Year-2: cache TTL ≤ rotation window |
| T4.5 | Password history bypass (last-5 reuse) | E | Medium | M1.1 password_history table with argon2id; UNIQUE per (user, hash) | OK | — |
| T4.6 | Session fixation (pre-auth session passed to victim) | S | Medium | sid claim regenerated on every login; old sid added to denylist | OK | — |
| T4.7 | TOTP enrollment bypass (skip-2fa via direct API call) | E+S | High | M1.1 `/auth/2fa/verify` is the ONLY path to convert pending→enrolled | OK | — |
| T4.8 | OAuth client_credentials timing attack on token endpoint | I | Low | argon2id constant-time compare + crypto.timingSafeEqual on bearer prefix | OK | — |

### E5: BFF API gateway

| ID | Threat | STRIDE | Severity | Existing control | Status | New action |
|---|---|---|---|---|---|---|
| T5.1 | Cross-tenant data leak via `X-Tenant-ID` header tampering | S+I+E | **Critical** | T4.24 P3 + P7: JWT `tenant_id` claim validated against header; mismatch → 403 EWS_403_tenant_mismatch (CRITICAL severity); ~8000 jest tests assert | OK | T7-P2 dedicated tenant-isolation suite |
| T5.2 | IDOR — supplying another tenant's resource_id | S+I | High | Store layer scopes every read to `tenant_id`; cross-tenant returns 404 not 403 (existence-probe guard) | OK | — |
| T5.3 | SQL injection via filter compiler (T4.6) | T+E | Critical | T4.6.2 8-safety-rail filter compiler; parameterised SQL; assertSafeSql forbidden-keyword regex; `:p0,p1` parameter binding | OK | T7-P2 dedicated injection suite + T2.9 NL→SQL test |
| T5.4 | API key tenant override via Bearer auth | E | Critical | M1.3 middleware: when api-key auth wins, `X-Tenant-ID` header is IGNORED; tenant baked into key | OK | T7-P2 verify |
| T5.5 | Service-account key leakage via /v1/admin/api-keys response | I | High | M1.2: full key returned ONCE on create; subsequent GET returns hash-prefix-only; constant-time verify | OK | — |
| T5.6 | Webhook secret leakage via /v1/webhooks response | I | High | T4.12: secret returned ONCE on create; subsequent GET shows hash-prefix-only | OK | — |
| T5.7 | Webhook SSRF — attacker subscribes to internal URL (169.254.169.254) | I+E | High | T4.12 dispatcher validates URL: refuses RFC1918 + link-local + cloud metadata IPs | OK | T7-P2 SSRF suite |
| T5.8 | RBAC matrix bypass via header injection | E | High | `infra/rbac/matrix.json` + `@apex-ews/rbac` requireRole + per-route assertion; CI gate via rbac-matrix.yml | OK | T7-P2 dedicated suite |
| T5.9 | Maker-checker self-approval bypass | E | High | M9.3: server-side check `maker !== checker`; 409 EWS_409_self_approval_forbidden | OK | — |
| T5.10 | CSRF on state-changing routes (cookie-only fallback) | S | Medium | All `/v1/*` routes require Bearer (no cookie auth); CORS allowlist by Origin | OK | — |
| T5.11 | Reports/PDF/Excel command-injection via report parameter | T+E | Medium | T4.6.4 execution engine sanitises inputs; PDF/Excel render via library code, not shell | OK | — |
| T5.12 | Path traversal on report download | I | Medium | report_id strict regex; no filename in URL | OK | — |
| T5.13 | Rate-limit bypass via tenant-rotation | D | Medium | Rate limits keyed on (api_key OR session) + tenant — rotating headers doesn't bypass | TODO | Verify via load test + WAF |
| T5.14 | DoS via deep-nested filter tree | D | Medium | T4.6.2 complexity caps: AND/OR ≤ 20 children, MAX_PARAMS=200, in/not_in ≤ 100 elements | OK | — |

### E6: regulatory-svc family

| ID | Threat | STRIDE | Severity | Existing control | Status | New action |
|---|---|---|---|---|---|---|
| T6.1 | Direct service access bypassing BFF (e.g. ALB misroute) | S+E | High | regulatory-svc family runs on internal cluster-only LB; not exposed via public ALB | TODO | T3-P5 verify network policies enforce no public ingress |
| T6.2 | Rule promotion forge — bypass maker-checker | E | High | T4.7 rule lifecycle + M9.3 maker-checker; PromotionEngine refuses self-approval | OK | — |
| T6.3 | Retired-model scoring (e.g. ML inference on archived model) | T+I | Medium | M7.2 returns 409 EWS_409_retired on score request | OK | — |
| T6.4 | Cross-rule data exfiltration via custom DSL | I+E | High | Rule DSL is interpreted (not compiled to SQL); cannot reach outside mart.* via T4.6.2 contract | OK | T7-P2 verify |
| T6.5 | Indicator catalogue tampering | T | High | Catalog is platform-static (not tenant-mutable); CI gate prevents PR merge without sign-off | OK | — |

### E7: audit-svc + audit.event_log hash-chain

| ID | Threat | STRIDE | Severity | Existing control | Status | New action |
|---|---|---|---|---|---|---|
| T7.1 | Audit forgery — insert past event with valid prev_hash | T+R | **Critical** | M15.2 hash-chain SHA-256 over canonical encoding; per-tenant chain segmentation; `verifyChain` walks oldest-first | OK | T7-P2 dedicated hash-chain forgery test |
| T7.2 | Audit truncation — delete tail events | T+R | **Critical** | S3 Object Lock COMPLIANCE 7-year on `apex-ews-audit-logs` bucket; cannot be deleted within retention window | OK (T2-P5) | — |
| T7.3 | Audit replay — duplicate event injection | T | High | event_id is UUID; INSERT carries UNIQUE constraint; verifyChain detects link break | OK | — |
| T7.4 | Cross-tenant audit pollution — write to another tenant's chain | T+E | Critical | M15.1 record() requires explicit `tenant_id`; per-tenant chain segmentation; integrity verification per tenant | OK | — |
| T7.5 | Audit gap — sensitive action not recorded | R | High | M9.3 maker-checker + M13.2 config + M15.1 all wire audit fan-out at the route layer; unit tests assert audit on every mutation | OK | T7-P2 verify via code review |

### E8: Aurora PostgreSQL

| ID | Threat | STRIDE | Severity | Existing control | Status | New action |
|---|---|---|---|---|---|---|
| T8.1 | Direct DB access from outside VPC | I+E | Critical | db-tier subnet with NACL ingress-deny-all from outside VPC; RDS Proxy enforces IAM auth + TLS | TODO | Verify in T2-P1 / readiness-checklist D1 |
| T8.2 | Service-account credential leak → arbitrary table access | I+E | High | Per-service Aurora user with least-priv GRANTS (no superuser); `data/schema/004_app_schemas.sql` documents grants | OK | T7-P2 verify via PG_HBA + role inspection |
| T8.3 | Backup snapshot leak (e.g. cross-account share) | I | High | Snapshots encrypted with KMS CMK; copy-snapshot to non-prod account explicitly forbidden via SCP | TODO | Verify in T1-P2 SCP |
| T8.4 | TLS bypass (client connects without TLS) | I | High | parameter_group `rds.force_ssl=1`; AWS RDS Proxy `require_tls: true` | OK | T7-P2 verify |
| T8.5 | Logical replication tap (e.g. unauthorised CDC subscriber) | I | Medium | Logical replication slots monitored; CDC only on explicit allowlist | TODO | Year-2 control |

### E9: MSK Kafka

| ID | Threat | STRIDE | Severity | Existing control | Status | New action |
|---|---|---|---|---|---|---|
| T9.1 | Unauthorised topic read | I | High | MSK IAM auth (T2-P4); per-topic ACL grants only the producer/consumer SAs | OK | — |
| T9.2 | Topic injection (publish to apex.audit.events from non-authorised service) | T+S | High | IAM policy scopes Write to specific producer SA per topic; CI gate via security-scan IAM check | OK | T7-P2 verify |
| T9.3 | MSK replication lag → DR failover loses recent events | D | Medium | MM2 replication monitored (T5.2); 2-minute lag SLO budget | TODO | Year-2: tune retention |

### E10: External integrations (CBS / IFRS9 / AML / Bureau via VPN)

| ID | Threat | STRIDE | Severity | Existing control | Status | New action |
|---|---|---|---|---|---|---|
| T10.1 | Bank-side breach → tainted data reaches mart | T | Medium | dbt tests + reconciliation drift alarm at 0.1%; quarantine on >0.5% drift | OK | T4-P2 verify |
| T10.2 | VPN tunnel compromise → data exfiltration | I | High | IPsec with FIPS-validated crypto; 2 tunnels active-active; CloudWatch tunnel state alarm | OK | — |
| T10.3 | Bank API rate-limit ban our IP → integration outage | D | Medium | T3.1.1 ResilientCbsClient with circuit breaker + retry + audit; M14.26 SLA budget | OK | — |
| T10.4 | Bank-side credential leak (our credentials to bank API) | I+E | High | Secrets Manager rotation; per-bank credential isolated; revoke-on-leak runbook | OK | `docs/bau-runbook.md` |

### E11: Vendor channels (SES / AT / FCM / APNS / Claude)

| ID | Threat | STRIDE | Severity | Existing control | Status | New action |
|---|---|---|---|---|---|---|
| T11.1 | Vendor data leak via DPA breach | I | Medium | DPA per vendor in `docs/vendor-accounts.md`; sub-processor disclosure to tenants | OK | Annual security review per BAU §5 |
| T11.2 | SES sender reputation poisoning by phishing on our domain | T+S | Medium | SPF + DKIM + DMARC on `alerts.apex-ews.example`; SES bounce/complaint monitoring | TODO | Year-2 DMARC reject policy |
| T11.3 | Push notification leakage of sensitive info | I | Medium | M10.3 templates carry only Alert ID / Case ID — no PII; deep-link to authenticated SPA | OK | T7-P2 verify |
| T11.4 | Claude API leaks confidential prompts | I | Low | T2.9 stub mode; production requires DPA; no PII in prompts (per template review) | OK | — |
| T11.5 | Africa's Talking SMS spoofing (sender-ID hijack) | S | Low | Sender-ID registered with AT; locked at carrier level | OK | — |

## 3. Cross-cutting threat scenarios

### TX-1: "Insider with audit:read scope" (rogue admin)

A user with admin RBAC (audit:read scope) attempts to:
1. Read every tenant's audit log → **mitigated** by tenant_id filter on M15.1 list+get; admin sees only their own tenant
2. Disable audit logging mid-action → **mitigated** by audit fan-out at the route layer; cannot be turned off without code change
3. Export user PII via reports endpoint → **mitigated** by RBAC + reports:share scope (T4.6.3); PII fields tagged via M14.6 catalog
4. Forge a maker-checker approval → **mitigated** by maker ≠ checker enforcement

**Residual risk:** rogue admin can read their tenant's audit log + read PII within their RBAC scope. Mitigated by quarterly access review (X.1) + Plus rotation off privileged roles.

### TX-2: "Compromised CI runner"

GitHub Actions runner compromised:
1. Push malicious code → **mitigated** by branch protection on main (requires PR + 1 review + CI green)
2. Issue malicious AWS API calls → **mitigated** by OIDC-scoped IAM role with read-only + assume-role for production deploys only
3. Read secrets → **mitigated** by GitHub Secrets encrypted at rest + auditable via gh audit log

**Residual risk:** malicious PR mergeable by compromised maintainer. Mitigated by quarterly access review + 1-reviewer-not-author requirement on main.

### TX-3: "Lost mobile device" (field officer scenario)

Device stolen with active session:
1. Session age >15min → idle timeout fires; re-auth required
2. Session active → attacker has access until JWT expires (12h max) — **mitigated** by SessionStore denylist on revoke + TOTP required for sensitive actions
3. Offline queue carries PII → **mitigated** by SQLite encryption (platform keystore-backed)

**Residual risk:** 12h window where revocation isn't possible if user can't report theft. Mitigated by short JWT TTL + admin-revoke flow in BAU runbook.

## 4. Threat-to-pentest-scope mapping

The vendor engaged for T7 will test specifically against these threats (subset of pentest brief):

| Threat ID | Pentest test category (per docs/pentest-brief.md §3) |
|---|---|
| T1.3 (XSS) | Injection — reflected + stored XSS, CSP completeness |
| T4.1-T4.8 (auth + 2FA) | Auth + Identity |
| T5.1-T5.4 (tenant isolation) | Authz + Tenant — IDOR, X-Tenant-ID override, RBAC matrix bypass |
| T5.3 (SQL injection) | Injection — parameterised SQL verification |
| T5.7 (SSRF on webhooks) | Injection — SSRF |
| T7.1-T7.5 (audit chain) | Crypto + Business logic — hash-chain forgery, audit gap |
| T8.4 (TLS bypass) | Crypto + Authz |
| T11.3 (push notification PII) | Information disclosure |

Pentest finding severity follows the same banking-tighter mapping as this threat model.

## 5. Risk acceptance log (residual)

Threats explicitly accepted as residual risk (with sign-off):

| Threat | Owner | Acceptance rationale | Re-review date | CISO sign |
|---|---|---|---|---|
| T4.4 (stale JWKS cache) | CISO | Process-lifetime cache vs production rotation = 1 BFF restart per quarter; trade-off accepted for prototype phase | Year-2 Q1 | TBD |
| T8.5 (logical replication tap) | DATA + CISO | No production logical replication in v1; monitoring covers; will tighten in Year-2 | Year-2 Q1 | TBD |
| T11.2 (DMARC reject policy) | INT | Sender domain shared; reject would break legitimate emails initially; Year-2 ramp to reject after monitoring | Year-2 Q1 | TBD |

## 6. Workshop output (W3-W4)

This document will be the input to the W3 threat-model workshop. The agenda:

| Time | Activity | Lead |
|---|---|---|
| 0:00-0:15 | DFD review + element inventory | SRE-lead |
| 0:15-1:15 | STRIDE walk per element (E1-E11) | CISO |
| 1:15-1:45 | Cross-cutting scenarios (TX-1 through TX-3) | CTO |
| 1:45-2:15 | Risk acceptance discussion | CISO + Risk-IT |
| 2:15-2:30 | Pentest scope sign-off | CISO + vendor PM |

Workshop output:
- Finalised threat list with severity + status
- Mitigations queued as tasks in TASKS.md (if "TODO" status)
- Sign-off on residual-risk register
- Pentest scope letter to vendor

## 7. Living document

This threat model is reviewed:
- **Quarterly** alongside `docs/risk-register.md` review
- **On every architecture change** (per `docs/charter.md` change-control)
- **On every pentest finding** that suggests a missed threat axis
- **On every regulator query** that touches a specific element

Updates land via PR-to-`main` with CISO review.
