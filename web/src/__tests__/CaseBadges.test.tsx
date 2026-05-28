// Phase 4 — reusable case workflow chips.

import { describe, test, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  CaseStatusBadge,
  CasePriorityBadge,
  CaseSlaBadge,
} from '@/components/cms/CaseBadges';

describe('CaseStatusBadge', () => {
  test('renders the status label', () => {
    render(<CaseStatusBadge status="INVESTIGATING" />);
    expect(screen.getByText('INVESTIGATING')).toBeInTheDocument();
  });
});

describe('CasePriorityBadge', () => {
  test('renders the priority label', () => {
    render(<CasePriorityBadge priority="P1" />);
    expect(screen.getByText('P1')).toBeInTheDocument();
  });
});

describe('CaseSlaBadge', () => {
  test('breached state', () => {
    render(<CaseSlaBadge sla={{ progress_pct: 120, breached: true, warning: false }} />);
    expect(screen.getByText(/SLA breached/)).toBeInTheDocument();
  });

  test('warning state shows the progress %', () => {
    render(<CaseSlaBadge sla={{ progress_pct: 75, breached: false, warning: true }} />);
    expect(screen.getByText(/SLA warn \(75%\)/)).toBeInTheDocument();
  });

  test('on-track state shows "SLA N%"', () => {
    render(<CaseSlaBadge sla={{ progress_pct: 40, breached: false, warning: false }} />);
    expect(screen.getByText('SLA 40%')).toBeInTheDocument();
  });

  test('breached takes precedence over warning', () => {
    render(<CaseSlaBadge sla={{ progress_pct: 130, breached: true, warning: true }} />);
    expect(screen.getByText(/SLA breached/)).toBeInTheDocument();
    expect(screen.queryByText(/SLA warn/)).not.toBeInTheDocument();
  });
});
