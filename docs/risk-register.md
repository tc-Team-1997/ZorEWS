# ZorEWS — Programme Risk Register

**Owner:** orchestrator · **Cadence:** Reviewed monthly + at every steering committee · **Last reviewed:** 2026-05-20

> Tracked risks across the programme. Each row carries: ID, description, category, probability, impact, exposure (P × I), mitigation, owner, status, review date. Composite "exposure" tier = max(probability, impact) heuristic.

**Probability tiers:** Low (< 25%) · Medium (25-60%) · High (> 60%)
**Impact tiers:** Low · Medium · High · Critical

**Categories:** TECH (technical), SEC (security), COMP (compliance/regulatory), OPS (operational), FIN (financial), BIZ (business/stakeholder), VEND (vendor).

---

## 1. Active risks

### R-001 — Production deploy not yet executed
- **Category:** TECH
- **Description:** Terraform IaC for all 5 layers (00-landing-zone → 40-edge) shipped + validated in CI, but `terraform apply` has never run in any AWS account. Real account-level edge cases (quota limits, region availability, KMS grants) only surface at apply time.
- **Probability:** High · **Impact:** Medium · **Exposure:** Medium
- **Mitigation:** Plan dry-run weekly with `terraform plan -var-file=dev.tfvars`. First apply targets dev account with reduced footprint. Year-2 Theme A epic owns this.
- **Owner:** SRE lead + agent-integration
- **Status:** Open
- **Next review:** Year-2 kickoff

### R-002 — Audit chain forgery via parallel session
- **Category:** SEC
- **Description:** Audit chain (M15.2) signs every event with SHA-256 + prev_hash. If a malicious actor with admin tenant access could insert + recompute hashes faster than `verifyChain` detection cadence, integrity claims could be bypassed.
- **Probability:** Low · **Impact:** Critical · **Exposure:** High
- **Mitigation:** `verifyChain()` runs in BAU daily checklist (T5.6 §1). Pentest brief (T5.4 §3.4) mandates hash-chain forgery as a Critical test case. Production swap to WORM-backed audit-svc + S3 Object Lock COMPLIANCE preserves chain across tamper attempts.
- **Owner:** CISO + agent-integration
- **Status:** Open (mitigation in place; pentest will validate)
- **Next review:** Post first pentest

### R-003 — Tenant isolation bypass
- **Category:** SEC
- **Description:** Multi-tenant context (T4.24) gates every public `/v1/*` endpoint with JWT tenant claim + `X-Tenant-ID` header validation. A bug in middleware ordering or RBAC enforcement could leak BANK_DEMO data to BIL or vice versa.
- **Probability:** Medium · **Impact:** Critical · **Exposure:** Critical
- **Mitigation:** Tenant scoping covered in every BFF route test (~8000 jest tests assert isolation). Pentest brief T5.4 §3.2 mandates IDOR + X-Tenant-ID override as Critical tests. CI gate blocks merge if RBAC tests fail.
- **Owner:** CISO + agent-integration
- **Status:** Open (mitigation strong; ongoing validation)
- **Next review:** Monthly

### R-004 — Bank API integration delays (T3.1-T3.3)
- **Category:** BIZ
- **Description:** Live CBS / IFRS9 / AML connectors require bank API access + MoUs. Bank IT teams may take 4-8 weeks longer than estimated to provision sandbox access.
- **Probability:** High · **Impact:** Medium · **Exposure:** High
- **Mitigation:** OpenAPI mocks for all 4 systems already ship in `integrations/`. Synthetic data generator covers 10k customers. Per-tenant feature flag allows tenants to opt in to live integration on a per-bank schedule. Year-2 Theme C epic.
- **Owner:** agent-integration + BANK stakeholder
- **Status:** Open
- **Next review:** Quarterly with BANK

### R-005 — Pentest finds Critical requiring architecture change
- **Category:** SEC
- **Description:** First third-party pentest (Year-2 Theme A) may surface a Critical finding requiring re-architecture (e.g. fundamental flaw in JWT validation, hash chain, tenant scoping). Remediation could slip 4-8 weeks.
- **Probability:** Medium · **Impact:** High · **Exposure:** High
- **Mitigation:** Pentest brief (T5.4) is tight + methodology mandates threat-model up-front + remediation playbook has Critical 3-day patch SLA. Internal red-team exercise pre-pentest to surface obvious flaws first.
- **Owner:** CISO
- **Status:** Open
- **Next review:** Pre-engagement (T-2 weeks)

### R-006 — Model performance degradation post-retrain
- **Category:** TECH
- **Description:** Continuous learning loop (T5.1 / Year-2 Theme E) auto-promotes new models via the gate. A retrained model may pass the gate but degrade on a tenant-specific subset (segment drift). Tenant-facing accuracy drop without operator awareness.
- **Probability:** Medium · **Impact:** Medium · **Exposure:** Medium
- **Mitigation:** Champion/challenger A/B (Year-2 Theme E) before full traffic. Drift monitor (T2.6) alerts on prediction-distribution shift. Auto-promotion gate (T5.1) enforces thresholds. Model card auto-generation surfaces decision rationale.
- **Owner:** agent-ai
- **Status:** Open
- **Next review:** Year-2 Theme E kickoff

### R-007 — AWS region availability for secondary
- **Category:** OPS
- **Description:** Default secondary region is `ap-south-1` (Mumbai). If RBI / IRDAI mandate data residency requiring an alternative region (e.g. `ap-south-2` Hyderabad still in beta), DR plan slips.
- **Probability:** Low · **Impact:** Medium · **Exposure:** Medium
- **Mitigation:** `var.secondary_region` is configurable in T5.2 Terraform. Compliance officer tracks regulatory data-residency rulings monthly.
- **Owner:** SRE lead + Compliance officer
- **Status:** Open
- **Next review:** Monthly

### R-008 — BIL stakeholder scope creep
- **Category:** BIZ
- **Description:** BIL has 16 modules with ~88 sub-phases remaining (Year-2 Theme B). Stakeholder may push for unlisted modules or expanded scope mid-flight.
- **Probability:** High · **Impact:** Medium · **Exposure:** High
- **Mitigation:** Quarterly scope review with BIL per `docs/year-2-backlog.md`. Change control via steering committee (per charter §9). Out-of-scope items move to Year-3 backlog rather than slipping in.
- **Owner:** ORCH + BIL stakeholder
- **Status:** Open
- **Next review:** Quarterly

### R-009 — Regulator issues new directive mid-flight
- **Category:** COMP
- **Description:** RBI (Cyber Resilience June 2024) or IRDAI (Info-Sec April 2023) may issue new guidance during the year-2 window. 4+ weeks rework if material.
- **Probability:** Medium · **Impact:** Medium · **Exposure:** Medium
- **Mitigation:** Compliance officer subscribes to RBI + IRDAI bulletins + monthly review. `docs/compliance-mapping.md` tracks current controls; gap analysis on new directive within 5 business days.
- **Owner:** CISO + Compliance officer
- **Status:** Open
- **Next review:** Monthly

### R-010 — Vendor lock-in (AWS)
- **Category:** VEND
- **Description:** Heavy use of AWS-specific services (Aurora Global, MSK, EKS, KMS, Glue, MSK Connect, CloudWatch). Migration to multi-cloud would require 6-12 months effort.
- **Probability:** Medium · **Impact:** Low · **Exposure:** Medium
- **Mitigation:** Pure-function business logic in BFF + services keeps domain logic portable. Storage abstracted behind interfaces (`IUserStore`, `ICaseStore`, etc.) — pg vs in-memory swap is a one-line factory change. Multi-cloud explicitly Year-2 out-of-scope (charter §2).
- **Owner:** CTO
- **Status:** Accepted (documented + reviewed annually)
- **Next review:** Annual

### R-011 — Webhook subscriber outage
- **Category:** TECH
- **Description:** Outbound webhooks (T4.12) fan out to external subscribers. Subscriber-side outage triggers retry storm (3 retries with 1s/4s/16s backoff). At-scale, could push BFF latency.
- **Probability:** Medium · **Impact:** Low · **Exposure:** Medium
- **Mitigation:** Webhook dispatcher uses fire-and-forget pattern (caller doesn't wait). Per-subscription delivery log + auto-disable at 100% failure for 7 days (per `docs/bau-runbook.md` §6.3). Year-2 may add DLQ + circuit breaker.
- **Owner:** agent-integration + SRE lead
- **Status:** Open
- **Next review:** Quarterly

### R-012 — KMS rotation breaks live workloads
- **Category:** SEC
- **Description:** KMS rotation (annual per `docs/bau-runbook.md` §5) on the active envelope-encryption key could break in-flight Aurora reads / MSK consumers / S3 reads if grants don't refresh atomically.
- **Probability:** Low · **Impact:** High · **Exposure:** High
- **Mitigation:** Rotation tested in staging first. Aurora + MSK use envelope encryption with KMS grants — rotation creates new key version but old version stays decryptable for object lifetime. CloudWatch alarms on KMS access denied.
- **Owner:** CISO + SRE lead
- **Status:** Open
- **Next review:** Pre-rotation (1 week before)

### R-013 — Synthetic dataset misrepresents real risk
- **Category:** TECH
- **Description:** Prototype uses 10k synthetic customers + deterministic synth across all M14 adapters. Real production data may surface signal patterns not present in synthetic (e.g. concept drift, adversarial patterns).
- **Probability:** High · **Impact:** Low · **Exposure:** Medium
- **Mitigation:** Acknowledged limitation. All resolver shapes are stable so swap to real data is plug-in. T2.1 feature store backfill + Year-2 Theme E drift monitor catch concept drift post-launch.
- **Owner:** agent-data + agent-ai
- **Status:** Accepted
- **Next review:** Pre-production launch

### R-014 — RBAC matrix drift between code + JSON
- **Category:** OPS
- **Description:** RBAC matrix lives in `infra/rbac/matrix.json` + is enforced by `@apex-ews/rbac` middleware. Code-side changes (new route, new role) may forget to update the JSON, causing 403s or worse, missing-permission bypass.
- **Probability:** Medium · **Impact:** Medium · **Exposure:** Medium
- **Mitigation:** RBAC CI gate runs `access_review.py --validate-only` on every PR touching `infra/rbac/**`. Pentest brief T5.4 §3.2 mandates RBAC bypass per role+op pair. Quarterly access review (X.1) catches drift.
- **Owner:** agent-integration + CISO
- **Status:** Open (CI gate mitigates)
- **Next review:** Quarterly

### R-015 — Single-engineer key-person dependency
- **Category:** OPS
- **Description:** Several agent owners (agent-ai, agent-rule, agent-indicator) are 1-deep. Departure or unavailability blocks the corresponding module's work.
- **Probability:** Medium · **Impact:** Medium · **Exposure:** Medium
- **Mitigation:** Documentation-first development (every module has README + mapping doc). Cross-training pairs assigned during code-review. CISO + CTO maintain a key-person roster + succession plan.
- **Owner:** CTO + HR
- **Status:** Open
- **Next review:** Quarterly

---

## 2. Closed / accepted risks

| ID | Description | Closure | Date |
|---|---|---|---|
| _none yet_ | | | |

Closed risks land here with a `Closure` note (e.g. "Mitigation deployed", "Accepted permanently with compensating controls", "No longer relevant"). Each closure logged in steering committee minutes.

---

## 3. Risk-acceptance log

See `docs/risk-acceptance-log.md` (to be authored when first risk is formally accepted).

---

## 4. Review cadence

| Cadence | Audience | Output |
|---|---|---|
| Monthly | Risk-IT + CISO | Status update on every Open risk |
| Quarterly | Steering committee | Risk register review + new risk identification + closure decisions |
| On incident | CISO + CTO | Post-incident new-risk evaluation |
| Annually | Board (via CISO) | Risk posture summary + budget impact |

---

## 5. References

- `docs/charter.md` — programme governance + risk appetite.
- `docs/raci.md` — accountability for each mitigation.
- `docs/pentest-brief.md` + `docs/pentest-remediation-playbook.md` — security risk validation.
- `docs/year-2-backlog.md` §3 — Year-2 risk table.
- `docs/bau-runbook.md` — operational mitigations (daily/weekly checks).
- `docs/dr-runbook.md` — disaster recovery mitigation.
- `docs/compliance-mapping.md` — regulatory risk coverage.
