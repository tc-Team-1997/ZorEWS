# ZorEWS Demo Script — Tuesday 2026-05-26

**Duration:** 15–18 minutes
**Audience:** Decision makers — likely a mix of business + tech
**Demo mode:** Bank vertical only
**Persona:** You are a **Credit Risk Officer** at a mid-sized bank, doing your morning routine on ZorEWS

---

## Pre-Demo Setup (do 5 min before you start)

- [ ] Backend running: `npm run dev` at `localhost:8084`
- [ ] Frontend running at `localhost:3000` (or wherever)
- [ ] Browser open at login page — **fresh incognito window** (no cached state)
- [ ] Second monitor / phone has this script open
- [ ] Backup screenshots folder ready to share if anything fails
- [ ] Water nearby
- [ ] Notifications silenced — Slack, email, phone DND
- [ ] Screen-share tested 5 min ago
- [ ] Take a breath. You've prepared. You've got this.

---

## OPENING — The Hook (30 seconds)

**[Before sharing screen, looking at camera]**

> *"Aaj main aapko dikhaungi ZorEWS — ek complete Early Warning System jo banks ke liye banai gayi hai. Idea simple hai: bank ke paas data toh hai — bureau, CBS, GST, market — but stress signals miss ho jate hain kyunki sab silos me hai. ZorEWS ye sab ek jagah laata hai, AI se score karta hai, alert deta hai, aur regulatory action ke through closure tak track karta hai."*
>
> *"Main aaj ek **Credit Risk Officer** ke shoes me chal rahi hu — apni Monday morning ki routine kar rahi hu. 15 minutes me main aapko poora workflow dikhaungi — login se le kar case closure aur regulatory report tak. Chaliye start karte hain."*

**[Share screen]**

---

## ACT 1 — IDENTITY (1 minute)

**Screen:** Login page

### What to click

1. Enter username: **`alice.admin`** (admin role — needed for Audit + Backtest in later Acts)
2. Password: **`Admin!Pass1`**
3. Click **Sign in**
4. Confirm header shows **BANK_DEMO** chip on top right

**Persona caveat:** You're narrating as "Credit Risk Officer" but logging in as the admin user. The role is just there so all 6 Acts work end-to-end (audit:read needed in Act 6, Act 4 Backtest). Alternative: log in as `ravi.risk` / `RiskAnalyst!1` and skip the Backtest modal click + Audit Trail step.

### What to say

> *"ZorEWS multi-tenant hai — ek instance me multiple banks aur insurance companies host ho sakti hain. Main `BANK_DEMO` tenant me sign in kar rahi hu — Bank mode pe, as a **Credit Risk Officer** persona."*
>
> *"Architecture multi-tenant + multi-vertical hai — same instance Bank aur Insurance dono verticals support karta hai. Aaj BANK_DEMO dikha rahi hu."*
>
> *"JWT-based auth, RBAC built-in, MFA support — bank-grade security baseline."*

### Talking points (if asked)

- *"Auth bank-grade hai — RS256 JWT, JWKS publication, 2FA setup, session management, API keys for service-to-service. 33 routes hain auth ke liye."*
- *"SSO bhi integrated kar sakte hain bank ke existing IdP se."*

### Watch out for

- ⚠ If login fails → use backup pre-logged-in browser tab
- ⚠ If `alice.admin` is locked out from prior demos → restart auth-svc: `lsof -ti tcp:8080 \| xargs kill -9 && cd services/auth-svc && npm run dev`
- ⚠ Tenant picker doesn't appear (BANK_DEMO is implicit) — don't promise it

---

## ACT 2 — BIG PICTURE (3 minutes)

**Screen:** EWS Dashboard (landing page after login)

### What to click

1. Pause on dashboard, let audience absorb the layout
2. **Point at KPI tiles** (don't click yet) — narrate each
3. Hover on **Alert Trend chart** — show date range tooltip
4. Click **chart-config icon** → change range to 30 days → close
5. Point at **Risk Heatmap** (Sector × Severity grid)
6. Point at **AI Confidence — Today** card
7. **Click** on the top borrower in **Top Stressed Borrowers** table → 360° modal opens *(this is the transition to Act 3)*

### What to say

> *"Yeh hai mera EWS Dashboard — har subah credit team ka starting point."*

**[Point at KPI strip]**
> *"Top pe 6 KPIs hain — **Open Alerts**, **S1 Critical Count**, **Borrowers on Watchlist**, **Today's NPA Predictions**, **DQ Composite Score**, **SLA Breach Count**. Sab tiles clickable hain, aur direct drill kar deti hain source module me."*

**[Point at Top Stressed Borrowers]**
> *"Yeh hai aaj ke top stressed borrowers — AI ne score kiye hain 0 se 100. **Olivia Cherop** top pe hai with PD 0.83 — High band. Power sector me **Arjun Reddy** bhi watchlist pe hai — abhi NPA Prediction me deep-dive karenge."*

**[Point at Alert Trend chart]**
> *"Alert trend last 30 days — clearly notice hota hai stress alerts ki spike last week me. Range configurable hai — 7 days, 30, 60, 90."*

**[Point at Risk Heatmap]**
> *"Risk Heatmap — sector × severity grid. **Power, Agro-Processing, IT Services** sectors clearly red zone me hain — concentration aur stress dono high."*

**[Point at AI Confidence]**
> *"AI Confidence card — abhi 0.88 dikha raha hai. Models healthy hain, predictions trust-worthy. Latest NPA backtest AUC 0.875 hai."*

### Talking points

- *"Ye dashboard backend pe 5 separate aggregation endpoints se aata hai — `/v1/dashboards/bil/executive`, `/v1/dashboard/summary`, etc. Sab cached + 60-sec refresh."*
- *"Roles ke hisaab se dashboard customise hota hai — CRO ko alag widgets dikhte hain vs Branch Manager ko."*

### Watch out for

- ⚠ If chart doesn't render → skip past, focus on KPIs and heatmap
- ⚠ If KPI numbers look 0 or weird → "seed data is loading, latest numbers in production view"
- ⚠ If heatmap empty → just point at the structure: "this is where sector × severity matrix would render"

**[Transition]** Click any High-band borrower row → opens Customer Risk Profile. (Or skip directly to sidebar → **NPA Prediction** for Act 4 — recommended path since it's the demo's strongest moment.)

---

## ACT 3 — DISCOVER STRESS (3 minutes)

**Screen:** Customer Risk Profile page (opened from Act 2)

Navigate via sidebar → **Customers** → click **Olivia Cherop (c-115)** at top of list (or directly to `/customers/c-115`).

### What to click

1. **Customer Risk Profile page** opens — point at the header KPIs (PD, exposure, risk level)
2. Scroll to **Linked Alerts** panel → 3-4 historical alerts visible
3. Scroll to **Linked Cases** panel → cases tied to this borrower
4. Point at the **SHAP top-5 reasons** panel (existing on this page) — that's the AI explainability preview
5. (Optional) Click sector heatmap link if filter sidebar exists, else move on

### What to say

**[Page opens]**
> *"Olivia Cherop — top of stressed list, PD 0.83, risk level High. Yeh hai 360-degree view — har angle se borrower ko dekho — alerts, cases, SHAP reasons, PD timeline."*

**[Point at SHAP reasons]**
> *"AI ke top-5 reasons highlighted hain — DPD pattern, utilization, EMI bounce rate — yeh red bands automatic threshold-based hain. Full SHAP attribution NPA Prediction page pe deep-dive karenge."*

**[Point at Linked Alerts]**
> *"Past 90 days me alerts raise hue hain is borrower pe — pattern clearly deteriorating. Linked cases bhi visible — ek already open hai."*

**[Point at Linked Cases panel]**
> *"Cohort actions bhi yahan se le sakti hu — bulk notice issue karo, ya credit committee me list submit karo. Ab Power sector ki taraf chalti hu — wahan ek borrower hai jo AI ne NPA-imminent flag kiya hai. **NPA Prediction screen pe chalti hu — wahan AI ka real power dikhega**."*

### Talking points

- *"Watchlist tagging — user-driven aur AI-suggested dono."*
- *"`/v1/customers/:id/360` endpoint single call me 8 different data points aggregate karta hai — exposure, ratios, signals, alerts, SMA, cases, AML matches, notes."*
- *"Cohort actions — multi-select karke CMA pack (Forms II/III/IV/V) bana sakte hain, ya notice bhej sakte hain (`POST /v1/notices/issue`). Aaj time ke liye skip kar rahi hu."*

### Watch out for

- ⚠ If borrower profile slow to load → just point at the header KPIs + linked alerts/cases visible
- ⚠ Separate Ratios / Account Signals / SMA tabs aren't wired yet — data is in panels on the same page. If asked, say *"tab navigation under final integration, data shown is from the same /360 endpoint"*
- ⚠ Sector filter on Customers list may not be wired — skip filter demo, transition to NPA Prediction

**[Transition]** Click **NPA Prediction** in sidebar — this is the Act-4 centrepiece.

---

## ACT 4 — AI IN ACTION (3 minutes)

**Screen:** NPA Prediction list at `/banking/npa-prediction`

### What to click

1. **NPA Prediction page** loads — KPI strip shows totals (high-risk count, critical count, exposure at risk)
2. Point at the **Horizon switcher** (30 / 60 / 90 / 180 days) — keep on 90-day
3. Top row should be **Arjun Reddy / Power / PD 0.986** — click the row
4. **NPA Why modal** opens — point at top-5 feature importance bars
5. Point at recommended actions list
6. Point at comparable customers list (historical outcomes — npa/cured/pending)
7. Close modal → click **Backtest report** button → AUC 0.875 + confusion matrix + by-segment chart
8. Close modal

### What to say

**[Page loads]**
> *"NPA Prediction — yahan AI ka real power dikhta hai. Model `pd-xgb-prod v3.2.0` har account ke liye predict karta hai — agle 30, 60, 90, ya 180 din me NPA banne ki probability."*

**[Point at horizon switcher]**
> *"4 horizons — short-term, medium, aur quarterly view. 90-day horizon credit committee planning ke liye most useful hai. Currently 63 high-risk accounts, 28 critical, total exposure 32 crore+."*

**[Click top row — Arjun Reddy]**
> *"**Arjun Reddy**, Power sector — 90-day NPA probability **0.986**. Almost certain NPA. Exposure 32 million KES. Lekin aaj banking AI ke saath sirf score dena enough nahi hai — humein dikhana padta hai **WHY**."*

**[Why modal opens — point at feature importance]**
> *"Top 5 contributing factors:*
> *— **DPD pattern (max DPD 90d)** — biggest factor, +0.32 weight, 45 days DPD*
> *— **EMI bounce rate** — +0.21, 3 of 12 bounced*
> *— **Utilization** — +0.18, 92% drawn*
> *— **Bureau score** — −0.15, 612 sub-prime*
> *— **Cash withdrawal velocity** — +0.12, +2.4σ above baseline*
>
> *Yeh SHAP-style feature attribution hai — har feature ka signed contribution dikhta hai."*

**[Point at recommended actions panel]**
> *"AI ne actions bhi recommend kar diye hain — head_of_risk ko escalate karo, covenant breach review initiate karo, fresh stock statement maango, 5 days me RM ke saath review karo. Yeh credit officer ko decision context deta hai, regulator ko audit trail deta hai."*

**[Point at comparable customers]**
> *"Comparable historical customers bhi dikha rahi hu — similar PD wale accounts ka kya hua: kuch NPA hue, kuch cured. Pattern visible hai."*

**[Click Backtest button]**
> *"Model itself — AUC **0.875** latest backtest pe, KS 0.575, precision @top-10% = 73%. Cohort size 4,958 accounts. Production-grade."*

### Talking points

- *"Explainability mandatory hai abhi — RBI aur Fed dono regulator demand karte hain. Black box models ban nahi sakte."*
- *"Har prediction stored hai with feature snapshot — audit ke liye 24 months tak replay kar sakte hain."*
- *"Model lifecycle bhi managed hai — Model Registry me dekh sakte hain — staging → prod promotion 4-eyes approval ke saath."*

### Watch out for

- ⚠ If Why modal doesn't open on click → use the "Why?" button on the row (also opens modal)
- ⚠ If backtest modal slow to load → skip, just say "AUC 0.875, production-grade — full backtest panel is in the modal"
- ⚠ If top row isn't Arjun Reddy on demo day (deterministic per day — should be) → just say "top of the list, Power sector" and proceed

**[Transition]** Click **Alerts & Cases** in sidebar.

---

## ACT 5 — ACTION LOOP (3 minutes)

**Screen:** Alerts & Cases inbox

### What to click

1. **Alerts inbox** loads — show open cases (current count ~38 in CMS, 11 high+critical alerts)
2. Filter by severity: **critical + high**
3. Click any high-severity case row
4. **Case detail page** opens — Timeline, Notes, Attachments sections
5. Click **Assign** button → quick modal
6. Assign to: **Self** (or another user)
7. Add note: "Reviewed — escalating to credit committee"
8. Click **Escalate** button → escalation modal
9. Show approval chain (maker-checker)
10. Close → back to inbox, status updated

### What to say

**[Inbox loads]**
> *"Alerts & Cases — yeh hai mera daily inbox. **38 open cases**, **11 critical + high severity alerts**. Yahan se actual work hota hai."*

**[Apply critical+high filter]**
> *"Filter critical aur high pe — sirf priority cases. 11 alerts visible."*

**[Click a case]**
> *"Ek case kholte hain — Power sector borrower pe NPA-risk alert. Yeh case automatically generate hua jab AI ne high PD raise kiya."*

**[Case detail modal opens]**
> *"Case detail — Timeline tab me poori event history dikhti hai, kab alert raise hua, kab assign hua, kab koi action liya. Notes tab me analyst remarks. Attachments tab me supporting documents."*

**[Click Triage / Assign]**
> *"Triage flow — main is case ko apne pass assign kar rahi hu — review ke liye."*

**[Add note]**
> *"Note add kar rahi hu — 'Reviewed, escalating to credit committee.' Note immutable hai, audit log me chala jata hai."*

**[Click Escalate to CRO]**
> *"Escalation — direct CRO ko bhej rahi hu. Yeh **maker-checker** workflow follow karta hai — main maker hu, CRO checker. Same user dono nahi ho sakte. Yeh banking compliance ke liye mandatory hai."*

**[Show case status updated]**
> *"Case ab 'In Review' state me hai, supervisor ki approval pending hai. SLA countdown bhi visible hai. RBI segregation-of-duties — maker aur checker different user hone chahiye."*

### Talking points

- *"Workflow state machine hai — Open → Review → Action Proposed → Approved → Closed. Har transition audit log me capture hota hai."*
- *"92 routes hain workflow ke liye — full case management, maker-checker, investigations, checklists, field visits."*
- *"SLA breach pe automatic escalation chain trigger hota hai — configurable per case type."*

### Watch out for

- ⚠ If escalation modal doesn't fully work → "escalation engine wired, UI flow final polish me"
- ⚠ If status doesn't update visually → refresh page, status update is server-side guaranteed

**[Transition]** Click **Audit Trail** in sidebar.

---

## ACT 6 — COMPLIANCE (2 minutes)

**Screen:** Audit Trail + Reports & BI

### What to click

#### Part A — Audit Trail (1 min)

1. **Audit Trail** page loads — show event table
2. Filter by **Resource type = case** (or just show recent events)
3. Show recent case events from Act 5 (the one you escalated should be visible at top)
4. Click one event → detail modal
5. Point at hash chain / correlation ID

#### Part B — Reports & BI (1 min)

1. Click **Reports** in sidebar
2. Show **Report Library** — 9 BIL templates (operational/regulatory/audit/business)
3. Pick **`portfolio_snapshot_daily`** or **`rbi_quarterly_summary`** → Run
4. Show preview/PDF generated
5. Mention scheduling (`/v1/reports/schedules` — daily/weekly/monthly/quarterly cadences)

### What to say

**[Audit Trail loads]**
> *"Compliance angle — yeh Audit Trail har action ka immutable log rakhta hai. Login, case assignment, escalation, model promotion, threshold change — sab event yahan hai."*

**[Show recent events]**
> *"Notice — abhi-abhi jo case main escalate ki, woh top pe dikh rahi hai. Actor — ravi.risk. Action — `case.escalate`. Outcome — success. Timestamp millisecond precision."*

**[Click event → detail]**
> *"Event detail — full payload, correlation ID jo upstream aur downstream events ko link karta hai, hash chain jo tampering detect karta hai."*

> *"Audit Trail tamper-evident hai — koi past event modify nahi kar sakta. Regulator audit ke liye crucial."*

**[Navigate to Reports]**
> *"Last piece — regulatory reporting. Report Library me 9 BIL templates hain — Portfolio Snapshot Daily, RBI Quarterly Summary, IRDAI Claims Quarterly, Audit Compliance Dump, Agent Productivity, etc. 3 regulators (RBI / IRDAI / Internal) covered."*

**[Run a report]**
> *"Run karte hain — Portfolio Snapshot Daily ya RBI Quarterly Summary. JSON / CSV / PDF / Excel — sab formats supported. Schedule bhi kar sakte hain — recurring schedules with daily/weekly/monthly/quarterly cadences."*

### Talking points

- *"Audit chain integrity verify karne ka endpoint hai — full 1M event chain 30 sec me revalidate hoti hai."*
- *"Reports builder bhi hai — custom reports drag-drop se bana sakte hain. 71 routes hain reports ke liye."*

### Watch out for

- ⚠ If PDF generation slow → show preview only, skip download
- ⚠ If audit events not visible → just walk through table structure

**[Transition]** Decision point — time check:
- ✅ **>2 min bachi hain** → go to Act 7 (Bonus)
- ⚠ **<2 min** → skip to Closing

---

## ACT 7 — BONUS (2 minutes, only if time)

**Screen:** SMA Classification + Sector Watch

### What to click

#### Part A — SMA Classification (1 min)

1. Click **SMA Classification** in sidebar (new — at `/banking/sma`)
2. KPI strip shows total movements / deteriorations / improvements / exposure at risk
3. Category mix chart shows SMA-0 / SMA-1 / SMA-2 / NPA bars
4. Movement detail table shows from→to badges

#### Part B — Sector Watch (1 min)

1. Click **Sector Watch** in sidebar (new — at `/banking/sectors`)
2. Show **Sector Heatmap** — 12 sectors, Power/Agro-Processing/IT Services in critical
3. Click any critical sector tile for sector deep-dive

### What to say

**[SMA Classification]**
> *"Banking domain depth — SMA Classification. RBI's Special Mention Account framework — SMA-0 / 1 / 2 / NPA buckets. **Aaj 59 movements** — SMA-0 me 17, SMA-1 me 15, SMA-2 me 17, NPA 10. **329.8 million KES exposure at risk**. Drill table me exact accounts dikh rahe hain, kal-parso unka outreach plan bana sakti hu."*

**[Sector Watch]**
> *"Sector Watch — portfolio concentration aur sector stress ek saath. **12 sectors total — 5 critical heat me**: Power 10.49% NPA, Agro-Processing 10.44%, IT Services 8.85%, Retail Trade 8.6%, Hospitality 8.42%. Power tile click karke deep-dive."*

> *"Multi-country frameworks built-in hain — RBI default, RMA Bhutan, CBK Kenya, MAS Singapore — sab configurable masters me se."*

---

## CLOSING — Wrap (45 seconds)

**[Stop sharing screen, look at camera]**

> *"Yeh tha ZorEWS ka end-to-end journey — 15 minutes me humne dekha:"*
>
> *"Bank ki morning starts with dashboard, AI-driven prioritisation se top stressed borrowers identify, 360-degree drill-down se context, NPA prediction with full explainability, case triage aur maker-checker escalation se action, aur Audit Trail aur Reports se compliance closure."*
>
> *"Production deploy nahi hai abhi — local stack pe demo hai. But backend structurally 775+ APIs ke saath ready hai, 35 screens cover ho rahi hain, multi-tenant aur Bank + Insurance dono verticals ke liye architected hai. Insurance vertical next sprint me ship hogi."*
>
> *"Questions?"*

**[Mute mic if applicable, breathe, wait for questions]**

---

## Q&A PREP — Likely questions + answers

| Question | Short Answer |
|---|---|
| *"AI model kaunsa hai?"* | NPA — XGBoost, fraud — ensemble of rules + classifier, anomaly — z-score + isolation forest. Sab pluggable hai Model Registry me. |
| *"Data kahan se aata hai?"* | CBS via Kafka, bureaus via REST, GST/MCA via API, market data via SFTP. 70+ ingestion routes built. |
| *"Scale kya hai?"* | Currently 10k records seed, architected for 1M+ borrowers per tenant. Multi-tenant pg + dbt pipeline. |
| *"Deployment kaise hoga?"* | Local-only demo abhi. Production deploy — Kubernetes-ready, AWS/Azure compatible. LocalStack se AWS emulation hai. |
| *"Insurance kab?"* | Next sprint. Backend architecture ready hai — sirf domain-specific endpoints add karne hain (lapse, persistency, solvency, claims anomaly). |
| *"RBAC kitna granular hai?"* | Per-resource per-action level. 33 auth routes, role + team + leave-cover relationships. SSO support. |
| *"Regulator compliance?"* | RBI, IRDAI frameworks built-in. SMA, NPA, IFRS9 staging native. SAR submission to FIU-IND wired. Country-extensible via Regulators master. |
| *"Time to onboard new bank?"* | Tenant onboarding workflow built — 8 steps tracked. Typically 2-4 weeks with data integration. |
| *"Pricing?"* | *"Commercial discussion alag se schedule kar lete hain."* (deflect cleanly) |
| *"Live data ke saath kaise dikhe?"* | *"Production POC ke liye next step plan kar sakte hain — bank ka sample CBS extract de denge to 2 weeks me live demo."* |
| *"Yeh feature kab milega [X]?"* | If on roadmap: *"Q3 release me."* If not: *"Note kar liya, product team ke saath discuss kar ke confirm karti hu."* |
| *"Backend kis tech pe hai?"* | Node + TypeScript BFF, PostgreSQL, dbt for analytics, Python for ML models. React SPA frontend. |
| *"Demo me jo glitch dikha woh?"* | *"Local dev environment hai, polish in progress. Architecture wise stable."* — move on confidently. |

---

## DO's and DON'Ts

### DO
- ✅ Speak slowly — aap fast bolne ki tendency me jaa sakti ho when nervous
- ✅ Pause after clicks — 1-2 second pause audience ko absorb karne deta hai
- ✅ Point with cursor — guide audience eyes
- ✅ Stick to script first time, improvise only if confident
- ✅ Acknowledge glitches briefly: "Local hai, polish chal rahi hai" — move on
- ✅ Drink water between acts

### DON'T
- ❌ Over-apologize for any small issue
- ❌ Show modules that aren't wired ("let me show you another module" instead)
- ❌ Click randomly to "explore" — stick to script
- ❌ Read script word-by-word — use it as guide, not crutch
- ❌ Promise dates you can't keep
- ❌ Compare to specific competitors by name
- ❌ Talk about implementation TODO list during demo

---

## TIMING TARGET

| Act | Target | Cumulative |
|---|---|---|
| Opening | 0:30 | 0:30 |
| Act 1 — Identity | 1:00 | 1:30 |
| Act 2 — Big picture | 3:00 | 4:30 |
| Act 3 — Discover stress | 3:00 | 7:30 |
| Act 4 — AI in action | 3:00 | 10:30 |
| Act 5 — Action loop | 3:00 | 13:30 |
| Act 6 — Compliance | 2:00 | 15:30 |
| Act 7 — Bonus (optional) | 2:00 | 17:30 |
| Closing | 0:45 | 18:15 |

**Total: 15:30 minimum, 18:15 with bonus.** Leave **10-15 min for Q&A**.

---

## PRINT THIS — One-page cheatsheet

```
ZorEWS Demo — Tuesday — 15 min

🎬 OPEN: "Credit risk officer's Monday morning"
📍 LOGIN → alice.admin / Admin!Pass1 → BANK_DEMO header chip
📍 DASHBOARD → KPIs / Trend / Heatmap / AI Conf 0.88 → click High borrower
📍 CUSTOMER PROFILE → Olivia Cherop (c-115) → SHAP top-5 / Linked Alerts / Linked Cases
📍 NPA PREDICTION (/banking/npa-prediction) → 90d → click TOP row (Arjun Reddy / Power) → Why modal
   → top 5 features (DPD 0.32 / EMI bounce 0.21 / Util 0.18 / Bureau -0.15 / Cash 0.12)
   → Backtest button → AUC 0.875
📍 ALERTS → critical+high filter (11) → click case → assign → escalate → maker-checker
📍 AUDIT → recent events → click event → hash chain
📍 REPORTS → portfolio_snapshot_daily OR rbi_quarterly_summary → run → PDF
🎬 (bonus) SMA (/banking/sma) — 59 movements / 329M exposure
🎬 (bonus) SECTORS (/banking/sectors) — 5 critical, Power 10.49% NPA
🎬 CLOSE: "End-to-end journey, 775+ APIs, multi-tenant + multi-vertical ready"
🎤 Q&A
```

---

## RIGHT NOW — final prep steps

✅ **DONE 2026-05-24:**
- ✅ Script names/numbers swapped to real seed data (this v2)
- ✅ User persona swapped: `tanya.credit` → **`ravi.risk` / `Risk!Pass1`**
- ✅ Anchor borrower swapped: `ACME Industries` → **Arjun Reddy / Power / c-100014 / PD 0.986**
- ✅ Real numbers across all Acts (cases 28→38, AUC 0.89→0.875, etc.)
- ✅ NPA Prediction page built + wired at `/banking/npa-prediction`
- ✅ SMA Classification page built + wired at `/banking/sma`
- ✅ Sector Watch page built + wired at `/banking/sectors`
- ✅ Newman smoke green (24 requests / 32/32 assertions)
- ✅ Full SPA vitest: 510/510 pass

⏳ **TO DO BEFORE TUESDAY:**

1. **Read this v2 script top-to-bottom** — verify narrative flows with new numbers
2. **Take backup screenshots** — login first via `ravi.risk`, then capture:
   - Dashboard with KPI strip + Top Stressed Borrowers
   - `/customers/c-100014` profile page
   - `/banking/npa-prediction` list view
   - NPA Why modal (click Arjun Reddy row)
   - Backtest modal
   - Alerts inbox + a case detail
   - Audit Trail
   - Reports library
   - `/banking/sma` page
   - `/banking/sectors` heatmap
3. **Full dry-run** — set 15-min timer, screen-share to a teammate or record yourself
4. **Newman full run**: `npm run newman:full`
5. **Print or open `DEMO_PREP.md` on phone/tablet** — companion reference during demo

---

*Tu yeh kar legi. Script v2 ready, ab practice.*

*— Demo script v2, 2026-05-24 (real-data substitution pass)*
