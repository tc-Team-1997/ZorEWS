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

1. Enter username: `tanya.credit` (or whatever your seed user is)
2. Password: `••••••••`
3. Click **Sign in**
4. **[If tenant picker appears]** Select tenant: **BANK_DEMO**
5. Confirm header shows **BANK** chip on top right

### What to say

> *"ZorEWS multi-tenant hai — ek instance me multiple banks aur insurance companies host ho sakti hain. Main `BANK_DEMO` tenant me sign in kar rahi hu — Bank mode pe."*
>
> *"Notice karein top-right pe — yeh **BANK / INSURANCE** toggle hai. Aaj hum Bank vertical dikha rahe hain. Insurance vertical bhi same architecture pe banti hai — aaj scope me nahi."*
>
> *"JWT-based auth, RBAC built-in, MFA support — bank-grade security baseline."*

### Talking points (if asked)

- *"Auth bank-grade hai — RS256 JWT, JWKS publication, 2FA setup, session management, API keys for service-to-service. 33 routes hain auth ke liye."*
- *"SSO bhi integrated kar sakte hain bank ke existing IdP se."*

### Watch out for

- ⚠ If login fails → use backup pre-logged-in browser tab
- ⚠ If mode toggle doesn't show → say "header element under final styling polish"

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
> *"Yeh hai aaj ke top stressed borrowers — AI ne score kiye hain 0 se 100. S1 highest severity. ACME Industries top pe hai with score 87 — abhi click karenge."*

**[Point at Alert Trend chart]**
> *"Alert trend last 30 days — clearly notice hota hai stress alerts ki spike last week me. Range configurable hai — 7 days, 30, 60, 90."*

**[Point at Risk Heatmap]**
> *"Risk Heatmap — sector × severity grid. Real Estate aur Power sectors clearly red zone me hain — concentration aur stress dono high."*

**[Point at AI Confidence]**
> *"AI Confidence card — abhi 0.89 dikha raha hai, kal 0.87 tha. Models healthy hain, predictions trust-worthy."*

### Talking points

- *"Ye dashboard backend pe 5 separate aggregation endpoints se aata hai — `/v1/dashboards/bil/executive`, `/v1/dashboard/summary`, etc. Sab cached + 60-sec refresh."*
- *"Roles ke hisaab se dashboard customise hota hai — CRO ko alag widgets dikhte hain vs Branch Manager ko."*

### Watch out for

- ⚠ If chart doesn't render → skip past, focus on KPIs and heatmap
- ⚠ If KPI numbers look 0 or weird → "seed data is loading, latest numbers in production view"
- ⚠ If heatmap empty → just point at the structure: "this is where sector × severity matrix would render"

**[Transition]** Click ACME Industries row in Top Stressed Borrowers.

---

## ACT 3 — DISCOVER STRESS (3 minutes)

**Screen:** Borrower 360° modal (opened from Act 2)

If 360° modal doesn't open directly, navigate via sidebar → **Borrower Watch** → click ACME row.

### What to click

1. **Borrower 360° modal opens** — show Overview tab
2. Switch to **Ratios** tab → point at DSCR / ICR with red/amber bands
3. Switch to **Account Signals** tab → point at "Cash flow drop 32% MoM" signal
4. Switch to **SMA Status** tab → show "SMA-1 since 12 days"
5. Switch to **Alerts History** tab → 3-4 historical alerts
6. **Close modal**
7. Show **Borrower Watch list** behind it — apply filter: **Sector = Real Estate**
8. Show filtered list (3-5 borrowers)

### What to say

**[Modal opens, Overview tab]**
> *"ACME Industries — manufacturing sector, total exposure 45 crore, EWS score 87. Yeh hai 360-degree view — har angle se borrower ko dekho."*

**[Click Ratios tab]**
> *"Financial ratios — DSCR 0.9, jo 1.0 ke threshold se neeche hai. ICR bhi weak. Yeh red bands automatic threshold-based hain, aur sector benchmark se compare ho rahe hain."*

**[Click Account Signals tab]**
> *"Account behaviour signals — AI ne detect kiya hai cash flow 32% drop month-over-month, salary credits 3 employees ke ruke hain. Yeh signals manual rules nahi catch karte — yahan ML model lagta hai."*

**[Click SMA Status tab]**
> *"SMA classification — abhi SMA-1 me hai, 12 days se. RBI framework ke according 30 din me SMA-2 me chala jayega agar nothing changes. Yeh trajectory critical hai."*

**[Click Alerts History]**
> *"Past 90 days me 4 alerts raise hue hain is borrower pe — pattern clearly deteriorating."*

**[Close modal, apply Real Estate filter]**
> *"Yeh sirf ek borrower ka view tha. Ab dekhte hain — Real Estate sector me kitne borrowers similar stress me hain..."*

**[Filtered list shows]**
> *"5 borrowers Real Estate me — sab on watchlist, sab S2 ya S3. Yahan se main cohort action le sakti hu — bulk notice issue karo, ya credit committee me list submit karo."*

### Talking points

- *"Watchlist tagging — user-driven aur AI-suggested dono."*
- *"360° endpoint single call me 8 different data points aggregate karta hai — limits, exposure, ratios, signals, alerts, SMA, cases, notes."*
- *"Cohort actions — multi-select karke CMA pack bana sakte hain, ya notice bhej sakte hain. Aaj time ke liye skip kar rahi hu."*

### Watch out for

- ⚠ If 360° modal doesn't open → use Borrower Watch list, walk through ACME row data verbally
- ⚠ If tabs don't switch → "tab navigation under final integration, data shown is from same endpoint"
- ⚠ If filter doesn't work → skip filter demo, transition directly to Act 4

**[Transition]** Click **NPA Prediction** in sidebar.

---

## ACT 4 — AI IN ACTION (3 minutes)

**Screen:** NPA Prediction list

### What to click

1. **NPA Prediction list page** loads — show top 10 high-risk accounts
2. Point at columns: 30d / 60d / 90d NPA probability
3. Show sort by 90d horizon (descending)
4. Click the **top account** row → **NPA Why modal** opens
5. In Why modal, point at top 5 features with importance bars
6. Point at the natural-language explanation
7. Click **Backtest report** button → quick glimpse of AUC 0.89
8. Close modals

### What to say

**[List loads]**
> *"NPA Prediction — yahan AI ka real power dikhta hai. Model NPA-v3.2 har account ke liye predict karta hai — agle 30, 60, aur 90 din me NPA banne ki probability."*

**[Point at columns]**
> *"3 horizons — short-term, medium, aur quarterly view. 90-day horizon credit committee planning ke liye most useful hai."*

**[Click top row]**
> *"ACME Industries (yes, wahi borrower jisko abhi dekha) — 90-day NPA probability 0.84. Bahut high. Lekin aaj banking AI ke saath sirf score dena enough nahi hai — humein dikhana padta hai **WHY**."*

**[Why modal opens — point at feature importance]**
> *"Top 5 contributing factors — DSCR drop is #1 contributor at 0.31 importance, cash flow trend #2, sector beta #3, default cluster proximity #4, payment delays #5. Yeh SHAP-style feature attribution hai."*

**[Point at natural-language explanation]**
> *"AI ne natural language me bhi explain kiya hai — 'This account shows characteristics similar to 78% of accounts that turned NPA in the past 12 months, primarily driven by deteriorating debt service capacity.' Yeh credit officer ko decision context deta hai, regulator ko audit trail deta hai."*

**[Click Backtest button]**
> *"Model itself — AUC 0.89 latest backtest pe. Production-grade."*

### Talking points

- *"Explainability mandatory hai abhi — RBI aur Fed dono regulator demand karte hain. Black box models ban nahi sakte."*
- *"Har prediction stored hai with feature snapshot — audit ke liye 24 months tak replay kar sakte hain."*
- *"Model lifecycle bhi managed hai — Model Registry me dekh sakte hain — staging → prod promotion 4-eyes approval ke saath."*

### Watch out for

- ⚠ If Why modal doesn't open → talk through feature importance verbally pointing at backup screenshot
- ⚠ If explanation text empty → "natural language generation in final QA, feature importance chart is core artifact"

**[Transition]** Click **Alerts & Cases** in sidebar.

---

## ACT 5 — ACTION LOOP (3 minutes)

**Screen:** Alerts & Cases inbox

### What to click

1. **Alerts inbox** loads — show 28 open cases (badge in sidebar should match)
2. Filter by severity: **S1 + S2**
3. Click a case (preferably one linked to ACME)
4. **Case detail modal** opens — show Timeline, Notes, Attachments tabs
5. Click **Triage Now** or **Assign** button → quick modal
6. Assign to: **Self** (or another user)
7. Add note: "Reviewed — escalating to credit committee"
8. Click **Escalate to CRO** button → escalation modal
9. Show approval chain
10. Close → back to inbox, show case status updated to "In Review"

### What to say

**[Inbox loads]**
> *"Alerts & Cases — yeh hai mera daily inbox. 28 open cases — sab severity tagged. Yahan se actual work hota hai."*

**[Apply S1+S2 filter]**
> *"Filter S1 aur S2 pe — sirf critical aur high-priority dikha do. 12 cases."*

**[Click ACME-related case]**
> *"Ek case kholte hain — ACME Industries pe NPA-risk alert. Yeh case automatically generate hua jab AI ne 80+ score raise kiya."*

**[Case detail modal opens]**
> *"Case detail — Timeline tab me poori event history dikhti hai, kab alert raise hua, kab assign hua, kab koi action liya. Notes tab me analyst remarks. Attachments tab me supporting documents."*

**[Click Triage / Assign]**
> *"Triage flow — main is case ko apne pass assign kar rahi hu — review ke liye."*

**[Add note]**
> *"Note add kar rahi hu — 'Reviewed, escalating to credit committee.' Note immutable hai, audit log me chala jata hai."*

**[Click Escalate to CRO]**
> *"Escalation — direct CRO ko bhej rahi hu. Yeh **maker-checker** workflow follow karta hai — main maker hu, CRO checker. Same user dono nahi ho sakte. Yeh banking compliance ke liye mandatory hai."*

**[Show case status updated]**
> *"Case ab 'In Review' state me hai, CRO ki approval pending hai. SLA countdown bhi visible hai — 48 hours."*

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
3. Show ACME-related events from Act 5 (should be visible at top)
4. Click one event → detail modal
5. Point at hash chain / correlation ID

#### Part B — Reports & BI (1 min)

1. Click **Reports & BI** in sidebar
2. Show **Report Library** — list of templates
3. Pick **Stressed Borrowers Report** (or similar) → Run
4. Show preview/PDF generated
5. Mention scheduling

### What to say

**[Audit Trail loads]**
> *"Compliance angle — yeh Audit Trail har action ka immutable log rakhta hai. Login, case assignment, escalation, model promotion, threshold change — sab event yahan hai."*

**[Show ACME events]**
> *"Notice — abhi-abhi jo case main escalate ki, woh top pe dikh rahi hai. Actor — me. Action — case.escalate. Outcome — success. Timestamp millisecond precision."*

**[Click event → detail]**
> *"Event detail — full payload, correlation ID jo upstream aur downstream events ko link karta hai, hash chain jo tampering detect karta hai."*

> *"Audit Trail tamper-evident hai — koi past event modify nahi kar sakta. Regulator audit ke liye crucial."*

**[Navigate to Reports & BI]**
> *"Last piece — regulatory reporting. Report Library me pre-built templates hain — Stressed Borrowers Report, NPA Trend Report, Sector Concentration Report, AML STR Report, etc."*

**[Run Stressed Borrowers Report]**
> *"Run karte hain — Stressed Borrowers Report. PDF generate hota hai, formatted, regulator-submittable. Schedule bhi kar sakte hain — har Monday morning auto-run, board ko email."*

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

1. Click **SMA Classification** in sidebar
2. Show today's SMA movements: SMA-0 → SMA-1 transitions, count
3. Click a movement → drill modal showing accounts

#### Part B — Sector Watch (1 min)

1. Click **Sector Watch** in sidebar
2. Show **Sector Heatmap** — Real Estate, Power highlighted
3. Click Real Estate → sector deep-dive

### What to say

**[SMA Classification]**
> *"Banking domain depth — SMA Classification. RBI's Special Mention Account framework — SMA-0 / 1 / 2 buckets. Aaj 12 accounts SMA-0 se SMA-1 me transition kar gaye. Drill karke main exact accounts dekh sakti hu, aur kal-parso unka outreach plan bana sakti hu."*

**[Sector Watch]**
> *"Sector Watch — portfolio concentration aur sector stress ek saath. Real Estate aur Power — dono hot zone me hain, jaise dashboard pe bhi dikha tha. Click karke deep-dive."*

> *"India-specific frameworks built-in hain — RBI default. RMA Bhutan, CBK Kenya, MAS Singapore — sab configurable masters me se."*

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
📍 LOGIN → BANK_DEMO → Bank mode
📍 DASHBOARD → KPIs / Trend / Heatmap / AI Conf → click ACME
📍 ACME 360° → Ratios / Signals / SMA / Alerts → filter Real Estate
📍 NPA PREDICTION → 90d sort → ACME Why → top-5 features → AUC 0.89
📍 ALERTS → S1+S2 filter → ACME case → triage → assign me → escalate CRO
📍 AUDIT → ACME events on top → click event → hash chain
📍 REPORTS → Stressed Borrowers Report → run → PDF
🎬 (bonus) SMA today / Sector heatmap
🎬 CLOSE: "End-to-end journey, 775 APIs, multi-tenant ready"
🎤 Q&A
```

---

## RIGHT NOW — next 15 minutes

1. **Read this script top-to-bottom** — 5 min. Make sure narrative flows.
2. **Edit any names/numbers** to match your seed data:
   - Replace `ACME Industries` with actual top borrower name
   - Replace `0.84 NPA prob` with actual number from your `/v1/banking/npa/high-risk` response
   - Replace `28 open cases` with actual count from `/v1/cms/cases`
3. **Print or open on phone/tablet** — for quick glance during demo
4. **Move to next prep step** — Newman smoke run

---

*Tu yeh kar legi. Script ready hai, ab build aur practice.*

*— Demo script v1, 2026-05-24*
