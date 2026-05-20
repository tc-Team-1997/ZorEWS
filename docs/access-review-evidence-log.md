# ZorEWS — Quarterly Access Review Evidence Log

**Owner:** CISO + Risk-IT lead · **Cadence:** Quarterly (Q1/Q2/Q3/Q4) · **Last reviewed:** 2026-05-20

> Append-only evidence trail for the cross-cutting **X.1 quarterly access review** task. Each review produces a Markdown report from `infra/rbac/scripts/access_review.py`, runs the 5-business-day sign-off workflow per `infra/rbac/README.md`, and an entry is appended to this log. Pair with `docs/raci.md` §4 (CISO accountable, Risk-IT responsible) and `docs/compliance-mapping.md` (DPA 2019 Art. 33 + ISO 27001 A.5.18 + A.8.3 controls).

---

## 1. Cadence

| Quarter | Trigger date | Close window | Sign-off due |
|---|---|---|---|
| Q1 | 1st business day Apr | 5 business days | day 7 |
| Q2 | 1st business day Jul | 5 business days | day 7 |
| Q3 | 1st business day Oct | 5 business days | day 7 |
| Q4 | 1st business day Jan | 5 business days | day 7 |

Trigger fires automatically via the BAU monthly checklist (`docs/bau-runbook.md` §3) on the trigger date. Risk-IT lead opens a JIRA epic `ACCESS-REVIEW-YYYY-QN`.

---

## 2. Runbook (5-business-day window)

| Day | Action | Owner |
|---|---|---|
| 0 (trigger) | Run `access_review.py --matrix infra/rbac/matrix.json --roster <current-roster.json> --report-out reports/access-review-YYYY-QN.md` | Risk-IT lead |
| 0 | Verify matrix internal-consistency + roster validation passes | Risk-IT lead |
| 0 | Distribute report to: CISO, CTO, HR, Compliance officer, Risk-IT lead, Risk-Ops manager | Risk-IT lead |
| 1-3 | Stakeholders review their owned-role sections; flag any: dormant accounts (no login > 90 days), unexpected admin elevations, role-mismatch vs current job, terminated employees still active | All principals |
| 1-3 | Push remediation tickets in JIRA `APEX-EWS` for each finding | Risk-IT lead |
| 4 | All findings either remediated OR formally risk-accepted in writing | Risk-IT lead |
| 5 | Risk-Ops manager signs the cover sheet | Risk-Ops manager |
| 5 | CISO countersigns | CISO |
| 5 | Final report committed to `reports/access-review-YYYY-QN.md` | Risk-IT lead |
| 5 | Audit event written to `apex.audit.events` topic via audit-svc with `event_type: 'access.review.completed'` + report SHA-256 hash | audit-svc |
| 5 | Entry appended to this log (§4) | Risk-IT lead |

---

## 3. Report contents (per quarter)

The `access_review.py` script produces a Markdown report with:

1. **Cover sheet** — quarter, trigger date, close date, sign-off names, RBAC matrix SHA-256.
2. **Matrix internal-consistency check** — every role mentioned in any operation appears in roles[]; no orphan operations; no duplicate role/op pairs.
3. **Roster summary** — total users, per-role distribution, sample users per role.
4. **Dormancy findings** — users with last_login_at > 90 days ago (configurable threshold).
5. **Privilege elevation findings** — users with admin role added in last quarter.
6. **Termination cross-check** — users in roster but not in HR active-employee list.
7. **Role drift findings** — users whose current role doesn't match HR job title.
8. **Sign-off block** — Risk-Ops manager + CISO with date + comments.
9. **Audit anchor** — SHA-256 hash of the report content (embedded in the `apex.audit.events` event metadata).

---

## 4. Evidence log entries

Format per entry:

```
### YYYY-QN — <Q1|Q2|Q3|Q4> <year>

- **Trigger date:** YYYY-MM-DD
- **Close date:** YYYY-MM-DD
- **Report:** `reports/access-review-YYYY-QN.md` (SHA-256: <64-hex>)
- **Roster size:** N users / M distinct roles
- **Matrix SHA-256:** <64-hex>
- **Findings:**
  - Dormant: <N> users
  - Privilege elevation: <N> events
  - Termination cross-check: <N> mismatches
  - Role drift: <N> mismatches
- **Remediation:**
  - <N> users deactivated
  - <N> users role-corrected
  - <N> risks formally accepted (see `docs/risk-acceptance-log.md`)
- **Sign-off:**
  - Risk-Ops manager: <name> (<YYYY-MM-DD>)
  - CISO: <name> (<YYYY-MM-DD>)
- **Audit event:** `apex.audit.events` event_id `<event-id>` at `<ISO timestamp>`
```

### 2026-Q2 — _placeholder_ (first run pending July trigger)

The first formal review will fire on the first business day of July 2026 once the production deployment has been live for ≥ 1 quarter. Prototype-phase reviews have been informal (run via `access_review.py` against the sample roster for CI validation only).

---

## 5. Tooling

- **`infra/rbac/scripts/access_review.py`** — generates the quarterly report. CLI: `--matrix <path> --roster <path> --report-out <path>` OR `--validate-only` for CI.
- **`infra/rbac/matrix.json`** — RBAC source-of-truth (5 roles × 27 operations).
- **`infra/rbac/sample_roster.json`** — sample roster used in CI + prototype runs.
- **`.github/workflows/rbac-matrix.yml`** — CI gate runs `--validate-only` on every PR touching `infra/rbac/**`.
- **`infra/rbac/lib/`** — TS package `@apex-ews/rbac` consumed by every BFF service.

---

## 6. Compliance mapping

| Framework | Control | This log satisfies |
|---|---|---|
| ISO 27001:2022 | A.5.18 Access Rights | Quarterly cadence + remediation evidence |
| ISO 27001:2022 | A.8.3 Information Access Restriction | Roster validation + dormancy + drift findings |
| RBI Cyber Resilience (Jun 2024) | §4.1 access management | Quarterly cadence + RBAC matrix + termination cross-check |
| IRDAI Info-Sec (Apr 2023) | §6.2 user provisioning | Sign-off workflow + audit anchor |
| DPA 2019 | Art. 33 accountability | Audit chain via `apex.audit.events` event with hash |

---

## 7. References

- `infra/rbac/README.md` — RBAC matrix overview + workflow.
- `infra/rbac/scripts/access_review.py` — review-report generator.
- `docs/risk-register.md` R-014 — RBAC matrix drift risk.
- `docs/compliance-mapping.md` — full DPA 2019 + ISO 27001 control mapping.
- `docs/raci.md` §4 — accountability matrix.
- `docs/bau-runbook.md` §3 — monthly trigger.
- `docs/risk-acceptance-log.md` — formally accepted access risks (to be authored on first acceptance).
