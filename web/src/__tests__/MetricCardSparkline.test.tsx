// web/src/__tests__/MetricCardSparkline.test.tsx
//
// P0h — MetricCard sparkline + trend indicator (additive optional props).
// Pure `buildSparkPath` coverage + render assertions for the new chip + SVG.

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { MetricCard, buildSparkPath } from '@/components/ui/MetricCard';

describe('buildSparkPath', () => {
  it('returns empty string for series shorter than 2', () => {
    expect(buildSparkPath([])).toBe('');
    expect(buildSparkPath([42])).toBe('');
  });

  it('emits an M move-to + L line-to pair per point', () => {
    const path = buildSparkPath([0, 1, 2], 100, 20);
    expect(path).toMatch(/^M /);
    expect(path.match(/L /g)?.length).toBe(2); // 3 points → 1 M + 2 L
  });

  it('handles constant series (range=0) without dividing by zero', () => {
    const path = buildSparkPath([5, 5, 5, 5]);
    expect(path).toMatch(/^M /);
    expect(path).not.toMatch(/NaN|Infinity/);
  });
});

describe('MetricCard — sparkline + trend (additive)', () => {
  function renderCard(props: Parameters<typeof MetricCard>[0]) {
    return render(
      <MemoryRouter>
        <MetricCard {...props} />
      </MemoryRouter>,
    );
  }

  it('renders neither chip nor sparkline by default (backward-compat)', () => {
    renderCard({ label: 'Customers', value: '10,000', testId: 'kpi' });
    expect(screen.queryByTestId('metric-trend')).not.toBeInTheDocument();
    expect(screen.queryByTestId('metric-sparkline')).not.toBeInTheDocument();
    expect(screen.getByText('Customers')).toBeInTheDocument();
    expect(screen.getByText('10,000')).toBeInTheDocument();
  });

  it('renders the trend chip when `trend` is supplied', () => {
    renderCard({
      label: 'Open alerts',
      value: 18,
      trend: { direction: 'up', value: '+12%' },
      testId: 'kpi',
    });
    const chip = screen.getByTestId('metric-trend');
    expect(chip).toBeInTheDocument();
    expect(chip).toHaveAttribute('data-trend-direction', 'up');
    expect(chip).toHaveTextContent('+12%');
  });

  it('renders the sparkline when `series` is supplied with >= 2 points', () => {
    renderCard({
      label: 'PD trend',
      value: '0.42',
      series: [0.2, 0.3, 0.35, 0.42],
      testId: 'kpi',
    });
    expect(screen.getByTestId('metric-sparkline')).toBeInTheDocument();
  });

  it('renders BOTH together when both props supplied', () => {
    renderCard({
      label: 'NPA share',
      value: '4.25%',
      trend: { direction: 'down', value: '-0.3 pp' },
      series: [4.5, 4.4, 4.3, 4.25],
      testId: 'kpi',
    });
    expect(screen.getByTestId('metric-trend')).toHaveAttribute('data-trend-direction', 'down');
    expect(screen.getByTestId('metric-sparkline')).toBeInTheDocument();
  });

  it('does NOT render sparkline for a single-point series', () => {
    renderCard({ label: 'Solo', value: '1', series: [42], testId: 'kpi' });
    expect(screen.queryByTestId('metric-sparkline')).not.toBeInTheDocument();
  });
});
