// web/src/__tests__/RiskTrendConfigDrawer.test.tsx
//
// Test coverage for the Enterprise Risk Trend Intelligence Configuration system.
// 8 tests: 3 pure-engine + 2 pure-engine (benchmark + forecast) + 3 UI.

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// ─── Engines ──────────────────────────────────────────────────────────────────

import {
  buildDefaultConfig,
  validateConfig,
  getDomainLabel,
  ALL_DOMAINS,
} from '@/modules/dashboard/riskTrend/riskTrendConfigurationEngine';

import {
  generateBenchmarkSeries,
} from '@/modules/dashboard/riskTrend/riskTrendBenchmarkEngine';

import {
  generateForecastSeries,
} from '@/modules/dashboard/riskTrend/riskTrendForecastEngine';

// ─── UI ───────────────────────────────────────────────────────────────────────

import { RiskTrendConfigDrawer } from '@/modules/dashboard/riskTrend/RiskTrendConfigDrawer';
import { AlertAnalyticsSection } from '@/components/dashboard/AlertAnalyticsSection';
import { api } from '@/lib/api';
import type { AlertListResponse } from '@/lib/api';

// Mock the API
vi.mock('@/lib/api', () => ({
  api: {
    alerts: vi.fn(),
  },
}));

const mockAlerts = vi.mocked(api.alerts);

function makeQC() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
    },
  });
}

function renderDrawer(open = true) {
  const config = buildDefaultConfig();
  const onChange = vi.fn();
  const onSave   = vi.fn();
  const onClose  = vi.fn();
  const onReset  = vi.fn();

  render(
    <RiskTrendConfigDrawer
      open={open}
      onClose={onClose}
      config={config}
      onChange={onChange}
      onSave={onSave}
      onReset={onReset}
    />,
  );
  return { config, onChange, onSave, onClose, onReset };
}

// ─── Test suites ──────────────────────────────────────────────────────────────

describe('riskTrendConfigurationEngine', () => {
  it('buildDefaultConfig returns a valid config object', () => {
    const cfg = buildDefaultConfig();
    expect(cfg.domains.length).toBeGreaterThan(0);
    expect(cfg.severities.length).toBe(4);
    expect(cfg.sources.length).toBeGreaterThan(0);
    expect(cfg.chartType).toBeDefined();
    expect(cfg.timeRange).toBeDefined();
    expect(cfg.granularity).toBeDefined();
  });

  it('validateConfig passes on a default config', () => {
    const cfg = buildDefaultConfig();
    const result = validateConfig(cfg);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('getDomainLabel returns non-empty strings for all domains', () => {
    for (const domain of ALL_DOMAINS) {
      const label = getDomainLabel(domain);
      expect(label).toBeTruthy();
      expect(typeof label).toBe('string');
      expect(label.length).toBeGreaterThan(0);
    }
  });
});

describe('riskTrendBenchmarkEngine', () => {
  it('generateBenchmarkSeries returns correct length', () => {
    const series = generateBenchmarkSeries('previous_month', 30, 'test-seed');
    expect(series).toHaveLength(30);
    series.forEach((point) => {
      expect(point).toHaveProperty('date');
      expect(point).toHaveProperty('current');
      expect(point).toHaveProperty('benchmark');
      expect(point).toHaveProperty('delta');
      expect(typeof point.current).toBe('number');
      expect(typeof point.benchmark).toBe('number');
    });
  });
});

describe('riskTrendForecastEngine', () => {
  it('generateForecastSeries returns historical + forecast points', () => {
    const historical = [40, 45, 38, 52, 48, 55, 60, 57, 62, 65];
    const series = generateForecastSeries(historical, 30, 'test-seed');

    const historicalPoints = series.filter((p) => !p.is_forecast);
    const forecastPoints   = series.filter((p) =>  p.is_forecast);

    expect(historicalPoints).toHaveLength(historical.length);
    expect(forecastPoints).toHaveLength(30);

    forecastPoints.forEach((p) => {
      expect(p.lower).toBeLessThanOrEqual(p.value);
      expect(p.upper).toBeGreaterThanOrEqual(p.value);
    });
  });
});

describe('RiskTrendConfigDrawer UI', () => {
  it('drawer renders with correct testid when open=true', () => {
    renderDrawer(true);
    expect(screen.getByTestId('risk-trend-config-drawer')).toBeInTheDocument();
    expect(screen.getByTestId('config-section-nav')).toBeInTheDocument();
    expect(screen.getByTestId('config-center-panel')).toBeInTheDocument();
    expect(screen.getByTestId('config-preview-panel')).toBeInTheDocument();
  });

  it('clicking a section nav item makes it active', () => {
    renderDrawer(true);
    // The default active section is 'domains'. Click 'metrics'.
    const metricsNav = screen.getByTestId('config-nav-metrics');
    fireEvent.click(metricsNav);
    // After clicking, the metrics section controls should be visible
    expect(screen.getByTestId('metric-radio-group')).toBeInTheDocument();
  });

  it('configure button renders in AlertAnalyticsSection', async () => {
    const emptyResponse: AlertListResponse = { items: [], total: 0 };
    mockAlerts.mockResolvedValue(emptyResponse);

    const qc = makeQC();
    render(
      <MemoryRouter>
        <QueryClientProvider client={qc}>
          <AlertAnalyticsSection />
        </QueryClientProvider>
      </MemoryRouter>,
    );

    // The configure button should be rendered even in empty/loading state
    // Wait for it to appear (loading state first)
    await screen.findByTestId('alert-analytics-configure-btn');
    expect(screen.getByTestId('alert-analytics-configure-btn')).toBeInTheDocument();
  });
});
