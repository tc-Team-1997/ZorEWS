// copilotLanguageEngine.ts
//
// ZorEWS Copilot — Multilingual Intelligence Engine
// Phase 4: Automatic language detection + response formatting
// Supports: English | Hindi | Hinglish
//
// 100% additive — no existing logic changed.

// ─── Language Types ───────────────────────────────────────────────────────

export type CopilotLanguage = 'en' | 'hi' | 'hinglish';

// ─── Language Detection ───────────────────────────────────────────────────

const HINDI_DEVANAGARI = /[ऀ-ॿ]/;

const HINGLISH_KEYWORDS = /\b(kya|hai|kaise|kyun|kaisa|batao|bata|karo|kar|mujhe|hota|hoti|hote|nahi|nhi|accha|theek|samjhao|explain|iska|uska|aur|ya|mein|se|ke|ki|ka|par|pe|wala|wali|bahut|zyada|thoda|jab|tab|abhi|pehle|baad|sab|kuch|yaha|waha|bolo|puchh|lagta|lagti|zaroor|chahiye|hoga|hogi|milega|milegi|dekho|dekh)\b/i;

export function detectLanguage(text: string): CopilotLanguage {
  // Strong Devanagari → Hindi
  if (HINDI_DEVANAGARI.test(text)) return 'hi';
  // Hindi words in Latin script → Hinglish
  const hinglishMatches = text.match(HINGLISH_KEYWORDS);
  if (hinglishMatches && hinglishMatches.length >= 1) return 'hinglish';
  return 'en';
}

// ─── Greeting templates ───────────────────────────────────────────────────

export function getGreeting(lang: CopilotLanguage): string {
  const hour = new Date().getHours();
  if (lang === 'hi') {
    const time = hour < 12 ? 'सुप्रभात' : hour < 17 ? 'नमस्ते' : 'शुभ संध्या';
    return `${time}! मैं ZorEWS Copilot हूँ — आपका एंटरप्राइज रिस्क इंटेलिजेंस असिस्टेंट।`;
  }
  if (lang === 'hinglish') {
    const time = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
    return `${time}! Main ZorEWS Copilot hun — aapka enterprise risk intelligence assistant.`;
  }
  const time = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  return `${time}! I'm ZorEWS Copilot — your enterprise risk intelligence assistant.`;
}

// ─── Concept response templates ───────────────────────────────────────────

export interface ConceptEntry {
  term:          string;
  term_hi?:      string;           // Hindi name
  definition:    string;
  definition_hi?: string;          // Hindi definition
  definition_hinglish?: string;    // Hinglish definition
  purpose:       string;
  purpose_hi?:   string;
  example:       string;
  example_hi?:   string;
  relatedTerms:  string[];
  relatedModules: string[];
  domain:        'banking' | 'insurance' | 'operational' | 'technology' | 'regulatory';
  importance:    'critical' | 'high' | 'medium';
}

// ─── Format concept response by language ─────────────────────────────────

export function formatConceptResponse(concept: ConceptEntry, lang: CopilotLanguage): string {
  if (lang === 'hi') {
    const def = concept.definition_hi ?? concept.definition;
    const purpose = concept.purpose_hi ?? concept.purpose;
    const example = concept.example_hi ?? concept.example;
    const termHi = concept.term_hi ? ` (${concept.term_hi})` : '';
    return `**${concept.term}${termHi}**\n\n**परिभाषा:** ${def}\n\n**व्यावसायिक महत्व:** ${purpose}\n\n**उदाहरण:** ${example}\n\n**संबंधित अवधारणाएं:** ${concept.relatedTerms.join(', ')}\n\n**प्लेटफ़ॉर्म मॉड्यूल:** ${concept.relatedModules.join(', ')}`;
  }
  if (lang === 'hinglish') {
    const def = concept.definition_hinglish ?? concept.definition;
    const termHi = concept.term_hi ? ` (${concept.term_hi})` : '';
    return `**${concept.term}${termHi}**\n\n**Definition:** ${def}\n\n**Business Purpose:** ${concept.purpose}\n\n**Example (Udaharan):** ${concept.example}\n\n**Related Concepts:** ${concept.relatedTerms.join(', ')}\n\n**Platform Modules:** ${concept.relatedModules.join(', ')}`;
  }
  // English
  return `**${concept.term}**${concept.term_hi ? ` *(${concept.term_hi})*` : ''}\n\n**Definition:** ${concept.definition}\n\n**Business Purpose:** ${concept.purpose}\n\n**Example:** ${concept.example}\n\n**Related Concepts:** ${concept.relatedTerms.join(', ')}\n\n**Platform Modules:** ${concept.relatedModules.join(', ')}`;
}

// ─── "Not found" intelligent response by language ─────────────────────────

export function getSmartFallbackByLanguage(query: string, lang: CopilotLanguage): string {
  if (lang === 'hi') {
    return `मैं आपके प्रश्न "${query.slice(0, 60)}" को समझता हूँ।\n\nZorEWS Copilot एक एंटरप्राइज नॉलेज असिस्टेंट है जो इन विषयों पर जानकारी दे सकता है:\n\n🏦 **बैंकिंग:** NPA, SMA, DPD, क्रेडिट रिस्क, रिकवरी, बासेल\n🛡️ **बीमा:** क्लेम्स, अंडरराइटिंग, पर्सिस्टेंसी, IRDAI\n⚠️ **कंप्लायंस:** AML, KYC, RBI, SAR फाइलिंग\n🤖 **AI/ML:** प्रेडिक्टिव रिस्क, मॉडल गवर्नेंस, SHAP\n📊 **प्लेटफ़ॉर्म:** सभी 30+ मॉड्यूल की जानकारी\n\nकृपया अपना प्रश्न और विस्तार से पूछें।`;
  }
  if (lang === 'hinglish') {
    return `Main aapka question "${query.slice(0, 60)}" samjh raha hun.\n\nZorEWS Copilot in topics par help kar sakta hai:\n\n🏦 **Banking:** NPA, SMA, DPD, Credit Risk, Recovery, Basel\n🛡️ **Insurance:** Claims, Underwriting, Persistency, IRDAI\n⚠️ **Compliance:** AML, KYC, RBI regulations, SAR\n🤖 **AI/ML:** Predictive Risk, Model Governance, SHAP\n📊 **Platform:** Sab 30+ modules ki jankari\n\nPlease apna question aur detail mein puchho.`;
  }
  return `I understand you're asking about: *"${query.slice(0, 80)}"*\n\nZorEWS Copilot is your enterprise knowledge brain covering:\n\n🏦 **Banking:** NPA, SMA, DPD, Credit Risk, Collections, Basel III, RBI\n🛡️ **Insurance:** Claims, Underwriting, Persistency, Solvency, IRDAI\n⚠️ **Compliance:** AML, KYC, Regulatory Filing, Audit Trail\n🤖 **AI/ML:** Predictive Risk, Model Governance, SHAP Explainability\n📊 **Platform:** All 30+ modules explained\n\nTry asking: "What is NPA?", "How does investigation work?", "I am a Risk Analyst", or any BFSI concept.`;
}

// ─── Module explanation wrapper by language ───────────────────────────────

export function formatModuleByLanguage(
  moduleName: string,
  summary: string,
  purpose: string,
  kpis: string[],
  lang: CopilotLanguage
): string {
  if (lang === 'hi') {
    return `**${moduleName}**\n\n**सारांश:** ${summary}\n\n**उद्देश्य:** ${purpose}\n\n**मुख्य KPIs:**\n${kpis.map(k => `• ${k}`).join('\n')}`;
  }
  if (lang === 'hinglish') {
    return `**${moduleName}**\n\n**Summary:** ${summary}\n\n**Purpose:** ${purpose}\n\n**Key KPIs:**\n${kpis.map(k => `• ${k}`).join('\n')}`;
  }
  return `**${moduleName}**\n\n${summary}\n\n**Purpose:** ${purpose}\n\n**Key KPIs:** ${kpis.join(' · ')}`;
}

// ─── Workflow response wrapper by language ────────────────────────────────

export function formatWorkflowByLanguage(
  workflowName: string,
  steps: string[],
  outcome: string,
  lang: CopilotLanguage
): string {
  const stepLines = steps.map((s, i) => `**${i + 1}.** ${s}`).join('\n');
  if (lang === 'hi') {
    return `**${workflowName} — कार्यप्रवाह**\n\n${stepLines}\n\n**परिणाम:** ${outcome}`;
  }
  if (lang === 'hinglish') {
    return `**${workflowName} — Workflow**\n\n${stepLines}\n\n**Outcome:** ${outcome}`;
  }
  return `**${workflowName} — Workflow**\n\n${stepLines}\n\n**Outcome:** ${outcome}`;
}
