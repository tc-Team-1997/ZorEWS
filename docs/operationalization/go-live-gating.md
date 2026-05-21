# ZorEWS — Go-Live Gating + Security/Compliance Validation Flow

**Last updated:** 2026-05-21
**Authoritative parent:** [`docs/production-operationalization-roadmap.md`](../production-operationalization-roadmap.md)
**Companion artefacts:** [execution-plans.md](execution-plans.md) · [dependency-matrix.md](dependency-matrix.md) · [readiness-checklists.md](readiness-checklists.md)

> Defines the hard, non-negotiable gates that block T9-P2 production cutover. Maps each gate to its evidence artifact, sign-off owner, fall-back path, and rollback procedure. **The steering committee uses this document as the authoritative go/no-go scorecard.**

## 1. The 5 hard go-live gates

All five must be **GREEN** at the T9-P1 review meeting. **No gate is waivable.** A single AMBER or RED slips T9-P2 by ≥1 week per failed gate.

| Gate | Description | Evidence artifact | Sign-off owner | Fallback if AMBER/RED |
|---|---|---|---|---|
| **A** | Pentest clean — final attestation states zero unremediated Critical + zero unremediated High >30 days SLA | `apex_ews_pentest_final_attestation_v1.pdf` signed by vendor + CISO + CTO + Risk-IT-lead | CISO | Slip 1-2 weeks per remediation cycle; re-run T7-P3 + T7-P4 |
| **B** | DR game-day Green — full-stack failover scoring rubric per `docs/dr-game-day-plan.md` returns Green across all 6 dimensions (RTO/RPO/runbook accuracy/validator findings/comms cadence/audit-chain integrity) | `apex_ews_dr_gameday_2026_QN_report.pdf` signed by SRE-lead + CISO | SRE-lead | Slip 2-4 weeks; re-run DR drill |
| **C** | 5× load-test PASS — `infra/load-test/scenarios/pilot_5x_mix.js` `thresholds_passed: true` over 15min run, with Aurora reader CPU <60%, MSK disk <70%, BFF p95 <800ms / p99 <2000ms / error rate <0.5% | `infra/load-test/reports/2026-MM-DD-5x-pilot-mix.md` filed; SRE-lead sign-off | SRE-lead | Slip 1 week per iteration; capacity uplift + retest; if 3 iterations fail → Year-2 Theme A epic |
| **D** | ISO 27001:2022 Stage-1 passed — pre-certification gap analysis green (no major non-conformities) per `docs/year-2-backlog.md` Theme I | `apex_ews_iso27001_stage1_audit_report.pdf` signed by auditor + CISO | CISO + auditor | Slip 4-6 weeks; remediate gaps; re-audit |
| **E** | Steering committee sign-off — minutes filed, all attendees voted PROCEED | `apex_ews_steering_signoff_2026_MM_DD.pdf` with CISO + CTO + Risk-IT-lead signatures | Steering chair | Reschedule meeting; slip ≥1 week |

## 2. Gate-by-gate validation sequence

The order in which gates are validated matters — each unlocks confidence in the next.

```
T+0  ─┬─ Track 7 Pentest (5w)
      │     │
T+8w ─┤     └─→ Gate A (pentest clean) ─┐
      │                                  │
T+6w ─┼─ DR game-day rehearsal (1d)     │
      │     │                            │
T+7w ─┤     └─→ Gate B (DR Green) ──────┤
      │                                  │
T+7w ─┼─ Track 8 Load test (3w)         ├─→ T9-P1 review meeting
      │     │                            │   ├─ Gate E (steering signs)
T+8w ─┤     └─→ Gate C (5× PASS) ───────┤   │
      │                                  │
T+0  ─┼─ ISO 27001 prep + audit (12w)   │
      │     │                            │
T+12w─┤     └─→ Gate D (ISO Stage 1) ───┘
      │
T+12w─┴─ T9-P1 review ─→ if all 5 GREEN → T9-P2 cutover
                       ─→ if any AMBER/RED → slip
```

## 3. Security + compliance validation flow

Sequenced flow from "code in repo" to "RBI/IRDAI regulator filed". Every stage produces a named artifact stored in `docs/` or a signed PDF in the secure document store.

```
┌─────────────────────────────────────────────────────────────────┐
│ Stage 1: CONTINUOUS (every PR + every commit to main)           │
│ ──────────────────────────────────────────────────────────────  │
│  • services-ci.yml      → all unit + integration tests pass     │
│  • schema-compat.yml    → BACKWARD compat for 7 Kafka schemas   │
│  • rbac-matrix.yml      → matrix self-consistent + 11 pytest    │
│  • terraform-ci.yml     → fmt + validate × 5 layers             │
│  • security-scan.yml    → Trivy IaC + Checkov + container scan  │
│                            (CRITICAL findings block merge)      │
│  Artifacts: GitHub Security dashboard + SARIF uploads           │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ Stage 2: PRE-PENTEST (W3-W4)                                    │
│ ──────────────────────────────────────────────────────────────  │
│  • Threat-model exercise (CISO + SRE + each service owner)      │
│  • Internal security-scan.yml report reviewed; zero Critical    │
│  • RBAC matrix Q2 access review per X.1                         │
│  • Penetration test brief reviewed with vendor                  │
│  Artifacts: docs/threat-model.md (new) · `docs/access-review-evidence-log.md` 2026-Q2 entry started │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ Stage 3: PENTEST EXECUTION (W6-W11)                             │
│ ──────────────────────────────────────────────────────────────  │
│  • Vendor runs phases 1-4 per docs/pentest-brief.md §4          │
│  • Daily status emails; flash reports on Critical within 4h      │
│  • Findings imported to DefectDojo                              │
│  • Critical: 3-day patch SLA; High: 14-day; Medium: 30-day      │
│  • Each patch goes through Stage 1 CI before re-testing         │
│  Artifacts: vendor_pentest_draft_report_v1.pdf (W11)            │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ Stage 4: PENTEST RETEST + ATTESTATION (W12)                     │
│ ──────────────────────────────────────────────────────────────  │
│  • Vendor retests every Critical + High remediation             │
│  • Final attestation: zero unremediated Critical                │
│  • CISO + CTO + Risk-IT-lead sign                                │
│  Artifacts: apex_ews_pentest_final_attestation_v1.pdf            │
│           → unlocks Gate A                                       │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ Stage 5: COMPLIANCE FILING (W12-W13)                            │
│ ──────────────────────────────────────────────────────────────  │
│  • DPA 2019 (Kenya) audit-trail review                          │
│    → docs/data-lineage.md cited as the structural evidence      │
│  • RBI Cyber Resilience self-assessment                         │
│    → docs/charter.md compliance-mapping cited                   │
│  • IRDAI Info-Sec self-assessment                                │
│    → identical mapping                                           │
│  • ISO 27001:2022 Stage-1 audit (external auditor)              │
│  Artifacts:                                                      │
│    • dpa_2019_audit_trail_review_2026.pdf                       │
│    • rbi_cyber_resilience_self_assessment_2026.pdf              │
│    • irdai_info_sec_self_assessment_2026.pdf                    │
│    • apex_ews_iso27001_stage1_audit_report.pdf                  │
│           → unlocks Gate D                                       │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ Stage 6: STEERING REVIEW (T9-P1, W12)                           │
│ ──────────────────────────────────────────────────────────────  │
│  • Gates A + B + C + D presented                                │
│  • All readiness checklists from readiness-checklists.md         │
│  • Final budget envelope + cost projection                      │
│  • Risk register review per docs/risk-register.md                │
│  Artifacts: apex_ews_steering_signoff_2026_MM_DD.pdf            │
│           → unlocks Gate E                                       │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ Stage 7: POST-LAUNCH (W14-W17, 30-day review)                   │
│ ──────────────────────────────────────────────────────────────  │
│  • Adoption metrics from /v1/admin/adoption-metrics (X.4)        │
│  • Actual SLO performance vs predicted                           │
│  • Year-2 backlog re-prioritisation per docs/year-2-backlog.md  │
│  Artifacts: apex_ews_30d_postlaunch_review_2026_MM_DD.pdf       │
└─────────────────────────────────────────────────────────────────┘
```

## 4. Operational runbook references

Every alarm, incident, and procedure used during go-live and steady-state points back to one of these runbooks. **No new runbook content created during T9 — only execution against documented procedures.**

| Domain | Runbook | When to use |
|---|---|---|
| Daily ops | `docs/bau-runbook.md` § daily | 08:00 IST every business day during hypercare and beyond |
| Weekly ops | `docs/bau-runbook.md` § weekly | Mondays during hypercare and beyond |
| Monthly ops | `docs/bau-runbook.md` § monthly | First business day of every month |
| Quarterly ops | `docs/bau-runbook.md` § quarterly | Apr/Jul/Oct/Jan, includes DR game-day + access review |
| DR — failover | `docs/dr-runbook.md` §A | When primary-region SLO at risk; CISO + CTO decision |
| DR — failback | `docs/dr-runbook.md` §B | After 24h stability + 1h shadow-write soak |
| DR — game-day | `docs/dr-game-day-plan.md` | Quarterly; sets the bar for Gate B |
| Pentest finding triage | `docs/pentest-remediation-playbook.md` §1 | Every finding landing in DefectDojo |
| Critical security patch | `docs/pentest-remediation-playbook.md` §2 (Critical procedure) | Within 4h of Critical finding |
| Access review | `docs/access-review-evidence-log.md` § runbook | Quarterly per X.1 |
| Add a tenant | `docs/bau-runbook.md` § common ops "add a tenant" | Via M2.2 onboarding wizard + Risk-IT approval |
| Rotate API key | `docs/bau-runbook.md` § common ops "rotate an API key" | M1.2 admin route + service-account cert refresh |
| Investigate webhook failure | `docs/bau-runbook.md` § common ops "webhook failures" | When `/v1/webhooks/:id/deliveries` shows <90% success |
| Promote AI model | `docs/bau-runbook.md` § common ops "promote AI model" | M7.2 promotion engine; maker-checker required |
| Respond to high-priority alert | `docs/bau-runbook.md` § common ops "high-priority alert" | M9.1 investigation flow + maker-checker on close |
| Investigate audit chain integrity failure | `docs/dr-runbook.md` § audit trail | When `/v1/audit/integrity` returns `valid=false` |
| Capacity uplift | `infra/load-test/reports/template.md` § recommendations | When load test or steady-state metrics reveal scaling gap |
| Cost runaway | `docs/bau-runbook.md` § monthly cost review + T5.5 FinOps dashboard | When budget alarm fires |
| Pager-fatigue review | `docs/bau-runbook.md` § weekly | SLO error-budget gates noisy alarms automatically |
| On-call rotation handoff | `docs/on-call-rota.md` § weekly handoff | Monday 09:00 IST every week |

## 5. Critical-path analysis — top-3 sequential risks

Per the dependency-matrix critical path, the top 3 latency contributors are:

### Risk 1: Pentest fieldwork window (W6-W11)
- **Duration:** 5 weeks (T7-P2).
- **Why it's critical:** Cannot be parallelised — vendor schedule is fixed.
- **Mitigation strategy:** Pre-pentest threat-model in W3-W4 catches issues earlier; pre-pentest internal security-scan zero-Critical confidence.
- **What slips if breached:** Gate A → T9 slips by full pentest cycle.

### Risk 2: Bank VPN provisioning (T4-P1)
- **Duration:** 5 days but with high external dependency.
- **Why it's critical:** Blocks T4-P2 (CBS), T4-P3 (IFRS9), T4-P4 (AML), T4-P5 (Bureau).
- **Mitigation strategy:** Weekly call with bank network team starting W3. Written SoW with bank-side commitment.
- **What slips if breached:** T4 entire track slips. `INTEGRATIONS_MODE=mock` fallback can launch without live integrations (acceptable for tenant-1 if BANK_DEMO uses synthetic data).

### Risk 3: 5× load-test capacity tuning iteration (T8-P3)
- **Duration:** 1 week per iteration; up to 3 iterations possible.
- **Why it's critical:** Failed test = T9 slips.
- **Mitigation strategy:** Aurora autoscale 2-8 readers; Karpenter spot-instances absorb spike; PDBs prevent service degradation.
- **What slips if breached:** Gate C → T9 slips by 1 week per iteration; 3+ iterations escalates to Year-2 Theme A.

## 6. Decision rules at T9-P1

```
                       ┌─ All 5 gates GREEN → PROCEED to T9-P2 cutover
                       │
T9-P1 review ──────────┼─ 1 gate AMBER → review remediation plan
                       │                  ├─ Plan acceptable to CISO → defer T9 by 1 week
                       │                  └─ Plan not acceptable → escalate to board
                       │
                       ├─ 1+ gate RED → SLIP launch (no exceptions)
                       │
                       └─ Cost envelope >120% of $25k/mo budget → board review required
                                                                 before PROCEED
```

**Veto authority:**
- CISO holds independent veto on Gates A, B, D (security + DR + compliance).
- CTO holds independent veto on Gate C (performance + scale).
- Steering chair holds independent veto on Gate E (overall judgement).

A unanimous board override IS possible (per `docs/charter.md` §6 change control) but is reserved for material-business-impact override and requires written documentation in the post-launch review.

## 7. Cutover sequence (T9-P2)

Once Gate E unlocks, the cutover proceeds via this 8-step playbook:

| Step | Time | Owner | Action | Verification |
|---|---|---|---|---|
| 1 | T-24h | SRE | Final pre-cutover snapshot: Aurora cluster snapshot + S3 versioning checkpoint + Kafka offsets noted | Snapshot ID logged in `docs/bau-runbook.md` § change log |
| 2 | T-12h | SRE | Lower DNS TTL on `api.apex-ews.example` to 60s for fast revert capability | `dig +short api.apex-ews.example` shows TTL <90s |
| 3 | T-2h | SRE + INT | All hands available; PagerDuty + Slack channels staffed; CISO + CTO on standby | Roll call in #apex-ews-incident |
| 4 | T-0 | SRE | `INTEGRATIONS_MODE=live` flag flipped via ArgoCD; new ALB target group registered | `curl /v1/integrations/adapters/health` shows live status |
| 5 | T+0 to T+24h | SRE | **READ-ONLY soak:** tenant exposed but writes blocked at BFF middleware via `BFF_READ_ONLY=true` env flag | 24h of read-only operation shows 0 errors |
| 6 | T+24h | CISO + INT | Read-only soak review: error rate, p95, audit chain integrity all green | Sign-off captured in `docs/bau-runbook.md` § change log |
| 7 | T+24h | SRE | `BFF_READ_ONLY=false` — write traffic enabled | First write transaction logged in audit chain; `/v1/audit/integrity` returns `valid=true` |
| 8 | T+24h to T+48h | SRE + tenant ops | Active monitoring; PagerDuty primary on-call pinned; daily standup in #apex-ews-incident | 48h with all SLOs green or improving |

**Rollback procedure (any step ≥4 fails):**
1. `INTEGRATIONS_MODE=mock` (env flip via ArgoCD)
2. Route53 record reverts to staging ALB (DNS propagation ~5min with 60s TTL)
3. Tenant disabled via `PATCH /v1/tenants/:id active=false`
4. Incident post-mortem within 48h
5. Steering committee re-convenes within 1 week to decide re-launch or extended slip

## 8. Hypercare schedule (week 1 + week 2)

| Day | Activity | Owner | Output |
|---|---|---|---|
| H+0 | Cutover + initial 24h soak (read-only) | SRE+CISO | Soak report |
| H+1 | Write-traffic enabled; first business day | SRE+tenant ops | 09:00 IST standup + daily metrics report |
| H+2 to H+7 | Daily 09:00 IST standup; daily metrics report; primary on-call pinned | SRE+CISO+CTO | 7-day metrics summary at H+7 |
| H+7 | Week-1 review: SLO status, incident count, tenant ops feedback | Steering chair + CISO | Week-1 review minutes |
| H+8 to H+14 | Continuing hypercare; standup cadence drops to MWF | SRE | 14-day metrics summary |
| H+14 | Steady-state transition: on-call schedule resumes normal; SLO budget burn review weekly | SRE+ORCH | Year-2 backlog grooming kickoff |

## 9. Post-launch open items tracker

These do NOT block T9-P2 cutover but are tracked for Year-2 Theme A (production hardening):

| Item | Status | Owner | Target |
|---|---|---|---|
| Aurora Global Database fully live (gated by `enable_aurora_autoscale` flag) | Pending T5.2 IaC flag flip | SRE | Year-2 Q1 |
| MSK MirrorMaker 2 actively replicating to secondary region | Pending T5.2 IaC flag flip | SRE | Year-2 Q1 |
| S3 Cross-Region Replication active | Pending T5.2 IaC flag flip | SRE | Year-2 Q1 |
| `/v1/reports` PDF/Excel migrated to client-side (MSW dev mode) | Pending follow-up | UI | post-launch |
| Reserved webhook events (`alert.updated`, `case.assigned`, `case.closed`) | Pending follow-up | INT | post-launch |
| Real CBS schema lock-in (T3.1 deepening beyond initial wire-up) | Pending T4-P2 production cycle | INT | Year-2 Q1 |
| T2.12 real-time alert path Kafka streaming branch | Pending T2.12.2 work | INT+RULE | Year-2 Q1 |
| T2.1 feature-store 24mo backfill from production data | Pending T2-P3 ramp-up | DATA | Year-2 Q1 |
| First production DR game-day | Pending T9 hypercare end | SRE | Q3 2026 |
| Second tenant onboarding | Pending T9-P4 | INT | post-launch |
| Continuous learning pipeline T5.1 retraining cycle | Pending Theme E | AI | Year-2 Q2 |
| Mobile RN store-published production version | Pending T6-P5 store-side review | UI | T+13w |
| ISO 27001 Stage-2 (full certification) | Pending Stage-1 + 6-month conformance period | CISO | Year-2 Q3 |

## 10. Final go-live attestation bundle

When all 5 gates are GREEN, the steering committee signs `apex_ews_v1_production_attestation.pdf` containing:

1. Gate A — pentest final attestation (CISO + CTO + Risk-IT-lead sigs)
2. Gate B — DR game-day report (SRE-lead + CISO sigs)
3. Gate C — load-test attestation (SRE-lead sig)
4. Gate D — ISO 27001 Stage-1 audit report (CISO + auditor sigs)
5. Gate E — steering committee minutes + sign-off (Steering chair sig)
6. Production-readiness checklist sign-off log (per `readiness-checklists.md` §5)
7. Production-hardening checklist sign-off (`readiness-checklists.md` §2 all GREEN)
8. Observability coverage matrix sign-off (`readiness-checklists.md` §3 all GREEN)
9. Environment-readiness sign-off for `production` (`readiness-checklists.md` §4 prod column all GREEN)
10. Cost envelope confirmation (CTO + FinOps)
11. Compliance filings confirmation (CISO + Compliance officer)
12. RACI sign-off for hypercare period (`docs/raci.md` §5 ops + §3 governance signed)

**Bundle storage:** secured document store (limited access); SHA-256 hash recorded in M15.1 audit chain at the moment of signing for tamper-evidence.

**Distribution:**
- Full attestation: CISO + CTO + Steering chair only
- Summary 1-page extract: Risk-IT lead, tenant ops lead, SRE-lead, on-call rotation
- External regulator copies (RBI, IRDAI, ISO 27001 auditor): redacted versions excluding internal-only system addresses

The signing of this attestation = production go-live decision authority. **Decision is irrevocable once tenant-1 first production write transaction is committed and chained into the audit log.**
