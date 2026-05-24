// services/bff/__tests__/notices.test.ts

import {
  ALL_NOTICE_CATEGORIES,
  ALL_NOTICE_CHANNELS,
  NOTICE_TEMPLATES,
  isNoticeCategory,
  isNoticeChannel,
  listNoticeTemplates,
  getNoticeTemplate,
  previewNotice,
  issueNotices,
  listIssuedRuns,
  _resetNoticeStore,
  NoticesError,
} from '../src/notices';

const NOW = new Date('2026-05-23T12:00:00.000Z');

beforeEach(() => _resetNoticeStore());

describe('catalog + enums', () => {
  it('ALL_NOTICE_CATEGORIES is 7-value enum', () => {
    expect(ALL_NOTICE_CATEGORIES).toHaveLength(7);
    expect(ALL_NOTICE_CATEGORIES).toContain('sarfaesi_13_2');
  });
  it('ALL_NOTICE_CHANNELS is 4-value enum', () => {
    expect(ALL_NOTICE_CHANNELS).toEqual(['email', 'sms', 'post', 'registered_post']);
  });
  it('NOTICE_TEMPLATES covers all 7 categories', () => {
    const cats = new Set(NOTICE_TEMPLATES.map((t) => t.category));
    expect(cats.size).toBe(ALL_NOTICE_CATEGORIES.length);
  });
  it('type guards', () => {
    expect(isNoticeCategory('sma_reminder')).toBe(true);
    expect(isNoticeCategory('bogus')).toBe(false);
    expect(isNoticeChannel('email')).toBe(true);
    expect(isNoticeChannel('telegram')).toBe(false);
  });
});

describe('listNoticeTemplates + getNoticeTemplate', () => {
  it('returns all 7 templates by default', () => {
    expect(listNoticeTemplates()).toHaveLength(7);
  });

  it('filters by category', () => {
    const out = listNoticeTemplates('sarfaesi_13_2');
    expect(out).toHaveLength(1);
    expect(out[0].category).toBe('sarfaesi_13_2');
  });

  it('defensive copy — mutate returned array does not pollute store', () => {
    const out = listNoticeTemplates();
    out[0].required_vars.push('hack');
    const out2 = listNoticeTemplates();
    expect(out2[0].required_vars).not.toContain('hack');
  });

  it('get returns null on miss', () => {
    expect(getNoticeTemplate('bogus')).toBeNull();
  });
});

describe('previewNotice', () => {
  it('renders subject + body with all vars present', () => {
    const out = previewNotice({
      template_id: 'tpl_sma_reminder_v1',
      vars: {
        customer_name: 'Mohan Reddy',
        account_id: 'a-100001',
        overdue_amount: 125000,
        overdue_days: 45,
        sma_category: 'SMA-1',
        as_of_date: '2026-05-23',
      },
    });
    expect(out.ready_to_issue).toBe(true);
    expect(out.missing_vars).toEqual([]);
    expect(out.subject).toContain('SMA-1');
    expect(out.subject).toContain('a-100001');
    expect(out.body).toContain('Mohan Reddy');
    expect(out.body).toContain('45');
  });

  it('lists missing_vars when vars incomplete', () => {
    const out = previewNotice({
      template_id: 'tpl_sma_reminder_v1',
      vars: { customer_name: 'X' },
    });
    expect(out.ready_to_issue).toBe(false);
    expect(out.missing_vars).toContain('account_id');
    expect(out.missing_vars).toContain('overdue_amount');
    expect(out.missing_vars).toContain('sma_category');
  });

  it('uses template default_channels when none supplied', () => {
    const out = previewNotice({ template_id: 'tpl_sma_reminder_v1', vars: {} });
    expect(out.channels).toEqual(['email', 'sms']);
  });

  it('honours caller-supplied channels', () => {
    const out = previewNotice({ template_id: 'tpl_npa_tagging_v1', vars: {}, channels: ['registered_post'] });
    expect(out.channels).toEqual(['registered_post']);
  });

  it('rejects unknown template + bad channel', () => {
    expect(() => previewNotice({ template_id: 'bogus', vars: {} })).toThrow(NoticesError);
    expect(() =>
      previewNotice({ template_id: 'tpl_sma_reminder_v1', vars: {}, channels: ['fax' as 'email'] }),
    ).toThrow(NoticesError);
  });

  it('rejects malformed input', () => {
    // @ts-expect-error testing missing template_id
    expect(() => previewNotice({ vars: {} })).toThrow(NoticesError);
  });
});

describe('issueNotices', () => {
  it('issues all rows when every var present', () => {
    const out = issueNotices(
      'BANK_DEMO',
      {
        template_id: 'tpl_kyc_refresh_v1',
        cohort: [
          { customer_id: 'c-100001', vars: { customer_name: 'Alice', customer_id: 'c-100001', kyc_due_date: '2026-06-30' } },
          { customer_id: 'c-100002', vars: { customer_name: 'Bob', customer_id: 'c-100002', kyc_due_date: '2026-07-15' } },
        ],
      },
      'alice.admin',
      NOW,
    );
    expect(out.issued_count).toBe(2);
    expect(out.skipped_count).toBe(0);
    expect(out.rows.every((r) => r.status === 'issued')).toBe(true);
    for (const r of out.rows) expect(r.notice_id).toMatch(/^ntc-BANK_DEMO-20260523-\d+$/);
  });

  it('skips rows with missing vars + records reason', () => {
    const out = issueNotices(
      'BANK_DEMO',
      {
        template_id: 'tpl_kyc_refresh_v1',
        cohort: [
          { customer_id: 'c-100001', vars: { customer_name: 'Alice', customer_id: 'c-100001', kyc_due_date: '2026-06-30' } },
          { customer_id: 'c-100002', vars: { customer_name: 'Bob' } }, // missing kyc_due_date + customer_id
        ],
      },
      'alice.admin',
      NOW,
    );
    expect(out.issued_count).toBe(1);
    expect(out.skipped_count).toBe(1);
    const skipped = out.rows.find((r) => r.status === 'skipped')!;
    expect(skipped.reason).toContain('missing_vars');
  });

  it('skips rows with missing customer_id', () => {
    const out = issueNotices(
      'BANK_DEMO',
      {
        template_id: 'tpl_kyc_refresh_v1',
        cohort: [{ customer_id: '', vars: {} }],
      },
      'alice',
      NOW,
    );
    expect(out.skipped_count).toBe(1);
    expect(out.rows[0].reason).toBe('missing_customer_id');
  });

  it('rejects empty cohort', () => {
    expect(() =>
      issueNotices('BANK_DEMO', { template_id: 'tpl_kyc_refresh_v1', cohort: [] }, 'alice', NOW),
    ).toThrow(NoticesError);
  });

  it('rejects cohort > 1000', () => {
    const big = new Array(1001).fill(null).map((_, i) => ({ customer_id: `c-${i}`, vars: {} }));
    expect(() =>
      issueNotices('BANK_DEMO', { template_id: 'tpl_kyc_refresh_v1', cohort: big }, 'alice', NOW),
    ).toThrow(NoticesError);
  });

  it('rejects unknown template + empty issued_by', () => {
    expect(() =>
      issueNotices(
        'BANK_DEMO',
        { template_id: 'bogus', cohort: [{ customer_id: 'c-1', vars: {} }] },
        'alice',
        NOW,
      ),
    ).toThrow(NoticesError);
    expect(() =>
      issueNotices(
        'BANK_DEMO',
        { template_id: 'tpl_kyc_refresh_v1', cohort: [{ customer_id: 'c-1', vars: {} }] },
        '',
        NOW,
      ),
    ).toThrow(NoticesError);
  });
});

describe('listIssuedRuns', () => {
  it('returns runs newest-first + tenant-scoped', () => {
    issueNotices('BANK_DEMO', { template_id: 'tpl_kyc_refresh_v1', cohort: [{ customer_id: 'c-1', vars: { customer_name: 'A', customer_id: 'c-1', kyc_due_date: '2026-06-30' } }] }, 'alice', new Date(NOW.getTime() - 5000));
    issueNotices('BANK_DEMO', { template_id: 'tpl_sma_reminder_v1', cohort: [{ customer_id: 'c-2', vars: { customer_name: 'B', account_id: 'a-1', overdue_amount: 1000, overdue_days: 30, sma_category: 'SMA-0', as_of_date: '2026-05-23' } }] }, 'alice', NOW);
    issueNotices('BIL', { template_id: 'tpl_kyc_refresh_v1', cohort: [{ customer_id: 'c-3', vars: { customer_name: 'C', customer_id: 'c-3', kyc_due_date: '2026-06-30' } }] }, 'alice', NOW);

    const bank = listIssuedRuns('BANK_DEMO');
    expect(bank).toHaveLength(2);
    expect(bank[0].issued_at >= bank[1].issued_at).toBe(true);
    expect(bank.every((r) => r.tenant_id === 'BANK_DEMO')).toBe(true);
  });
});
