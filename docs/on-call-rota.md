# ZorEWS — On-Call Rota

**Owner:** SRE lead · **Rotation cadence:** Weekly (Mon 09:00 IST → Mon 09:00 IST) · **Last reviewed:** 2026-05-20

> Primary + secondary on-call assignments. Pair with `docs/bau-runbook.md` (daily ops) + `docs/slos.md` (alert thresholds) + `docs/dr-runbook.md` (failover-time roster).

---

## 1. Rota structure

### 1.1 Tiers

| Tier | Coverage | Response time |
|---|---|---|
| **Primary** | 24/7, every page | Acknowledge within 5 min; engage within 15 min |
| **Secondary** | 24/7, paged if primary doesn't ack within 15 min | Acknowledge within 10 min |
| **Manager-on-call** | Business hours + escalations | Engage within 30 min when paged |
| **CISO/Compliance** | Business hours + Critical | Engage within 1h when paged for Critical security |

### 1.2 Hand-off

- Monday 09:00 IST: outgoing primary briefs incoming primary in 15-min huddle (Slack call).
- Hand-off note posted in `#apex-ews-oncall`: open incidents, recent changes, planned maintenance.
- Outgoing primary stays available as secondary for the new week (knowledge continuity).

---

## 2. Eligibility

To join the on-call rota, an engineer MUST:

- [ ] Have shipped code to production for ≥ 30 days.
- [ ] Be RBAC-permitted for `audit:read` (see `infra/rbac/matrix.json`).
- [ ] Have completed the on-call training (DR runbook walkthrough, SLO reading session, mock incident).
- [ ] Be paired with a senior engineer for the first 2 rotations as shadow.
- [ ] Have notification access (PagerDuty + Slack + JIRA + AWS Console MFA).

---

## 3. Compensation + protections

- On-call week = +1 day comp leave per ack'd page > 22:00 IST OR weekend.
- Maximum 1-in-4 rotation (i.e. at most 1 week of every 4 on primary).
- No new feature work assigned during on-call week — focus is incident response + BAU checklist.
- Mandatory rest: ≥ 8h between page and next planned shift.
- Manager-on-call covers if primary is rest-deprived after a Critical incident.

---

## 4. Rotation template (sample)

| Week | Primary | Secondary | Manager | CISO/Comp |
|---|---|---|---|---|
| W1 (Jun 02) | Engineer A | Engineer B | SRE lead | CISO |
| W2 (Jun 09) | Engineer B | Engineer C | SRE lead | CISO |
| W3 (Jun 16) | Engineer C | Engineer D | SRE lead | CISO |
| W4 (Jun 23) | Engineer D | Engineer A | SRE lead | CISO |

Actual rotation tracked in PagerDuty schedule `apex-ews-prod-oncall`. Source-of-truth is PagerDuty, not this document.

---

## 5. Coverage gaps

- **Public holidays:** secondary becomes primary, manager-on-call becomes secondary. Holiday list is the intersection of (India RBI bank holidays) + (any tenant-specific holidays).
- **Vacation:** swap requested ≥ 2 weeks in advance; trade with a peer; SRE lead approves.
- **Sick day:** secondary acts as primary; if also sick, manager-on-call escalates to the next available engineer.
- **Force majeure** (regional outage, natural disaster): the runbook explicitly permits a manager to override the rota and assign whoever is available.

---

## 6. Escalation path

```
Page fires → Primary (5 min ack)
   ↓ no ack at 15 min
Secondary (10 min ack)
   ↓ no ack at 30 min
Manager-on-call
   ↓ for Critical security:
CISO/Compliance
   ↓ for Critical with customer impact:
CTO
   ↓ for prolonged outage > 1h with customer impact:
CEO + board comms team
```

---

## 7. Mock incident schedule

To keep skills sharp:

- **Monthly:** SRE lead runs a 1-hour table-top exercise (no production impact) with the on-call engineer.
- **Quarterly:** DR game-day per `docs/dr-game-day-plan.md` — every engineer participates over the year.
- **Annually:** Full Phase-5 mock: pentest finding triage + DR failover + customer comms in a single day.

---

## 8. Tooling access

Each on-call engineer needs (provisioned at training):

- PagerDuty schedule member.
- Slack: `#apex-ews-alerts` + `#apex-ews-oncall` + `#apex-ews-security` + DR-WAR-ROOM.
- JIRA project: `APEX-EWS` write access for ops tickets.
- AWS Console: read-only across all production accounts + write to `apex-ews-prod-ops` IAM role with MFA.
- Aurora: `app_iam.users` row with `admin` role, optional break-glass for direct DB access.
- BFF: API key with `audit:read` + `integrations:read` scopes.
- Grafana: read-write on dashboards, read-only on alert rules.

---

## 9. References

- `docs/bau-runbook.md` — daily/weekly/monthly/quarterly/annual ops checklists.
- `docs/slos.md` — burn-rate alert thresholds.
- `docs/dr-runbook.md` — failover-time roster.
- `docs/dr-game-day-plan.md` — quarterly rehearsal.
- `docs/pentest-remediation-playbook.md` — security incident escalation.
- `infra/rbac/README.md` — RBAC + access review.
