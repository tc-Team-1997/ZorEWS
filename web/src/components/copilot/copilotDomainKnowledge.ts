// copilotDomainKnowledge.ts
//
// ZorEWS Copilot — BFSI Domain Knowledge Base
// Deep domain knowledge for Banking, Insurance, and Operational concepts.
// Feeds the reasoning engine for rich, contextual answers.
//
// 100% additive — no existing logic changed.

import type { CopilotResponse } from './copilotEngine';

// ─── Domain topic entry ───────────────────────────────────────────────────

export interface DomainTopic {
  id:          string;
  title:       string;
  domain:      'banking' | 'insurance' | 'operational' | 'regulatory';
  keywords:    string[];
  keywords_hi: string[];
  body:        string;
  body_hi?:    string;
  body_hinglish?: string;
  kpis?:       string[];
  bestPractices?: string[];
  relatedTopics: string[];
  module:      string;
  route:       string;
}

// ─── Banking Domain Topics ────────────────────────────────────────────────

const BANKING_TOPICS: DomainTopic[] = [
  {
    id: 'credit_risk',
    title: 'Credit Risk Management',
    domain: 'banking',
    keywords: ['credit risk', 'credit management', 'credit portfolio', 'lending risk', 'borrower risk'],
    keywords_hi: ['क्रेडिट रिस्क', 'उधार जोखिम', 'क्रेडिट प्रबंधन'],
    body: `**Credit Risk** is the risk of loss when a borrower fails to repay a loan. It is the primary risk in banking, accounting for 60-70% of total bank risk.

**Three pillars of credit risk:**
• **PD (Probability of Default)** — Likelihood of borrower defaulting (e.g., PD 0.78 = 78% chance of NPA in 90 days)
• **LGD (Loss Given Default)** — % of exposure lost after recovery (secured: 20-40%, unsecured: 40-70%)
• **EAD (Exposure at Default)** — Total outstanding at time of default

**Expected Credit Loss = PD × LGD × EAD**

**Credit Risk Signals in ZorEWS:**
• DPD ≥ 30 days → SMA classification
• Utilization > 90% → Over-leveraged alert
• EMI bounce rate > 20% → Behavioural red flag
• Bureau score drop > 50 points → Credit deterioration
• Revenue/turnover drop > 30% → DSCR stress

**RBI Requirements:** Banks must maintain CRAR ≥ 9%, conduct quarterly stress testing, and report SMA-0 onwards.`,
    body_hi: `**क्रेडिट रिस्क** वह जोखिम है जब उधारकर्ता ऋण नहीं चुकाता। यह बैंकिंग का प्राथमिक जोखिम है।

**तीन मुख्य मापदंड:**
• **PD** — डिफ़ॉल्ट की संभावना
• **LGD** — डिफ़ॉल्ट के बाद हानि
• **EAD** — डिफ़ॉल्ट के समय कुल जोखिम

**अपेक्षित हानि = PD × LGD × EAD**

ZorEWS पर: DPD ≥ 30 दिन, उपयोग > 90%, EMI बाउंस > 20% — ये सभी क्रेडिट रिस्क के संकेत हैं।`,
    body_hinglish: `**Credit Risk** woh risk hai jab borrower loan nahi chukate. Banking ka primary risk hai — 60-70% total bank risk.

**Teen main parameters:**
• **PD** — Default hone ki probability
• **LGD** — Default ke baad kitna loss
• **EAD** — Default ke time total outstanding

**Formula: ECL = PD × LGD × EAD**

ZorEWS mein: DPD ≥ 30, utilization > 90%, EMI bounce > 20% — yeh sab credit risk signals hain.`,
    kpis: ['Portfolio NPA %', 'PCR (Provision Coverage Ratio)', 'CRAR', 'ECL provision', 'Slippage rate'],
    bestPractices: ['Segment portfolio by risk band monthly', 'Review top-20 borrowers weekly', 'Run stress test quarterly before RBI reporting'],
    relatedTopics: ['npa', 'sma', 'dpd', 'stress_testing', 'portfolio_risk'],
    module: 'Predictive Risk Center',
    route: '/predictive-risk-center',
  },

  {
    id: 'portfolio_risk',
    title: 'Portfolio Risk & Concentration',
    domain: 'banking',
    keywords: ['portfolio risk', 'concentration risk', 'sector risk', 'geographic risk', 'portfolio concentration', 'portfolio management'],
    keywords_hi: ['पोर्टफोलियो जोखिम', 'एकाग्रता जोखिम'],
    body: `**Portfolio Risk** is the risk arising from the composition of a bank's total loan book — including concentration in sectors, geographies, products, or single borrowers.

**Types of Portfolio Concentration:**
• **Sector Concentration** — e.g., 30% in real estate (RBI limit: 20%) → Breach
• **Single Borrower Limit** — Max 25% of Tier-1 capital per borrower
• **Geographic Risk** — Over-exposure to one region (flood/drought risk)
• **Product Concentration** — e.g., 80% unsecured personal loans

**ZorEWS Portfolio Monitoring:**
• Sector Watch → tracks sector-wise concentration daily
• Branch & Geography Risk → geographic exposure heatmap
• NPA Early Warning → borrower-level portfolio health
• Predictive Risk Center → forward-looking 90-day portfolio PD forecast

**Key Portfolio Metrics:**
• Weighted Average PD of portfolio
• Sector-wise NPA ratio vs industry benchmark
• Top-10 borrower concentration (% of total book)
• Geographic HHI (Herfindahl-Hirschman Index)`,
    kpis: ['Sector concentration %', 'Single borrower exposure', 'Geographic HHI', 'Weighted average PD'],
    relatedTopics: ['credit_risk', 'stress_testing', 'sector_risk'],
    module: 'Sector Watch',
    route: '/banking/sectors',
  },

  {
    id: 'collections_recovery',
    title: 'Collections & Recovery Management',
    domain: 'banking',
    keywords: ['collections', 'recovery', 'collection management', 'debt recovery', 'npa recovery', 'collection officer', 'recovery rate', 'ots', 'sarfaesi'],
    keywords_hi: ['वसूली', 'संग्रह प्रबंधन', 'NPA वसूली'],
    body: `**Collections & Recovery** is the process of recovering outstanding dues from NPA borrowers through structured outreach, legal action, and asset liquidation.

**Recovery Stages:**
1. **Pre-NPA (EWS phase)** → Call/visit for DPD 1-90. Target: cure before NPA
2. **Soft Recovery** → Outreach, restructuring offers, OTS negotiation (NPA < 6 months)
3. **Formal Legal** → Section 13(2) SARFAESI notice, DRT filing, NCLT for large cases
4. **Asset Resolution** → Auction, ARC transfer, write-off authorization

**Key Recovery Tools:**
• **OTS (One-Time Settlement)** — Lump sum < outstanding. CRO approval needed
• **SARFAESI** — Possession without court for secured assets (60-day notice)
• **DRT (Debt Recovery Tribunal)** — For amounts > ₹20L
• **NCLT (IBC)** — For corporate insolvency > ₹1Cr

**ZorEWS Recovery Features:**
• Collections Risk module → Portfolio recovery pipeline
• CMS Cases → Case-level action tracking with GPS
• Recovery Center → Recovery workflow with maker-checker
• Borrower Watch → Pre-NPA outreach dashboard`,
    body_hinglish: `**Collections & Recovery** matlab NPA borrowers se paise wapas lena.

**Stages:**
1. Pre-NPA → Call/visit, DPD 1-90 mein cure karo
2. Soft Recovery → OTS offer, restructuring
3. Legal → SARFAESI notice (60 din), DRT filing
4. Asset Auction → Property seize karke auction

**Key tools:** OTS (ek baar mein settlement), SARFAESI (court ke bina possession), DRT.

Recovery rate target: 65%+. ZorEWS mein Collections Risk + CMS Cases se track karo.`,
    kpis: ['Recovery rate (%)', 'Collections efficiency', 'OTS acceptance rate', 'Avg resolution days'],
    relatedTopics: ['npa', 'credit_risk', 'maker_checker'],
    module: 'Recovery Center',
    route: '/recovery-center',
  },

  {
    id: 'stress_testing',
    title: 'Stress Testing & Scenario Analysis',
    domain: 'banking',
    keywords: ['stress testing', 'stress test', 'scenario analysis', 'scenario simulation', 'ecl stress', 'capital stress', 'rbi stress', 'adverse scenario', 'severely adverse'],
    keywords_hi: ['तनाव परीक्षण', 'परिदृश्य विश्लेषण'],
    body: `**Stress Testing** is the simulation of portfolio behavior under hypothetical adverse macroeconomic scenarios to quantify potential losses and capital requirements.

**RBI Mandated Scenarios:**
• **Baseline** — Business as usual. Zero shocks
• **Adverse** — GDP -3%, Rates +200bps, FX +8%
• **Severely Adverse** — GDP -7%, Rates +400bps, FX +15%

**IRDAI Scenarios (Insurance):**
• Form-K Solvency Stress
• Catastrophe scenario
• Lapse stress (sudden 30% increase)

**ZorEWS Digital Twin:**
• Runs all RBI/IRDAI scenarios in real-time
• Projects ECL impact (e.g., ₹142Cr under severely adverse)
• Shows IFRS9 Stage migration (Stage 1→2→3)
• Segment risk heatmap under stress
• Board-ready PDF/Excel reports

**Capital Planning using Stress Test:**
ECL under stress → Additional provision needed → Capital buffer required
Example: ECL ₹142Cr under stress → Buffer ₹200Cr → CRAR impact: -0.8%`,
    body_hinglish: `**Stress Testing** matlab portfolio ka test adversely economic conditions mein.

**RBI ke 3 scenarios:**
• Baseline — No shock
• Adverse — GDP -3%, Rate +200bps
• Severely Adverse — GDP -7%, Rate +400bps (sabse tough)

**ZorEWS Digital Twin** se yeh test run karo:
→ ECL impact dekhte hain (e.g., ₹142Cr extra loss)
→ IFRS9 stage migration (1→2→3)
→ Capital planning ke liye use karo`,
    kpis: ['ECL under stress (%)', 'Capital buffer required', 'Stage migration rate', 'Portfolio resilience score'],
    relatedTopics: ['credit_risk', 'ifrs9', 'portfolio_risk'],
    module: 'Digital Twin Center',
    route: '/digital-twin-center',
  },

  {
    id: 'financial_ratios',
    title: 'Financial Ratios for Credit Assessment',
    domain: 'banking',
    keywords: ['financial ratios', 'financial ratio', 'dscr', 'ltv', 'leverage ratio', 'current ratio', 'debt equity', 'net worth', 'profitability ratios', 'liquidity ratio'],
    keywords_hi: ['वित्तीय अनुपात', 'DSCR', 'LTV'],
    body: `**Financial Ratios** are quantitative metrics used to assess borrower creditworthiness and financial health.

**Leverage Ratios (Debt Capacity):**
• **Debt/Equity Ratio** — Total debt ÷ Net worth. >2x signals over-leverage for MSME
• **Interest Coverage Ratio (ICR)** — EBIT ÷ Interest expense. <1.5x = stress
• **DSCR** — Net operating income ÷ Annual debt service. <1.0 = cash flow insufficient

**Liquidity Ratios:**
• **Current Ratio** — Current assets ÷ Current liabilities. <1.0 = liquidity stress
• **Quick Ratio** — (Cash + Receivables) ÷ Current liabilities. <0.75 = concern

**Profitability Ratios:**
• **Net Profit Margin** — Net profit ÷ Revenue. Declining trend = EWS signal
• **Return on Equity (RoE)** — Net profit ÷ Net worth

**LTV (Loan to Value):**
• Home loans: RBI max 80% LTV
• LAP: RBI max 65% LTV
• Commercial: typically 60-70%

**ZorEWS Financial Ratios module** tracks these per borrower with trend alerts.`,
    kpis: ['DSCR', 'ICR', 'Debt/Equity', 'Current Ratio', 'LTV'],
    relatedTopics: ['credit_risk', 'dscr'],
    module: 'Financial Ratios',
    route: '/financial-ratios',
  },

  {
    id: 'fraud_banking',
    title: 'Fraud Risk Management (Banking)',
    domain: 'banking',
    keywords: ['fraud', 'fraud risk', 'fraud detection', 'fraud management', 'fraud cluster', 'synthetic identity', 'transaction fraud', 'loan fraud', 'kite flying', 'round tripping', 'fraud ring'],
    keywords_hi: ['धोखाधड़ी', 'फ्रॉड'],
    body: `**Fraud Risk** in banking includes credit fraud, transaction fraud, identity fraud, and insider fraud.

**Major Fraud Types:**
• **Synthetic Identity Fraud** — Real + fake documents to create new identity
• **Loan Fraud** — Fabricated financials, overvalued collateral, fictitious borrowers
• **Transaction Fraud** — Unauthorized transfers, card skimming, phishing
• **Kite Flying** — Circular transactions between related parties to inflate balances
• **Round Tripping** — Funds flow out and return as fresh credit to inflate turnover

**Fraud Signals ZorEWS Monitors:**
• Sudden large cash withdrawals (velocity anomaly)
• Multiple accounts at same address
• Document pattern matching across unrelated borrowers
• Transaction graph clustering (network analysis)
• Geographic anomaly (card used in 2 cities simultaneously)
• After-hours admin access (insider risk)

**SAR Filing Requirements:**
Confirmed fraud → File SAR with FIU-IND within 7 days
SAR must be confidential — customer cannot be informed

**ZorEWS Fraud Modules:** Fraud Signals, Investigation Center, AML/KYC compliance`,
    body_hinglish: `**Fraud Risk** mein credit fraud, transaction fraud, identity fraud included hain.

**Common Fraud:**
• Synthetic Identity — Fake + real documents se nayi identity
• Loan Fraud — Fake financials, overvalued property
• Round Tripping — Paise bahar bhejo, fresh loan ke roop mein wapas
• Kite Flying — Related parties ke beech circular transactions

**ZorEWS detection:** Velocity anomaly, document pattern matching, transaction graph clustering.

**SAR filing:** Fraud confirm hone ke 7 din mein FIU-IND ko report karo.`,
    kpis: ['Fraud rate (bps)', 'SAR filings', 'Detection accuracy', 'False positive rate'],
    relatedTopics: ['aml', 'kyc', 'synthetic_identity'],
    module: 'Fraud Signals',
    route: '/fraud-signals',
  },

  {
    id: 'rbi_guidelines',
    title: 'RBI Guidelines & Regulatory Framework',
    domain: 'banking',
    keywords: ['rbi', 'rbi guidelines', 'rbi regulation', 'rbi circular', 'rbi norms', 'rbi compliance', 'master direction', 'prompt corrective action', 'pca'],
    keywords_hi: ['RBI दिशानिर्देश', 'भारतीय रिज़र्व बैंक'],
    body: `**RBI (Reserve Bank of India)** is the central bank and regulator for Indian banks. Key regulatory requirements include:

**Capital Requirements:**
• CRAR minimum 9% (Basel III: 8%)
• Tier-1 capital minimum 7%
• CET-1 minimum 5.5%
• Capital Conservation Buffer 2.5%

**Asset Quality Norms:**
• NPA classification: DPD > 90 days
• SMA reporting: From SMA-0 (DPD 1-30)
• Provisioning: Sub-standard 15%, Doubtful 25-100%, Loss 100%
• PCR (Provision Coverage Ratio) target: ≥ 70%

**Liquidity Requirements:**
• LCR (Liquidity Coverage Ratio): 100%
• NSFR (Net Stable Funding Ratio): 100%

**Key RBI Filings:**
• Quarterly CRAR submission
• Monthly NPA reporting (SMA from SMA-0)
• Annual ICAAP (Internal Capital Adequacy Assessment Process)
• BSR (Basic Statistical Returns) annual

**Prompt Corrective Action (PCA):**
RBI triggers PCA when CRAR < 9% or NPA > 10% or RoE < 0 → Restrictions on dividends, branch expansion, lending

**ZorEWS tracks:** All RBI compliance obligations in Regulatory Compliance Center`,
    kpis: ['CRAR %', 'PCR %', 'NPA ratio', 'LCR', 'PCA threshold breaches'],
    relatedTopics: ['credit_risk', 'npa', 'stress_testing', 'crar'],
    module: 'Regulatory Compliance Center',
    route: '/regulatory-compliance-center',
  },
];

// ─── Insurance Domain Topics ──────────────────────────────────────────────

const INSURANCE_TOPICS: DomainTopic[] = [
  {
    id: 'claims_management',
    title: 'Insurance Claims Management',
    domain: 'insurance',
    keywords: ['claims', 'claims management', 'claims processing', 'claims ratio', 'loss ratio', 'claims fraud', 'claims settlement', 'incurred but not reported', 'ibnr'],
    keywords_hi: ['दावे', 'बीमा दावे', 'क्लेम्स'],
    body: `**Claims Management** is the process of receiving, validating, assessing, and settling insurance claims.

**Claims Workflow:**
1. Intimation → Survey/Assessment → Investigation → Settlement/Rejection

**Key Claims Metrics:**
• **Claims Ratio (Loss Ratio)** = Claims Incurred ÷ Net Premiums Earned
  → Industry benchmark: Motor 75%, Health 85%, Life (death) < 5%
• **Combined Ratio** = Claims Ratio + Expense Ratio
  → > 100% = Underwriting loss
• **IBNR (Incurred But Not Reported)** = Provision for claims not yet filed
• **Claims Settlement Time** → IRDAI mandates settlement within 30 days

**Claims Fraud Indicators:**
• Multiple claims in short period
• Claim immediately after policy inception (< 3 months)
• Inflated repair bills from empanelled garage/hospital
• Claims from high-fraud pin codes
• Involvement of banned doctors/hospitals

**ZorEWS Claims Analytics:**
• Claims Anomaly module → AI-powered fraud detection
• Investigation Center → Fraud investigation workflow
• Digital Twin → Claims stress under catastrophe scenario`,
    body_hinglish: `**Claims Management** matlab insurance claim receive karna, validate karna, settle karna.

**Claims Ratio** = Claims ÷ Premium. 80% matlab ₹80 claim per ₹100 premium.

**Fraud indicators:** Policy ke turant baad claim, multiple claims, inflated bills.

**IRDAI mandate:** 30 din mein settlement. Fail karne par penalty.`,
    kpis: ['Claims ratio (%)', 'Settlement time (days)', 'Fraud detection rate', 'IBNR provision'],
    relatedTopics: ['claims_ratio', 'insurance_fraud', 'underwriting'],
    module: 'Claims Anomaly',
    route: '/insurance/claims-anomaly',
  },

  {
    id: 'underwriting_insurance',
    title: 'Insurance Underwriting',
    domain: 'insurance',
    keywords: ['underwriting', 'insurance underwriting', 'risk assessment', 'premium pricing', 'underwriting risk', 'proposal evaluation', 'anti selection', 'moral hazard'],
    keywords_hi: ['अंडरराइटिंग', 'बीमा अंडरराइटिंग'],
    body: `**Underwriting** is the process of evaluating, pricing, and accepting or rejecting an insurance risk.

**Underwriting Process:**
1. **Proposal Evaluation** — Review application, financials, health/property status
2. **Risk Classification** — Standard, Preferred, Substandard, Declined
3. **Premium Pricing** — Base rate + loading for additional risk factors
4. **Policy Issuance** — Terms, conditions, exclusions

**Life Insurance Underwriting Factors:**
• Age, gender, medical history, family history
• Occupation (hazardous → loading)
• Lifestyle (smoking → 50-100% extra premium)
• Sum assured vs income (MER — Mortality Experience Ratio)

**General Insurance Underwriting:**
• Motor: Vehicle age, make, driver profile, geography
• Property: Construction type, location, fire protection
• Health: Pre-existing conditions, BMI, age

**Anti-Selection Risk:**
High-risk people buy more insurance (information asymmetry). Combated with medical tests, claim history checks.

**ZorEWS Underwriting Intelligence:**
• AI-powered proposal scoring
• Fraud ring detection in proposers
• Channel-level underwriting quality monitoring`,
    kpis: ['Loss ratio by channel', 'Underwriting profit margin', 'Decline rate', 'Portfolio weighted risk score'],
    relatedTopics: ['claims_ratio', 'reinsurance', 'solvency'],
    module: 'Underwriting Intelligence',
    route: '/insurance/underwriting',
  },

  {
    id: 'solvency_insurance',
    title: 'Insurance Solvency Management',
    domain: 'insurance',
    keywords: ['solvency', 'solvency ratio', 'asm', 'rsm', 'available solvency margin', 'required solvency margin', 'capital adequacy', 'irdai solvency'],
    keywords_hi: ['सॉल्वेंसी', 'शोधन क्षमता', 'ASM', 'RSM'],
    body: `**Solvency** is an insurer's ability to meet all policyholder obligations, even under adverse claims scenarios.

**IRDAI Solvency Framework:**
• **ASM (Available Solvency Margin)** = Total assets - liabilities - contingency reserves
• **RSM (Required Solvency Margin)** = Max(50% of net premiums, net incurred claims) or as prescribed
• **Solvency Ratio = ASM ÷ RSM**
  → IRDAI minimum: 1.5x
  → Watch zone: 1.35x - 1.5x
  → Intervention zone: < 1.35x → IRDAI corrective action

**Solvency Risk Factors:**
• Sudden claims surge (catastrophe, pandemic)
• High lapse rate (surrender value liability)
• Asset value fall (equity market crash)
• Reinsurance failure
• ALM mismatch (long-term liabilities vs short-term assets)

**ZorEWS Solvency Monitoring:**
• Digital Twin → Solvency stress under IRDAI Form-K scenario
• Insurance Dashboard → Real-time ASM/RSM tracking
• Regulatory Compliance Center → IRDAI annual return preparation`,
    body_hinglish: `**Solvency** matlab insurer ki policyholders ko pay karne ki capability.

**Formula:** Solvency Ratio = ASM ÷ RSM
IRDAI minimum 1.5x chahiye. 1.35 se neeche gaya toh IRDAI action leti hai.

**Risks:** Sudden claims surge, high lapse, asset value fall, reinsurance failure.`,
    kpis: ['Solvency ratio', 'ASM amount', 'Claims reserve adequacy', 'ALM gap'],
    relatedTopics: ['reinsurance', 'persistency', 'irdai'],
    module: 'Insurance Dashboard',
    route: '/insurance/dashboard',
  },

  {
    id: 'persistency_insurance',
    title: 'Policy Persistency & Lapse Management',
    domain: 'insurance',
    keywords: ['persistency', 'lapse', 'lapse rate', 'renewal', 'policy lapse', 'renewal rate', '13th month persistency', '25th month', 'conservation', 'persistency management'],
    keywords_hi: ['दृढ़ता', 'व्यपगमन', 'पॉलिसी लैप्स'],
    body: `**Persistency** measures how many policies remain active (premium-paying) over time. Low persistency signals product issues, mis-selling, or financial stress.

**IRDAI Persistency Reporting:**
• 13th month: Target > 75%
• 25th month: Target > 65%
• 37th month: Target > 60%
• 49th month: Target > 55%
• 61st month: Target > 50%

**Lapse Causes:**
• Financial stress (customer can't afford premium)
• Mis-selling (product didn't match need)
• Poor after-sale service
• Competitive products (policy surrender)
• Death/disability of policyholder

**Early Lapse Indicators (ZorEWS):**
• First premium paid, subsequent not paid → Lapse candidate
• Policy sourced by specific agent with pattern of early lapses
• Customer profile mismatch with product (age, income, term)
• Bancassurance channel with high EMI burden on same customer

**Conservation Strategies:**
• Auto-debit setup at inception
• AI-powered churn prediction (30-60 days before lapse)
• Proactive outreach by assigned advisor
• Payment holiday (for genuine hardship cases)`,
    body_hinglish: `**Persistency** matlab kitne policies active reh rahi hain.

**IRDAI targets:** 13th month > 75%, 25th month > 65%.

**Lapse reasons:** Financial stress, mis-selling, poor service.

**ZorEWS Policy Lapse Risk module** se: AI predict karta hai kaun lapse karega 30-60 din pehle.`,
    kpis: ['13th month persistency %', '25th month persistency %', 'Lapse rate', 'Conservation rate'],
    relatedTopics: ['claims_ratio', 'channel_risk', 'irdai'],
    module: 'Policy Lapse Risk',
    route: '/insurance/policy-lapse',
  },

  {
    id: 'reinsurance',
    title: 'Reinsurance',
    domain: 'insurance',
    keywords: ['reinsurance', 'retrocession', 'cession', 'treaty', 'facultative', 'cat bond', 'quota share', 'excess of loss', 'stop loss'],
    keywords_hi: ['पुनर्बीमा'],
    body: `**Reinsurance** is insurance for insurance companies — the primary insurer (cedant) transfers a portion of risk to a reinsurer.

**Types:**
• **Treaty Reinsurance** — Automatic coverage for a class of policies (e.g., all motor >₹10L)
• **Facultative** — Policy-by-policy negotiation for large/unusual risks
• **Quota Share** — Fixed % of all premiums and claims shared (e.g., 30% ceded)
• **Excess of Loss (XL)** — Reinsurer covers losses above a threshold (e.g., above ₹50Cr)
• **Stop Loss** — Caps total claims ratio at a percentage

**Why Reinsurance Matters:**
• Protects against catastrophic losses (earthquake, flood, pandemic)
• Enables writing larger sum assured policies
• Stabilizes financial results
• Frees up capital (capital relief)

**Reinsurance Risk:**
• Reinsurer default (credit risk) → choose rated reinsurers
• Basis risk (XL not triggered despite losses)
• Model risk (catastrophe model underestimates loss)`,
    kpis: ['Cession ratio %', 'Net retention', 'Reinsurance recoverable', 'Cat model accuracy'],
    relatedTopics: ['solvency_insurance', 'underwriting_insurance'],
    module: 'Digital Twin Center',
    route: '/digital-twin-center',
  },

  {
    id: 'irdai_compliance',
    title: 'IRDAI Regulatory Compliance',
    domain: 'insurance',
    keywords: ['irdai', 'irdai compliance', 'irdai circular', 'irdai regulations', 'irdai return', 'form k', 'insurance regulator', 'irda'],
    keywords_hi: ['IRDAI', 'बीमा विनियामक'],
    body: `**IRDAI (Insurance Regulatory and Development Authority of India)** regulates all life and general insurers.

**Key IRDAI Requirements:**

**Solvency:** Maintain solvency ratio ≥ 1.5x at all times
**Investments:** Minimum 50% in government securities and AAA bonds
**Persistency:** 13th month, 25th month reporting mandatory
**Product filing:** File and Use (FU) or Use and File (UF) approval
**KYC/AML:** Customer due diligence mandatory for all policies > ₹1L annual premium

**Annual Returns:**
• Form L-1 through L-43 for life insurers
• Form NL-1 through NL-38 for general insurers
• **Form-K** (Life) — Solvency margin return (quarterly)
• Annual audited financial statements by June 30

**Penalties:**
• Breach of solvency → Corrective action plan, capital infusion
• Mis-selling proven → Policy cancellation + refund + penalty
• Late filing → ₹1L/day fine

**ZorEWS IRDAI features:**
• Regulatory Compliance Center → Filing calendar, readiness score
• Digital Twin → Solvency stress scenarios
• Board Reporting Center → IRDAI submission-ready reports`,
    kpis: ['Solvency ratio', 'Filing compliance %', 'Persistency at 13th month', 'Investment compliance %'],
    relatedTopics: ['solvency_insurance', 'persistency_insurance', 'claims_management'],
    module: 'Regulatory Compliance Center',
    route: '/regulatory-compliance-center',
  },

  {
    id: 'channel_risk_insurance',
    title: 'Channel Risk (Insurance)',
    domain: 'insurance',
    keywords: ['channel risk', 'distribution risk', 'agent risk', 'bancassurance', 'broker risk', 'mis selling', 'channel quality', 'agent productivity'],
    keywords_hi: ['चैनल जोखिम', 'वितरण जोखिम', 'एजेंट जोखिम'],
    body: `**Channel Risk** is the risk arising from the quality of insurance distribution — agents, bancassurance, brokers, and digital channels.

**Why Channel Risk Matters:**
• Poor quality sourcing → High lapse rate → Revenue erosion
• Mis-selling → Regulatory penalty + reputation damage
• Fraud agent networks → Fabricated proposals

**Channel Risk Indicators:**
• Agent's 13th month persistency < 65% (vs company avg 82%)
• Multiple proposals from same address/customer
• High claim frequency from one agent's portfolio
• Agent earning unusually high commission vs peers
• Renewal rate drop in agent's book

**IRDAI Action on Mis-selling:**
• Warning, suspension, cancellation of agent license
• Insurer fined ₹25L-₹1Cr for systemic mis-selling
• Customer compensation + policy cancellation

**ZorEWS Channel Management:**
• Agent Productivity module → per-agent risk scores, persistency
• Insurance Dashboard → Channel-wise claims ratio, lapse rate
• Investigation Center → Mis-selling investigation workflow`,
    body_hinglish: `**Channel Risk** matlab agent ya bancassurance se aa raha business ka quality risk.

**Indicators:** Low persistency (<65%), multiple claims same agent, fraud proposals.

**ZorEWS mein:** Agent Productivity module se har agent ka risk score dekho.`,
    kpis: ['Agent persistency %', 'Channel-wise claims ratio', 'Mis-selling complaints', 'Channel renewal rate'],
    relatedTopics: ['persistency_insurance', 'underwriting_insurance', 'irdai_compliance'],
    module: 'Agent Productivity',
    route: '/insurance/agent-productivity',
  },
];

// ─── Combined catalog ─────────────────────────────────────────────────────

export const DOMAIN_KNOWLEDGE: DomainTopic[] = [
  ...BANKING_TOPICS,
  ...INSURANCE_TOPICS,
];

// ─── Search helpers ───────────────────────────────────────────────────────

export function findDomainTopic(query: string): DomainTopic | undefined {
  const q = query.toLowerCase();
  return DOMAIN_KNOWLEDGE.find(t =>
    t.keywords.some(k => q.includes(k)) ||
    t.keywords_hi.some(k => query.includes(k)) ||
    t.title.toLowerCase().includes(q)
  );
}

export function searchDomainTopics(query: string): DomainTopic[] {
  const q = query.toLowerCase();
  return DOMAIN_KNOWLEDGE.filter(t =>
    t.keywords.some(k => q.includes(k)) ||
    t.keywords_hi.some(k => query.includes(k)) ||
    t.title.toLowerCase().includes(q) ||
    t.body.toLowerCase().includes(q)
  ).slice(0, 4);
}

// ─── Format domain response ───────────────────────────────────────────────

export function formatDomainResponse(topic: DomainTopic, lang: 'en' | 'hi' | 'hinglish'): CopilotResponse {
  const body = lang === 'hi' && topic.body_hi
    ? topic.body_hi
    : lang === 'hinglish' && topic.body_hinglish
    ? topic.body_hinglish
    : topic.body;

  const kpiStr = topic.kpis && topic.kpis.length > 0
    ? `\n\n**Key Metrics:** ${topic.kpis.join(' · ')}`
    : '';

  const suggestions = [
    `How does ${topic.title} workflow work?`,
    `Open ${topic.module}`,
    ...(topic.relatedTopics.slice(0, 2).map(r => `What is ${r.replace(/_/g, ' ')}?`)),
  ];

  return {
    reply: `${body}${kpiStr}`,
    suggestions,
    actions: [{ label: `Open ${topic.module}`, href: topic.route, icon: 'external-link' }],
  };
}
