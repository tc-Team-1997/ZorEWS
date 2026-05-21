// T3.3.1 — AML ↔ EWS bidirectional alert correlation tests.

import {
  CorrelationError,
  correlateAmlWithEws,
  correlateEwsWithAml,
  peakAlertSeverity,
  peakAmlSeverity,
  recommendAmlAction,
  recommendEwsAction,
  type AlertLite,
  type CaseLite,
  type CorrelationSources,
  type InvestigationLite,
} from '../src/aml_alert_correlation';
import type { AmlAdapter, AmlMatch } from '../src/integrations/aml';

const NOW = new Date('2026-05-21T12:00:00.000Z');
const TENANT = 'BIL';

function makeAdapter(opts: {
  match?: AmlMatch | null;
  matches?: AmlMatch[];
}): AmlAdapter {
  return {
    async getMatch() {
      return opts.match ?? null;
    },
    async listMatches() {
      return opts.matches ?? [];
    },
    async screenCustomer(_tenant: string, customer_id: string) {
      return {
        customer_id,
        screened_at: NOW.toISOString(),
        matches: [],
        total_matches: 0,
        highest_severity: null,
        requires_review: false,
      };
    },
    async updateMatchStatus() {
      throw new Error('not implemented');
    },
  };
}

function makeSources(opts: {
  alerts?: AlertLite[];
  cases?: CaseLite[];
  investigations?: InvestigationLite[];
}): CorrelationSources {
  return {
    async listAlertsForCustomer() {
      return opts.alerts ?? [];
    },
    async listCasesForCustomer() {
      return opts.cases ?? [];
    },
    async listInvestigationsForCustomer() {
      return opts.investigations ?? [];
    },
  };
}

function amlMatch(overrides: Partial<AmlMatch> = {}): AmlMatch {
  return {
    match_id: 'M-1',
    customer_id: 'C-1',
    match_type: 'sanctions',
    severity: 'high',
    list_name: 'OFAC SDN',
    list_entity_id: 'E-100',
    list_entity_name: 'Acme Holdings',
    confidence_score: 0.91,
    status: 'open',
    status_changed_at: null,
    status_changed_by: null,
    detected_at: NOW.toISOString(),
    ...overrides,
  } as AmlMatch;
}

const ALERT_HIGH: AlertLite = {
  id: 'a-1',
  customer_id: 'C-1',
  severity: 'high',
  status: 'open',
  created_at: NOW.toISOString(),
};

describe('peakAlertSeverity', () => {
  test('picks the highest by rank order', () => {
    expect(
      peakAlertSeverity([{ ...ALERT_HIGH, severity: 'low' }, { ...ALERT_HIGH, severity: 'critical' }, { ...ALERT_HIGH, severity: 'medium' }]),
    ).toBe('critical');
  });
  test('null on empty list', () => {
    expect(peakAlertSeverity([])).toBeNull();
  });
});

describe('peakAmlSeverity', () => {
  test('high beats medium beats low', () => {
    expect(peakAmlSeverity([amlMatch({ severity: 'low' }), amlMatch({ severity: 'medium' })])).toBe('medium');
    expect(peakAmlSeverity([amlMatch({ severity: 'low' }), amlMatch({ severity: 'high' })])).toBe('high');
  });
  test('null on empty', () => {
    expect(peakAmlSeverity([])).toBeNull();
  });
});

describe('recommendAmlAction', () => {
  test('escalate_case when AML high + EWS critical', () => {
    const r = recommendAmlAction({
      aml: amlMatch({ severity: 'high' }),
      peak_alert_severity: 'critical',
      has_open_case: false,
      has_open_investigation: false,
    });
    expect(r).toBe('escalate_case');
  });

  test('open_investigation when AML high + no investigation', () => {
    const r = recommendAmlAction({
      aml: amlMatch({ severity: 'high' }),
      peak_alert_severity: 'low',
      has_open_case: false,
      has_open_investigation: false,
    });
    expect(r).toBe('open_investigation');
  });

  test('monitor when work already in flight', () => {
    const r = recommendAmlAction({
      aml: amlMatch({ severity: 'medium' }),
      peak_alert_severity: 'medium',
      has_open_case: true,
      has_open_investigation: false,
    });
    expect(r).toBe('monitor');
  });

  test('no_action when AML low + no linked surfaces', () => {
    const r = recommendAmlAction({
      aml: amlMatch({ severity: 'low' }),
      peak_alert_severity: null,
      has_open_case: false,
      has_open_investigation: false,
    });
    expect(r).toBe('no_action');
  });
});

describe('recommendEwsAction', () => {
  test('sanctions_review when open sanctions hit', () => {
    const r = recommendEwsAction({
      alert: ALERT_HIGH,
      aml_matches: [amlMatch({ match_type: 'sanctions', status: 'open' })],
      open_aml_high_flag: true,
    });
    expect(r).toBe('sanctions_review');
  });

  test('kyc_refresh when open AML high + medium+ alert', () => {
    const r = recommendEwsAction({
      alert: { ...ALERT_HIGH, severity: 'medium' },
      aml_matches: [amlMatch({ match_type: 'adverse_media', severity: 'high', status: 'open' })],
      open_aml_high_flag: true,
    });
    expect(r).toBe('kyc_refresh');
  });

  test('monitor when AML matches exist but neither sanctions hit nor open-high', () => {
    const r = recommendEwsAction({
      alert: ALERT_HIGH,
      aml_matches: [amlMatch({ match_type: 'pep', severity: 'medium', status: 'cleared' })],
      open_aml_high_flag: false,
    });
    expect(r).toBe('monitor');
  });

  test('no_action when zero AML matches', () => {
    const r = recommendEwsAction({ alert: ALERT_HIGH, aml_matches: [], open_aml_high_flag: false });
    expect(r).toBe('no_action');
  });
});

describe('correlateAmlWithEws (forward)', () => {
  test('happy path with high AML + critical alert flags bidirectional_high', async () => {
    const aml = amlMatch();
    const adapter = makeAdapter({ match: aml });
    const sources = makeSources({
      alerts: [{ ...ALERT_HIGH, severity: 'critical' }],
      cases: [],
      investigations: [],
    });
    const r = await correlateAmlWithEws('M-1', TENANT, adapter, sources, NOW);
    expect(r.aml_match.match_id).toBe('M-1');
    expect(r.peak_alert_severity).toBe('critical');
    expect(r.bidirectional_high_flag).toBe(true);
    expect(r.recommended_action).toBe('escalate_case');
  });

  test('no linked alerts → peak_alert_severity null + bidirectional_high false', async () => {
    const adapter = makeAdapter({ match: amlMatch() });
    const sources = makeSources({});
    const r = await correlateAmlWithEws('M-1', TENANT, adapter, sources, NOW);
    expect(r.peak_alert_severity).toBeNull();
    expect(r.bidirectional_high_flag).toBe(false);
  });

  test('unknown_match → CorrelationError', async () => {
    const adapter = makeAdapter({ match: null });
    const sources = makeSources({});
    await expect(
      correlateAmlWithEws('M-missing', TENANT, adapter, sources, NOW),
    ).rejects.toBeInstanceOf(CorrelationError);
  });

  test('empty tenant_id / aml_match_id rejected', async () => {
    const adapter = makeAdapter({ match: amlMatch() });
    const sources = makeSources({});
    await expect(correlateAmlWithEws('M-1', '', adapter, sources, NOW)).rejects.toThrow(/tenant_id/);
    await expect(correlateAmlWithEws('', TENANT, adapter, sources, NOW)).rejects.toThrow(/aml_match_id/);
  });

  test('linked cases + investigations surfaced in response', async () => {
    const adapter = makeAdapter({ match: amlMatch() });
    const sources = makeSources({
      cases: [{ case_id: 'CASE-1', customer_id: 'C-1', state: 'open', created_at: NOW.toISOString() }],
      investigations: [
        {
          investigation_id: 'INV-1',
          customer_id: 'C-1',
          status: 'gathering_evidence',
          opened_at: NOW.toISOString(),
        },
      ],
    });
    const r = await correlateAmlWithEws('M-1', TENANT, adapter, sources, NOW);
    expect(r.linked_cases).toHaveLength(1);
    expect(r.linked_investigations).toHaveLength(1);
  });
});

describe('correlateEwsWithAml (reverse)', () => {
  const ALERT_LOOKUP = async () => ({ ...ALERT_HIGH, severity: 'high' as const });

  test('happy path with open sanctions hit → sanctions_review', async () => {
    const adapter = makeAdapter({
      matches: [amlMatch({ match_type: 'sanctions', status: 'open' })],
    });
    const r = await correlateEwsWithAml('a-1', TENANT, ALERT_LOOKUP, adapter, NOW);
    expect(r.aml_matches).toHaveLength(1);
    expect(r.peak_aml_severity).toBe('high');
    expect(r.open_aml_high_flag).toBe(true);
    expect(r.recommended_action).toBe('sanctions_review');
  });

  test('no AML matches → no_action', async () => {
    const adapter = makeAdapter({ matches: [] });
    const r = await correlateEwsWithAml('a-1', TENANT, ALERT_LOOKUP, adapter, NOW);
    expect(r.peak_aml_severity).toBeNull();
    expect(r.recommended_action).toBe('no_action');
  });

  test('unknown alert → CorrelationError', async () => {
    const adapter = makeAdapter({ matches: [] });
    await expect(
      correlateEwsWithAml('a-missing', TENANT, async () => null, adapter, NOW),
    ).rejects.toBeInstanceOf(CorrelationError);
  });

  test('cleared AML matches do NOT trigger sanctions_review', async () => {
    const adapter = makeAdapter({
      matches: [amlMatch({ match_type: 'sanctions', status: 'cleared' })],
    });
    const r = await correlateEwsWithAml('a-1', TENANT, ALERT_LOOKUP, adapter, NOW);
    expect(r.recommended_action).not.toBe('sanctions_review');
  });
});
