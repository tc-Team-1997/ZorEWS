// Audit Center + Recovery Center unified landings — smoke tests.
//
// Covers:
//   • role gate (audit center: admin + supervisor; recovery center: admin only)
//   • landing card grids render every sub-section
//   • backwards-compat panels surface every legacy URL
//   • exported _CARDS arrays canonical-order invariants
//   • Compliance Reports landing — 6 packs render with regulator badges

import { describe, expect, it, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import {
  AuditCenterPage,
  AUDIT_CENTER_CARDS,
} from '@/modules/admin/audit/AuditCenterPage';
import { AuditComplianceReportsPage, COMPLIANCE_PACKS } from '@/modules/admin/audit/AuditComplianceReportsPage';
import {
  RecoveryCenterPage,
  RECOVERY_CENTER_CARDS,
} from '@/modules/admin/recovery/RecoveryCenterPage';
import { DashboardPage } from '@/modules/dashboard/DashboardPage';
import { renderWithProviders } from './utils';
import { useAuth } from '@/store/auth';

function setUser(role: 'admin' | 'supervisor' | 'risk_analyst' | 'field_officer') {
  const user = {
    id: 'u-001',
    username: role === 'admin' ? 'alice.admin' : `test.${role}`,
    roles: [role] as ('admin' | 'supervisor' | 'risk_analyst' | 'field_officer')[],
  };
  localStorage.setItem('apex.ews.user', JSON.stringify(user));
  localStorage.setItem('apex.ews.token', 'mock.test.token');
  useAuth.setState({ status: 'authenticated', user: user as never, token: 'mock.test.token' });
}

function renderAudit() {
  return renderWithProviders(
    <Routes>
      <Route path="/audit-center" element={<AuditCenterPage />} />
      <Route path="/" element={<DashboardPage />} />
    </Routes>,
    { route: '/audit-center' },
  );
}

function renderCompliance() {
  return renderWithProviders(
    <Routes>
      <Route path="/audit-center/compliance" element={<AuditComplianceReportsPage />} />
      <Route path="/" element={<DashboardPage />} />
    </Routes>,
    { route: '/audit-center/compliance' },
  );
}

function renderRecovery() {
  return renderWithProviders(
    <Routes>
      <Route path="/recovery-center" element={<RecoveryCenterPage />} />
      <Route path="/" element={<DashboardPage />} />
    </Routes>,
    { route: '/recovery-center' },
  );
}

beforeEach(() => {
  localStorage.clear();
});

describe('AuditCenterPage', () => {
  it('admin sees the landing + all 5 cards', () => {
    setUser('admin');
    renderAudit();
    expect(screen.getByTestId('audit-center-page')).toBeInTheDocument();
    for (const card of AUDIT_CENTER_CARDS) {
      expect(screen.getByTestId(`audit-center-card-${card.id}`)).toBeInTheDocument();
    }
  });

  it('supervisor can see the page', () => {
    setUser('supervisor');
    renderAudit();
    expect(screen.getByTestId('audit-center-page')).toBeInTheDocument();
  });

  it('risk_analyst is redirected (below admin+supervisor gate)', () => {
    setUser('risk_analyst');
    renderAudit();
    expect(screen.queryByTestId('audit-center-page')).not.toBeInTheDocument();
  });

  it('renders backwards-compat legacy URL panel', () => {
    setUser('admin');
    renderAudit();
    expect(screen.getByTestId('audit-center-legacy-links')).toBeInTheDocument();
  });

  it('exports exactly 5 cards in canonical order', () => {
    const ids = AUDIT_CENTER_CARDS.map((c) => c.id);
    expect(ids).toEqual(['trail', 'login-audit', 'activity', 'export', 'compliance']);
  });

  it('every audit-center card declares a /audit-center/* target', () => {
    for (const card of AUDIT_CENTER_CARDS) {
      expect(card.to).toMatch(/^\/audit-center\//);
    }
  });
});

describe('AuditComplianceReportsPage', () => {
  it('admin sees the landing + all 6 compliance packs', () => {
    setUser('admin');
    renderCompliance();
    expect(screen.getByTestId('audit-compliance-reports-page')).toBeInTheDocument();
    expect(screen.getByTestId('audit-compliance-packs')).toBeInTheDocument();
    for (const pack of COMPLIANCE_PACKS) {
      expect(screen.getByTestId(`audit-compliance-pack-${pack.id}`)).toBeInTheDocument();
    }
  });

  it('every pack carries a regulator from the closed enum', () => {
    const allowed = new Set(['RBI', 'IRDAI', 'SOC 2', 'DPA 2019']);
    for (const pack of COMPLIANCE_PACKS) {
      expect(allowed.has(pack.regulator)).toBe(true);
    }
  });

  it('every pack links into Export Reports', () => {
    for (const pack of COMPLIANCE_PACKS) {
      expect(pack.exportTo).toBe('/audit-center/export');
    }
  });

  it('field_officer is redirected', () => {
    setUser('field_officer');
    renderCompliance();
    expect(screen.queryByTestId('audit-compliance-reports-page')).not.toBeInTheDocument();
  });
});

describe('RecoveryCenterPage', () => {
  it('admin sees the landing + all 10 cards', () => {
    setUser('admin');
    renderRecovery();
    expect(screen.getByTestId('recovery-center-page')).toBeInTheDocument();
    for (const card of RECOVERY_CENTER_CARDS) {
      expect(screen.getByTestId(`recovery-center-card-${card.id}`)).toBeInTheDocument();
    }
  });

  it('supervisor is redirected (recovery center is admin-only)', () => {
    setUser('supervisor');
    renderRecovery();
    expect(screen.queryByTestId('recovery-center-page')).not.toBeInTheDocument();
  });

  it('risk_analyst is redirected', () => {
    setUser('risk_analyst');
    renderRecovery();
    expect(screen.queryByTestId('recovery-center-page')).not.toBeInTheDocument();
  });

  it('exports exactly 10 cards in canonical order', () => {
    const ids = RECOVERY_CENTER_CARDS.map((c) => c.id);
    expect(ids).toEqual([
      'deleted', 'restore', 'permanent-delete', 'analytics',
      'workflow', 'history', 'search', 'policies', 'rbac', 'governance',
    ]);
  });

  it('permanent-delete card uses the danger tone', () => {
    const card = RECOVERY_CENTER_CARDS.find((c) => c.id === 'permanent-delete');
    expect(card?.tone).toBe('danger');
  });

  it('every recovery-center card declares a /recovery-center/* target', () => {
    for (const card of RECOVERY_CENTER_CARDS) {
      expect(card.to).toMatch(/^\/recovery-center\//);
    }
  });

  it('renders backwards-compat legacy URL panel', () => {
    setUser('admin');
    renderRecovery();
    expect(screen.getByTestId('recovery-center-legacy-links')).toBeInTheDocument();
  });
});
