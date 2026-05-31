# Enterprise Demo Data Foundation

**Status:** shipped 2026-05-31 (15th IA overlay this session).
**Route:** `/enterprise-demo-center`
**Schema migration:** `data/schema/058_enterprise_demo_foundation.sql`
**Owner:** agent-data + agent-integration + orchestrator

> Converts ZorEWS from a feature-rich prototype into an enterprise-grade demo platform with realistic Indian banking + insurance data. **Additive overlay — every existing module, route, API, and business workflow untouched.** Existing demo data (raw seeds, app_*, mart, audit chain, 14 prior IA centers) remains intact and continues to render at its existing route without change.

---

## 1. Why this overlay exists

ZorEWS already had ~14 IA centers (Governance, IAM, Rule, Audit, Recovery, AI Governance, Security Activity, Role-Based Dashboard, Executive Cockpit, Predictive Risk, Investigation, Regulatory Compliance, Data Fabric, plus the 12 module dashboards). Each one had its own demo data path. But a demo to an enterprise prospect — especially one running both banking AND insurance lines — needed a single screen that proves "yes, this platform handles 50,000 accounts and 5,000 policies and 800 cases and 24 forecasts and 40 compliance obligations all wired together, demo-day ready, no empty grids."

The Enterprise Demo Foundation is that screen. It is read-only and pulls deterministic snapshots from 5 pure engines, so a demo always renders. A backend wire-up later swaps each resolver for a `/v1/enterprise-demo/*` BFF route with the same shape.

## 2. Scope per the 8-phase brief

| Phase | Deliverable | Location |
|---|---|---|
| 1 | **Banking demo** — 5 banks (HDFC/ICICI/SBI/Axis/Kotak) × 5 regions × 50 branches × 10k customers × 50k accounts × 20k loans with SMA/NPA/DPD + sector classification | `enterpriseBankingEngine.ts` |
| 2 | **Insurance demo** — 3 insurers (ICICI Lombard, HDFC Ergo, SBI General) × 20k customers × 5k policies (5 types) × 3k claims × 500 fraud cases × 200 agents | `enterpriseInsuranceEngine.ts` |
| 3 | **Alert generation** — 2000 alerts (1200 banking + 800 insurance) across 5+5 alert kinds with severity / risk score / trigger / owner / escalation status | `enterpriseRiskOpsEngine.ts` |
| 4 | **Investigation cases** — 800 cases (6 case types) with timeline events, investigator notes, evidence records, closure reasons | `enterpriseRiskOpsEngine.ts` |
| 5 | **Executive KPIs** — Banking (portfolio exposure / SMA / NPA / fraud / recovery) + Insurance (active policies / claim ratio / fraud claims / persistency / solvency) + 30-day trends | `enterpriseAnalyticsEngine.ts` |
| 6 | **Predictive forecasts** — 6 forecast kinds × 4 horizons (30/60/90/180d) = 24 forecasts with confidence + risk drivers + recommended actions | `enterpriseAnalyticsEngine.ts` |
| 7 | **Compliance posture** — 40 obligations + 80 findings across 7 frameworks (RBI/Basel/AML/KYC for banking; IRDAI/Solvency/Claims for insurance) with compliance health scores | `enterpriseAnalyticsEngine.ts` |
| 8 | **Data Fabric integration** — 12 demo sources + 15 pipelines + 72 quality scores + 30 lineage edges + 5 AI workload readiness scores | `enterpriseDataFabricIntegration.ts` |

## 3. 15 Deliverables checklist

| # | Deliverable | Location |
|---|---|---|
| 1 | PostgreSQL schema additions (15 tables, all CREATE TABLE IF NOT EXISTS) | `data/schema/058_enterprise_demo_foundation.sql` |
| 2 | Seed data strategy: 5 banks + 3 insurers seeded via `INSERT … ON CONFLICT DO NOTHING`; all other entities synthesized deterministically per `(tenant_id, asOf, axis)` | section 6 |
| 3 | Data generation engine — 5 self-contained TypeScript modules, all pure, all deterministic via FNV-1a + Mulberry32 | `web/src/modules/enterpriseDemo/*.ts` |
| 4 | Realistic enterprise sample datasets — Indian names + cities + PAN format + INR amounts + correlated DPD/SMA/NPA distribution | engine modules |
| 5 | Alert generation framework — 2000 alerts with 10 distinct kinds, severity ladder, escalation status, SLA deadline | `enterpriseRiskOpsEngine.ts` |
| 6 | Investigation population logic — 800 cases linked to alerts, timeline events scale with status, evidence + notes per case | `enterpriseRiskOpsEngine.ts` |
| 7 | Dashboard population logic — KPI tiles + 30-day trends for both banking + insurance executive views | `enterpriseAnalyticsEngine.ts` |
| 8 | Predictive forecasting population — 24 forecasts (6 kinds × 4 horizons), confidence decays with horizon (0.85→0.55) | `enterpriseAnalyticsEngine.ts` |
| 9 | Compliance population logic — 40 obligations with realistic due-date spread; 80 findings; per-domain health scores | `enterpriseAnalyticsEngine.ts` |
| 10 | Data Fabric integration — 12 sources × 6 quality dimensions = 72 scores, lineage threading sources → pipelines → marts → KPI surfaces | `enterpriseDataFabricIntegration.ts` |
| 11 | Migration script — `058_enterprise_demo_foundation.sql` idempotent; existing migrations 001-057 unchanged | section 6 |
| 12 | RBAC compatibility — page gated to `admin / supervisor / risk_analyst` at sidebar, with an extended 18-role catalog inside the page (super_admin / country_admin / cdo / cro / ceo / cfo / coo / data_engineer / data_steward / compliance_officer / auditor / fraud_analyst / executive / board_member / country_head) | section 7 |
| 13 | Backward compatibility — every prior route still resolves; sibling test sweep across 9 IA pages all pass (342/342); existing migrations unchanged | section 9 |
| 14 | Demo readiness checklist | section 10 |
| 15 | Production migration path | section 11 |

## 4. Module map

```
web/src/modules/enterpriseDemo/
├── enterpriseBankingEngine.ts          # 5 banks × 50 branches × 10k customers × 50k accounts × 20k loans
├── enterpriseInsuranceEngine.ts        # 3 insurers × 20k customers × 5k policies × 3k claims × 500 fraud × 200 agents
├── enterpriseRiskOpsEngine.ts          # 2000 alerts + 800 cases + timeline events + notes + evidence
├── enterpriseAnalyticsEngine.ts        # Banking + Insurance executive KPIs + 24 forecasts + 40 obligations + 80 findings
├── enterpriseDataFabricIntegration.ts  # 12 demo sources + 15 pipelines + 72 quality scores + lineage + AI readiness
└── EnterpriseDemoCenterPage.tsx        # SPA page rendering all 10 sections
```

All public functions are pure and accept `(tenant_id, asOf)`. The page computes deterministic snapshots in the browser today; swapping each call for a `fetch` against a `/v1/enterprise-demo/*` BFF route does not change the page.

## 5. 10 page sections

The page renders 10 sections, each behind its own `data-testid="edf-section-<name>"`:

1. **Banking portfolio inventory** — 5 KPI tiles + per-bank rollup table
2. **Loan health distribution** — 6 status chips + loan-type chart + DPD bucket chart + top sector exposures + recent NPA loans
3. **Insurance portfolio inventory** — 6 KPI tiles + per-insurer rollup + policy-type chart
4. **Claims + fraud hot-list** — recent claims table + top fraud types + recent fraud cases
5. **Enterprise alert operations** — 4 KPI tiles + recent alerts table + severity pie chart
6. **Investigation operations** — 4 case-status chips + recent cases table + mean age metrics
7. **Executive KPIs** — Banking (6 tiles + portfolio trend) + Insurance (5 tiles + active-policies trend) side-by-side
8. **Predictive risk forecasts** — Horizon filter (all/30d/60d/90d/180d) + 24-forecast table with confidence + Δ%
9. **Regulatory compliance posture** — 5 status chips + obligations table + framework breakdown + 2 domain health tiles
10. **Data Fabric integration** — 4 KPI tiles + demo sources table + AI readiness per dataset

Cross-IA footer links to: Executive Cockpit, Predictive Risk, Investigations, Regulatory Compliance, Data Fabric, Role Dashboard.

## 6. Schema migration (`058_enterprise_demo_foundation.sql`)

15 additive tables under `app_iam.*`, all idempotent. Re-running `make migrate` is safe. Existing tables and prior migrations (001-057) untouched.

| # | Table | PK | Purpose |
|---|---|---|---|
| 1 | `demo_banks` | bank_id | 5-bank catalog |
| 2 | `demo_bank_branches` | branch_id | 50 branches × 5 regions |
| 3 | `demo_bank_customers` | customer_id | 10,000 customers across segments |
| 4 | `demo_bank_accounts` | account_id | 50,000 accounts across 3 types |
| 5 | `demo_bank_loans` | loan_id | 20,000 loans with DPD + SMA + NPA |
| 6 | `demo_insurers` | insurer_id | 3-insurer catalog |
| 7 | `demo_insurance_customers` | customer_id | 20,000 insurance customers |
| 8 | `demo_insurance_policies` | policy_id | 5,000 policies × 5 types |
| 9 | `demo_insurance_claims` | claim_id | 3,000 claims × 5 statuses |
| 10 | `demo_insurance_fraud_cases` | fraud_id | 500 fraud cases × 5 fraud types |
| 11 | `demo_insurance_agents` | agent_id | 200 agents with performance |
| 12 | `demo_enterprise_alerts` | alert_id | 2,000 alerts × 2 domains |
| 13 | `demo_enterprise_cases` | case_id | 800 cases × 6 case types |
| 14 | `demo_enterprise_forecasts` | forecast_id | 24 forecasts × 4 horizons |
| 15 | `demo_compliance_obligations` | obligation_id | 40 obligations × 7 frameworks |

Every CHECK constraint mirrors a closed enum declared in the engines. Seeds 5 banks + 3 insurers for `BANK_DEMO` on apply.

## 7. RBAC

Sidebar visibility: `admin / supervisor / risk_analyst` (intentionally narrow). Page-level access is wider — `ENTERPRISE_DEMO_ROLES` covers 18 personas including super_admin, country_admin, cdo, cro, ceo, cfo, coo, data_engineer, data_steward, compliance_officer, auditor, fraud_analyst, executive, board_member, country_head plus the 3 sidebar roles.

Refused: `field_officer / investigator / unknown` → redirect to dashboard.

## 8. Closed enums (15)

```
LoanType              home | personal | vehicle | education | business
LoanStatus            active | watchlist | sma0 | sma1 | sma2 | npa
DpdBucket             current | 1_30 | 31_60 | 61_90 | 90_plus
SectorClassification  agriculture | manufacturing | services | retail_trade | real_estate | infrastructure | msme | it_ites
Region                North | South | East | West | Central
PolicyType            health | motor | life | travel | commercial
PolicyStatus          active | high_risk | lapse_risk | lapsed
ClaimStatus           submitted | investigating | approved | rejected | paid
BankingAlertKind      sma_breach | npa_risk | fraud_signal | collections_risk | sector_risk
InsuranceAlertKind    policy_lapse_risk | claims_anomaly | fraud_detection | underwriting_deviation | persistency_breach
AlertSeverity         low | medium | high | critical
CaseStatus            open | in_progress | escalated | closed
EscalationStatus      none | sla_warning | sla_breached | escalated_l1 | escalated_l2 | escalated_exec
ForecastHorizon       30d | 60d | 90d | 180d
ObligationStatus      compliant | due_soon | overdue | breach | remediation
```

## 9. Tests

Suite: `web/src/__tests__/EnterpriseDemoCenter.test.tsx` — **69 vitest cases all pass**.

Coverage:
- Closed-enum invariants across all 5 engines (catalogs at exact sizes, canonical orderings)
- Resolver shape + filter behaviour (status / domain / type filters)
- Aggregation totals (10000 / 50000 / 20000 / 20000 / 5000 / 3000 / 500 / 2000 / 800 / 24 / 40 / 80 / 12 / 15 / 72 / 5)
- Determinism (re-runs at same asOf produce identical output)
- SPA page render (10 sections, role gate, filter wiring)
- KPI tile presence (banking + insurance + alerts + cases + executive + forecasts + compliance + fabric)

**Sibling sweep across 9 prior IA centers** (DataFabricCenter / RegulatoryComplianceCenter / InvestigationCenter / PredictiveRiskCenter / ExecutiveCockpit / RoleBasedDashboard / DashboardPage / AppShell / AppShellNavGroups) — **342/342 pass. Zero regression.**

## 10. Demo readiness checklist

- ✅ Every section renders non-empty (deterministic synthesis guarantees content)
- ✅ Banking: 50 branches, 10k customers, 50k accounts, 20k loans visible/queryable
- ✅ Insurance: 20k customers, 5k policies, 3k claims, 500 fraud cases visible
- ✅ Alerts: 2000 alerts split 1200/800 banking/insurance, severities distributed
- ✅ Cases: 800 cases with status mix (open / in_progress / escalated / closed)
- ✅ Executive KPIs: portfolio exposure ≈ ₹5000Cr, NPA ratio 3-7%, claim ratio 55-75%, persistency 70-85%, solvency 150-220%
- ✅ Forecasts: 24 rows with confidence band 0.55-0.85 across 4 horizons
- ✅ Compliance: 40 obligations + 80 findings across 7 frameworks, both domain health scores positive
- ✅ Data Fabric: 12 sources × 6 dimensions = 72 quality scores, 5 AI readiness datasets
- ✅ All cross-IA links work (Executive Cockpit, Predictive Risk, Investigations, Regulatory, Data Fabric, Role Dashboard)

## 11. Production migration path

When the BFF lands, swap the in-memory engine resolvers for these endpoints. Each one preserves the same response shape so the SPA contract stays stable.

| Endpoint | Replaces |
|---|---|
| `GET /v1/enterprise-demo/banking/banks` | `BANK_CATALOG` |
| `GET /v1/enterprise-demo/banking/branches` | `listBranches` |
| `GET /v1/enterprise-demo/banking/customers?offset=&limit=` | `listCustomers` |
| `GET /v1/enterprise-demo/banking/accounts?offset=&limit=` | `listAccounts` |
| `GET /v1/enterprise-demo/banking/loans?status=&sector=&bank_id=` | `listLoans` |
| `GET /v1/enterprise-demo/banking/summary` | `summarizeBankingPortfolio` + `summarizeBankWise` |
| `GET /v1/enterprise-demo/insurance/insurers` | `INSURER_CATALOG` |
| `GET /v1/enterprise-demo/insurance/policies?status=&type=&insurer_id=` | `listPolicies` |
| `GET /v1/enterprise-demo/insurance/claims?status=&is_fraud_flagged=` | `listClaims` |
| `GET /v1/enterprise-demo/insurance/fraud-cases` | `listFraudCases` |
| `GET /v1/enterprise-demo/insurance/agents` | `listAgents` |
| `GET /v1/enterprise-demo/insurance/summary` | `summarizeInsurancePortfolio` + `summarizeInsurerWise` |
| `GET /v1/enterprise-demo/alerts?domain=&kind=&severity=&status=` | `listEnterpriseAlerts` + `summarizeAlertOps` |
| `GET /v1/enterprise-demo/cases?domain=&case_type=&status=` | `listEnterpriseCases` + `summarizeInvestigationOps` |
| `GET /v1/enterprise-demo/cases/:id/timeline` | `listCaseTimeline` + `listInvestigatorNotes` + `listEvidence` |
| `GET /v1/enterprise-demo/kpis/banking` + `/insurance` | `buildBankingExecutiveKpi` + `buildInsuranceExecutiveKpi` |
| `GET /v1/enterprise-demo/forecasts?horizon=&domain=&kind=` | `listEnterpriseForecasts` |
| `GET /v1/enterprise-demo/compliance/obligations` + `/findings` + `/summary` | `listComplianceObligations` + `listComplianceFindings` + `summarizeCompliancePosture` |
| `GET /v1/enterprise-demo/fabric/sources` + `/pipelines` + `/quality` + `/lineage` + `/readiness` + `/summary` | data fabric integration surface |

The 15 backing tables (`app_iam.demo_*`) are the persistence target. The pg-backed swap follows the T4.13–T4.18 pattern: cache-on-init + sync reads + write-through fire-and-forget pg INSERTs.

## 12. Hard constraints honoured

- ✅ No existing module removed (Governance / IAM / Rule / Audit / Recovery / AI Governance / Security Activity / Role-Based Dashboard / Executive Cockpit / Predictive Risk / Investigation / Regulatory Compliance / Data Fabric)
- ✅ No existing route removed
- ✅ No existing API removed
- ✅ No business workflows modified
- ✅ Backward compatibility maintained
- ✅ Additive changes only
- ✅ `CREATE TABLE IF NOT EXISTS` everywhere
- ✅ Existing demo data intact (014 + 015 + 057 + raw + app_* + mart + audit chain — all untouched)

## 13. Verification

```bash
cd /Users/chuadhary_taniya/ZorEWS/web
npx tsc --noEmit                    # 26 pre-existing baseline errors; zero in enterpriseDemo
npx vite build                      # clean build (4.97s)
npx vitest run src/__tests__/EnterpriseDemoCenter.test.tsx
# Test Files  1 passed (1)
#      Tests  69 passed (69)
npx vitest run \
  src/__tests__/DataFabricCenter.test.tsx \
  src/__tests__/RegulatoryComplianceCenter.test.tsx \
  src/__tests__/InvestigationCenter.test.tsx \
  src/__tests__/PredictiveRiskCenter.test.tsx \
  src/__tests__/ExecutiveCockpit.test.tsx \
  src/__tests__/RoleBasedDashboard.test.tsx \
  src/__tests__/DashboardPage.test.tsx \
  src/__tests__/AppShell.test.tsx \
  src/__tests__/AppShellNavGroups.test.tsx
# Test Files  9 passed (9)
#      Tests  342 passed (342)
```
