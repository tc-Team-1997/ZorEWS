// Predictive Risk Center — page render + role gate + pure-resolver suites.

import { describe, expect, it, beforeEach } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { PredictiveRiskCenterPage } from '@/modules/predictive/PredictiveRiskCenterPage';
import {
  BANKING_PREDICTIONS,
  buildExecutiveForecast,
  buildRiskTimeline,
  canAccessPredictiveRiskCenter,
  DEFAULT_THRESHOLDS,
  EXECUTIVE_FORECAST_SCOPES,
  FORECAST_HORIZONS,
  INSURANCE_PREDICTIONS,
  PREDICTIVE_ROLES,
  RISK_LEVELS,
  bandForScore,
  predictBankingSuite,
  predictInsuranceSuite,
  predictRisk,
  resolveThresholds,
} from '@/modules/predictive/predictiveRiskEngine';
import {
  SIGNAL_LIBRARY,
  SIGNAL_SEVERITIES,
  getSignalDef,
  listActiveSignals,
  listSignalDefs,
} from '@/modules/predictive/predictiveSignals';
import {
  RECOMMENDATION_ACTIONS,
  RECOMMENDATION_CATALOG,
  getRecommendation,
  listRecommendations,
  recommendationsFor,
} from '@/modules/predictive/predictiveRecommendations';
import { buildExplanation } from '@/modules/predictive/predictiveExplanations';
import { DashboardPage } from '@/modules/dashboard/DashboardPage';
import { renderWithProviders } from './utils';
import { useAuth } from '@/store/auth';

type AnyRole = 'admin' | 'supervisor' | 'risk_analyst' | 'fraud_analyst' | 'field_officer';

function setUser(role: AnyRole) {
  const user = {
    id: 'u-001',
    username: `test.${role}`,
    roles: [role] as AnyRole[],
  };
  localStorage.setItem('apex.ews.user', JSON.stringify(user));
  localStorage.setItem('apex.ews.token', 'mock.test.token');
  useAuth.setState({ status: 'authenticated', user: user as never, token: 'mock.test.token' });
}

function renderRoute() {
  return renderWithProviders(
    <Routes>
      <Route path="/predictive-risk-center" element={<PredictiveRiskCenterPage />} />
      <Route path="/" element={<DashboardPage />} />
    </Routes>,
    { route: '/predictive-risk-center' },
  );
}

beforeEach(() => {
  localStorage.clear();
});

const ASOF = new Date('2026-05-30T08:00:00Z');

// ───────────────────────────────────────────────────────────────────────────
// Role gate
// ───────────────────────────────────────────────────────────────────────────

describe('canAccessPredictiveRiskCenter', () => {
  it('grants every declared role in PREDICTIVE_ROLES', () => {
    for (const role of PREDICTIVE_ROLES) {
      expect(canAccessPredictiveRiskCenter([role])).toBe(true);
    }
  });

  it('grants legacy executive + admin + supervisor backend roles', () => {
    expect(canAccessPredictiveRiskCenter(['admin'])).toBe(true);
    expect(canAccessPredictiveRiskCenter(['supervisor'])).toBe(true);
    expect(canAccessPredictiveRiskCenter(['executive'])).toBe(true);
  });

  it('grants risk_analyst + fraud_analyst (per brief)', () => {
    expect(canAccessPredictiveRiskCenter(['risk_analyst'])).toBe(true);
    expect(canAccessPredictiveRiskCenter(['fraud_analyst'])).toBe(true);
  });

  it('refuses unknown roles', () => {
    expect(canAccessPredictiveRiskCenter(['field_officer'])).toBe(false);
    expect(canAccessPredictiveRiskCenter(['collection_officer'])).toBe(false);
    expect(canAccessPredictiveRiskCenter(['random_role'])).toBe(false);
  });

  it('refuses empty / null / undefined input', () => {
    expect(canAccessPredictiveRiskCenter([])).toBe(false);
    expect(canAccessPredictiveRiskCenter(undefined)).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Risk scoring engine
// ───────────────────────────────────────────────────────────────────────────

describe('bandForScore + resolveThresholds', () => {
  it('exposes all 5 risk levels', () => {
    expect(RISK_LEVELS).toEqual(['low', 'moderate', 'high', 'severe', 'critical']);
  });

  it('classifies into correct band at default thresholds', () => {
    expect(bandForScore(5)).toBe('low');
    expect(bandForScore(25)).toBe('moderate');
    expect(bandForScore(50)).toBe('high');
    expect(bandForScore(75)).toBe('severe');
    expect(bandForScore(95)).toBe('critical');
  });

  it('honours boundary semantics (≥ critical = critical)', () => {
    expect(bandForScore(DEFAULT_THRESHOLDS.critical)).toBe('critical');
    expect(bandForScore(DEFAULT_THRESHOLDS.critical - 1)).toBe('severe');
    expect(bandForScore(DEFAULT_THRESHOLDS.moderate)).toBe('moderate');
    expect(bandForScore(DEFAULT_THRESHOLDS.moderate - 1)).toBe('low');
  });

  it('resolveThresholds prefers tenant > domain > country > default', () => {
    const tenantOverride = { moderate: 10, high: 20, severe: 30, critical: 40 };
    const domainOverride = { moderate: 15, high: 25, severe: 35, critical: 45 };
    const countryOverride = { moderate: 12, high: 22, severe: 32, critical: 42 };
    expect(
      resolveThresholds(
        { tenant: 'BANK_DEMO', domain: 'banking', country: 'IN' },
        { tenants: { BANK_DEMO: tenantOverride }, domains: { banking: domainOverride }, countries: { IN: countryOverride } },
      ),
    ).toEqual(tenantOverride);
    expect(resolveThresholds({ domain: 'banking', country: 'IN' }, { domains: { banking: domainOverride }, countries: { IN: countryOverride } })).toEqual(domainOverride);
    expect(resolveThresholds({ country: 'IN' }, { countries: { IN: countryOverride } })).toEqual(countryOverride);
    expect(resolveThresholds({})).toEqual(DEFAULT_THRESHOLDS);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Prediction suite shape
// ───────────────────────────────────────────────────────────────────────────

describe('predictRisk', () => {
  it('exposes 7 banking + 7 insurance prediction kinds', () => {
    expect(BANKING_PREDICTIONS).toHaveLength(7);
    expect(INSURANCE_PREDICTIONS).toHaveLength(7);
  });

  it('supports all 4 declared horizons (30/60/90/180)', () => {
    expect(FORECAST_HORIZONS).toEqual([30, 60, 90, 180]);
    for (const h of FORECAST_HORIZONS) {
      const f = predictRisk('BANK_DEMO', 'npa_probability', h, ASOF);
      expect(f.horizon).toBe(h);
      expect(f.points.length).toBeGreaterThan(0);
      const last = f.points[f.points.length - 1];
      expect(last.day_offset).toBe(h);
    }
  });

  it('every forecast carries required fields with bounded values', () => {
    const f = predictRisk('BANK_DEMO', 'emi_default_risk', 90, ASOF);
    expect(f).toMatchObject({
      tenant_id: 'BANK_DEMO',
      kind: 'emi_default_risk',
      domain: 'banking',
      horizon: 90,
      trend: expect.stringMatching(/^(rising|falling|flat)$/),
    });
    expect(f.current_score).toBeGreaterThanOrEqual(0);
    expect(f.current_score).toBeLessThanOrEqual(100);
    expect(f.forecast_score).toBeGreaterThanOrEqual(0);
    expect(f.forecast_score).toBeLessThanOrEqual(100);
    expect(f.confidence).toBeGreaterThan(0);
    expect(f.confidence).toBeLessThanOrEqual(1);
    expect(RISK_LEVELS).toContain(f.current_band);
    expect(RISK_LEVELS).toContain(f.forecast_band);
    for (const p of f.points) {
      expect(p.score).toBeGreaterThanOrEqual(0);
      expect(p.score).toBeLessThanOrEqual(100);
      expect(p.lower_bound).toBeLessThanOrEqual(p.score);
      expect(p.upper_bound).toBeGreaterThanOrEqual(p.score);
      expect(p.confidence).toBeGreaterThan(0);
      expect(p.confidence).toBeLessThanOrEqual(1);
      expect(RISK_LEVELS).toContain(p.band);
    }
  });

  it('is deterministic per (tenant, kind, day)', () => {
    const a = predictRisk('BANK_DEMO', 'npa_probability', 90, ASOF);
    const b = predictRisk('BANK_DEMO', 'npa_probability', 90, ASOF);
    expect(a).toEqual(b);
  });

  it('different tenant yields different output', () => {
    const a = predictRisk('BANK_DEMO', 'npa_probability', 90, ASOF);
    const b = predictRisk('BIL', 'npa_probability', 90, ASOF);
    expect(a.current_score).not.toBe(b.current_score);
  });

  it('delta_pp = forecast_score - current_score', () => {
    const f = predictRisk('BANK_DEMO', 'claim_fraud_probability', 60, ASOF);
    expect(f.delta_pp).toBe(f.forecast_score - f.current_score);
  });

  it('trend correctly classifies delta_pp', () => {
    for (const kind of BANKING_PREDICTIONS) {
      const f = predictRisk('BANK_DEMO', kind, 90, ASOF);
      if (f.delta_pp > 2) expect(f.trend).toBe('rising');
      else if (f.delta_pp < -2) expect(f.trend).toBe('falling');
      else expect(f.trend).toBe('flat');
    }
  });

  it('confidence bands widen toward the horizon', () => {
    const f = predictRisk('BANK_DEMO', 'npa_probability', 180, ASOF);
    const first = f.points[0];
    const last = f.points[f.points.length - 1];
    expect(last.upper_bound - last.lower_bound).toBeGreaterThanOrEqual(first.upper_bound - first.lower_bound);
    expect(last.confidence).toBeLessThanOrEqual(first.confidence);
  });
});

describe('predictBankingSuite + predictInsuranceSuite', () => {
  it('returns 7 forecasts each, one per kind', () => {
    const banking = predictBankingSuite('BANK_DEMO', 90, ASOF);
    const insurance = predictInsuranceSuite('BANK_DEMO', 90, ASOF);
    expect(banking).toHaveLength(7);
    expect(insurance).toHaveLength(7);
    expect(banking.map((f) => f.kind).sort()).toEqual([...BANKING_PREDICTIONS].sort());
    expect(insurance.map((f) => f.kind).sort()).toEqual([...INSURANCE_PREDICTIONS].sort());
  });

  it('every banking forecast carries domain=banking; insurance domain=insurance', () => {
    expect(predictBankingSuite('BANK_DEMO', 60, ASOF).every((f) => f.domain === 'banking')).toBe(true);
    expect(predictInsuranceSuite('BANK_DEMO', 60, ASOF).every((f) => f.domain === 'insurance')).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Risk Evolution Timeline
// ───────────────────────────────────────────────────────────────────────────

describe('buildRiskTimeline', () => {
  it('contains historical + current + predicted points in temporal order', () => {
    const t = buildRiskTimeline('BANK_DEMO', 'npa_probability', 90, ASOF, 90);
    const sources = new Set(t.points.map((p) => p.source));
    expect(sources.has('historical')).toBe(true);
    expect(sources.has('current')).toBe(true);
    expect(sources.has('predicted')).toBe(true);
    for (let i = 1; i < t.points.length; i++) {
      expect(t.points[i].day_offset).toBeGreaterThan(t.points[i - 1].day_offset);
    }
  });

  it('current point is exactly at day_offset=0 with confidence=1', () => {
    const t = buildRiskTimeline('BANK_DEMO', 'emi_default_risk', 90, ASOF);
    const current = t.points.find((p) => p.source === 'current');
    expect(current).toBeDefined();
    expect(current!.day_offset).toBe(0);
    expect(current!.confidence).toBe(1.0);
  });

  it('historical points carry null confidence; predicted carry [0,1] confidence', () => {
    const t = buildRiskTimeline('BANK_DEMO', 'claim_fraud_probability', 60, ASOF, 60);
    for (const p of t.points) {
      if (p.source === 'historical') {
        expect(p.confidence).toBeNull();
      } else {
        expect(p.confidence).toBeGreaterThan(0);
        expect(p.confidence).toBeLessThanOrEqual(1);
      }
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Signal library
// ───────────────────────────────────────────────────────────────────────────

describe('SIGNAL_LIBRARY + listActiveSignals', () => {
  it('declares ≥ 14 signal definitions across banking + insurance', () => {
    expect(SIGNAL_LIBRARY.length).toBeGreaterThanOrEqual(14);
    expect(SIGNAL_LIBRARY.some((s) => s.domain === 'banking')).toBe(true);
    expect(SIGNAL_LIBRARY.some((s) => s.domain === 'insurance')).toBe(true);
  });

  it('every signal has feeds_predictions ⊆ known prediction kinds', () => {
    const all = new Set<string>([...BANKING_PREDICTIONS, ...INSURANCE_PREDICTIONS]);
    for (const s of SIGNAL_LIBRARY) {
      for (const k of s.feeds_predictions) {
        expect(all.has(k)).toBe(true);
      }
    }
  });

  it('every signal has a valid default_severity', () => {
    for (const s of SIGNAL_LIBRARY) {
      expect(SIGNAL_SEVERITIES).toContain(s.default_severity);
    }
  });

  it('listSignalDefs filters by domain', () => {
    const banking = listSignalDefs('banking');
    const insurance = listSignalDefs('insurance');
    expect(banking.every((s) => s.domain === 'banking')).toBe(true);
    expect(insurance.every((s) => s.domain === 'insurance')).toBe(true);
    expect(banking.length + insurance.length).toBe(SIGNAL_LIBRARY.length);
  });

  it('getSignalDef returns the matching def or undefined', () => {
    expect(getSignalDef('missed_emi')).toBeDefined();
    expect(getSignalDef('non_existent_signal')).toBeUndefined();
  });

  it('listActiveSignals returns ≥ 4 observations across both domains (2-5 per domain)', () => {
    const obs = listActiveSignals('BANK_DEMO', ASOF);
    expect(obs.length).toBeGreaterThanOrEqual(4);
    expect(obs.length).toBeLessThanOrEqual(10);
  });

  it('listActiveSignals filters by domain', () => {
    const obs = listActiveSignals('BANK_DEMO', ASOF, { domain: 'banking' });
    expect(obs.every((o) => o.domain === 'banking')).toBe(true);
  });

  it('listActiveSignals is sorted newest-first', () => {
    const obs = listActiveSignals('BANK_DEMO', ASOF);
    for (let i = 1; i < obs.length; i++) {
      expect(obs[i - 1].observed_at >= obs[i].observed_at).toBe(true);
    }
  });

  it('listActiveSignals is deterministic per (tenant, day)', () => {
    const a = listActiveSignals('BANK_DEMO', ASOF);
    const b = listActiveSignals('BANK_DEMO', ASOF);
    expect(a).toEqual(b);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// AI Explanations
// ───────────────────────────────────────────────────────────────────────────

describe('buildExplanation', () => {
  it('returns 5 SHAP-style drivers sorted by |shap_value| descending', () => {
    const f = predictRisk('BANK_DEMO', 'npa_probability', 90, ASOF);
    const e = buildExplanation(f, ASOF);
    expect(e.top_drivers).toHaveLength(5);
    for (let i = 1; i < e.top_drivers.length; i++) {
      expect(Math.abs(e.top_drivers[i - 1].shap_value)).toBeGreaterThanOrEqual(Math.abs(e.top_drivers[i].shap_value));
    }
  });

  it('every driver has direction matching shap_value sign', () => {
    const f = predictRisk('BANK_DEMO', 'claim_fraud_probability', 60, ASOF);
    const e = buildExplanation(f, ASOF);
    for (const d of e.top_drivers) {
      if (d.shap_value > 0) expect(d.direction).toBe('up');
      if (d.shap_value < 0) expect(d.direction).toBe('down');
    }
  });

  it('risk_factors are 3-5 non-empty narrative bullets', () => {
    const f = predictRisk('BANK_DEMO', 'npa_probability', 90, ASOF);
    const e = buildExplanation(f, ASOF);
    expect(e.risk_factors.length).toBeGreaterThanOrEqual(3);
    expect(e.risk_factors.length).toBeLessThanOrEqual(5);
    for (const r of e.risk_factors) {
      expect(r.length).toBeGreaterThan(0);
    }
  });

  it('recommended_action_ids resolve via getRecommendation', () => {
    const f = predictRisk('BANK_DEMO', 'npa_probability', 90, ASOF);
    const e = buildExplanation(f, ASOF);
    expect(e.recommended_action_ids.length).toBeGreaterThan(0);
    for (const id of e.recommended_action_ids) {
      expect(getRecommendation(id)).toBeDefined();
    }
  });

  it('echoes prediction_score, confidence, label, model_id', () => {
    const f = predictRisk('BANK_DEMO', 'sma_migration_risk', 60, ASOF);
    const e = buildExplanation(f, ASOF);
    expect(e.prediction_score).toBe(f.current_score);
    expect(e.confidence).toBe(f.confidence);
    expect(e.label).toBe(f.label);
    expect(e.model_id).toBe('predictive-sma_migration_risk');
    expect(e.model_version).toBe('1.0.0');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Prescriptive Recommendations
// ───────────────────────────────────────────────────────────────────────────

describe('RECOMMENDATION_CATALOG', () => {
  it('exposes all 6 declared action_ids from the brief', () => {
    expect(RECOMMENDATION_ACTIONS).toEqual([
      'contact_borrower',
      'increase_monitoring',
      'launch_investigation',
      'escalate_review',
      'freeze_exposure',
      'trigger_retention_campaign',
    ]);
    expect(RECOMMENDATION_CATALOG).toHaveLength(6);
  });

  it('every recommendation carries label + description + assignee_role', () => {
    for (const r of RECOMMENDATION_CATALOG) {
      expect(r.label.length).toBeGreaterThan(0);
      expect(r.description.length).toBeGreaterThan(0);
      expect(r.domains.length).toBeGreaterThan(0);
      expect(['risk_analyst', 'collection_officer', 'fraud_analyst', 'supervisor']).toContain(r.default_assignee_role);
    }
  });

  it('listRecommendations filters by domain', () => {
    const banking = listRecommendations('banking');
    const insurance = listRecommendations('insurance');
    expect(banking.every((r) => r.domains.includes('banking'))).toBe(true);
    expect(insurance.every((r) => r.domains.includes('insurance'))).toBe(true);
  });

  it('recommendationsFor maps explanation action_ids to full defs', () => {
    const f = predictRisk('BANK_DEMO', 'npa_probability', 90, ASOF);
    const e = buildExplanation(f, ASOF);
    const recs = recommendationsFor(e);
    expect(recs.length).toBe(e.recommended_action_ids.length);
    for (const r of recs) {
      expect(RECOMMENDATION_ACTIONS).toContain(r.action_id);
    }
  });

  it('escalate_review + freeze_exposure require maker-checker', () => {
    expect(getRecommendation('escalate_review')!.requires_maker_checker).toBe(true);
    expect(getRecommendation('freeze_exposure')!.requires_maker_checker).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Executive Forecasts
// ───────────────────────────────────────────────────────────────────────────

describe('buildExecutiveForecast', () => {
  it('exposes all 4 scope axes', () => {
    expect(EXECUTIVE_FORECAST_SCOPES).toEqual(['enterprise', 'country', 'tenant', 'portfolio']);
  });

  it('enterprise scope returns exactly 1 entry', () => {
    const e = buildExecutiveForecast('enterprise', 90, ASOF);
    expect(e).toHaveLength(1);
    expect(e[0].entity_id).toBe('ENT');
  });

  it('country scope returns ≥ 1 entry; each with valid band + horizon', () => {
    const e = buildExecutiveForecast('country', 90, ASOF);
    expect(e.length).toBeGreaterThan(0);
    for (const row of e) {
      expect(RISK_LEVELS).toContain(row.forecast_band);
      expect(row.horizon).toBe(90);
      expect(row.confidence).toBeGreaterThan(0);
      expect(row.confidence).toBeLessThanOrEqual(1);
      expect(['rising', 'falling', 'flat']).toContain(row.trend);
    }
  });

  it('tenant + portfolio scopes return ≥ 1 entries', () => {
    expect(buildExecutiveForecast('tenant', 60, ASOF).length).toBeGreaterThan(0);
    expect(buildExecutiveForecast('portfolio', 180, ASOF).length).toBeGreaterThan(0);
  });

  it('is deterministic per (scope, horizon, day)', () => {
    const a = buildExecutiveForecast('country', 90, ASOF);
    const b = buildExecutiveForecast('country', 90, ASOF);
    expect(a).toEqual(b);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Page render
// ───────────────────────────────────────────────────────────────────────────

describe('PredictiveRiskCenterPage', () => {
  it('admin sees every section', () => {
    setUser('admin');
    renderRoute();
    expect(screen.getByText(/Predictive Risk Center/i)).toBeInTheDocument();
    for (const sectionId of [
      'cockpit-section-horizon',
      'cockpit-section-overview',
      'cockpit-section-forecasts',
      'cockpit-section-timeline',
      'cockpit-section-explanation',
      'cockpit-section-signals',
      'cockpit-section-actions',
      'cockpit-section-executive',
    ]) {
      expect(screen.getByTestId(sectionId)).toBeInTheDocument();
    }
  });

  it('risk_analyst sees the page (per brief — not bounced)', () => {
    setUser('risk_analyst');
    renderRoute();
    expect(screen.queryByText(/Predictive Risk Center/i)).toBeInTheDocument();
  });

  it('fraud_analyst sees the page (per brief)', () => {
    setUser('fraud_analyst');
    renderRoute();
    expect(screen.queryByText(/Predictive Risk Center/i)).toBeInTheDocument();
  });

  it('field_officer is bounced to /', () => {
    setUser('field_officer');
    renderRoute();
    expect(screen.queryByText(/Predictive Risk Center/i)).not.toBeInTheDocument();
  });

  it('renders 4 horizon chips (30/60/90/180)', () => {
    setUser('admin');
    renderRoute();
    for (const h of FORECAST_HORIZONS) {
      expect(screen.getByTestId(`horizon-${h}`)).toBeInTheDocument();
    }
  });

  it('renders both domain tabs (banking + insurance)', () => {
    setUser('admin');
    renderRoute();
    expect(screen.getByTestId('domain-tab-banking')).toBeInTheDocument();
    expect(screen.getByTestId('domain-tab-insurance')).toBeInTheDocument();
  });

  it('renders 7 banking forecast cards by default', () => {
    setUser('admin');
    renderRoute();
    for (const kind of BANKING_PREDICTIONS) {
      expect(screen.getByTestId(`forecast-card-${kind}`)).toBeInTheDocument();
    }
  });

  it('switching to insurance tab renders 7 insurance cards', () => {
    setUser('admin');
    renderRoute();
    fireEvent.click(screen.getByTestId('domain-tab-insurance'));
    for (const kind of INSURANCE_PREDICTIONS) {
      expect(screen.getByTestId(`forecast-card-${kind}`)).toBeInTheDocument();
    }
  });

  it('clicking a forecast card updates the AI explanation panel', () => {
    setUser('admin');
    renderRoute();
    // Switch to insurance + click on claim_fraud_probability
    fireEvent.click(screen.getByTestId('domain-tab-insurance'));
    fireEvent.click(screen.getByTestId('forecast-card-claim_fraud_probability'));
    // Explanation panel title includes the label
    expect(screen.getByTestId('cockpit-section-explanation')).toHaveTextContent(/predictive-claim_fraud_probability/);
  });

  it('renders 5 KPI tiles in the overview strip', () => {
    setUser('admin');
    renderRoute();
    for (const kpi of ['kpi-total', 'kpi-critical', 'kpi-severe', 'kpi-rising', 'kpi-confidence']) {
      expect(screen.getByTestId(kpi)).toBeInTheDocument();
    }
  });

  it('signal filter chips (all/banking/insurance) render', () => {
    setUser('admin');
    renderRoute();
    expect(screen.getByTestId('signal-filter-all')).toBeInTheDocument();
    expect(screen.getByTestId('signal-filter-banking')).toBeInTheDocument();
    expect(screen.getByTestId('signal-filter-insurance')).toBeInTheDocument();
  });

  it('all 4 executive scope chips render', () => {
    setUser('admin');
    renderRoute();
    for (const s of EXECUTIVE_FORECAST_SCOPES) {
      expect(screen.getByTestId(`exec-scope-${s}`)).toBeInTheDocument();
    }
  });

  it('clicking a horizon chip switches the selected horizon', () => {
    setUser('admin');
    renderRoute();
    fireEvent.click(screen.getByTestId('horizon-30'));
    // After clicking +30d, the forecast cards should still render
    expect(screen.getByTestId('forecast-card-npa_probability')).toBeInTheDocument();
  });

  it('executive forecast table renders ENT row by default', () => {
    setUser('admin');
    renderRoute();
    expect(screen.getByTestId('exec-row-ENT')).toBeInTheDocument();
  });
});
