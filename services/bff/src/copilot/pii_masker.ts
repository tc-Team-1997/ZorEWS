// services/bff/src/copilot/pii_masker.ts
//
// Copilot-1 — PII masker for queries before they hit the LLM.
//
// Pure function. Given text, returns the same text with PII tokens
// replaced by labelled placeholders, plus the list of distinct kinds
// that fired. Order-of-operations matters: most-specific patterns
// run first so account_no doesn't eat aadhaar / pan / phone.
//
// Approach is deliberately MINIMAL — only the 6 patterns the spec
// calls out, to avoid over-masking valid identifiers (case numbers,
// alert IDs, EWS rule IDs, etc.). Operators can file a feedback
// issue if a pattern blocks a legitimate query.

export type PiiKind =
  | 'email'
  | 'pan'
  | 'aadhaar'
  | 'phone'
  | 'customer_id'
  | 'account_no';

export interface MaskResult {
  masked: string;
  hits: PiiKind[];
}

interface PatternDef {
  kind: PiiKind;
  re: RegExp;
  replacement: string;
}

// Order: customer_id → email → pan → aadhaar → phone → account_no.
//
// account_no's loose 9-18 digit run runs LAST so it doesn't eat
// aadhaar's 12-digit form (already masked by then) or phone numbers.
const PATTERNS: PatternDef[] = [
  // EWS customer ID convention: cust-<id>. Case-insensitive.
  {
    kind: 'customer_id',
    re: /\bcust-[a-z0-9-]+\b/gi,
    replacement: '[CUSTOMER_ID]',
  },
  // Email — minimal RFC: <something>@<something>.<something>
  {
    kind: 'email',
    re: /\S+@\S+\.\S+/g,
    replacement: '[EMAIL]',
  },
  // PAN (India): 5 letters + 4 digits + 1 letter
  {
    kind: 'pan',
    re: /\b[A-Z]{5}\d{4}[A-Z]\b/g,
    replacement: '[PAN]',
  },
  // Aadhaar (India): 12 digits, optionally space-separated 4-4-4
  {
    kind: 'aadhaar',
    re: /\b\d{4}\s?\d{4}\s?\d{4}\b/g,
    replacement: '[AADHAAR]',
  },
  // Phone (loose IN-style): EITHER `+CC <10digits>` OR a bare 10-digit
  // run with word-boundaries (so a 15-digit account number doesn't get
  // partially eaten as a phone match).
  {
    kind: 'phone',
    re: /\+\d{1,3}[\s-]?\d{10}\b|\b\d{10}\b/g,
    replacement: '[PHONE]',
  },
  // Bank account: long-digit run 9-18 chars
  {
    kind: 'account_no',
    re: /\b\d{9,18}\b/g,
    replacement: '[ACCOUNT]',
  },
];

/**
 * Pure function. Replaces PII tokens with labelled placeholders.
 * Returns the masked text + the distinct kinds that fired (sorted
 * for stable test assertions).
 */
export function maskPII(text: string): MaskResult {
  if (typeof text !== 'string' || text.length === 0) {
    return { masked: text ?? '', hits: [] };
  }
  let masked = text;
  const hitSet = new Set<PiiKind>();
  for (const p of PATTERNS) {
    const before = masked;
    masked = masked.replace(p.re, p.replacement);
    if (masked !== before) hitSet.add(p.kind);
  }
  const hits = [...hitSet].sort() as PiiKind[];
  return { masked, hits };
}

/** Convenience: returns true iff any PII kind was found. */
export function hasPII(text: string): boolean {
  return maskPII(text).hits.length > 0;
}
