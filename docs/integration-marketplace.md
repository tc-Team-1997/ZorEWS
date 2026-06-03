# Enterprise Integration Marketplace — Phase 20

**Route:** `/integration-marketplace`  
**Module:** `web/src/modules/integrationMarketplace/`  
**Schema:** `data/schema/063_integration_marketplace.sql`  
**Engine:** `integrationMarketplaceEngine.ts` (pure-function, deterministic per tenant+day)  

---

## Overview

The Integration Marketplace provides a unified platform for managing the enterprise integration ecosystem. It covers 22 integrations across 8 banking, 6 insurance, and 8 enterprise systems, along with 15 APIs, 12 data exchange flows, 10 event types, and 12 strategic partners.

---

## Sections

| Tab | Description |
|-----|-------------|
| Integration Catalog | 22-integration searchable grid with health, governance state, and status |
| API Marketplace | 15-API registry with SLA, availability %, error rate, and auth type |
| Data Exchange Hub | 12-flow table with throughput + daily/weekly/monthly aggregate metrics |
| Event Subscription Center | 10 event types + subscriber delivery status tracking |
| Partner Ecosystem | 12 partners (bureaus, agencies, auditors) with SLA + compliance rating |
| Governance | Approval workflow status, security/compliance review tracking |
| Observability | 24h error trend, request/error bar chart, latency percentiles (P95/P99) |
| AI Integration Insights | 7 AI-generated risk, bottleneck, and capacity recommendations |
| Executive View | Maturity score, vendor risk, top risks panel |
| Readiness Score | 6-dimension composite gauge + radar chart + industry benchmark |

---

## Integration Coverage

### Banking (8)
- Core Banking System (Temenos T24)
- Loan Origination System (Finacle LOS)
- Collections Platform (ARCS)
- AML System (NICE Actimize)
- CRM (Salesforce)
- Treasury System (Murex ALM)
- Credit Bureau (CIBIL TransUnion)
- Payment Gateway (NPCI UPI + NEFT/RTGS)

### Insurance (6)
- Policy Administration (IRIS PolicyCenter)
- Claims Management (Guidewire ClaimCenter)
- Agent Portal
- Reinsurance Platform (RI3K)
- Fraud System (FRISS)
- Customer Portal

### Enterprise (8)
- ERP (SAP S4/HANA)
- HRMS (PeopleSoft HCM)
- DMS (OpenText)
- Email (AWS SES)
- SMS (Africa's Talking / Twilio)
- WhatsApp Business API
- Data Lake (AWS S3 + Glue)
- BI Platform (Power BI / Tableau)

---

## API Marketplace (15 APIs)

Includes REST, GraphQL, Webhook, and Event API types with:
- P95 SLA targets (100ms–3000ms depending on API complexity)
- Availability tracking (typically 98–99.9%)
- Per-day call volume and error rate
- OAuth2, JWT, mTLS, API Key authentication

---

## Data Exchange Flows (12)

| Source | Target | Data Type |
|--------|--------|-----------|
| CBS | ZorEWS mart | Loan + Customer |
| CIBIL Bureau | Risk Engine | Credit Score |
| AML System | Compliance Center | STR + Watchlist |
| LOS | EWS Indicators | Application Data |
| Collections | Recovery Center | DPD + Buckets |
| Policy Admin | Predictive Risk | Policy Data |
| Claims System | Fraud Engine | Claim Events |
| Agent Portal | AI Agents | Agent KPIs |
| ERP | Digital Twin | Financial Data |
| HRMS | Governance Center | Employee Data |
| Data Lake | Feature Store | ML Features |
| ZorEWS Events | BI Platform | Analytics Events |

---

## Event Types (10)

| Event | Category | Avg Daily Volume |
|-------|----------|-----------------|
| alert.created | Alerts | 2,500 |
| alert.escalated | Alerts | 320 |
| case.opened | Cases | 180 |
| case.closed | Cases | 145 |
| rule.triggered | Rules | 8,500 |
| model.drift_detected | AI | 12 |
| compliance.breach | Compliance | 25 |
| fraud.detected | Fraud | 85 |
| decision.approved | Decisions | 1,200 |
| customer.risk_changed | Risk | 450 |

---

## Partner Ecosystem (12)

Covers 6 partner types:
- Credit Bureaus: CIBIL TransUnion, CRIF High Mark, Experian India
- Collection Agencies: Mahindra Finance Recovery, D&B Collections
- Investigators: Kroll India, Control Risks India
- Audit Firms: Deloitte India (Forensics), KPMG Advisory
- Recovery Agencies: Encore Capital Recovery
- Insurance Surveyors: McLR Surveyors India, Vipul Surveyors

---

## Readiness Score Dimensions

| Dimension | Weight | Description |
|-----------|--------|-------------|
| Security | 25% | mTLS, key rotation, API security |
| Governance | 20% | Approval workflows, review backlog |
| Reliability | 20% | Failover, circuit breakers, SLA |
| Performance | 15% | Latency percentiles, auto-scaling |
| Compliance | 15% | DPDP 2023, RBI data residency |
| Documentation | 5% | API contracts, runbooks |

---

## Database Schema (063_integration_marketplace.sql)

8 additive tables in `app_integration` schema:

| Table | Purpose |
|-------|---------|
| `integration_registry` | Master integration catalog |
| `api_registry` | API marketplace entries |
| `data_exchange_flows` | Flow definitions + metrics |
| `event_subscriptions` | Event pub/sub registry |
| `partner_registry` | Strategic partner details |
| `integration_governance` | Approval workflow records |
| `integration_insights` | AI-generated insights |
| `integration_readiness_scores` | Readiness dimension scores |

---

## RBAC

Reuses the existing 20-role framework. Access granted to:
`admin`, `supervisor`, `risk_analyst`, `super_admin`, `country_admin`,
`bank_admin`, `insurance_admin`, `fraud_analyst`, `auditor`,
`compliance_officer`, `operations_user`, `executive`, `cdo`, `cro`,
`ceo`, `coo`, `board_member`, `operations_manager`, `country_head`,
`investigation_officer`

---

## Navigation

- **Icon:** Plug (Lucide)
- **i18n key:** `integration_marketplace`
- **Locales:** en (`Integration Marketplace`) / hi (`एकीकरण मार्केटप्लेस`) / dz / ne

---

## Implementation Notes

- Engine is **pure-function** — no I/O, no React, no stores
- All data is **deterministic** per `(tenant, day)` via FNV-1a + Mulberry32 seeding
- Production swap: replace stub functions with real API calls; page contract unchanged
- All 19 prior IA overlays remain untouched (additive-only)
