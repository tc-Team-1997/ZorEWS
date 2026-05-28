// Phase 3 — Dashboard Foundation: reusable primitive + container render tests.

import { describe, test, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EmptyState, Skeleton, SkeletonText, SkeletonCard } from '@/components/ui';
import { WidgetContainer } from '@/modules/dashboard/widgets';

describe('EmptyState', () => {
  test('renders title + description', () => {
    render(<EmptyState title="No alerts" description="You're all caught up." />);
    expect(screen.getByText('No alerts')).toBeInTheDocument();
    expect(screen.getByText("You're all caught up.")).toBeInTheDocument();
    expect(screen.getByTestId('empty-state')).toBeInTheDocument();
  });

  test('renders an action when provided', () => {
    render(<EmptyState title="No data" action={<button>Refresh</button>} />);
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument();
  });
});

describe('Skeleton primitives', () => {
  test('Skeleton renders a shimmer block', () => {
    render(<Skeleton className="h-4 w-20" />);
    expect(screen.getByTestId('skeleton')).toBeInTheDocument();
  });

  test('SkeletonText renders the requested number of lines', () => {
    const { container } = render(<SkeletonText lines={4} />);
    // 4 inner line blocks
    expect(container.querySelectorAll('[data-testid="skeleton"]')).toHaveLength(4);
  });

  test('SkeletonCard renders a title bar + body lines', () => {
    render(<SkeletonCard />);
    expect(screen.getByTestId('skeleton-card')).toBeInTheDocument();
  });
});

describe('WidgetContainer state precedence', () => {
  test('renders children when idle', () => {
    render(
      <WidgetContainer title="Portfolio Health">
        <div>widget body</div>
      </WidgetContainer>,
    );
    expect(screen.getByText('widget body')).toBeInTheDocument();
    expect(screen.queryByTestId('widget-loading')).not.toBeInTheDocument();
  });

  test('loading shows skeleton, hides children', () => {
    render(
      <WidgetContainer title="Portfolio Health" loading>
        <div>widget body</div>
      </WidgetContainer>,
    );
    expect(screen.getByTestId('widget-loading')).toBeInTheDocument();
    expect(screen.queryByText('widget body')).not.toBeInTheDocument();
  });

  test('empty shows empty state', () => {
    render(
      <WidgetContainer title="Fraud Alerts" empty emptyTitle="No fraud alerts">
        <div>widget body</div>
      </WidgetContainer>,
    );
    expect(screen.getByTestId('widget-empty')).toBeInTheDocument();
    expect(screen.getByText('No fraud alerts')).toBeInTheDocument();
  });

  test('error takes precedence over loading + empty', () => {
    render(
      <WidgetContainer title="Solvency Watch" error="boom" loading empty>
        <div>widget body</div>
      </WidgetContainer>,
    );
    expect(screen.getByTestId('widget-error')).toBeInTheDocument();
    expect(screen.queryByTestId('widget-loading')).not.toBeInTheDocument();
    expect(screen.queryByTestId('widget-empty')).not.toBeInTheDocument();
  });
});
