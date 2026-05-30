// AI Governance Center + sub-page smoke tests.

import { describe, expect, it, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import {
  AiGovernanceCenterPage,
  AI_GOVERNANCE_CARDS,
  AI_QUICK_LINKS,
} from '@/modules/ai/governance/AiGovernanceCenterPage';
import {
  AiGovernanceReportsPage,
  AI_GOVERNANCE_PACKS,
} from '@/modules/ai/governance/AiGovernanceReportsPage';
import { deriveHealth, bucketLabel, STALE_DAYS } from '@/modules/ai/governance/AiModelMonitoringPage';
import { slopeVerdict, METRICS } from '@/modules/ai/governance/AiPerformanceTrackingPage';
import { DashboardPage } from '@/modules/dashboard/DashboardPage';
import { renderWithProviders } from './utils';
import { useAuth } from '@/store/auth';

function setUser(role: 'admin' | 'supervisor' | 'risk_analyst' | 'field_officer') {
  const user = {
    id: 'u-001',
    username: `test.${role}`,
    roles: [role] as ('admin' | 'supervisor' | 'risk_analyst' | 'field_officer')[],
  };
  localStorage.setItem('apex.ews.user', JSON.stringify(user));
  localStorage.setItem('apex.ews.token', 'mock.test.token');
  useAuth.setState({ status: 'authenticated', user: user as never, token: 'mock.test.token' });
}

function renderCenter() {
  return renderWithProviders(
    <Routes>
      <Route path="/ai/governance" element={<AiGovernanceCenterPage />} />
      <Route path="/" element={<DashboardPage />} />
    </Routes>,
    { route: '/ai/governance' },
  );
}

function renderReports() {
  return renderWithProviders(
    <Routes>
      <Route path="/ai/governance/reports" element={<AiGovernanceReportsPage />} />
      <Route path="/" element={<DashboardPage />} />
    </Routes>,
    { route: '/ai/governance/reports' },
  );
}

beforeEach(() => {
  localStorage.clear();
});

describe('AiGovernanceCenterPage', () => {
  it('admin sees the landing + all 6 cards', () => {
    setUser('admin');
    renderCenter();
    expect(screen.getByTestId('ai-governance-center-page')).toBeInTheDocument();
    for (const card of AI_GOVERNANCE_CARDS) {
      expect(screen.getByTestId(`ai-governance-card-${card.id}`)).toBeInTheDocument();
    }
  });

  it('risk_analyst can see the page (matches AI Workbench gate)', () => {
    setUser('risk_analyst');
    renderCenter();
    expect(screen.getByTestId('ai-governance-center-page')).toBeInTheDocument();
  });

  it('field_officer is redirected', () => {
    setUser('field_officer');
    renderCenter();
    expect(screen.queryByTestId('ai-governance-center-page')).not.toBeInTheDocument();
  });

  it('exports exactly 6 cards in canonical order', () => {
    const ids = AI_GOVERNANCE_CARDS.map((c) => c.id);
    expect(ids).toEqual([
      'monitoring',
      'prediction-audit',
      'performance',
      'drift',
      'explainability',
      'reports',
    ]);
  });

  it('explainability card points at /ai/workbench/explainability (moved under Workbench)', () => {
    const card = AI_GOVERNANCE_CARDS.find((c) => c.id === 'explainability');
    expect(card?.to).toBe('/ai/workbench/explainability');
    expect(card?.legacyTo).toBe('/ai/explainability');
  });

  it('quick links cover the 5 non-governance AI surfaces', () => {
    const labels = AI_QUICK_LINKS.map((q) => q.label);
    expect(labels).toContain('AI Workbench');
    expect(labels).toContain('Model Registry');
    expect(labels).toContain('Experiment Tracking');
    expect(labels).toContain('AI Insights');
    expect(labels).toContain('Feature Store');
  });

  it('renders backwards-compat legacy URL panel', () => {
    setUser('admin');
    renderCenter();
    expect(screen.getByTestId('ai-governance-legacy-links')).toBeInTheDocument();
  });
});

describe('AiGovernanceReportsPage', () => {
  it('admin sees the landing + all 6 governance packs', () => {
    setUser('admin');
    renderReports();
    expect(screen.getByTestId('ai-governance-reports-page')).toBeInTheDocument();
    for (const pack of AI_GOVERNANCE_PACKS) {
      expect(screen.getByTestId(`ai-governance-pack-${pack.id}`)).toBeInTheDocument();
    }
  });

  it('every pack carries a regulator from the closed enum', () => {
    const allowed = new Set(['RBI', 'IRDAI', 'SOC 2', 'Internal MRM']);
    for (const pack of AI_GOVERNANCE_PACKS) {
      expect(allowed.has(pack.regulator)).toBe(true);
    }
  });

  it('every pack primary link points into the AI governance tree or audit-center export', () => {
    for (const pack of AI_GOVERNANCE_PACKS) {
      expect(pack.primaryTo.startsWith('/ai/') || pack.primaryTo.startsWith('/audit-center/')).toBe(true);
    }
  });

  it('field_officer is redirected', () => {
    setUser('field_officer');
    renderReports();
    expect(screen.queryByTestId('ai-governance-reports-page')).not.toBeInTheDocument();
  });
});

describe('AiModelMonitoringPage helpers', () => {
  it('deriveHealth maps retired status to retired bucket', () => {
    expect(deriveHealth('retired', 30, 'green')).toBe('retired');
  });
  it('deriveHealth promotes red drift verdict to drift_alert', () => {
    expect(deriveHealth('production', 10, 'red')).toBe('drift_alert');
  });
  it('deriveHealth maps amber drift to watch', () => {
    expect(deriveHealth('production', 10, 'amber')).toBe('watch');
  });
  it(`deriveHealth promotes deployment-age > ${STALE_DAYS} days to stale`, () => {
    expect(deriveHealth('production', STALE_DAYS + 1, 'green')).toBe('stale');
  });
  it('deriveHealth returns healthy when drift green + fresh', () => {
    expect(deriveHealth('production', 30, 'green')).toBe('healthy');
  });
  it('bucketLabel covers every bucket value', () => {
    for (const b of ['healthy', 'watch', 'drift_alert', 'stale', 'retired'] as const) {
      expect(typeof bucketLabel(b)).toBe('string');
      expect(bucketLabel(b).length).toBeGreaterThan(0);
    }
  });
});

describe('AiPerformanceTrackingPage helpers', () => {
  it('exports the 5-metric closed enum', () => {
    expect(METRICS).toEqual(['auc', 'precision', 'recall', 'f1', 'drift_score']);
  });
  it('slopeVerdict on positive slope reports improving + success tone', () => {
    const v = slopeVerdict(0.01);
    expect(v.label).toBe('Improving');
    expect(v.tone).toBe('success');
  });
  it('slopeVerdict on negative slope reports declining + danger tone', () => {
    const v = slopeVerdict(-0.01);
    expect(v.label).toBe('Declining');
    expect(v.tone).toBe('danger');
  });
  it('slopeVerdict on near-zero slope reports flat', () => {
    expect(slopeVerdict(0).label).toBe('Flat');
  });
  it('slopeVerdict on null reports insufficient data', () => {
    const v = slopeVerdict(null);
    expect(v.label).toBe('Insufficient data');
    expect(v.tone).toBe('neutral');
  });
});
