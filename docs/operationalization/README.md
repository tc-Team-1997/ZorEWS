# ZorEWS — Operationalization Execution Package

**Anchored at:** T+0 = 2026-05-21 · **Target tenant-1 production:** T+13w = 2026-08-19 · **30-day review:** T+17w = 2026-09-13

> Operationalization execution package: 4 companion docs that decompose the high-level [`production-operationalization-roadmap.md`](../production-operationalization-roadmap.md) into engineering-phase units, dependency matrices, readiness checklists, and gating contracts. **Steering committee uses these at T9-P1.**

## Companion documents

| Doc | Purpose | Reader |
|---|---|---|
| **[execution-plans.md](execution-plans.md)** | Per-phase execution plans for all 9 tracks. Each phase carries owner · duration · prerequisites · deliverables · validation gate · rollback · risk. 44 phases total. | SRE / INT / DATA / UI / CISO — engineering owners |
| **[dependency-matrix.md](dependency-matrix.md)** | Track-to-track + inter-phase dependency graph · critical-path analysis · weekly parallelisation plan · estimated calendar timeline · deployment architecture validation · risk register · blocker-to-fallback map | SRE-lead + Steering chair |
| **[readiness-checklists.md](readiness-checklists.md)** | 4 checklists: per-service production readiness · per-layer production hardening · observability coverage matrix · per-environment readiness · sign-off log | All track owners + Steering committee |
| **[go-live-gating.md](go-live-gating.md)** | 5 hard go-live gates · security/compliance validation flow · operational runbook references · critical-path analysis · T9-P1 decision rules · cutover playbook · hypercare schedule · post-launch open items · final attestation bundle structure | CISO + CTO + Steering chair |

## Quick navigation

### "I'm an engineering owner — what do I actually do?"
1. Find your track in [execution-plans.md](execution-plans.md) (T1 through T9).
2. Each phase is a self-contained 2-5 day unit of work with explicit prerequisites + deliverables + validation gate.
3. When your phase's validation gate goes green, mark progress in your track log and tick `readiness-checklists.md`.

### "I'm the SRE-lead coordinating the program — what do I track?"
1. **Critical path:** [dependency-matrix.md §2](dependency-matrix.md) shows the longest sequential chain.
2. **Weekly parallelisation:** [dependency-matrix.md §3](dependency-matrix.md) shows which tracks run in parallel each week.
3. **Cross-service infrastructure:** [dependency-matrix.md §4](dependency-matrix.md) shows what every service depends on at runtime.
4. **Deployment architecture validation:** [dependency-matrix.md §5](dependency-matrix.md) is the pre-T9 architecture review matrix.

### "I'm the CISO — what do I sign?"
1. **5 hard go-live gates:** [go-live-gating.md §1](go-live-gating.md) — A (pentest) and B (DR) and D (ISO Stage-1) are your veto domains.
2. **Security validation flow:** [go-live-gating.md §3](go-live-gating.md) — sequenced from CI to RBI/IRDAI filing.
3. **Production hardening checklist:** [readiness-checklists.md §2](readiness-checklists.md) — Network · Compute · Data · Secrets · IAM · Observability · Deployment · Mobile layers.
4. **Sign-off log:** [readiness-checklists.md §5](readiness-checklists.md) — your signatures live here.

### "I'm the Steering chair — how do I decide GO / NO-GO?"
1. **Gate scorecard:** [go-live-gating.md §1 + §6](go-live-gating.md) — 5 gates, no waivers, all must be green.
2. **Decision rules:** [go-live-gating.md §6](go-live-gating.md) — explicit GREEN/AMBER/RED logic.
3. **Cutover sequence:** [go-live-gating.md §7](go-live-gating.md) — 8-step playbook after sign-off.
4. **Rollback procedure:** [go-live-gating.md §7](go-live-gating.md) — exactly what reverses the cutover.

### "I'm on-call during hypercare — what alarms fire and what do I do?"
1. **Critical alarms catalog:** [readiness-checklists.md §3](readiness-checklists.md) — 15+ alarms, each with severity + condition + runbook URL.
2. **Operational runbook references:** [go-live-gating.md §4](go-live-gating.md) — every runbook keyed by domain.
3. **Hypercare schedule:** [go-live-gating.md §8](go-live-gating.md) — daily/weekly cadence for weeks 1-2.

## Phase ID quick-reference

Phase IDs (e.g. `T2-P3`) are stable anchors used across all 4 docs. Do not rename.

| ID range | Track | Owner |
|---|---|---|
| T1-P1 to T1-P5 | AWS landing zone | SRE-lead + CTO |
| T2-P1 to T2-P6 | Data plane runtime | DATA + SRE |
| T3-P1 to T3-P5 | EKS + secrets | SRE |
| T4-P1 to T4-P6 | Bank integrations | INT + bank liaison |
| T5-P1 to T5-P4 | Observability + SLO | SRE |
| T6-P1 to T6-P5 | Mobile RN | UI + UX-lead |
| T7-P1 to T7-P4 | Pentest engagement | CISO + INT |
| T8-P1 to T8-P4 | Load + stress test | SRE |
| T9-P1 to T9-P5 | Go-live + hypercare | ORCH + steering |

## Key dates

| Date | Milestone | Source doc |
|---|---|---|
| 2026-05-21 | T+0 — execution begins | this README |
| 2026-06-25 (W6) | DR game-day rehearsal | go-live-gating.md §2 |
| 2026-07-09 (W7) | Hard deadline: T7-P2 pentest fieldwork must begin | dependency-matrix.md §6 |
| 2026-07-09 (W8 end) | 5× load-test gate | execution-plans.md T8-P3 |
| 2026-07-31 (W11) | Hard deadline: app store approval | dependency-matrix.md §6 |
| 2026-08-07 (W12) | T7-P4 pentest final attestation | go-live-gating.md §1 Gate A |
| 2026-08-13 (W12 end) | T9-P1 5-gate review meeting | go-live-gating.md §6 |
| 2026-08-19 (W13) | T9-P2 tenant-1 production cutover | go-live-gating.md §7 |
| 2026-09-13 (W17 end) | 30-day post-launch review | go-live-gating.md §1 |

## Out-of-scope (per user directive)

The user's instructions explicitly de-prioritised additive feature development:

> "Do not continue low-value additive feature busywork. Preserve stable runtime architecture. Focus on production-safe operationalization. Focus on deployability, scalability, observability, reliability, and runtime resilience. Maintain enterprise-grade architecture and governance standards."

These docs deliberately exclude:
- New BFF endpoints / SPA pages / mobile screens beyond what's already shipped
- New data adapters or new analytics dashboards
- Architecture changes (the 100% module coverage from T6 is the surface; T9-P2 ships that surface as-is)

What IS in scope: infrastructure, observability, security hardening, integration wire-up, runbook validation, performance tuning, go-live execution.

## Cross-references to existing planning docs

This package builds on (does not replace) these existing artifacts:

- [`docs/charter.md`](../charter.md) — programme mission, scope, success criteria, governance
- [`docs/raci.md`](../raci.md) — accountability matrix (R/A/C/I) across 18 roles
- [`docs/risk-register.md`](../risk-register.md) — 15 programme-level risks
- [`docs/bau-runbook.md`](../bau-runbook.md) — daily/weekly/monthly/quarterly/annual ops
- [`docs/slos.md`](../slos.md) — 3-tier SLO catalogue + error budget policy + burn-rate alarms
- [`docs/on-call-rota.md`](../on-call-rota.md) — 4-tier on-call roster + escalation
- [`docs/dr-runbook.md`](../dr-runbook.md) — failover + failback procedures + RTO/RPO targets
- [`docs/dr-game-day-plan.md`](../dr-game-day-plan.md) — quarterly DR drill scoring rubric
- [`docs/pentest-brief.md`](../pentest-brief.md) — engagement scope + 7 mandatory test categories
- [`docs/pentest-remediation-playbook.md`](../pentest-remediation-playbook.md) — SLA matrix + 9-step workflow
- [`docs/data-lineage.md`](../data-lineage.md) — provenance + retention + PII handling
- [`docs/vendor-accounts.md`](../vendor-accounts.md) — 10 third-party vendor stubs + provisioning checklist
- [`docs/year-2-backlog.md`](../year-2-backlog.md) — 9 themes for the year following go-live

## Status of this package

**This package is the deliverable for the user's directive of 2026-05-21.** It is implementation-ready: every phase has a named owner, validation gate, and rollback. Engineering teams pick up tracks; SRE-lead owns coordination; CISO + Steering chair own go/no-go.

No new tools or systems are introduced — the package executes against what is already shipped + the IaC + planning docs already in the repo. Total new docs: 4 + this README, ~3,200 lines of operationalization plan, ~0 lines of new application code.

Steering committee reviews and approves at next standing meeting; execution kicks off immediately after.
