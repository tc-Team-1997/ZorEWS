// copilotReasoningEngine.ts
//
// ZorEWS Copilot — Smart Reasoning Engine
// Phase 7-8: Multi-source knowledge search + intelligent response generation
// Ensures Copilot NEVER returns "I don't know" or template-not-found responses
//
// Search order:
// 1. Concept Dictionary (200+ BFSI concepts)
// 2. Module Registry (30+ platform modules)
// 3. Workflow Catalog (8+ workflows)
// 4. Navigation Catalog (50+ routes)
// 5. Role Guide (8 roles)
// 6. Domain inference (generate contextual answer from closest match)
//
// 100% additive — no existing logic changed.

import { findConcept, searchConcepts, CONCEPT_DICTIONARY } from './copilotConceptDictionary';
import { findModuleByRoute, searchModules, MODULE_REGISTRY } from './copilotKnowledgeRegistry';
import { findWorkflow, searchWorkflows, formatWorkflowResponse } from './copilotWorkflowCatalog';
import { searchNavEntries } from './copilotNavigationCatalog';
import { findRoleGuide, formatRoleGuideResponse } from './copilotRoleGuideCatalog';
import { formatConceptResponse, detectLanguage, getSmartFallbackByLanguage } from './copilotLanguageEngine';
import type { CopilotLanguage } from './copilotLanguageEngine';
import type { CopilotResponse } from './copilotEngine';

// ─── Normalize query for concept detection ────────────────────────────────

function normalizeQuery(q: string): string {
  return q
    .replace(/kya\s+(h(ai|ota|oti|ote)|hai|hota|hoti|hote)\s*/gi, '')
    .replace(/what\s+is\s+(an?\s+|the\s+)?/i, '')
    .replace(/explain\s+(the\s+|a\s+)?/i, '')
    .replace(/tell\s+me\s+about\s+(the\s+|a\s+)?/i, '')
    .replace(/describe\s+/i, '')
    .replace(/\bke\s+baare\s+mein\b/gi, '')
    .replace(/\bkya\b/gi, '')
    .replace(/\bhai\b/gi, '')
    .replace(/\bsamjhao\b/gi, '')
    .replace(/\bbatao\b/gi, '')
    .trim();
}

// ─── Detect if query is about a specific concept ──────────────────────────

function isConceptQuery(q: string): boolean {
  return /\b(what\s+is|explain|describe|define|kya\s+hai|kya\s+hota|samjhao|batao|tell\s+me\s+about|meaning\s+of|matlab)\b/i.test(q);
}

function isWorkflowQuery(q: string): boolean {
  return /\b(how\s+does|how\s+do|workflow|process|step|steps|kaise\s+kaam|kaise\s+hota|kaise\s+work|lifecycle|flow)\b/i.test(q);
}

function isRoleQuery(q: string): boolean {
  return /\b(i\s+am|i'm|main\s+hun|mujhe|guide\s+for|role\s+of|training\s+for)\b/i.test(q);
}

function isNavigationQuery(q: string): boolean {
  return /\b(where|kahan|navigate|go\s+to|open|find|locate)\b/i.test(q);
}

// ─── Main reasoning function ──────────────────────────────────────────────

export function reasonAndRespond(
  query: string,
  currentPath?: string,
): CopilotResponse {
  const lang: CopilotLanguage = detectLanguage(query);
  const normalized = normalizeQuery(query);

  // ── 1. Concept Dictionary (highest priority for "what is X" queries) ──
  if (isConceptQuery(query)) {
    const concept = findConcept(normalized) ?? findConcept(query);
    if (concept) {
      const reply = formatConceptResponse(concept, lang);
      const sug = generateConceptSuggestions(concept, lang);
      return {
        reply,
        suggestions: sug,
        sections: [
          {
            title: lang === 'hi' ? 'संबंधित मॉड्यूल' : 'Related Platform Modules',
            type: 'bullets',
            items: concept.relatedModules,
          },
        ],
        actions: concept.relatedModules.slice(0, 2).map(m => {
          const mod = MODULE_REGISTRY.find(mr => mr.name.toLowerCase().includes(m.toLowerCase().split(' ')[0]!));
          return { label: m, href: mod ? (Array.isArray(mod.route) ? mod.route[0]! : mod.route) : '/', icon: 'external-link' };
        }),
      };
    }
  }

  // ── 2. Workflow queries ───────────────────────────────────────────────
  if (isWorkflowQuery(query)) {
    const wf = findWorkflow(normalized) ?? findWorkflow(query);
    if (wf) {
      return {
        reply: formatWorkflowResponse(wf),
        suggestions: [`Navigate to ${wf.relatedModule}`, 'Show step SLAs', 'Related workflows', 'What are the actors?'],
        actions: [{ label: wf.name, href: wf.route, icon: 'git-branch' }],
      };
    }
  }

  // ── 3. Role queries ───────────────────────────────────────────────────
  if (isRoleQuery(query)) {
    const guide = findRoleGuide(query);
    if (guide) {
      return {
        reply: formatRoleGuideResponse(guide),
        suggestions: guide.suggestedQuestions.slice(0, 4),
        actions: guide.primaryScreens.slice(0, 3).map(s => ({ label: s.label, href: s.route, icon: 'external-link' })),
      };
    }
  }

  // ── 4. Module query ───────────────────────────────────────────────────
  const moduleMatches = searchModules(normalized.length > 3 ? normalized : query);
  if (moduleMatches.length > 0) {
    const m = moduleMatches[0]!;
    const kpis = m.kpis.slice(0, 4).map(k => `• ${k}`).join('\n');
    const header = lang === 'hi'
      ? `**${m.name}**\n\n**उद्देश्य:** ${m.purpose}\n\n**व्यावसायिक लक्ष्य:** ${m.businessObjective}\n\n**मुख्य KPIs:**\n${kpis}`
      : lang === 'hinglish'
      ? `**${m.name}**\n\n**Purpose:** ${m.purpose}\n\n**Key KPIs:**\n${kpis}`
      : `**${m.name}**\n\n${m.summary}\n\n**Purpose:** ${m.purpose}\n\n**Key KPIs:**\n${kpis}`;
    return {
      reply: header,
      suggestions: m.exampleQuestions.slice(0, 4),
      actions: [
        Array.isArray(m.route)
          ? { label: `Open ${m.name}`, href: m.route[0]!, icon: 'external-link' }
          : { label: `Open ${m.name}`, href: m.route, icon: 'external-link' },
      ],
    };
  }

  // ── 5. Navigation query ───────────────────────────────────────────────
  if (isNavigationQuery(query)) {
    const navEntries = searchNavEntries(query);
    if (navEntries.length > 0) {
      const primary = navEntries[0]!;
      return {
        reply: lang === 'hi'
          ? `**${primary.label}** पर नेविगेट करें\n\n${primary.description}\n\nRoute: \`${primary.route}\``
          : lang === 'hinglish'
          ? `**${primary.label}** par navigate karen\n\n${primary.description}`
          : `**Navigate to: ${primary.label}**\n\n${primary.description}\n\nRoute: \`${primary.route}\``,
        suggestions: navEntries.slice(1, 4).map(e => e.label),
        actions: navEntries.slice(0, 3).map(e => ({ label: e.label, href: e.route, icon: 'arrow-right' })),
      };
    }
  }

  // ── 6. Broader concept search (fuzzy match) ───────────────────────────
  const conceptMatches = searchConcepts(normalized.length > 3 ? normalized : query);
  if (conceptMatches.length > 0) {
    const concept = conceptMatches[0]!;
    return {
      reply: formatConceptResponse(concept, lang),
      suggestions: generateConceptSuggestions(concept, lang),
    };
  }

  // ── 7. Workflow search ────────────────────────────────────────────────
  const wfMatches = searchWorkflows(query);
  if (wfMatches.length > 0) {
    const wf = wfMatches[0]!;
    return {
      reply: formatWorkflowResponse(wf),
      suggestions: ['Navigate to module', 'Related concepts', 'Step SLAs', 'Who are the actors?'],
      actions: [{ label: wf.relatedModule, href: wf.route, icon: 'external-link' }],
    };
  }

  // ── 8. Current page context ───────────────────────────────────────────
  if (currentPath) {
    const pageModule = findModuleByRoute(currentPath);
    if (pageModule) {
      return {
        reply: lang === 'hi'
          ? `**${pageModule.name}** के बारे में आपका प्रश्न: *"${query.slice(0, 60)}"*\n\n${pageModule.summary}\n\n**इस मॉड्यूल के बारे में पूछें:**\n${pageModule.exampleQuestions.slice(0, 4).map(q => `• "${q}"`).join('\n')}`
          : lang === 'hinglish'
          ? `Aap **${pageModule.name}** par hain. Aapka question: *"${query.slice(0, 60)}"*\n\n${pageModule.summary}\n\nYahan pooch sakte hain:\n${pageModule.exampleQuestions.slice(0, 3).map(q => `• "${q}"`).join('\n')}`
          : `On **${pageModule.name}** — regarding: *"${query.slice(0, 60)}"*\n\n${pageModule.summary}\n\nYou can ask me:\n${pageModule.exampleQuestions.slice(0, 4).map(q => `• "${q}"`).join('\n')}`,
        suggestions: pageModule.exampleQuestions.slice(0, 4),
      };
    }
  }

  // ── 9. Domain inference — generate intelligent response from keywords ──
  const inferred = inferDomainResponse(query, lang);
  if (inferred) return inferred;

  // ── 10. Smart multilingual fallback (never generic) ───────────────────
  return {
    reply: getSmartFallbackByLanguage(query, lang),
    suggestions: [
      lang === 'hi' ? 'NPA क्या है?' : lang === 'hinglish' ? 'NPA kya hai?' : 'What is NPA?',
      lang === 'hi' ? 'Alert lifecycle कैसे काम करता है?' : lang === 'hinglish' ? 'Alert lifecycle kaise kaam karta hai?' : 'How does alert lifecycle work?',
      lang === 'hi' ? 'मैं एक Risk Analyst हूँ' : lang === 'hinglish' ? 'Main Risk Analyst hun' : 'I am a Risk Analyst',
      lang === 'hi' ? 'Compliance status क्या है?' : 'Compliance status today',
    ],
  };
}

// ─── Domain inference ─────────────────────────────────────────────────────

function inferDomainResponse(query: string, lang: CopilotLanguage): CopilotResponse | null {
  const q = query.toLowerCase();

  // Banking / credit keywords
  if (/\b(credit|lending|loan|borrow|emi|repay|finance|bank|default|debt|collateral|underwrite)\b/i.test(q)) {
    const bankConcepts = CONCEPT_DICTIONARY.filter(c => c.domain === 'banking').slice(0, 3).map(c => `• **${c.term}**: ${c.definition.slice(0, 80)}...`).join('\n');
    return {
      reply: lang === 'hi'
        ? `आपका प्रश्न बैंकिंग/क्रेडिट रिस्क से संबंधित लगता है। ZorEWS इन अवधारणाओं को समझता है:\n\n${bankConcepts}\n\nआप इन में से किसी के बारे में पूछ सकते हैं।`
        : lang === 'hinglish'
        ? `Aapka question banking/credit risk ke baare mein lagta hai. ZorEWS yeh concepts samajhta hai:\n\n${bankConcepts}`
        : `Your question relates to banking/credit risk. ZorEWS covers:\n\n${bankConcepts}\n\nAsk about any of these specifically for a detailed explanation.`,
      suggestions: ['What is NPA?', 'What is DPD?', 'What is Credit Risk?', 'How does NPA early warning work?'],
    };
  }

  // Insurance keywords
  if (/\b(insurance|policy|premium|claim|insurer|insured|reinsur|actuari|persist|lapse|irdai|life|health|motor|propert)\b/i.test(q)) {
    return {
      reply: lang === 'hi'
        ? `आपका प्रश्न बीमा क्षेत्र से है। ZorEWS इन मुख्य बीमा अवधारणाओं को समझता है:\n\n• **Persistency** — पॉलिसी नवीनीकरण दर\n• **Claims Ratio** — दावे/प्रीमियम अनुपात\n• **Solvency** — वित्तीय शक्ति मापक\n• **Lapse Rate** — पॉलिसी समाप्ति दर\n• **Channel Risk** — वितरण चैनल जोखिम\n\nकृपया विस्तार से पूछें।`
        : lang === 'hinglish'
        ? `Aapka question insurance ke baare mein hai. Main yeh samjha sakta hun:\n\n• **Persistency** — Policy renewal rate\n• **Claims Ratio** — Claims/Premium ka ratio\n• **Solvency** — Financial strength measure\n• **Lapse Rate** — Kitni policies band ho rahi hain\n\nKuch specific poochho.`
        : `Your question is about insurance. ZorEWS covers:\n\n• **Persistency** — Policy renewal rates\n• **Claims Ratio** — Claims to premium ratio\n• **Solvency** — Financial strength metric\n• **Lapse Rate** — Policy discontinuation rate\n• **Channel Risk** — Distribution quality risk\n\nAsk about any concept specifically.`,
      suggestions: ['What is Persistency Ratio?', 'What is Claims Ratio?', 'What is Solvency Ratio?', 'What is IRDAI?'],
    };
  }

  // Compliance / regulatory keywords
  if (/\b(regulat|compli|rbi|filing|aml|kyc|pmla|fatf|basel|irdai|sebi|audit|report|submission)\b/i.test(q)) {
    return {
      reply: lang === 'hi'
        ? `आपका प्रश्न नियामक/अनुपालन से संबंधित है। ZorEWS इन पर मार्गदर्शन दे सकता है:\n\n• **AML** — धन-शोधन निवारण\n• **KYC** — ग्राहक पहचान सत्यापन\n• **SAR** — संदिग्ध गतिविधि रिपोर्ट\n• **Basel III** — पूंजी पर्याप्तता ढांचा\n• **CRAR** — पूंजी पर्याप्तता अनुपात\n\nकौन सी अवधारणा विस्तार से जाननी है?`
        : `Your question is compliance/regulatory related. ZorEWS covers:\n\n• **AML/KYC** — Customer due diligence\n• **SAR Filing** — FIU-IND suspicious activity reports\n• **Basel III** — Capital adequacy framework\n• **CRAR** — Capital to risk-weighted assets\n• **IRDAI** — Insurance regulatory compliance\n\nWhich concept would you like explained?`,
      suggestions: ['What is AML?', 'What is KYC?', 'What is Basel III?', 'How does compliance workflow work?'],
    };
  }

  // AI/ML/Data keywords
  if (/\b(ai|ml|machine\s*learning|model|algorithm|predict|forecast|data|pipeline|neural|deep\s*learn|shap|drift)\b/i.test(q)) {
    return {
      reply: lang === 'hinglish'
        ? `Aapka question AI/ML ke baare mein lagta hai. Main yeh samjha sakta hun:\n\n• **SHAP** — AI decision explainability\n• **Model Drift** — Model accuracy degradation\n• **PSI** — Population Stability Index\n• **Champion/Challenger** — Model validation approach\n• **Digital Twin** — Portfolio simulation\n\nKya specifically poochna hai?`
        : `Your question is AI/ML related. ZorEWS covers:\n\n• **SHAP Explainability** — Why AI made a decision\n• **Model Drift** — When models become inaccurate\n• **PSI** — Population Stability Index for drift detection\n• **Champion/Challenger** — Safe model deployment\n• **Digital Twin** — Portfolio scenario simulation\n\nAsk about any specifically.`,
      suggestions: ['What is SHAP?', 'What is Model Drift?', 'What is PSI?', 'How does AI Governance work?'],
    };
  }

  return null;
}

// ─── Suggestion generator ─────────────────────────────────────────────────

function generateConceptSuggestions(concept: { term: string; relatedTerms: string[] }, lang: CopilotLanguage): string[] {
  const related = concept.relatedTerms.slice(0, 2);
  if (lang === 'hi') {
    return [
      ...related.map((t: string) => `${t} क्या है?`),
      `${concept.term} का workflow कैसे काम करता है?`,
      'संबंधित मॉड्यूल दिखाएं',
    ];
  }
  if (lang === 'hinglish') {
    return [
      ...related.map((t: string) => `${t} kya hai?`),
      `${concept.term} ka workflow kaise kaam karta hai?`,
      'Related modules dikhao',
    ];
  }
  return [
    ...related.map((t: string) => `What is ${t}?`),
    `How does ${concept.term} work in ZorEWS?`,
    `Best practices for ${concept.term}`,
    'Show related modules',
  ];
}
