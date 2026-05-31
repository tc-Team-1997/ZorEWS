# ZorEWS — Monday Execution Playbook

**Day:** Monday, 2026-05-25
**Owner:** Tanya (solo)
**Goal:** Wire 10 hero frontend screens to backend APIs end-to-end
**Time budget:** 12 hours in 3 blocks of 4 hours

---

## HOW TO USE THIS DOCUMENT

This is a **paste-and-build** playbook. For each hour, the document gives you:

1. **🎯 Goal** — what success looks like for that hour
2. **🤖 AI Prompt** — copy-paste this into Claude/Cursor to generate the code
3. **📡 API contract** — exact endpoint + sample response shape
4. **✅ Acceptance test** — manual verification before moving to next hour
5. **🆘 If broken** — common issue + 1-minute fix

**Rule:** If acceptance test fails after 60 minutes, **commit what works, defer fixes to evening bug-fix slot, move to next hour**. Don't sink time chasing perfection.

---

## SHARED SETUP (do this before 9 AM — 15 minutes)

### Common API conventions (every screen uses these)

```typescript
// Common headers for EVERY /v1/* call
const headers = {
  'Authorization': `Bearer ${jwt}`,
  'X-Tenant-ID': 'BANK_DEMO',
  'X-Channel': 'API',
  'Content-Type': 'application/json'
};

// Response envelope (every /v1/* route returns this)
type Envelope<T> = {
  header: {
    status: 'success' | 'error';
    code: string;
    message: string;
    requestId: string;
    timestamp: string;
  };
  body: T;
};

// Paginated list shape
type PaginatedList<T> = {
  items: T[];
  page: number;
  page_size: number;
  total: number;
};
```

### Create a shared API client (do this once, 10 min)

**🤖 PROMPT — Run this first in Claude/Cursor:**

```
Create a single-file API client at src/api/client.ts for a React SPA.
Requirements:
- BASE_URL from env var REACT_APP_API_URL (default http://localhost:8084)
- Auto-attach Authorization, X-Tenant-ID, X-Channel headers from localStorage
- For /v1/* routes, auto-unwrap the { header, body } envelope and return body only
- For /api/* routes, return JSON as-is
- Throw a typed ApiError on non-2xx with { code, message, status }
- Export: apiGet, apiPost, apiPatch, apiDelete, apiPut
- TypeScript strict mode
- Use fetch (no axios)
Output: complete file, no placeholders.
```

### Demo user / tenant / token (have these handy)

```
Username: tanya.credit (or your seed user)
Password: <from your seed script>
Tenant: BANK_DEMO
Mode: bank
```

Test the client works: `apiGet('/healthz')` should return 200 before you start Hour 1.

---

# BLOCK 1 — MORNING (9 AM – 1 PM)

> *"Identity + Big Picture + Borrower Discovery — Acts 1-3 of demo"*

---

## HOUR 1 — Login + Header (Tenant + Mode toggle)

⏱ **9:00 AM – 10:00 AM**

### 🎯 Goal
User can sign in, see their name + tenant + BANK badge in header, mode toggle visible (Bank/Insurance).

### 📡 API contract

```
POST /auth/login
Body: { username, password }
Returns: { token, refresh_token, user: { username, full_name, roles[] } }

GET /auth/me
Headers: Bearer + tenant
Returns: { username, full_name, email, roles[], tenant_id }

GET /v1/tenants/me
Returns envelope.body = { tenant_id, name, channels[], active, vertical }
```

### 🤖 AI Prompt

```
Build a React Login screen + persistent app header for ZorEWS.

Requirements:
LOGIN SCREEN (route: /login):
- Two fields: username, password
- Sign in button
- On success: POST /auth/login → save token + refresh_token to localStorage, save user to context, redirect to /dashboard
- On failure: red banner with error message from API
- Match this wireframe: title "Early Warning System", subtitle "Sign in", clean dark blue theme

APP HEADER (top of every authenticated page):
- Left: ZorEWS logo + "Zor EWS" wordmark
- Right area:
  - BANK / INSURANCE mode toggle (pill, defaults to BANK from localStorage)
  - User chip showing full_name with dropdown (My Profile, Preferences, My Activity, Switch Role, Sign out)
  - Notification bell with count badge
  - Global search icon

AUTH CONTEXT:
- Create AuthContext that provides { user, tenant, mode, setMode, signOut }
- On app load, hydrate from localStorage; call GET /auth/me and GET /v1/tenants/me to populate
- Redirect to /login if no token
- Mode toggle: persists to localStorage; updates context; all child components re-render

Use the apiGet/apiPost helpers from src/api/client.ts.
Use only Tailwind utility classes. No CSS files.
Output: complete files for src/screens/Login.tsx, src/components/Header.tsx, src/context/AuthContext.tsx, src/App.tsx (with router setup).
```

### ✅ Acceptance test

Manual checks (5 min):
- [ ] Wrong password → red error banner
- [ ] Correct password → land on /dashboard URL
- [ ] Header shows your full_name
- [ ] Header shows BANK chip (orange)
- [ ] Click INSURANCE chip → toggle changes to blue (color change OK even if data doesn't refresh yet)
- [ ] Refresh page → stay logged in (token persists)
- [ ] Sign out → back to /login

### 🆘 If broken

| Symptom | Fix |
|---|---|
| CORS error in console | Add `Access-Control-Allow-Origin: *` in BFF dev config (Express: `app.use(cors())`) |
| 401 even with right password | Check JWT signing key matches between auth-svc and BFF |
| Header not appearing | App.tsx must wrap routes in `<AuthContext.Provider>` + render `<Header />` |
| Mode toggle doesn't persist | `localStorage.setItem('mode', mode)` in toggle handler |

---

## HOUR 2 — EWS Dashboard

⏱ **10:00 AM – 11:00 AM**

### 🎯 Goal
Land on dashboard after login. See 6 KPI tiles + Top Stressed Borrowers table + Alert Trend chart + Risk Heatmap + AI Confidence card. All driven by real backend.

### 📡 API contract

```
GET /v1/dashboard/summary?mode=bank
Returns envelope.body = {
  kpis: {
    open_alerts: number,
    s1_critical_count: number,
    borrowers_on_watchlist: number,
    npa_predictions_today: number,
    dq_composite_score: number,
    sla_breach_count: number
  }
}

GET /v1/dashboard/top-stressed?mode=bank&limit=10
Returns envelope.body = { items: [{ customer_id, name, sector, ews_score, severity, top_signal, exposure }] }

GET /v1/dashboard/alert-trend?days=30
Returns envelope.body = { points: [{ date, s1, s2, s3, total }] }

GET /v1/dashboard/dq-by-source
Returns envelope.body = { sources: [{ source_id, name, score }] }

GET /v1/dashboard/risk-heatmap?mode=bank
Returns envelope.body = { rows: [{ sector, s1: number, s2: number, s3: number }] }

GET /v1/dashboard/ai-confidence
Returns envelope.body = { overall: number, by_model: [{ model_id, name, confidence }] }
```

*Note: if these exact paths don't exist, use whichever dashboard endpoints your backend ships (e.g. `/v1/dashboards/bil/executive`). Adapt the response shape.*

### 🤖 AI Prompt

```
Build the ZorEWS EWS Dashboard screen at route /dashboard.

Layout (top to bottom):
1. KPI strip: 6 clickable tiles in a horizontal row
   - Open Alerts (red icon if > threshold)
   - S1 Critical Count
   - Borrowers on Watchlist
   - NPA Predictions Today
   - DQ Composite Score (out of 100)
   - SLA Breach Count
   Each tile: large number, small label, subtle bg color per severity. Click navigates to source module with drill filter.

2. Two-column row:
   - Left (60%): "Top Stressed Borrowers" table — 10 rows. Cols: Borrower (name), Sector, EWS Score (with colored badge), Severity (S1/S2/S3 pill), Top Signal, Exposure. Click row → navigate to /borrowers/:id (modal opens via route)
   - Right (40%): "AI Confidence — Today" card — overall confidence as large number + per-model list

3. Two-column row:
   - Left (50%): Alert Trend line chart — 30 days, stacked by severity. Use Chart.js or Recharts. Include a "configure" icon (opens simple modal with date range options: 7/30/60/90 days)
   - Right (50%): Risk Heatmap — 2D grid: sectors (rows) × severity columns (S1/S2/S3) with count + cell bg intensity based on count

4. Below: "Data Quality by Source" horizontal bar chart

Data fetching:
- On mount, parallel-fetch all 6 endpoints listed above using apiGet
- Show skeleton loaders while loading
- If any single endpoint fails, show that section's error state with "Retry" button — other sections still render

Mode-aware: Pass mode from AuthContext into every dashboard endpoint as ?mode=bank|insurance

Use Tailwind only. Use Recharts for charts.
Output: src/screens/Dashboard.tsx + any reusable components (KPITile, SeverityBadge, etc.) in src/components/.
```

### ✅ Acceptance test

- [ ] All 6 KPI tiles show numbers (not zeros, not loading forever)
- [ ] Top Stressed Borrowers table shows ≥5 rows
- [ ] Alert Trend chart renders a line
- [ ] Risk Heatmap shows cells with numbers
- [ ] AI Confidence shows a number like 0.89
- [ ] Click on KPI tile → navigates somewhere (even if target screen not ready yet)
- [ ] Click row in stressed borrowers → navigates to /borrowers/<id>
- [ ] Toggle Bank ↔ Insurance → dashboard refetches (even if numbers same)

### 🆘 If broken

| Symptom | Fix |
|---|---|
| All tiles zero | Seed data is empty for this tenant — check Postgres: `SELECT count(*) FROM alerts WHERE tenant_id='BANK_DEMO'` |
| Chart renders empty | `points` array empty — check `/v1/dashboard/alert-trend` response in browser network tab |
| Heatmap looks broken | Skip heatmap, render as simple table for demo — say "heatmap visualization in final polish" |
| 500 error on a tile | That specific endpoint not built yet — render placeholder card with hardcoded mock for demo |

---

## HOUR 3 — Borrower Watch list

⏱ **11:00 AM – 12:00 PM**

### 🎯 Goal
Sidebar "Borrower Watch" link → page with table of 12 borrowers (matches sidebar badge). Filter by sector works. Click row navigates to detail.

### 📡 API contract

```
GET /api/customers?mode=bank&sector=&segment=&watchlist_only=false&page=1&page_size=50
Returns: { items: [{ id, name, sector, segment, exposure, ews_score, severity, top_signal, watchlist_tag, watchlist_added_at }], page, page_size, total }

POST /v1/watchlist
Body: { customer_id, reason }

DELETE /v1/watchlist/:customer_id
```

### 🤖 AI Prompt

```
Build the Borrower Watch screen at route /borrowers.

Layout:
- Page header: "Borrower Watch" + subtitle showing count "X of Y borrowers"
- Filter bar (horizontal): Sector dropdown, Segment dropdown, Severity multi-select, EWS Score range slider, "Watchlist only" toggle. All filters trigger refetch.
- Cohort actions row (visible when rows selected): "Add cohort to watchlist", "Build CMA Pack" (button — opens stub modal saying "CMA generation in progress"), "Export CSV"
- Main table: checkbox column + Name, Sector, Segment, Exposure (formatted ₹), EWS Score (badge with color: red≥80, orange 60-80, yellow 40-60), Severity pill (S1/S2/S3), Top Signal (truncated), Watchlist (★ icon if on watchlist, clickable to toggle)
- Pagination at bottom

Data:
- On mount, GET /api/customers with current filters
- Filter changes → refetch
- Star icon click → POST /v1/watchlist (or DELETE if already on) → refetch row
- Row click (not on checkbox/star) → navigate to /borrowers/:id

Filter dropdowns:
- Sector: hardcode for demo ['Real Estate', 'Power', 'Manufacturing', 'Retail Trade', 'Construction', 'Textiles', 'IT Services', 'Healthcare']
- Segment: ['Retail', 'SME', 'Corporate', 'Large Corporate']

Use Tailwind. Use a simple table — no fancy data grid library.
Output: src/screens/BorrowerWatch.tsx.
```

### ✅ Acceptance test

- [ ] Table shows borrowers — count matches sidebar badge ideally
- [ ] Apply Sector = "Real Estate" filter → table filters to subset
- [ ] EWS Score badges color-coded
- [ ] Severity pills colored
- [ ] Click watchlist star → toggle works (star changes state)
- [ ] Click row → URL changes to /borrowers/:id (next hour wires the modal)

### 🆘 If broken

| Symptom | Fix |
|---|---|
| Empty table | Hit `/api/customers` directly in browser network tab — does the response have items? If not, seed data issue |
| Filter doesn't refetch | useEffect dependency array must include filter state |
| Watchlist toggle 401 | Check token is being sent; check /v1/watchlist route is mounted |
| Slow render with many rows | Add `page_size=20` and pagination |

---

## HOUR 4 — Borrower 360° modal

⏱ **12:00 PM – 1:00 PM**

### 🎯 Goal
Click a borrower row → modal opens with tabbed deep-dive (Overview, Ratios, Signals, SMA, Alerts). Each tab shows real data.

### 📡 API contract

```
GET /v1/customers/:customer_id/360
Returns envelope.body = {
  overview: { name, sector, segment, exposure, limits, contact, sanction_date, ews_score, severity },
  ratios: [{ code, name, value, threshold_warn, threshold_critical, trend_vs_sector, history: [{date, value}] }],
  signals: [{ id, type, score, detected_at, evidence }],
  sma: { current_bucket, days_in_bucket, framework_code, trajectory },
  alerts_history: [{ alert_id, severity, raised_at, status, title }],
  cases: [{ case_id, status, severity, opened_at, title }],
  notes: [{ note_id, author, body, created_at }]
}

GET /v1/risk-profile/:customer_id
Returns envelope.body = { ews_score, components: [{ name, weight, value, contribution }] }
```

### 🤖 AI Prompt

```
Build a Borrower 360° modal component that opens for route /borrowers/:id.

Use a routed modal pattern: the URL changes to /borrowers/:id (overlay over BorrowerWatch list), Escape key or X button navigates back to /borrowers.

Modal layout:
- Header: Borrower name + Sector + EWS Score badge + Severity pill + "Add to watchlist" button + Close (X)
- Tabs (horizontal): Overview | Ratios | Signals | SMA | Alerts | Cases | Notes
- Tab content area below

Overview tab:
- Two-column key-value grid: Sector, Segment, Exposure, Sanctioned Limits, Sanction Date, Contact
- Below: Risk Profile component score breakdown (top 5 contributors with weight × value bars)

Ratios tab:
- Table: Ratio Name, Current Value, Threshold (warn/critical), Trend vs Sector (▲/→/▼ with color)
- Click row → expand to show 12-month history mini-chart

Signals tab:
- Card list: each signal with type icon, score badge, detected date, evidence summary
- "Investigate" button on each card (just logs to console for demo)

SMA tab:
- Big status card: "Currently SMA-X · Y days in bucket · Framework: RBI"
- Trajectory mini-chart: SMA bucket transitions over time

Alerts tab:
- Table: Severity, Date, Title, Status — sorted newest first
- Click row → navigate to /alerts (drill filter applied)

Cases / Notes tabs: similar simple list view

Data:
- On modal open, parallel fetch /v1/customers/:id/360 and /v1/risk-profile/:id
- Show loading skeleton in tab content while fetching
- Show error state with retry if fetch fails

Use Tailwind. Modal: fixed overlay with backdrop blur, max-width 1200px, max-height 90vh, scrollable content area.
Output: src/screens/Borrower360.tsx.
```

### ✅ Acceptance test

- [ ] Click borrower in list → modal opens within 500ms
- [ ] URL changes to /borrowers/:id
- [ ] All 7 tabs clickable
- [ ] Overview tab populated with real data
- [ ] Ratios tab shows at least 4 ratios with thresholds
- [ ] Signals tab shows ≥1 signal
- [ ] SMA tab shows current bucket
- [ ] Press Escape → modal closes, back to list
- [ ] Click X → modal closes

### 🆘 If broken

| Symptom | Fix |
|---|---|
| Modal doesn't open on row click | Check `useNavigate('/borrowers/' + id)` wired to row onClick |
| 404 from /360 endpoint | Some borrowers may not have full data — pick one that does for demo |
| Empty Ratios tab | Backend may not seed ratios — show placeholder with "data being loaded" |
| Slow open | Reduce concurrent fetches; defer Cases/Notes tabs to lazy load |

---

## 🍽 LUNCH BREAK — 1:00 PM – 1:30 PM

**Do not skip.** Eat properly. Walk for 5 min. Don't check email/Slack.

---

# BLOCK 2 — AFTERNOON (1:30 PM – 5:30 PM)

> *"AI in Action + Action Loop — Acts 4-5 of demo"*

---

## HOUR 5 — NPA Prediction list

⏱ **1:30 PM – 2:30 PM**

### 🎯 Goal
Sidebar "NPA Prediction" → table of high-risk accounts with 30/60/90-day probabilities. Sort by horizon. Each row leads to "Why" modal.

### 📡 API contract

```
GET /v1/banking/npa/high-risk?horizon=90&min_prob=0.5&page=1&page_size=50
Returns envelope.body = {
  items: [{
    account_id,
    customer_id,
    customer_name,
    sector,
    current_sma,
    prob_30d,
    prob_60d,
    prob_90d,
    top_features: [{ name, importance }]
  }],
  page, page_size, total,
  model: { id, name, version, last_trained, auc }
}
```

### 🤖 AI Prompt

```
Build the NPA Prediction screen at route /npa.

Layout:
- Page header: "NPA Prediction" + subtitle with model info: "Model NPA-v3.2 · Backtest AUC 0.89 · Last trained DATE"
- Filter bar: Horizon selector (30d / 60d / 90d), Min probability slider (0-1), Sector multi-select
- Action bar: "Open Backtest Report" button (opens stub modal)

Main table:
- Columns: Account ID, Customer (clickable to /borrowers/:id), Sector, Current SMA pill, 30d Prob, 60d Prob, 90d Prob, Top Features (chip stack of top 3 feature names)
- Probability cells: colored cell bg — red ≥0.8, orange 0.6-0.8, yellow 0.4-0.6
- Sort by selected horizon descending by default
- Row click → navigate to /npa/:account_id (opens Why modal in next hour)

Data:
- On mount + filter change, GET /v1/banking/npa/high-risk with current filters
- If endpoint not yet shipped, fallback to GET /v1/ai/predictions with filter to NPA model

Use Tailwind. Output: src/screens/NpaPrediction.tsx.
```

### ✅ Acceptance test

- [ ] Table shows ≥5 high-risk accounts
- [ ] Three probability columns visible with color coding
- [ ] Sort by 90d works
- [ ] Filter by horizon switches default sort
- [ ] Click row → URL changes to /npa/:account_id
- [ ] Model info banner shows AUC

### 🆘 If broken

| Symptom | Fix |
|---|---|
| Endpoint 404 | Check exact path in openapi.md — may be `/v1/ai/models/:npa_model_id/predictions` |
| All probs same value | Seed data needs variance — for demo, just sort and show |
| Top features empty | Render "—" placeholder |

---

## HOUR 6 — NPA Why / Explainability modal

⏱ **2:30 PM – 3:30 PM**

### 🎯 Goal
Click NPA row → modal opens with top-5 feature contributors + natural language explanation + trust signals.

### 📡 API contract

```
GET /v1/banking/npa/predictions/:account_id/why
Returns envelope.body = {
  account_id, customer_name, prediction_value, horizon_days,
  top_features: [{ name, value, importance, direction: '+' | '-', description }],
  explanation_text: "This account shows characteristics similar to ...",
  similar_cases: [{ account_id, customer_name, outcome }]
}

GET /v1/ai/predictions/:prediction_id/explanation
GET /v1/ai/predictions/:prediction_id/trust-signals
Returns envelope.body = { training_data_freshness, prediction_confidence, similar_case_count, model_version }
```

### 🤖 AI Prompt

```
Build the NPA "Why" modal at route /npa/:account_id (routed modal over /npa).

Modal layout (3 sections):

1. Header card:
   - Customer name + account ID
   - Big probability number with horizon label "84% probability of NPA in 90 days"
   - "View on Model Registry" button (stub link)

2. Top 5 Contributing Features:
   - Horizontal bar chart: feature name on left, bar showing importance, value on right with + or - color
   - Below each bar: 1-line description

3. Natural language explanation card:
   - Large quote-style text rendering explanation_text
   - Prefix: "🤖 AI Analysis:"

4. Trust signals strip (bottom):
   - 4 small cards: Training Data Age, Prediction Confidence, Similar Cases Count, Model Version
   - Each with icon + value + label

Modal styling: white card, max-width 800px, scrollable. Close on Escape or X.

Data:
- On open, fetch /v1/banking/npa/predictions/:account_id/why
- Fetch /v1/ai/predictions/:account_id/trust-signals in parallel (this endpoint may not exist — wrap in try/catch and just skip trust signals if fails)
- Show loading skeleton

Use Tailwind. Use Recharts for the horizontal bar chart (or render bars manually with width % — simpler).
Output: src/screens/NpaWhy.tsx.
```

### ✅ Acceptance test

- [ ] Modal opens on row click within 1 second
- [ ] Top 5 features render with importance bars
- [ ] Each feature has direction indicator (+/-)
- [ ] Natural language explanation visible
- [ ] Trust signals strip shows (or hidden gracefully if endpoint missing)
- [ ] Escape closes modal

### 🆘 If broken

| Symptom | Fix |
|---|---|
| /why endpoint 404 | Use generic /v1/ai/predictions/:id/explanation if NPA-specific not built |
| Empty explanation_text | Hardcode a fallback: "Based on the top contributing factors above, this account requires immediate review." |
| Bars look broken | Render simple div widths: `<div style={{width: `${importance*100}%`}} className="bg-red-500" />` |

---

## HOUR 7 — Alerts & Cases inbox

⏱ **3:30 PM – 4:30 PM**

### 🎯 Goal
Sidebar "Alerts & Cases" → inbox with 28 cases. Filter chips work. Click case → detail (next hour).

### 📡 API contract

```
GET /v1/alerts?severity=&status=&assignee=&since=&until=&page=1&page_size=50
Returns envelope.body = { items: [{ alert_id, severity, customer_id, customer_name, title, raised_at, status, source_module }], page, page_size, total }

GET /v1/cms/cases?status=open&severity=&assignee=&page=1&page_size=50
Returns envelope.body = { items: [{ case_id, title, customer_id, customer_name, severity, status, assignee, opened_at, sla_deadline, source_alert_id }], page, page_size, total }

GET /v1/cms/cases/stats
Returns envelope.body = { by_status: {...}, by_severity: {...}, total_open, sla_breached }
```

### 🤖 AI Prompt

```
Build the Alerts & Cases inbox at route /alerts.

Layout:
- Page header: "Alerts & Cases" + count subtitle from /v1/cms/cases/stats
- Top strip: stats cards showing Open / In Review / Action Proposed / Approved / Closed Today (colored)
- Filter chip row: Severity (S1, S2, S3 toggles), Status (Open, In Review, Action Proposed, Closed), Assignee (Me, Anyone), Date range
- Main table: Case ID, Severity pill, Customer, Title, Assignee, SLA Countdown (live time-remaining string with red if <2h), Status pill, Source module
- Action: New Case button (top right, opens stub modal)

Data:
- On mount + filter change, fetch /v1/cms/cases (primary) and /v1/alerts (for context)
- Fetch /v1/cms/cases/stats once for the stats strip
- Click row → navigate to /alerts/:case_id

SLA Countdown:
- Compute time from now to sla_deadline using date-fns formatDistanceToNow
- Red text if <2 hours, amber if <12 hours, normal otherwise

Use Tailwind. Output: src/screens/AlertsInbox.tsx.
```

### ✅ Acceptance test

- [ ] Inbox shows ≥10 cases
- [ ] Stats strip shows numbers
- [ ] Filter by Severity = S1 → table filters
- [ ] Filter by Status → table filters
- [ ] SLA countdown visible
- [ ] Click row → URL changes to /alerts/:case_id

### 🆘 If broken

| Symptom | Fix |
|---|---|
| /cases empty but /alerts has data | Cases may not auto-create from alerts — for demo, render /alerts items as case-like rows |
| SLA deadline missing | Skip countdown column |
| Filter doesn't work | Move filter state to URL search params for easier debugging |

---

## HOUR 8 — Case detail + Triage flow

⏱ **4:30 PM – 5:30 PM**

### 🎯 Goal
Click case → detail modal opens with Timeline, Notes, Attachments. Triage actions (Assign / Escalate / Close) actually update status.

### 📡 API contract

```
GET /v1/cms/cases/:case_id
Returns envelope.body = { case_id, title, description, customer, severity, status, assignee, opened_at, sla_deadline, ... }

GET /v1/cms/cases/:case_id/{notes,attachments,history,timeline}
POST /v1/cms/cases/:case_id/notes — body: { body }
POST /v1/cms/cases/:case_id/assign — body: { assignee_username }
POST /v1/cms/cases/:case_id/escalate — body: { to_role, reason }
POST /v1/cms/cases/:case_id/close — body: { reason_code, reason_text }
POST /v1/cms/cases/:case_id/transition — body: { to_state }
```

### 🤖 AI Prompt

```
Build the Case Detail modal at route /alerts/:case_id (routed modal over AlertsInbox).

Modal layout:
- Header: Case title + Severity pill + Status pill + Customer name (link to /borrowers/:id) + Close X
- Action bar (top): "Triage Now", "Assign", "Add Note", "Escalate to CRO", "Close Case" buttons

Tabs:
- Details: case description, source alert link, opened_at, SLA countdown
- Timeline: vertical list of events from /v1/cms/cases/:case_id/timeline (status changes, notes, assignments)
- Notes: list of notes + textarea + "Add note" button → POST /v1/cms/cases/:id/notes
- Attachments: simple list (metadata only — no upload for demo)

Action modals (each opens a small inline form):
- Assign: dropdown of users (hardcode 3-4 demo users for now) + Submit → POST /assign
- Escalate: dropdown of roles (CRO, Credit Committee, Vigilance) + reason textarea + Submit → POST /escalate
- Close: reason code dropdown + reason text + Submit → POST /close

After any action:
- Refetch case detail and timeline
- Show toast "Action successful"
- Update case status pill in header

Use Tailwind. Output: src/screens/CaseDetail.tsx.
```

### ✅ Acceptance test

- [ ] Modal opens on row click
- [ ] Details, Timeline, Notes tabs all show data
- [ ] Add a note → appears in Notes list
- [ ] Assign case → status indicator updates
- [ ] Escalate case → status changes to "In Review" or similar
- [ ] Close modal → back to inbox

### 🆘 If broken

| Symptom | Fix |
|---|---|
| Timeline empty | Fall back to /v1/cms/cases/:id/history |
| Assign endpoint 400 | Inspect request body — assignee_username vs assignee_id naming |
| Escalate fails | Skip — demo shows assign and close, mention "full escalation workflow integrated, end-to-end demo in extended session" |

---

## ☕ COFFEE BREAK — 5:30 PM – 5:45 PM

15 min. Stand up. Stretch. Drink water.

---

# BLOCK 3 — EVENING (5:45 PM – 9:45 PM)

> *"Compliance + Dry Run + Bug Fix — Acts 6 + integration test"*

---

## HOUR 9 — Audit Trail

⏱ **5:45 PM – 6:45 PM**

### 🎯 Goal
Sidebar "Audit Trail" → event log with filters. Click event → detail modal showing payload + correlation ID.

### 📡 API contract

```
GET /v1/audit/events?actor_username=&action=&resource_type=&since=&until=&page=1&page_size=50
Returns envelope.body = { items: [{ event_id, timestamp, actor_username, action, resource_type, resource_id, outcome, severity, correlation_id }], page, page_size, total }

GET /v1/audit/events/:event_id
Returns envelope.body = { ...event, payload, prev_hash, current_hash }

GET /v1/audit/summary?days=30
Returns envelope.body = { total, by_outcome, by_severity }
```

### 🤖 AI Prompt

```
Build the Audit Trail screen at route /audit.

Layout:
- Page header: "Audit Trail" + subtitle "Immutable event log"
- Top strip: small summary cards from /v1/audit/summary — total events, success rate, critical count
- Filter bar: Actor, Action (text search), Resource type (dropdown), Outcome (success/failure), Date range
- Main table: Timestamp (formatted), Actor, Action, Resource (type + ID), Outcome (pill: green/red), Severity (pill)
- Row click → detail modal

Detail modal:
- Header: Event ID + Timestamp + Actor
- Full payload as formatted JSON (with copy button)
- Correlation ID with "View related events" button (filters audit list by correlation_id)
- Hash chain info: prev_hash + current_hash (monospace)

Data:
- On mount + filter change, GET /v1/audit/events
- Newest first

Use Tailwind. For JSON display, use a simple <pre> block.
Output: src/screens/AuditTrail.tsx.
```

### ✅ Acceptance test

- [ ] Table shows recent events (your own login/case actions should be visible at top)
- [ ] Filter by Resource = "case" → events filter
- [ ] Click event → modal with payload
- [ ] Correlation ID visible
- [ ] Hash chain info visible

### 🆘 If broken

| Symptom | Fix |
|---|---|
| No events showing | Check /v1/audit/events endpoint — may need to flush audit-svc queue |
| Detail modal empty | Field name may be `event_data` not `payload` — adapt |
| Hash chain field missing | Hide that section gracefully |

---

## HOUR 10 — Reports & BI

⏱ **6:45 PM – 7:45 PM**

### 🎯 Goal
Sidebar "Reports & BI" → list of report templates. Pick one + Run → preview/download.

### 📡 API contract

```
GET /v1/reports/catalog
Returns envelope.body = { items: [{ id, name, description, category, format_options[] }] }

POST /v1/reports/builder/run
Body: { report_id, format: 'json'|'csv'|'pdf'|'xlsx', filters: {...} }
Returns envelope.body = { rows, projection, aggregates, totals }

POST /v1/reports/builder/export.csv
Returns CSV file (Content-Disposition attachment)

GET /v1/reports/schedules
GET /v1/reports/schedules/upcoming
```

### 🤖 AI Prompt

```
Build the Reports & BI screen at route /reports.

Layout:
- Page header: "Reports & BI" + subtitle
- Two-column layout:
  - Left (60%): Report Library table — list from /v1/reports/catalog. Cols: Name, Description, Category, Actions (Run, Schedule)
  - Right (40%): Scheduled Reports calendar/list from /v1/reports/schedules/upcoming

Run report flow:
- Click "Run" on a row → opens parameter modal: select format (CSV/PDF/JSON), date range, "Run report" submit
- Submit → POST /v1/reports/builder/run → show results in a preview modal (first 50 rows + total count)
- "Download CSV" button in preview → POST /v1/reports/builder/export.csv with same params, trigger browser download

For demo, focus on ONE report end-to-end. Pick the first item in catalog.

Use Tailwind. Output: src/screens/ReportsBi.tsx.
```

### ✅ Acceptance test

- [ ] Report catalog shows ≥3 templates
- [ ] Click "Run" on one → parameter modal opens
- [ ] Submit → results preview shows data rows
- [ ] Download CSV → file downloads
- [ ] Scheduled reports list shows upcoming runs

### 🆘 If broken

| Symptom | Fix |
|---|---|
| Empty catalog | Backend may not seed report templates — fall back to hardcoded 3 templates |
| Run fails | For demo, render a fake table from `/v1/reports/builder/preview` if `/run` not built |
| CSV download blocked | Just show preview in modal, skip download for demo |

---

## HOUR 11 — DRY RUN #1

⏱ **7:45 PM – 8:45 PM**

### 🎯 Goal
Go through the full demo script end-to-end. Time yourself. Note every bug, every confusion.

### Method

1. **Open demo script in second window** (computer:// link to ZorEWS_Demo_Script.md)
2. **Start a stopwatch**
3. **Sign out of app, close all browser tabs**
4. **Open fresh incognito at /login**
5. **Walk through script literally** — every click, every line you'd say
6. **Don't fix anything during the run** — just note in a scratch text file:
   - Bug: ___
   - Slow load: ___
   - Confusing: ___
   - Missing data: ___

### What to time

| Section | Target | Actual |
|---|---|---|
| Total run | ≤18 min | ___ |
| Dashboard load | ≤3 sec | ___ |
| 360° modal open | ≤1 sec | ___ |
| NPA Why modal | ≤1 sec | ___ |
| Case action submit → status update | ≤2 sec | ___ |

### Common dry-run findings

- Dashboard tile click goes to wrong route → fix in evening bug-fix slot
- 360° modal tabs slow → defer non-essential tabs to lazy load
- NPA Why explanation empty → hardcode fallback text
- Case escalate button silently fails → wrap in try/catch + show toast

---

## HOUR 12 — Bug fix round 1

⏱ **8:45 PM – 9:45 PM**

### 🎯 Goal
Fix the top 5 issues from dry-run. Defer the rest to Tuesday morning bug-fix slot.

### Method

1. **List all bugs from Hour 11 in a text file**
2. **Sort by demo-impact:** Showstoppers first (can't continue demo), then ugly (looks bad), then nitpicks
3. **Pick top 5.** Set 12-min budget per bug = 60 min total.
4. **For each:**
   - Read the error / repro the bug
   - Try the obvious fix first
   - If not fixed in 12 min, **commit a workaround and move on**

### Workaround patterns

| Bug type | Workaround |
|---|---|
| API returns 500 | Wrap in try/catch, render placeholder + "data loading…" |
| Modal won't close | Add Escape key listener as backup |
| Slow load | Add skeleton loader so it doesn't look frozen |
| Wrong data shape | Coerce with `data?.field ?? defaultValue` |
| Console errors | Suppress with try/catch — clean console > clean code for demo |
| Missing endpoint | Hardcode demo response in frontend service layer |

### Commit + sleep

- Commit all fixes: `git commit -am "Monday bug fix round 1: top 5 demo blockers"`
- Take screenshots of each hero screen in working state — store in `/demo-backups/` folder
- **Sleep by 11 PM.** Tuesday needs you sharp.

---

## END-OF-MONDAY SUCCESS CRITERIA

By 9:45 PM, you should have:

- [ ] All 10 hero screens accessible from sidebar
- [ ] Login → Dashboard → Borrower drill works without console errors
- [ ] At least one full demo path completes in <20 min
- [ ] Backup screenshots taken for every hero screen
- [ ] Demo script updated with any name/number changes from real data
- [ ] Git committed and pushed
- [ ] Tomorrow's plan reviewed (Tuesday morning = 2 more dry-runs + polish)

---

## EMERGENCY ESCAPE HATCHES

If by **2 PM Monday** you're behind schedule (still on Hour 1-2), invoke emergency mode:

### Emergency Mode A — Skip 2 hero screens
Cut: Audit Trail + Reports & BI. Demo without these — say "compliance and reporting modules in extended demo".
Saves: 2 hours.

### Emergency Mode B — Pre-record demo
Open Loom / OBS. Record yourself walking through the wireframe with mock data. Play recording at demo. Acknowledge it's "recorded for stability" up front.
Saves: bug-fix anxiety, gives perfect run.

### Emergency Mode C — Reduce scope to 5 screens
Cut to: Login, Dashboard, Borrower Watch + 360, NPA + Why. That's a 10-min demo focused on the AI story.
Saves: 4 hours.

**Decide which mode at 2 PM Monday based on Block 1 progress.**

---

## FILE STRUCTURE (recommended)

```
src/
├── api/
│   └── client.ts                  # Hour 0 setup
├── context/
│   └── AuthContext.tsx            # Hour 1
├── components/
│   ├── Header.tsx                 # Hour 1
│   ├── Sidebar.tsx                # Pre-existing wireframe nav
│   ├── KPITile.tsx                # Hour 2
│   ├── SeverityBadge.tsx          # Hour 2
│   └── SLACountdown.tsx           # Hour 7
├── screens/
│   ├── Login.tsx                  # Hour 1
│   ├── Dashboard.tsx              # Hour 2
│   ├── BorrowerWatch.tsx          # Hour 3
│   ├── Borrower360.tsx            # Hour 4
│   ├── NpaPrediction.tsx          # Hour 5
│   ├── NpaWhy.tsx                 # Hour 6
│   ├── AlertsInbox.tsx            # Hour 7
│   ├── CaseDetail.tsx             # Hour 8
│   ├── AuditTrail.tsx             # Hour 9
│   └── ReportsBi.tsx              # Hour 10
├── App.tsx                        # Hour 1 (router setup)
└── main.tsx                       # Vite entry
```

---

## ONE-LINE PROMPTS — Quick reference

For each hour, if you just want a one-liner to start, use these:

```
H1: "Build React Login + Header for ZorEWS with /auth/login + mode toggle, full file"
H2: "Build EWS Dashboard React screen with 6 KPI tiles + 4 charts from /v1/dashboard/*, mode-aware, full file"
H3: "Build Borrower Watch table React screen with filters + watchlist toggle from /api/customers, full file"
H4: "Build Borrower 360° routed modal with 7 tabs (Overview/Ratios/Signals/SMA/Alerts/Cases/Notes) from /v1/customers/:id/360, full file"
H5: "Build NPA Prediction table with 30/60/90d probability columns from /v1/banking/npa/high-risk, click→/npa/:id, full file"
H6: "Build NPA Why routed modal with top-5 feature bars + NL explanation from /v1/banking/npa/predictions/:id/why, full file"
H7: "Build Alerts & Cases inbox React screen with severity/status filter chips + SLA countdown from /v1/cms/cases, full file"
H8: "Build Case Detail routed modal with Timeline/Notes/Attachments tabs + Assign/Escalate/Close actions from /v1/cms/cases/:id, full file"
H9: "Build Audit Trail React screen with filters + event detail modal showing JSON payload + hash chain from /v1/audit/events, full file"
H10: "Build Reports & BI React screen with template catalog + run + CSV download from /v1/reports/catalog + /v1/reports/builder/run, full file"
```

---

*Bas execute karna hai. Sab planning ho gayi. Tu kar legi.*

*— Monday playbook v1, 2026-05-24*
