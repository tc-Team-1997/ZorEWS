// services/bff/__tests__/cms_cases_validation.test.ts
//
// CMS-1 — types + validator + helper tests.

import {
  ATTACHMENT_MAX_BYTES,
  CMS_CASE_STATES,
  CMS_PRIORITIES,
  CMS_RESOLUTION_CATEGORIES,
  CMS_SLA_WINDOWS_MS,
  CMS_SLA_WARNING_PCT,
  CmsCaseError,
  computeSlaDueAt,
  formatCmsCaseNumber,
  isCmsCaseNumber,
  isCmsCaseState,
  isCmsPriority,
  isCmsResolutionCategory,
  isLegalCmsTransition,
  isSlaBreached,
  legalCmsTransitions,
  pickNextAssignee,
  slaProgressPct,
  validateCmsAttachmentMeta,
  validateCmsCaseAssign,
  validateCmsCaseClose,
  validateCmsCaseInput,
  validateCmsCaseNote,
  validateCmsCaseTransition,
  validateCmsCaseUpdate,
} from '../src/cms_cases';

const NOW = new Date('2026-05-06T10:00:00.000Z');

const VALID = {
  title: 'Customer cust-001 RED breach',
  description: '3+ EMI bounces in 90d; fast-track investigation.',
  priority: 'P1' as const,
  alert_id: 'alrt-001',
  tags: ['credit', 'urgent'],
};

// ─── Enums + guards ───────────────────────────────────────────────────

describe('CMS-1 — guards', () => {
  test('isCmsCaseState', () => {
    for (const s of CMS_CASE_STATES) expect(isCmsCaseState(s)).toBe(true);
    expect(isCmsCaseState('in_action')).toBe(false); // legacy M9.1 vocab not adopted
  });

  test('isCmsPriority', () => {
    for (const p of CMS_PRIORITIES) expect(isCmsPriority(p)).toBe(true);
    expect(isCmsPriority('P5')).toBe(false);
    expect(isCmsPriority('high')).toBe(false);
  });

  test('isCmsResolutionCategory', () => {
    for (const c of CMS_RESOLUTION_CATEGORIES) expect(isCmsResolutionCategory(c)).toBe(true);
    expect(isCmsResolutionCategory('cured')).toBe(false); // legacy M9.1 vocab
  });

  test('CMS_SLA_WARNING_PCT is 80', () => {
    expect(CMS_SLA_WARNING_PCT).toBe(80);
  });
});

// ─── State machine ───────────────────────────────────────────────────

describe('CMS-1 — state machine', () => {
  test('OPEN → ASSIGNED + CLOSED', () => {
    expect(legalCmsTransitions('OPEN').sort()).toEqual(['ASSIGNED', 'CLOSED']);
  });

  test('ASSIGNED → INVESTIGATING / ESCALATED / CLOSED', () => {
    expect(legalCmsTransitions('ASSIGNED').sort()).toEqual(
      ['CLOSED', 'ESCALATED', 'INVESTIGATING'],
    );
  });

  test('INVESTIGATING → PENDING_APPROVAL / ESCALATED / CLOSED', () => {
    expect(legalCmsTransitions('INVESTIGATING').sort()).toEqual(
      ['CLOSED', 'ESCALATED', 'PENDING_APPROVAL'],
    );
  });

  test('PENDING_APPROVAL → CLOSED / INVESTIGATING / ESCALATED', () => {
    expect(legalCmsTransitions('PENDING_APPROVAL').sort()).toEqual(
      ['CLOSED', 'ESCALATED', 'INVESTIGATING'],
    );
  });

  test('ESCALATED → INVESTIGATING / CLOSED', () => {
    expect(legalCmsTransitions('ESCALATED').sort()).toEqual(['CLOSED', 'INVESTIGATING']);
  });

  test('CLOSED → OPEN (reopen path)', () => {
    expect(legalCmsTransitions('CLOSED')).toEqual(['OPEN']);
  });

  test('Negative cases — illegal transitions', () => {
    expect(isLegalCmsTransition('OPEN', 'INVESTIGATING')).toBe(false);
    expect(isLegalCmsTransition('OPEN', 'ESCALATED')).toBe(false);
    expect(isLegalCmsTransition('CLOSED', 'INVESTIGATING')).toBe(false);
    expect(isLegalCmsTransition('CLOSED', 'CLOSED')).toBe(false);
    expect(isLegalCmsTransition('ASSIGNED', 'OPEN')).toBe(false);
  });

  test('Reopen closes a case lifecycle: CLOSED → OPEN', () => {
    expect(isLegalCmsTransition('CLOSED', 'OPEN')).toBe(true);
  });
});

// ─── SLA helpers ─────────────────────────────────────────────────────

describe('CMS-1 — SLA helpers', () => {
  test('computeSlaDueAt: P1 = +4h, P2 = +24h, P3 = +72h, P4 = +7d', () => {
    expect(computeSlaDueAt('P1', NOW).toISOString()).toBe('2026-05-06T14:00:00.000Z');
    expect(computeSlaDueAt('P2', NOW).toISOString()).toBe('2026-05-07T10:00:00.000Z');
    expect(computeSlaDueAt('P3', NOW).toISOString()).toBe('2026-05-09T10:00:00.000Z');
    expect(computeSlaDueAt('P4', NOW).toISOString()).toBe('2026-05-13T10:00:00.000Z');
  });

  test('SLA windows match the brief', () => {
    expect(CMS_SLA_WINDOWS_MS.P1).toBe(4 * 3600 * 1000);
    expect(CMS_SLA_WINDOWS_MS.P2).toBe(24 * 3600 * 1000);
    expect(CMS_SLA_WINDOWS_MS.P3).toBe(72 * 3600 * 1000);
    expect(CMS_SLA_WINDOWS_MS.P4).toBe(7 * 86400 * 1000);
  });

  test('slaProgressPct: 0 at create_at, 100 at sla_due_at, 100+ when breached', () => {
    const due = computeSlaDueAt('P1', NOW); // 4 hours from NOW
    expect(slaProgressPct(NOW, NOW, due)).toBe(0);
    expect(slaProgressPct(new Date(NOW.getTime() + 2 * 3600 * 1000), NOW, due)).toBe(50);
    expect(slaProgressPct(due, NOW, due)).toBe(100);
    // Overshoot by 30 minutes — clears any rounding tolerance.
    expect(slaProgressPct(new Date(due.getTime() + 30 * 60_000), NOW, due)).toBeGreaterThan(100);
  });

  test('slaProgressPct: defensive when sla_due_at <= created_at returns 100', () => {
    expect(slaProgressPct(NOW, NOW, NOW)).toBe(100);
    expect(slaProgressPct(NOW, NOW, new Date(NOW.getTime() - 60_000))).toBe(100);
  });

  test('isSlaBreached', () => {
    const due = computeSlaDueAt('P1', NOW);
    expect(isSlaBreached(NOW, due)).toBe(false);
    expect(isSlaBreached(new Date(due.getTime() + 1), due)).toBe(true);
  });
});

// ─── Case-number generator ───────────────────────────────────────────

describe('CMS-1 — case-number format', () => {
  test('formatCmsCaseNumber pads to 5 digits', () => {
    expect(formatCmsCaseNumber(2026, 1)).toBe('EWS-2026-00001');
    expect(formatCmsCaseNumber(2026, 12345)).toBe('EWS-2026-12345');
    expect(formatCmsCaseNumber(2026, 99999)).toBe('EWS-2026-99999');
  });

  test('isCmsCaseNumber regex', () => {
    expect(isCmsCaseNumber('EWS-2026-00001')).toBe(true);
    expect(isCmsCaseNumber('EWS-2026-1')).toBe(false);
    expect(isCmsCaseNumber('CASE-2026-00001')).toBe(false);
    expect(isCmsCaseNumber('EWS-26-00001')).toBe(false);
  });

  test('rejects out-of-range year/seq', () => {
    expect(() => formatCmsCaseNumber(1899, 1)).toThrow(/year/);
    expect(() => formatCmsCaseNumber(10000, 1)).toThrow(/year/);
    expect(() => formatCmsCaseNumber(2026, 0)).toThrow(/seq/);
    expect(() => formatCmsCaseNumber(2026, 100_000)).toThrow(/seq/);
  });
});

// ─── Round-robin ─────────────────────────────────────────────────────

describe('CMS-1 — pickNextAssignee', () => {
  test('empty pool → null', () => {
    expect(pickNextAssignee([], null)).toBeNull();
    expect(pickNextAssignee([], 'alice')).toBeNull();
  });

  test('first pick when no last assignee', () => {
    expect(pickNextAssignee(['alice', 'bob', 'carol'], null)).toBe('alice');
  });

  test('rotates through pool', () => {
    expect(pickNextAssignee(['alice', 'bob', 'carol'], 'alice')).toBe('bob');
    expect(pickNextAssignee(['alice', 'bob', 'carol'], 'bob')).toBe('carol');
    expect(pickNextAssignee(['alice', 'bob', 'carol'], 'carol')).toBe('alice');
  });

  test('lastAssignedTo not in pool → falls back to first', () => {
    expect(pickNextAssignee(['alice', 'bob'], 'eve')).toBe('alice');
  });
});

// ─── Validators ──────────────────────────────────────────────────────

describe('CMS-1 — validateCmsCaseInput', () => {
  test('happy', () => {
    const out = validateCmsCaseInput(VALID);
    expect(out.title).toBe(VALID.title);
    expect(out.priority).toBe('P1');
    expect(out.tags).toEqual(['credit', 'urgent']);
  });

  test('missing title rejected', () => {
    const { title, ...rest } = VALID;
    void title;
    expect(() => validateCmsCaseInput(rest)).toThrow(/title/);
  });

  test('title > 200 chars rejected', () => {
    expect(() => validateCmsCaseInput({ ...VALID, title: 'x'.repeat(201) })).toThrow(/200/);
  });

  test('description > 4000 chars rejected', () => {
    expect(() =>
      validateCmsCaseInput({ ...VALID, description: 'x'.repeat(4001) }),
    ).toThrow(/4000/);
  });

  test('bad priority rejected', () => {
    expect(() => validateCmsCaseInput({ ...VALID, priority: 'P5' as never })).toThrow(/priority/);
    expect(() => validateCmsCaseInput({ ...VALID, priority: 'high' as never })).toThrow(/priority/);
  });

  test('> 16 tags rejected', () => {
    const tags = Array.from({ length: 17 }, (_, i) => `t-${i}`);
    expect(() => validateCmsCaseInput({ ...VALID, tags })).toThrow(/16/);
  });

  test('non-string tag rejected', () => {
    expect(() =>
      validateCmsCaseInput({ ...VALID, tags: ['ok', 7] as never }),
    ).toThrow(/tag/);
  });

  test('alert_id > 64 chars rejected', () => {
    expect(() =>
      validateCmsCaseInput({ ...VALID, alert_id: 'x'.repeat(65) }),
    ).toThrow(/alert_id/);
  });
});

describe('CMS-1 — validateCmsCaseUpdate', () => {
  test('partial update with title only', () => {
    expect(validateCmsCaseUpdate({ title: 'Updated' }).title).toBe('Updated');
  });

  test('empty body rejected', () => {
    expect(() => validateCmsCaseUpdate({})).toThrow(/at least one mutable field/);
  });

  test('priority change validated', () => {
    expect(validateCmsCaseUpdate({ priority: 'P2' }).priority).toBe('P2');
    expect(() => validateCmsCaseUpdate({ priority: 'P5' as never })).toThrow(/priority/);
  });

  test('tag list replacement', () => {
    expect(validateCmsCaseUpdate({ tags: ['a', 'b'] }).tags).toEqual(['a', 'b']);
  });
});

describe('CMS-1 — validateCmsCaseClose', () => {
  test('happy', () => {
    const out = validateCmsCaseClose({
      resolution_category: 'mitigated',
      resolution_notes: 'Customer paid in full.',
    });
    expect(out.resolution_category).toBe('mitigated');
  });

  test('missing notes rejected', () => {
    expect(() =>
      validateCmsCaseClose({ resolution_category: 'mitigated' } as never),
    ).toThrow(/resolution_notes/);
  });

  test('bad category rejected', () => {
    expect(() =>
      validateCmsCaseClose({
        resolution_category: 'cured' as never,
        resolution_notes: 'x',
      }),
    ).toThrow(/resolution_category/);
  });
});

describe('CMS-1 — validateCmsCaseAssign', () => {
  test('happy', () => {
    const out = validateCmsCaseAssign({ assigned_to: 'analyst.jane', reason: 'r' });
    expect(out.assigned_to).toBe('analyst.jane');
    expect(out.reason).toBe('r');
  });

  test('reason optional', () => {
    expect(validateCmsCaseAssign({ assigned_to: 'a' }).reason).toBeUndefined();
  });

  test('missing assigned_to rejected', () => {
    expect(() => validateCmsCaseAssign({})).toThrow(/assigned_to/);
  });
});

describe('CMS-1 — validateCmsCaseTransition', () => {
  test('happy', () => {
    expect(validateCmsCaseTransition({ target: 'ESCALATED' }).target).toBe('ESCALATED');
  });

  test('bad target rejected', () => {
    expect(() => validateCmsCaseTransition({ target: 'in_action' })).toThrow(/target/);
  });
});

describe('CMS-1 — validateCmsCaseNote', () => {
  test('happy: defaults is_internal=true', () => {
    const out = validateCmsCaseNote({ note_text: 'Met customer at branch.' });
    expect(out.is_internal).toBe(true);
  });

  test('is_internal=false honoured', () => {
    expect(validateCmsCaseNote({ note_text: 'x', is_internal: false }).is_internal).toBe(false);
  });

  test('missing note_text rejected', () => {
    expect(() => validateCmsCaseNote({})).toThrow(/note_text/);
  });
});

describe('CMS-1 — validateCmsAttachmentMeta', () => {
  test('happy', () => {
    const out = validateCmsAttachmentMeta({
      file_name: 'evidence.pdf',
      file_size: 1024,
      mime_type: 'application/pdf',
    });
    expect(out.mime_type).toBe('application/pdf');
  });

  test('file_size > 20 MB rejected', () => {
    expect(() =>
      validateCmsAttachmentMeta({
        file_name: 'big.pdf',
        file_size: ATTACHMENT_MAX_BYTES + 1,
        mime_type: 'application/pdf',
      }),
    ).toThrow(/cap 20 MB/);
  });

  test('non-whitelisted mime rejected', () => {
    try {
      validateCmsAttachmentMeta({
        file_name: 'evil.exe',
        file_size: 100,
        mime_type: 'application/x-msdownload',
      });
      fail('expected throw');
    } catch (e) {
      expect((e as CmsCaseError).code).toBe('invalid_mime_type');
    }
  });

  test('zero or negative file_size rejected', () => {
    expect(() =>
      validateCmsAttachmentMeta({
        file_name: 'x.pdf',
        file_size: 0,
        mime_type: 'application/pdf',
      }),
    ).toThrow(/file_size/);
    expect(() =>
      validateCmsAttachmentMeta({
        file_name: 'x.pdf',
        file_size: -1,
        mime_type: 'application/pdf',
      }),
    ).toThrow(/file_size/);
  });
});
