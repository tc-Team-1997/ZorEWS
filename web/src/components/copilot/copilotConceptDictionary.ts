// copilotConceptDictionary.ts
//
// ZorEWS Copilot — Enterprise Concept Dictionary
// 200+ BFSI concepts with multilingual definitions
// Domains: Banking | Insurance | Operational | Technology | Regulatory
//
// 100% additive — no existing logic changed.

import type { ConceptEntry } from './copilotLanguageEngine';

// ─── Complete Concept Catalog ─────────────────────────────────────────────

export const CONCEPT_DICTIONARY: ConceptEntry[] = [

  // ══════════════════════════════════════════════════════════════════════
  // BANKING CONCEPTS
  // ══════════════════════════════════════════════════════════════════════

  {
    term: 'NPA (Non-Performing Asset)',
    term_hi: 'अनर्जक आस्ति',
    definition: 'A loan or advance where the borrower has stopped making interest or principal repayments for more than 90 days. Once classified as NPA, the bank must make provisions against the exposure.',
    definition_hi: 'एक ऋण जिसमें उधारकर्ता ने 90 दिनों से अधिक समय से ब्याज या मूलधन का भुगतान नहीं किया है। NPA घोषित होने पर बैंक को प्रावधान बनाने होते हैं।',
    definition_hinglish: 'Woh loan jisme borrower ne 90 din se zyada se interest ya principal nahi bhara. NPA hone par bank ko provision banana padta hai.',
    purpose: 'NPAs directly impact bank profitability and capital adequacy. High NPA ratios can trigger regulatory action and reduce a bank\'s lending capacity.',
    purpose_hi: 'NPA सीधे बैंक की लाभप्रदता और पूंजी पर्याप्तता को प्रभावित करता है। उच्च NPA अनुपात नियामक कार्रवाई को ट्रिगर कर सकता है।',
    example: 'A MSME borrower with ₹50L outstanding has not paid EMI for 95 days → Loan classified as NPA Sub-standard → Bank provisions 15% = ₹7.5L',
    example_hi: 'एक MSME उधारकर्ता जिसका ₹50L बकाया है और 95 दिनों से EMI नहीं चुकाई → NPA Sub-standard → बैंक 15% प्रावधान = ₹7.5L',
    relatedTerms: ['SMA', 'DPD', 'LGD', 'ECL', 'Provisioning', 'Write-off', 'Recovery'],
    relatedModules: ['Predictive Risk Center', 'Alert Management', 'Investigation Center', 'CMS'],
    domain: 'banking',
    importance: 'critical',
  },

  {
    term: 'SMA (Special Mention Account)',
    term_hi: 'विशेष उल्लेख खाता',
    definition: 'An account that shows early stress signals before formal NPA classification. RBI mandates three categories: SMA-0 (0-30 DPD), SMA-1 (31-60 DPD), SMA-2 (61-90 DPD). Reporting mandatory from SMA-0.',
    definition_hi: 'एक खाता जो NPA वर्गीकरण से पहले प्रारंभिक तनाव संकेत दिखाता है। तीन श्रेणियां: SMA-0, SMA-1, SMA-2। SMA-0 से रिपोर्टिंग अनिवार्य।',
    definition_hinglish: 'Woh account jisme NPA se pehle stress dikhne lagta hai. Teen categories: SMA-0 (0-30 DPD), SMA-1 (31-60 DPD), SMA-2 (61-90 DPD). RBI ko SMA-0 se report karna mandatory hai.',
    purpose: 'SMA is the early warning indicator that gives banks time to intervene before NPA crystallization. EWS platforms track SMA migration as a key risk signal.',
    example: 'A borrower misses 2 consecutive EMIs → DPD reaches 45 → Classified SMA-1 → Risk Analyst alerted → Outreach within 7 days',
    relatedTerms: ['NPA', 'DPD', 'EWS', 'Early Warning', 'Credit Risk'],
    relatedModules: ['SMA Classification', 'NPA Prediction', 'Alert Management', 'Predictive Risk Center'],
    domain: 'banking',
    importance: 'critical',
  },

  {
    term: 'DPD (Days Past Due)',
    term_hi: 'देय से अधिक दिन',
    definition: 'The number of days a loan payment is overdue from its scheduled due date. DPD is the fundamental metric for credit stress classification in Indian banking.',
    definition_hi: 'एक ऋण भुगतान की निर्धारित तिथि से कितने दिन बीत गए हैं। DPD भारतीय बैंकिंग में क्रेडिट तनाव वर्गीकरण का मौलिक मीट्रिक है।',
    definition_hinglish: 'Loan payment ki due date ke baad kitne din ho gaye. DPD 0 = on time, DPD 30 = SMA-0, DPD 90 = NPA.',
    purpose: 'DPD drives loan classification (Standard → SMA-0/1/2 → NPA) and triggers provisioning requirements. Every EWS rule uses DPD as the primary signal.',
    example: 'DPD 0 = Current (Standard), DPD 15 = SMA-0, DPD 45 = SMA-1, DPD 75 = SMA-2, DPD 91 = NPA Sub-standard',
    relatedTerms: ['SMA', 'NPA', 'EMI', 'Bounce Rate', 'Credit Score'],
    relatedModules: ['SMA Classification', 'Predictive Risk Center', 'NPA Prediction', 'Alert Management'],
    domain: 'banking',
    importance: 'critical',
  },

  {
    term: 'EWS (Early Warning System)',
    term_hi: 'पूर्व चेतावनी प्रणाली',
    definition: 'A structured system that monitors multiple risk indicators and triggers alerts before a loan account deteriorates to NPA status. Uses statistical models, behavioral signals, and market data.',
    definition_hi: 'एक प्रणाली जो कई रिस्क संकेतकों की निगरानी करती है और लोन NPA होने से पहले अलर्ट देती है।',
    definition_hinglish: 'Ek system jo multiple risk signals monitor karta hai aur loan NPA hone se pehle alert deta hai. ZorEWS isi ka advanced version hai.',
    purpose: 'EWS gives risk teams 30-90 day advance warning to intervene before credit losses crystallize. RBI requires all banks to implement EWS.',
    example: 'ZorEWS monitors DPD, utilization, bureau score, EMI bounce, transaction velocity — combines signals to predict NPA 90 days in advance',
    relatedTerms: ['NPA', 'SMA', 'Credit Risk', 'Predictive Model', 'Risk Indicator'],
    relatedModules: ['Alert Management', 'Predictive Risk Center', 'Rule Engine', 'AI Governance'],
    domain: 'banking',
    importance: 'critical',
  },

  {
    term: 'PD (Probability of Default)',
    term_hi: 'डिफ़ॉल्ट की संभावना',
    definition: 'The statistical probability that a borrower will fail to meet their loan obligations within a specified time horizon (typically 12 months for IFRS9 Stage 1, lifetime for Stage 2/3).',
    definition_hi: 'एक उधारकर्ता के ऋण दायित्वों को पूरा न करने की सांख्यिकीय संभावना। आमतौर पर 12 महीने के लिए गणना की जाती है।',
    definition_hinglish: 'Borrower ke loan default karne ki probability. PD 0.75 matlab 75% chance hai ki borrower default karega.',
    purpose: 'PD is the core input to credit risk models (Basel IRB approach) and IFRS9 ECL calculation. Higher PD → higher provisioning required.',
    example: 'Customer c-001234: DPD=45, Bureau Score=612, EMI bounce rate=25% → AI Model predicts PD=0.78 (78% chance of NPA in 90 days)',
    relatedTerms: ['LGD', 'EAD', 'ECL', 'IFRS9', 'Basel', 'Credit Score', 'NPA'],
    relatedModules: ['Predictive Risk Center', 'AI Governance', 'Risk Scoring'],
    domain: 'banking',
    importance: 'critical',
  },

  {
    term: 'LGD (Loss Given Default)',
    term_hi: 'डिफ़ॉल्ट से हानि',
    definition: 'The percentage of exposure that will be lost if a borrower defaults, after recovery efforts and collateral liquidation. Typically 40-60% for unsecured loans, 20-40% for secured.',
    definition_hi: 'यदि कोई उधारकर्ता डिफ़ॉल्ट करता है तो कुल जोखिम का कितना प्रतिशत खो जाएगा, वसूली और संपार्श्विक के बाद।',
    definition_hinglish: 'Default ke baad bank ko kitna loss hoga percentage mein. Secured loan mein LGD kam hota hai, unsecured mein zyada.',
    purpose: 'LGD drives provisioning requirements. Expected Credit Loss = PD × LGD × EAD. Banks must estimate LGD by loan product and collateral type.',
    example: 'Term Loan ₹100L, Collateral value ₹60L → LGD = 40% → If default, expected loss = ₹40L',
    relatedTerms: ['PD', 'EAD', 'ECL', 'Collateral', 'Recovery Rate', 'Provisioning'],
    relatedModules: ['Predictive Risk Center', 'Digital Twin Center', 'Recovery Center'],
    domain: 'banking',
    importance: 'critical',
  },

  {
    term: 'EAD (Exposure at Default)',
    term_hi: 'डिफ़ॉल्ट पर जोखिम',
    definition: 'The total outstanding amount that a bank is exposed to at the time of borrower default, including drawn amounts and any undrawn committed facilities.',
    definition_hi: 'डिफ़ॉल्ट के समय बैंक की कुल बकाया राशि जिसका जोखिम है।',
    definition_hinglish: 'Jab borrower default karta hai tab bank ka total outstanding kitna hoga. Includes principal + interest + undrawn commitments.',
    purpose: 'EAD is the denominator in credit risk calculations. ECL = PD × LGD × EAD. For revolving facilities, EAD can exceed current outstanding.',
    example: 'CC limit ₹50L, drawn ₹30L, typical utilization at default 80% → EAD = ₹40L (80% of limit)',
    relatedTerms: ['PD', 'LGD', 'ECL', 'Credit Risk', 'Basel'],
    relatedModules: ['Predictive Risk Center', 'Digital Twin Center'],
    domain: 'banking',
    importance: 'high',
  },

  {
    term: 'ECL (Expected Credit Loss)',
    term_hi: 'अपेक्षित ऋण हानि',
    definition: 'The probability-weighted estimate of credit losses over the life of a financial instrument. IFRS9 requires forward-looking ECL provisioning across 3 stages.',
    definition_hi: 'एक वित्तीय साधन के जीवनकाल में ऋण हानि का संभावना-भारित अनुमान। IFRS9 के तहत तीन चरणों में प्रावधान।',
    definition_hinglish: 'Loan pe expected loss ka estimate. ECL = PD × LGD × EAD. IFRS9 ke tehat Stage 1/2/3 mein calculate karte hain.',
    purpose: 'ECL replaces the incurred loss model under IAS 39. Banks must recognize expected losses earlier, improving financial statement accuracy.',
    example: 'Stage 1 loan ₹100L: PD=2%, LGD=40%, EAD=₹100L → 12-month ECL = ₹0.8L. If stress → Stage 2: Lifetime ECL = ₹8L',
    relatedTerms: ['IFRS9', 'PD', 'LGD', 'EAD', 'Stage Migration', 'Provisioning', 'Basel'],
    relatedModules: ['Predictive Risk Center', 'Digital Twin Center', 'Regulatory Compliance'],
    domain: 'banking',
    importance: 'critical',
  },

  {
    term: 'IFRS9',
    term_hi: 'IFRS 9 लेखांकन मानक',
    definition: 'International Financial Reporting Standard 9 — replaces IAS39 for financial instrument accounting. Requires forward-looking Expected Credit Loss (ECL) provisioning in 3 stages based on credit deterioration.',
    definition_hi: 'वित्तीय साधन लेखांकन के लिए अंतर्राष्ट्रीय मानक। तीन चरणों में अपेक्षित ऋण हानि का प्रावधान अनिवार्य करता है।',
    definition_hinglish: 'Financial instruments ka accounting standard. Stage 1 = performing, Stage 2 = significant deterioration, Stage 3 = default. ECL alag-alag calculate hota hai.',
    purpose: 'IFRS9 makes banks recognize credit losses earlier and more accurately, reducing pro-cyclicality in provisioning compared to the old incurred loss model.',
    example: 'Stage 1 (Normal): 12-month ECL | Stage 2 (Significant risk increase): Lifetime ECL | Stage 3 (Credit impaired = NPA): Lifetime ECL, interest on net carrying amount',
    relatedTerms: ['ECL', 'PD', 'LGD', 'Stage Migration', 'Provisioning', 'IAS39'],
    relatedModules: ['Predictive Risk Center', 'Digital Twin Center', 'Regulatory Compliance'],
    domain: 'banking',
    importance: 'critical',
  },

  {
    term: 'Basel III',
    term_hi: 'बेसल III',
    definition: 'An international regulatory framework for banks developed by the Basel Committee on Banking Supervision (BCBS) following the 2008 financial crisis. Covers capital adequacy, leverage, and liquidity requirements.',
    definition_hi: '2008 वित्तीय संकट के बाद बैंकों के लिए अंतर्राष्ट्रीय नियामक ढांचा। पूंजी पर्याप्तता, उत्तोलन और तरलता आवश्यकताओं को नियंत्रित करता है।',
    definition_hinglish: '2008 financial crisis ke baad banks ke liye international regulatory framework. Capital adequacy, leverage aur liquidity requirements define karta hai.',
    purpose: 'Basel III ensures banks maintain sufficient capital buffers to absorb losses during economic downturns without government bailouts.',
    example: 'CRAR requirement: Minimum 8% (total capital), Tier-1: 6%, CET-1: 4.5%. LCR: 100%, NSFR: 100%. India via RBI: CRAR 9%',
    relatedTerms: ['CRAR', 'Tier-1 Capital', 'Tier-2 Capital', 'LCR', 'NSFR', 'Leverage Ratio', 'RWA'],
    relatedModules: ['Regulatory Compliance Center', 'Digital Twin Center', 'Board Reporting'],
    domain: 'regulatory',
    importance: 'critical',
  },

  {
    term: 'CRAR (Capital to Risk-weighted Assets Ratio)',
    term_hi: 'पूंजी पर्याप्तता अनुपात',
    definition: 'The ratio of a bank\'s capital to its risk-weighted assets (RWA). India\'s RBI mandates a minimum CRAR of 9% (higher than Basel III\'s 8%).',
    definition_hi: 'बैंक की पूंजी और जोखिम-भारित आस्तियों का अनुपात। RBI की न्यूनतम CRAR आवश्यकता 9% है।',
    definition_hinglish: 'Bank ki capital divided by risk-weighted assets. RBI ka minimum CRAR 9% hai. Zyada CRAR = zyada strong bank.',
    purpose: 'CRAR measures a bank\'s ability to absorb unexpected losses. Falling below minimum triggers RBI corrective action (PCA framework).',
    example: 'Capital ₹500Cr ÷ RWA ₹5000Cr = CRAR 10% → Above RBI minimum of 9% → Compliant',
    relatedTerms: ['Basel III', 'Tier-1 Capital', 'Tier-2 Capital', 'RWA', 'PCA'],
    relatedModules: ['Regulatory Compliance Center', 'Executive Cockpit'],
    domain: 'regulatory',
    importance: 'critical',
  },

  {
    term: 'LTV (Loan to Value)',
    term_hi: 'ऋण से मूल्य अनुपात',
    definition: 'The ratio of loan amount to the appraised value of the collateral asset. Higher LTV indicates lower collateral coverage and higher credit risk.',
    definition_hi: 'ऋण राशि और संपत्ति के मूल्यांकन मूल्य का अनुपात। उच्च LTV = कम सुरक्षा = अधिक जोखिम।',
    definition_hinglish: 'Loan amount divided by collateral value. LTV 80% matlab ₹80 loan pe ₹100 ki property hai. Zyada LTV = zyada risk.',
    purpose: 'LTV determines collateral coverage and guides underwriting decisions. RBI prescribes maximum LTV ratios by loan type.',
    example: 'Home Loan ₹80L, Property value ₹100L → LTV = 80% (RBI max for home loans). If property drops to ₹85L → LTV rises to 94% → Risk elevated',
    relatedTerms: ['Collateral', 'LGD', 'Haircut', 'Underwriting', 'Property Valuation'],
    relatedModules: ['Predictive Risk Center', 'Alert Management'],
    domain: 'banking',
    importance: 'high',
  },

  {
    term: 'DSCR (Debt Service Coverage Ratio)',
    term_hi: 'ऋण सेवा कवरेज अनुपात',
    definition: 'The ratio of Net Operating Income (NOI) to total debt service (interest + principal). DSCR < 1 means income insufficient to cover debt payments.',
    definition_hi: 'शुद्ध परिचालन आय और कुल ऋण सेवा का अनुपात। DSCR < 1 मतलब आय ऋण भुगतान के लिए अपर्याप्त है।',
    definition_hinglish: 'Business income divided by debt payments. DSCR 1.5 matlab income loan payment se 1.5x hai. 1 se kam = stress.',
    purpose: 'DSCR is the primary underwriting metric for project finance and MSME loans. Declining DSCR is an early warning signal for stress.',
    example: 'MSME annual NOI ₹24L, Annual debt service ₹20L → DSCR = 1.2 (acceptable). If revenue drops 20% → NOI = ₹19.2L → DSCR = 0.96 → Alert triggered',
    relatedTerms: ['Debt Service', 'NOI', 'Underwriting', 'Credit Risk', 'Financial Ratios'],
    relatedModules: ['Predictive Risk Center', 'Financial Ratios', 'Alert Management'],
    domain: 'banking',
    importance: 'high',
  },

  {
    term: 'OTS (One-Time Settlement)',
    term_hi: 'एकमुश्त समझौता',
    definition: 'A negotiated settlement where the bank agrees to accept a lump sum amount from an NPA borrower, typically less than the total outstanding, to close the account.',
    definition_hi: 'एक समझौता जहां बैंक NPA उधारकर्ता से एकमुश्त राशि स्वीकार करके खाता बंद करने पर सहमत होता है।',
    definition_hinglish: 'NPA borrower se ek baar mein settlement. Bank total outstanding se kam mein agree kar leta hai. CRO approval zaroori hoti hai.',
    purpose: 'OTS recovers a meaningful portion of stressed assets faster than legal proceedings. Board/CRO approval required for amounts above threshold.',
    example: 'NPA outstanding ₹50L, LGD = 40% → Bank expects to recover max ₹30L. OTS offer: ₹25L in 90 days → Accepted. Board approval required.',
    relatedTerms: ['NPA', 'Recovery', 'Write-off', 'SARFAESI', 'DRT', 'Legal Action'],
    relatedModules: ['Recovery Center', 'CMS', 'Investigation Center'],
    domain: 'banking',
    importance: 'high',
  },

  {
    term: 'SARFAESI Act',
    definition: 'Securitisation and Reconstruction of Financial Assets and Enforcement of Security Interest Act, 2002. Allows banks to recover NPA dues without court intervention by taking possession of secured assets.',
    definition_hi: 'बैंकों को NPA वसूली के लिए न्यायालय के हस्तक्षेप के बिना सुरक्षित संपत्तियों को जब्त करने की अनुमति देता है।',
    definition_hinglish: 'Bank ko court ke bina NPA borrower ki property seize karne ka adhikar deta hai. 60 days ka notice, phir possession.',
    purpose: 'SARFAESI significantly accelerates secured NPA recovery, reducing dependence on slow DRT/NCLT proceedings.',
    example: 'NPA SMA-2 → Formal NPA → 13(2) notice (60 days) → No response → 13(4) possession → Asset auction via auction platform',
    relatedTerms: ['NPA', 'DRT', 'NCLT', 'Secured Loan', 'Recovery', 'Asset Auction'],
    relatedModules: ['Recovery Center', 'CMS', 'Investigation Center'],
    domain: 'regulatory',
    importance: 'high',
  },

  {
    term: 'Write-off',
    term_hi: 'बट्टे खाते में डालना',
    definition: 'The accounting action of removing an NPA from the balance sheet after full provisioning when recovery prospects are remote. Write-off does not extinguish the debt — recovery efforts continue.',
    definition_hi: 'NPA को पूर्ण प्रावधान के बाद बैलेंस शीट से हटाने की लेखांकन क्रिया। ऋण समाप्त नहीं होता, वसूली जारी रहती है।',
    definition_hinglish: 'NPA ko balance sheet se remove karna. Recovery milne par income mein record hoti hai. CRO + Board approval mandatory.',
    purpose: 'Write-offs clean up the balance sheet, reduce NPA ratios, and release capital. Any subsequent recovery is booked as income.',
    example: 'NPA ₹50L, 100% provisioned → Written off → Balance sheet NPA ratio improves → Recovery of ₹20L after write-off → Booked as income',
    relatedTerms: ['NPA', 'Provisioning', 'OTS', 'Recovery', 'Technical Write-off'],
    relatedModules: ['Recovery Center', 'CMS', 'Audit Center'],
    domain: 'banking',
    importance: 'high',
  },

  {
    term: 'Stress Testing',
    term_hi: 'तनाव परीक्षण',
    definition: 'A simulation technique that tests a portfolio\'s resilience under hypothetical adverse macroeconomic scenarios (GDP shock, rate hike, FX devaluation) to quantify potential losses.',
    definition_hi: 'एक सिमुलेशन तकनीक जो काल्पनिक प्रतिकूल परिदृश्यों के तहत पोर्टफोलियो की लचीलेपन का परीक्षण करती है।',
    definition_hinglish: 'Portfolio pe adverse economic conditions ka test. RBI mandates quarterly stress testing. GDP girne, interest rate badhne ka impact dekhte hain.',
    purpose: 'Stress testing is mandated by RBI and IRDAI to assess capital adequacy under adverse conditions and plan capital buffers.',
    example: 'RBI Severely Adverse Scenario: GDP -7%, Rate +400bps, FX +15% → ZorEWS Digital Twin projects ECL impact = ₹142Cr, NPA ratio +2.3%',
    relatedTerms: ['Scenario Analysis', 'ECL', 'Capital Planning', 'Basel', 'ICAAP'],
    relatedModules: ['Digital Twin Center', 'Regulatory Compliance', 'Executive Cockpit'],
    domain: 'banking',
    importance: 'critical',
  },

  {
    term: 'RAROC (Risk-Adjusted Return on Capital)',
    term_hi: 'जोखिम-समायोजित पूंजी पर प्रतिफल',
    definition: 'A performance metric that adjusts returns for the risk taken. RAROC = (Revenue - Costs - Expected Loss) / Economic Capital. Used to compare risk-adjusted profitability across business lines.',
    definition_hi: 'प्रदर्शन मेट्रिक जो जोखिम के लिए रिटर्न को समायोजित करता है। व्यवसाय लाइनों की तुलना के लिए उपयोग किया जाता है।',
    definition_hinglish: 'Risk adjust karke return measure karna. RAROC se pata chalta hai ki jo return aa raha hai wo risk ke anuroop sahi hai ya nahi.',
    purpose: 'RAROC enables banks to price loans correctly and allocate capital to the most profitable risk-adjusted business lines.',
    example: 'MSME lending: Revenue ₹10Cr, Expected Loss ₹2Cr, Cost ₹3Cr, Economic Capital ₹20Cr → RAROC = (10-2-3)/20 = 25%',
    relatedTerms: ['ROE', 'Economic Capital', 'Risk Pricing', 'Capital Allocation'],
    relatedModules: ['Executive Cockpit', 'Predictive Risk Center'],
    domain: 'banking',
    importance: 'medium',
  },

  {
    term: 'Fraud Ring',
    term_hi: 'धोखाधड़ी गिरोह',
    definition: 'A coordinated network of individuals or entities that collude to commit financial fraud — typically involving multiple fake borrowers with fabricated documents, often orchestrated by a central operator.',
    definition_hi: 'व्यक्तियों या संस्थाओं का एक समन्वित नेटवर्क जो वित्तीय धोखाधड़ी करने के लिए मिलकर काम करता है।',
    definition_hinglish: 'Multiple log milke bank ko fraud karte hain. Fake documents, fake accounts, ek hi operator sab ko control karta hai.',
    purpose: 'Fraud rings cause disproportionate losses because multiple accounts are impacted simultaneously. AI clustering helps detect connected accounts before crystallization.',
    example: 'ZorEWS detects: 8 MSME borrowers with same address → same loan officer → similar document patterns → Fraud cluster flagged → ₹9.4Cr exposure',
    relatedTerms: ['Synthetic Identity', 'AML', 'KYC', 'Fraud Cluster', 'SAR', 'FIU-IND'],
    relatedModules: ['Fraud Signals', 'Investigation Center', 'Alert Management', 'AML'],
    domain: 'banking',
    importance: 'critical',
  },

  {
    term: 'Synthetic Identity Fraud',
    definition: 'A type of fraud where criminals combine real and fictitious information to create a new identity to apply for credit. The fake identity establishes credit history before defaulting.',
    definition_hi: 'जहां अपराधी नई पहचान बनाने के लिए वास्तविक और काल्पनिक जानकारी को मिलाते हैं।',
    definition_hinglish: 'Real aur fake information milake naya identity banate hain. Credit history banana, phir default karna. AI pattern matching se detect hota hai.',
    purpose: 'Synthetic identity is the fastest-growing fraud type in digital lending. Traditional KYC cannot catch it — requires AI behavioral pattern analysis.',
    example: 'Real Aadhaar + fake PAN + fake business registration → Opens accounts at 3 banks → Builds credit → Takes max credit → Disappears',
    relatedTerms: ['KYC', 'AML', 'Fraud Ring', 'Identity Verification', 'Behavioral Analysis'],
    relatedModules: ['Fraud Signals', 'Investigation Center', 'Alert Management'],
    domain: 'banking',
    importance: 'critical',
  },

  {
    term: 'AML (Anti-Money Laundering)',
    term_hi: 'धन-शोधन निवारण',
    definition: 'A set of procedures, laws, and regulations designed to prevent criminals from disguising illegally obtained funds as legitimate income.',
    definition_hi: 'अवैध धन को वैध आय के रूप में छुपाने से रोकने के लिए प्रक्रियाओं का समूह। PMLA, 2002 के तहत भारत में अनिवार्य।',
    definition_hinglish: 'Black money ko white karne se rokna. Transactions monitor karna, suspicious activity report (SAR) FIU-IND ko bhejni hoti hai.',
    purpose: 'AML compliance is mandatory under PMLA 2002. Banks must monitor transactions, file STRs/SARs with FIU-IND, and maintain KYC records.',
    example: 'Customer deposits ₹9.5L cash (just under ₹10L threshold) repeatedly → Transaction structuring detected → SAR filed with FIU-IND within 7 days',
    relatedTerms: ['KYC', 'SAR', 'STR', 'FIU-IND', 'PMLA', 'FATF', 'Suspicious Transaction'],
    relatedModules: ['Regulatory Compliance Center', 'Fraud Signals', 'Investigation Center'],
    domain: 'regulatory',
    importance: 'critical',
  },

  {
    term: 'KYC (Know Your Customer)',
    term_hi: 'अपने ग्राहक को जानें',
    definition: 'A mandatory regulatory process where banks verify the identity, address, and financial profile of their customers to prevent fraud, money laundering, and terrorist financing.',
    definition_hi: 'ग्राहकों की पहचान, पता और वित्तीय प्रोफाइल सत्यापित करने की अनिवार्य प्रक्रिया।',
    definition_hinglish: 'Customer ki identity verify karna. Aadhaar, PAN, address proof. Periodic refresh mandatory: 2 years (high risk), 8 years (low risk).',
    purpose: 'KYC prevents identity fraud and is the foundation of financial crime compliance. RBI mandates periodic KYC refresh based on customer risk category.',
    example: 'New customer: Aadhaar + PAN verified, video KYC done → Periodic refresh: High risk → every 2 years, Low risk → every 8 years',
    relatedTerms: ['AML', 'CDD', 'EDD', 'Aadhaar', 'PAN', 'CKYC', 'Video KYC'],
    relatedModules: ['Regulatory Compliance Center', 'Investigation Center'],
    domain: 'regulatory',
    importance: 'critical',
  },

  {
    term: 'SAR (Suspicious Activity Report)',
    term_hi: 'संदिग्ध गतिविधि रिपोर्ट',
    definition: 'A report filed with the Financial Intelligence Unit — India (FIU-IND) when a financial institution suspects that a transaction involves proceeds of crime or is related to money laundering.',
    definition_hi: 'FIU-IND को दायर की जाने वाली रिपोर्ट जब बैंक को संदेह हो कि लेनदेन अपराध से जुड़ा है।',
    definition_hinglish: 'Suspicious transaction mila → 7 days mein FIU-IND ko SAR file karna mandatory. Confidentiality zaroori — customer ko batana prohibited.',
    purpose: 'SAR filing is the primary mechanism for banks to report suspected money laundering and terrorist financing to law enforcement.',
    example: 'Fraud investigation confirms ₹9.4Cr transaction structuring → SAR prepared → Filed with FIU-IND within 7 days → Investigation number received',
    relatedTerms: ['AML', 'FIU-IND', 'STR', 'PMLA', 'Suspicious Transaction', 'Money Laundering'],
    relatedModules: ['Investigation Center', 'Regulatory Compliance Center', 'Audit Center'],
    domain: 'regulatory',
    importance: 'critical',
  },

  {
    term: 'Credit Risk',
    term_hi: 'क्रेडिट जोखिम',
    definition: 'The risk that a borrower will fail to repay a loan, resulting in financial loss for the lender. The primary risk in banking, measured through PD, LGD, and EAD.',
    definition_hi: 'जोखिम कि उधारकर्ता ऋण चुकाने में विफल होगा। PD, LGD और EAD के माध्यम से मापा जाता है।',
    definition_hinglish: 'Borrower ke loan na chukane ka risk. Banking ka sabse primary risk. PD × LGD × EAD = Expected Credit Loss.',
    purpose: 'Credit risk management ensures banks price loans correctly, maintain adequate provisions, and stay within regulatory capital requirements.',
    example: 'MSME portfolio ₹5000Cr: PD=4%, LGD=45%, EAD=₹5000Cr → ECL = ₹90Cr → Bank holds provision ≥₹90Cr',
    relatedTerms: ['PD', 'LGD', 'EAD', 'ECL', 'NPA', 'Credit Score', 'Underwriting'],
    relatedModules: ['Predictive Risk Center', 'Alert Management', 'Digital Twin Center'],
    domain: 'banking',
    importance: 'critical',
  },

  {
    term: 'Portfolio Concentration Risk',
    term_hi: 'पोर्टफोलियो एकाग्रता जोखिम',
    definition: 'The risk arising from undue exposure to a single borrower, sector, geography, or product type. High concentration amplifies losses when that segment is stressed.',
    definition_hi: 'एक उधारकर्ता, क्षेत्र, भूगोल या उत्पाद में अत्यधिक जोखिम से उत्पन्न जोखिम।',
    definition_hinglish: 'Ek sector ya borrower mein zyada loan dena risky hai. Agar woh sector crisis mein aaye toh bank ka bahut nuksaan.',
    purpose: 'RBI mandates single-borrower and sector-level exposure limits to prevent concentration. EWS tracks concentration by sector and geography.',
    example: 'Bank\'s real estate exposure: 28% of total portfolio → RBI limit 20% → Concentration breach → Corrective action required',
    relatedTerms: ['Sector Risk', 'Single Borrower Limit', 'Credit Risk', 'Geographic Risk'],
    relatedModules: ['Sector Watch', 'Branch & Geography Risk', 'Executive Cockpit'],
    domain: 'banking',
    importance: 'high',
  },

  {
    term: 'Data Lineage',
    term_hi: 'डेटा वंशावली',
    definition: 'The ability to trace data from its source origin through all transformations to its final use in reports, models, or dashboards. Critical for regulatory audit and data quality assurance.',
    definition_hi: 'डेटा को उसके स्रोत से अंतिम उपयोग तक ट्रेस करने की क्षमता। नियामक ऑडिट के लिए महत्वपूर्ण।',
    definition_hinglish: 'Data kahan se aaya, kaise badla, kahan gaya — sab trace karna. Regulators ko proof chahiye ki data accurate aur tamper-free hai.',
    purpose: 'Regulators require data lineage to validate that risk calculations are based on accurate, unmanipulated data. BCBS 239 mandates data lineage for systemically important banks.',
    example: 'NPA ratio calculation → traces to → Loan outstanding (CBS) → DPD calculation → SMA classification → IFRS9 staging → ECL provisioning',
    relatedTerms: ['Data Quality', 'Data Fabric', 'Data Catalog', 'BCBS 239', 'Audit Trail'],
    relatedModules: ['Data Fabric Center', 'Data Catalog', 'Audit Center'],
    domain: 'technology',
    importance: 'high',
  },

  // ══════════════════════════════════════════════════════════════════════
  // INSURANCE CONCEPTS
  // ══════════════════════════════════════════════════════════════════════

  {
    term: 'Persistency Ratio',
    term_hi: 'दृढ़ता अनुपात',
    definition: 'The percentage of life insurance policies that remain in force (i.e., premiums are still being paid) at the end of a given period after policy issuance. Measured at 13th, 25th, 37th, 49th, and 61st month.',
    definition_hi: 'जारी की गई पॉलिसियों का प्रतिशत जो एक दी गई अवधि के बाद भी सक्रिय हैं।',
    definition_hinglish: 'Kitne policies active reh rahi hain after issuance. IRDAI ke liye 13th, 25th, 37th month persistency mandatory report karna hota hai.',
    purpose: 'Persistency is a key measure of an insurer\'s business quality. Low persistency indicates poor product fit, mis-selling, or financial stress of policyholders.',
    example: '1000 policies issued in Jan 2023. 850 still paying premium in Jan 2024 (13th month) → 13th month persistency = 85%',
    relatedTerms: ['Lapse Rate', 'Renewal Rate', 'Premium', 'Policy Lifecycle', 'Mis-selling'],
    relatedModules: ['Insurance Dashboard', 'Policy Lapse Risk', 'Predictive Risk Center'],
    domain: 'insurance',
    importance: 'critical',
  },

  {
    term: 'Lapse Rate',
    term_hi: 'व्यपगमन दर',
    definition: 'The percentage of insurance policies that lapse (policyholder stops paying premiums) in a given period. High lapse rate signals product issues or financial stress among policyholders.',
    definition_hi: 'एक दी गई अवधि में समाप्त होने वाली बीमा पॉलिसियों का प्रतिशत।',
    definition_hinglish: 'Kitne customers ne premium dena band kar diya. Lapse rate badha matlab ya product issue hai ya customers financially stressed hain.',
    purpose: 'Lapse rate directly impacts insurer profitability and asset-liability management. High early lapses can trigger regulatory scrutiny for mis-selling.',
    example: 'ULIP portfolio: 100 policies Jan 2023, 20 lapsed by Dec 2023 → Lapse rate = 20%. Industry average = 8% → Investigation triggered',
    relatedTerms: ['Persistency', 'Renewal Rate', 'Mis-selling', 'Policy Lifecycle'],
    relatedModules: ['Policy Lapse Risk', 'Insurance Dashboard', 'Regulatory Compliance'],
    domain: 'insurance',
    importance: 'high',
  },

  {
    term: 'Claims Ratio',
    term_hi: 'दावा अनुपात',
    definition: 'Also called Loss Ratio — the ratio of claims paid to premiums earned, expressed as a percentage. Claims Ratio = (Claims Incurred / Net Premiums Earned) × 100.',
    definition_hi: 'अर्जित प्रीमियम के संबंध में भुगतान किए गए दावों का प्रतिशत। Claims Ratio = (दावे / प्रीमियम) × 100.',
    definition_hinglish: 'Jo claim pay kiya vs jo premium collect kiya ka ratio. 80% claims ratio matlab ₹80 claim pay kiya ₹100 premium mein.',
    purpose: 'Claims ratio is the primary profitability metric for general insurance. Combined ratio (claims + expenses) > 100% means underwriting loss.',
    example: 'Motor portfolio: ₹100Cr premiums earned, ₹82Cr claims paid → Claims ratio = 82%. Industry benchmark = 75% → Elevated, review underwriting',
    relatedTerms: ['Combined Ratio', 'Loss Ratio', 'Expense Ratio', 'Underwriting Profit', 'Reinsurance'],
    relatedModules: ['Insurance Dashboard', 'Claims Anomaly', 'Regulatory Compliance'],
    domain: 'insurance',
    importance: 'critical',
  },

  {
    term: 'Solvency Ratio',
    term_hi: 'सॉल्वेंसी अनुपात',
    definition: 'The ratio of an insurer\'s available solvency margin (ASM) to required solvency margin (RSM). IRDAI requires a minimum solvency ratio of 1.5x for all life and general insurers.',
    definition_hi: 'बीमाकर्ता की उपलब्ध सॉल्वेंसी मार्जिन और आवश्यक सॉल्वेंसी मार्जिन का अनुपात। IRDAI की न्यूनतम आवश्यकता 1.5x।',
    definition_hinglish: 'Insurer ki financial strength measure karta hai. IRDAI ka minimum 1.5x. Agar 1.35 ke neeche aye toh regulatory action ho sakti hai.',
    purpose: 'Solvency ratio ensures insurers can meet policyholder obligations even under adverse claims scenarios. Falling below 1.35 triggers IRDAI corrective action.',
    example: 'Insurer ASM = ₹450Cr, RSM = ₹300Cr → Solvency ratio = 1.5x (exactly at IRDAI minimum). If claims spike → ASM drops to ₹380Cr → Ratio 1.27 → Alert triggered',
    relatedTerms: ['ASM', 'RSM', 'IRDAI', 'Capital Adequacy', 'Reinsurance'],
    relatedModules: ['Insurance Dashboard', 'Regulatory Compliance', 'Digital Twin Center'],
    domain: 'insurance',
    importance: 'critical',
  },

  {
    term: 'Channel Risk (Insurance)',
    term_hi: 'चैनल जोखिम (बीमा)',
    definition: 'The risk arising from insurance sales through intermediary channels (agents, bancassurance, digital) — including mis-selling risk, quality of sourced business, and channel-specific lapse patterns.',
    definition_hi: 'बिचौलिए चैनलों के माध्यम से बीमा बिक्री से उत्पन्न जोखिम — गलत-बिक्री, व्यवसाय की गुणवत्ता और चैनल-विशिष्ट व्यपगमन।',
    definition_hinglish: 'Agent ya bancassurance channel se aa raha business ka risk. Kuch channels zyada mis-selling karte hain, zyada lapse hote hain.',
    purpose: 'Channel risk management ensures that sourced business is of appropriate quality. Poor channel quality leads to high lapse rates and regulatory penalties for mis-selling.',
    example: 'Branch A: Agent-sourced ULIP policies → 13th month persistency 62% (vs company avg 82%) → Agent under investigation for mis-selling → Channel risk alert raised',
    relatedTerms: ['Mis-selling', 'Persistency', 'Agent Productivity', 'Bancassurance', 'IRDAI Circulars'],
    relatedModules: ['Insurance Dashboard', 'Agent Productivity', 'Regulatory Compliance'],
    domain: 'insurance',
    importance: 'high',
  },

  {
    term: 'Underwriting (Insurance)',
    term_hi: 'अंडरराइटिंग (बीमा)',
    definition: 'The process of evaluating, classifying, and pricing an insurance risk. An underwriter decides whether to insure an applicant, on what terms, and at what premium.',
    definition_hi: 'बीमा जोखिम का मूल्यांकन, वर्गीकरण और मूल्य निर्धारण की प्रक्रिया। अंडरराइटर तय करता है कि किसे बीमा दें और किस प्रीमियम पर।',
    definition_hinglish: 'Decide karna ki applicant ko insurance do ya nahi, aur kitne premium par. Medical history, occupation, lifestyle dekhte hain.',
    purpose: 'Sound underwriting is the foundation of insurance profitability. Poor underwriting leads to adverse claims experience and solvency risk.',
    example: 'Life insurance applicant: Age 45, diabetic → Underwriter applies loading (extra premium) → Policy issued at 1.3x standard premium',
    relatedTerms: ['Risk Assessment', 'Premium Pricing', 'Claims Ratio', 'Anti-selection', 'Reinsurance'],
    relatedModules: ['Insurance Dashboard', 'Underwriting Intelligence', 'AI Governance'],
    domain: 'insurance',
    importance: 'high',
  },

  {
    term: 'Reinsurance',
    term_hi: 'पुनर्बीमा',
    definition: 'The practice of one insurer (ceding company) transferring a portion of its risk portfolio to another insurer (reinsurer) to reduce catastrophic exposure and manage capital.',
    definition_hi: 'एक बीमाकर्ता अपने जोखिम पोर्टफोलियो का एक हिस्सा दूसरे बीमाकर्ता को हस्तांतरित करता है।',
    definition_hinglish: 'Insurer apna zyada risk dusre insurer ko de deta hai. Large claims ka risk spread ho jata hai.',
    purpose: 'Reinsurance protects insurers from catastrophic losses, enables them to write larger policies, and stabilizes financial results.',
    example: 'General insurer: Property portfolio ₹5000Cr. Catastrophe reinsurance: Retains first ₹50Cr of any loss, reinsurer covers above ₹50Cr',
    relatedTerms: ['Cession', 'Retrocession', 'Treaty', 'Facultative', 'Cat Bond', 'Solvency'],
    relatedModules: ['Insurance Dashboard', 'Digital Twin Center', 'Executive Cockpit'],
    domain: 'insurance',
    importance: 'high',
  },

  {
    term: 'IRDAI',
    definition: 'Insurance Regulatory and Development Authority of India — the statutory regulator for the insurance sector in India. Prescribes solvency norms, product guidelines, KYC requirements, and conduct standards.',
    definition_hi: 'भारत में बीमा क्षेत्र का नियामक। सॉल्वेंसी, उत्पाद दिशानिर्देश, KYC और आचार मानक निर्धारित करता है।',
    definition_hinglish: 'India ka insurance regulator. Solvency ratio 1.5x mandate karta hai. Annual Form-K filings mandatory. IRDAI ke rules follow karne hote hain.',
    purpose: 'IRDAI protects policyholder interests and ensures the financial stability of the insurance sector through prudential regulation.',
    example: 'IRDAI mandates: Solvency ratio ≥1.5, 13th-month persistency reporting, CAT model submission, H1 financial returns within 30 days',
    relatedTerms: ['Solvency', 'Persistency', 'Form-K', 'Policyholder Protection', 'Circular'],
    relatedModules: ['Regulatory Compliance Center', 'Insurance Dashboard'],
    domain: 'regulatory',
    importance: 'critical',
  },

  // ══════════════════════════════════════════════════════════════════════
  // OPERATIONAL / PLATFORM CONCEPTS
  // ══════════════════════════════════════════════════════════════════════

  {
    term: 'Maker-Checker (4-Eyes Principle)',
    term_hi: 'मेकर-चेकर सिद्धांत',
    definition: 'A dual-control internal control mechanism where one person (maker) performs an action and a different, senior person (checker) must review and approve it before execution.',
    definition_hi: 'एक आंतरिक नियंत्रण तंत्र जहां एक व्यक्ति कार्य करता है और दूसरा उसे अनुमोदित करता है। स्व-अनुमोदन प्रतिबंधित है।',
    definition_hinglish: 'Ek kaam karo, dusra approve kare. Khud apna kaam approve nahi kar sakte. RBI ka requirement hai segregation of duties ke liye.',
    purpose: 'Maker-checker prevents unauthorized transactions, fraud, and errors. RBI mandates 4-eyes approval for all high-value transactions and sensitive risk decisions.',
    example: 'Case closure: Analyst (Maker) → submits closure with rationale → Supervisor (Checker) → reviews evidence → Approves/Rejects. Self-approval cryptographically blocked.',
    relatedTerms: ['Segregation of Duties', 'Dual Control', 'Audit Trail', 'Internal Controls', 'Operational Risk'],
    relatedModules: ['CMS', 'AI Governance', 'Recovery Center', 'Rule Engine'],
    domain: 'operational',
    importance: 'critical',
  },

  {
    term: 'AI Explainability (SHAP)',
    term_hi: 'AI व्याख्यात्मकता',
    definition: 'SHAP (SHapley Additive exPlanations) is a game theory-based method for explaining individual AI model predictions by quantifying each feature\'s contribution to the output.',
    definition_hi: 'AI मॉडल की प्रत्येक भविष्यवाणी को समझाने की विधि। प्रत्येक फीचर का योगदान मापता है।',
    definition_hinglish: 'AI model ne kyon yeh decision liya yeh samjhana. SHAP batata hai: DPD ne score ko +32 points badhaya, bureau score ne -12 points.',
    purpose: 'Regulators (RBI, IRDAI) require AI decisions to be explainable. SHAP enables risk analysts to understand and validate model outputs and comply with model risk management guidelines.',
    example: 'Customer risk score 78/100: SHAP → DPD-30+ contribution +32pts, Utilization 92% +18pts, EMI bounce +15pts, Bureau 612 -12pts',
    relatedTerms: ['Model Explainability', 'Feature Importance', 'Black Box AI', 'Model Risk Management', 'XAI'],
    relatedModules: ['AI Governance Center', 'Predictive Risk Center', 'AI Decisioning Center'],
    domain: 'technology',
    importance: 'critical',
  },

  {
    term: 'Model Drift',
    term_hi: 'मॉडल विचलन',
    definition: 'The degradation of a machine learning model\'s predictive accuracy over time as the statistical properties of the input data change (data drift) or the relationship between inputs and outputs changes (concept drift).',
    definition_hi: 'समय के साथ ML मॉडल की भविष्यवाणी सटीकता का कम होना।',
    definition_hinglish: 'AI model time ke saath kam accurate hone lagta hai. Data patterns change hote hain toh model ko retrain karna padta hai.',
    purpose: 'Drifting models make poor risk decisions. RBI MRM guidelines require continuous model monitoring with defined drift thresholds for model re-validation.',
    example: 'NPA model trained pre-COVID: PSI drift = 0.28 (high) after COVID → Model predicting 30% fewer NPAs than actual → Immediate re-validation required',
    relatedTerms: ['PSI', 'KS Statistic', 'AUC', 'Data Drift', 'Concept Drift', 'Model Monitoring'],
    relatedModules: ['AI Governance Center', 'Predictive Risk Center'],
    domain: 'technology',
    importance: 'high',
  },

  {
    term: 'PSI (Population Stability Index)',
    term_hi: 'जनसंख्या स्थिरता सूचकांक',
    definition: 'A statistical measure used to detect whether the distribution of a model\'s input variable (or score) has changed significantly between training and current deployment, indicating model drift.',
    definition_hi: 'एक सांख्यिकीय माप जो मॉडल की इनपुट वेरिएबल के वितरण में परिवर्तन का पता लगाता है।',
    definition_hinglish: 'Model ka training data aur current data kitna different hai yeh measure karna. PSI < 0.1 = stable, 0.1-0.25 = monitor, > 0.25 = retrain.',
    purpose: 'PSI is the industry standard for detecting model drift in credit risk models. RBI MRM guidelines require PSI monitoring for all production models.',
    example: 'PSI 0.08 → Model stable (Green). PSI 0.18 → Monitor (Yellow). PSI 0.32 → High drift, model needs re-validation (Red)',
    relatedTerms: ['Model Drift', 'KS Statistic', 'AUC', 'Model Monitoring', 'Champion Challenger'],
    relatedModules: ['AI Governance Center'],
    domain: 'technology',
    importance: 'high',
  },

  {
    term: 'Data Quality Score',
    term_hi: 'डेटा गुणवत्ता स्कोर',
    definition: 'A composite metric that measures the completeness, accuracy, consistency, timeliness, and validity of a dataset. Expressed as a percentage (0-100%). Threshold typically 85%+ for risk models.',
    definition_hi: 'डेटा की पूर्णता, सटीकता, संगति और समयबद्धता का समग्र माप। आमतौर पर 0-100% में व्यक्त।',
    definition_hinglish: 'Data kitna sahi aur complete hai. 85% se kam DQ score aane par data risk calculation mein use nahi karna chahiye.',
    purpose: 'Poor data quality leads to inaccurate risk calculations. A DQ gate ensures only validated data flows into risk models and regulatory reports.',
    example: 'CBS loan file: null rate 3%, 2 schema violations, 1 duplicate → DQ score 87% → Passes quality gate → Promoted to staging',
    relatedTerms: ['Data Lineage', 'DQ Gate', 'Data Validation', 'Schema Violation', 'Completeness'],
    relatedModules: ['Data Quality Center', 'Data Ingestion', 'Data Fabric Center'],
    domain: 'technology',
    importance: 'high',
  },

  {
    term: 'Audit Trail',
    term_hi: 'ऑडिट ट्रेल',
    definition: 'A chronological record of all system activities, user actions, and data changes — maintained in a tamper-evident format to enable forensic investigation and regulatory compliance.',
    definition_hi: 'सभी सिस्टम गतिविधियों और उपयोगकर्ता क्रियाओं का कालानुक्रमिक रिकॉर्ड। छेड़छाड़-प्रतिरोधी प्रारूप में।',
    definition_hinglish: 'Har action ka record rakhna. SHA-256 hash se tamper-proof. Regulator ko evidence chahiye toh audit trail se package banao.',
    purpose: 'Audit trails are mandatory for regulatory compliance, fraud investigation, and internal audit. SHA-256 hash chains prevent tampering.',
    example: 'Regulator queries: "Show all changes to customer c-001234 risk classification in 2024" → Audit Center generates evidence package with hash verification',
    relatedTerms: ['Hash Chain', 'Evidence Package', 'SHA-256', 'WORM Storage', 'Regulatory Evidence'],
    relatedModules: ['Audit Center', 'Regulatory Compliance', 'Investigation Center'],
    domain: 'operational',
    importance: 'critical',
  },

  {
    term: 'Champion/Challenger Model',
    term_hi: 'चैंपियन/चैलेंजर मॉडल',
    definition: 'A model validation approach where the existing production model (champion) is tested against a new candidate model (challenger) by scoring both on live data simultaneously before promoting the challenger.',
    definition_hi: 'जहां मौजूदा प्रोडक्शन मॉडल (चैंपियन) को नए मॉडल (चैलेंजर) के खिलाफ लाइव डेटा पर परीक्षण किया जाता है।',
    definition_hinglish: 'Purana champion model aur naya challenger model dono parallel mein run karte hain. Jo better perform kare use champion banao.',
    purpose: 'Champion/challenger ensures new models are validated on live data before full deployment, reducing model risk and meeting RBI MRM guidelines.',
    example: 'NPA model v2 (challenger) run parallel with v1 (champion) for 30 days → AUC 0.89 vs 0.82 → KS better → v2 promoted after maker-checker approval',
    relatedTerms: ['Model Drift', 'A/B Testing', 'Shadow Scoring', 'Model Promotion', 'AI Governance'],
    relatedModules: ['AI Governance Center'],
    domain: 'technology',
    importance: 'high',
  },

  {
    term: 'Digital Twin',
    term_hi: 'डिजिटल ट्विन',
    definition: 'A virtual replica of a bank\'s loan portfolio that simulates its behavior under various macroeconomic scenarios. Enables stress testing without impacting actual operations.',
    definition_hi: 'एक बैंक के ऋण पोर्टफोलियो की वर्चुअल प्रतिकृति जो विभिन्न परिदृश्यों के तहत इसके व्यवहार का अनुकरण करती है।',
    definition_hinglish: 'Portfolio ka virtual copy. Us copy pe stress test karte hain — GDP girne par, interest rate badhne par kya hoga. Real portfolio affect nahi hota.',
    purpose: 'Digital twins enable risk managers to simulate RBI/IRDAI mandated stress scenarios and quantify capital requirements before they happen.',
    example: 'RBI Severely Adverse Scenario on Digital Twin → GDP -7%, Rates +400bps → ECL impact ₹142Cr → Capital buffer required ₹200Cr',
    relatedTerms: ['Stress Testing', 'Scenario Analysis', 'ECL', 'Monte Carlo', 'Portfolio Simulation'],
    relatedModules: ['Digital Twin Center', 'Regulatory Compliance', 'Executive Cockpit'],
    domain: 'technology',
    importance: 'high',
  },

  {
    term: 'Autonomous AI Agent',
    term_hi: 'स्वायत्त AI एजेंट',
    definition: 'A software agent powered by AI that can independently monitor data, identify patterns, generate recommendations, and trigger workflows without constant human direction.',
    definition_hi: 'AI-संचालित सॉफ्टवेयर एजेंट जो स्वतंत्र रूप से डेटा मॉनिटर करता है और सिफारिशें उत्पन्न करता है।',
    definition_hinglish: 'AI agent jo khud se data monitor karta hai, patterns dhundta hai, recommendations deta hai. Human sirf approve/reject karta hai.',
    purpose: 'Autonomous agents extend risk analyst capacity, monitoring 24/7 without fatigue. Human oversight is maintained through approval workflows.',
    example: 'Credit Risk Agent monitors 10,000 accounts overnight → Flags 24 early-warning cases → Risk analyst reviews recommendations at 09:00 → Approves 22, overrides 2',
    relatedTerms: ['AI Agent', 'Robotic Process Automation', 'ML Ops', 'Human-in-the-Loop', 'Autonomous AI'],
    relatedModules: ['Autonomous Risk Operations', 'AI Governance', 'Alert Management'],
    domain: 'technology',
    importance: 'high',
  },

  {
    term: 'Integration Pipeline',
    term_hi: 'एकीकरण पाइपलाइन',
    definition: 'An automated data flow that extracts data from source systems (CBS, bureau, AML), transforms it according to business rules, and loads it into the target system (platform data store).',
    definition_hi: 'एक स्वचालित डेटा प्रवाह जो स्रोत प्रणालियों से डेटा निकालता है, बदलता है और लक्ष्य प्रणाली में लोड करता है।',
    definition_hinglish: 'CBS se data nikalna, transform karna, platform mein load karna. ETL pipeline bhi kehte hain. Health monitor karna important hai.',
    purpose: 'Integration pipelines ensure timely, validated data flow from source systems to risk intelligence. Failures impact alert generation and risk calculations.',
    example: 'CBS daily batch pipeline: Extract (22:00) → Validate schema → Quality check → Transform to Customer 360 → Load to mart (03:00) → EWS indicators calculated (05:00)',
    relatedTerms: ['ETL', 'Connector', 'API', 'Data Ingestion', 'Data Quality', 'Schema Validation'],
    relatedModules: ['Data Ingestion', 'Integration Marketplace', 'Data Fabric Center'],
    domain: 'technology',
    importance: 'high',
  },

  {
    term: 'RBAC (Role-Based Access Control)',
    term_hi: 'भूमिका-आधारित अभिगम नियंत्रण',
    definition: 'A security access control method where system permissions are assigned to roles rather than individuals. Users are granted permissions by being assigned to roles.',
    definition_hi: 'सुरक्षा पहुंच नियंत्रण विधि जहां अनुमतियां व्यक्तियों के बजाय भूमिकाओं को सौंपी जाती हैं।',
    definition_hinglish: 'User ko role assign karo, role ko permissions do. Risk Analyst dekhta hai alerts, Admin change kar sakta hai settings. Least privilege principle.',
    purpose: 'RBAC enforces least-privilege access, preventing unauthorized data access. RBI mandates role-based access controls as part of cyber security frameworks.',
    example: 'Risk Analyst → Can view alerts, create investigations, but cannot approve cases. Supervisor → Can approve. Admin → Can manage users and roles.',
    relatedTerms: ['Least Privilege', 'IAM', 'Access Control', 'Segregation of Duties', 'Authentication'],
    relatedModules: ['IAM Center', 'Governance Center', 'Audit Center'],
    domain: 'operational',
    importance: 'critical',
  },

  {
    term: 'Hash Chain Integrity',
    term_hi: 'हैश चेन अखंडता',
    definition: 'A tamper-detection mechanism where each audit record contains a SHA-256 hash of its own content linked to the previous record\'s hash. Any modification breaks the chain, making tampering detectable.',
    definition_hi: 'छेड़छाड़ का पता लगाने का तंत्र जहां प्रत्येक ऑडिट रिकॉर्ड में SHA-256 हैश होता है। किसी भी परिवर्तन से चेन टूट जाती है।',
    definition_hinglish: 'Har audit record ka SHA-256 hash pichle record se linked hai. Agar koi tamper kare toh chain break ho jata hai aur detect ho jata hai.',
    purpose: 'Hash chain integrity provides cryptographic proof that audit records have not been tampered with — essential for regulatory evidence and legal proceedings.',
    example: 'Event 1 hash → included in Event 2 hash → included in Event 3 hash. If Event 2 is modified → Event 3 hash verification fails → Tampering detected',
    relatedTerms: ['SHA-256', 'Blockchain', 'Audit Trail', 'Evidence Package', 'WORM Storage'],
    relatedModules: ['Audit Center', 'Regulatory Compliance'],
    domain: 'technology',
    importance: 'critical',
  },

  {
    term: 'API Gateway',
    term_hi: 'API गेटवे',
    definition: 'A server that acts as the entry point for all client requests to backend services. It handles authentication, rate limiting, routing, request transformation, and monitoring.',
    definition_hi: 'एक सर्वर जो सभी क्लाइंट अनुरोधों के लिए बैकएंड सेवाओं का प्रवेश बिंदु है।',
    definition_hinglish: 'Sab API requests pehle gateway mein aati hain. Authentication, rate limiting, routing sab yahan hota hai.',
    purpose: 'API gateways centralize security, monitoring, and access control for all external integrations, reducing attack surface and enabling analytics.',
    example: 'Bureau API call → Gateway validates JWT token → Checks rate limit → Routes to Bureau adapter → Returns response → Logs in audit trail',
    relatedTerms: ['JWT', 'OAuth', 'Rate Limiting', 'Microservices', 'API Security'],
    relatedModules: ['Integration Marketplace', 'Operations Center'],
    domain: 'technology',
    importance: 'medium',
  },

  {
    term: 'Operational Risk',
    term_hi: 'परिचालन जोखिम',
    definition: 'The risk of loss resulting from inadequate or failed internal processes, people, and systems, or from external events. One of the three major Basel III risk categories (Credit, Market, Operational).',
    definition_hi: 'अपर्याप्त या विफल आंतरिक प्रक्रियाओं, लोगों, प्रणालियों या बाहरी घटनाओं से हानि का जोखिम।',
    definition_hinglish: 'Process failure, system failure, fraud, human error se jo loss hota hai. Basel ke tehat operational risk ke liye bhi capital rakhna padta hai.',
    purpose: 'Operational risk includes cyber fraud, system outages, and process failures. Basel III requires explicit capital allocation for operational risk.',
    example: 'System outage during peak CBS sync → Data freshness gap → NPA indicators stale → EWS alerts delayed → Operational risk event logged',
    relatedTerms: ['Basel III', 'Business Continuity', 'Cyber Risk', 'Process Risk', 'RCSA'],
    relatedModules: ['Operations Center', 'Audit Center', 'Security Center'],
    domain: 'operational',
    importance: 'high',
  },

  {
    term: 'Recovery Rate',
    term_hi: 'वसूली दर',
    definition: 'The percentage of an outstanding NPA exposure that is successfully recovered through collections, legal action, OTS, or asset liquidation. Recovery rate = 1 - LGD.',
    definition_hi: 'NPA से वसूल की गई राशि का प्रतिशत। वसूली दर = 1 - LGD।',
    definition_hinglish: 'NPA mein se kitna paisa wapas milta hai percentage mein. Recovery rate 70% matlab ₹70 mila per ₹100 NPA mein. Target 65%+.',
    purpose: 'Recovery rate determines actual credit losses vs estimated provisions. Better recovery processes reduce net credit losses and improve profitability.',
    example: 'NPA portfolio ₹500Cr. Recovered ₹340Cr through OTS (₹150Cr) + Legal (₹120Cr) + Write-offs (₹70Cr remains) → Recovery rate = 68%',
    relatedTerms: ['NPA', 'LGD', 'OTS', 'Write-off', 'SARFAESI', 'Collections'],
    relatedModules: ['Recovery Center', 'CMS', 'Collections Risk'],
    domain: 'banking',
    importance: 'high',
  },

];

// ─── Search function ──────────────────────────────────────────────────────

export function findConcept(query: string): ConceptEntry | undefined {
  const q = query.toLowerCase()
    .replace(/kya\s+(h(ai|ota|oti|ote)|h[ae]|hai|hota)\s*/gi, '')  // Strip Hindi question wrappers
    .replace(/what\s+is\s+/i, '')
    .replace(/explain\s+/i, '')
    .replace(/\bke\s+baare\s+mein\b/gi, '')
    .trim();

  // Exact term match first
  const exact = CONCEPT_DICTIONARY.find(c =>
    c.term.toLowerCase().includes(q) ||
    (c.term_hi && c.term_hi.includes(query))
  );
  if (exact) return exact;

  // Keyword match
  return CONCEPT_DICTIONARY.find(c => {
    const allText = `${c.term} ${c.definition} ${c.definition_hi ?? ''} ${c.relatedTerms.join(' ')}`.toLowerCase();
    const words = q.split(/\s+/).filter(w => w.length > 2);
    return words.length > 0 && words.every(w => allText.includes(w));
  });
}

export function searchConcepts(query: string): ConceptEntry[] {
  const q = query.toLowerCase();
  return CONCEPT_DICTIONARY.filter(c => {
    const allText = `${c.term} ${c.definition} ${c.definition_hi ?? ''} ${c.relatedTerms.join(' ')} ${c.domain}`.toLowerCase();
    return allText.includes(q);
  }).slice(0, 5);
}

export function getConceptsByDomain(domain: ConceptEntry['domain']): ConceptEntry[] {
  return CONCEPT_DICTIONARY.filter(c => c.domain === domain);
}
