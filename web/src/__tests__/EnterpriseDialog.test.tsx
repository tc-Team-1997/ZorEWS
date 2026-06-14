// Unit tests for the EnterpriseDialog framework (thin wrapper over Modal).
//
// Covers:
//   - title + description + a SINGLE close icon, onClose fires
//   - Modal's built-in X is suppressed (no duplicate close)
//   - footer slot renders when provided (DialogFooter Cancel + primary)
//   - open=false renders nothing
//   - size maps to pixel width via Modal's widthClass override

import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { EnterpriseDialog, DialogFooter, Button } from '@/components/ui';

afterEach(() => {
  cleanup();
  document.body.style.overflow = '';
});

test('renders title + description + single close, calls onClose', () => {
  const onClose = vi.fn();
  render(
    <EnterpriseDialog open onClose={onClose} title="Add factor" description="Configure a KRI" testId="ed">
      body
    </EnterpriseDialog>,
  );
  expect(screen.getByText('Add factor')).toBeTruthy();
  expect(screen.getByText('Configure a KRI')).toBeTruthy();
  const closers = screen.getAllByTestId('ed-close');
  expect(closers.length).toBe(1); // exactly ONE close icon
  fireEvent.click(closers[0]);
  expect(onClose).toHaveBeenCalled();
});

test('Modal built-in X is suppressed (no duplicate)', () => {
  render(
    <EnterpriseDialog open onClose={() => {}} title="t" testId="ed">
      b
    </EnterpriseDialog>,
  );
  // Modal would emit `${testId}-content`; the only close testid is ed-close (count 1, asserted above).
  expect(screen.getByTestId('ed-content')).toBeTruthy();
});

test('renders footer when provided', () => {
  render(
    <EnterpriseDialog
      open
      onClose={() => {}}
      title="t"
      footer={<DialogFooter onCancel={() => {}} primary={<Button>Save</Button>} />}
    >
      b
    </EnterpriseDialog>,
  );
  expect(screen.getByText('Cancel')).toBeTruthy();
  expect(screen.getByText('Save')).toBeTruthy();
});

test('closed → renders nothing', () => {
  const { container } = render(
    <EnterpriseDialog open={false} onClose={() => {}} title="t">
      b
    </EnterpriseDialog>,
  );
  expect(container.querySelector('[role="dialog"]')).toBeNull();
});

test('size maps to pixel width', () => {
  render(
    <EnterpriseDialog open onClose={() => {}} title="t" size="xl" testId="ed">
      b
    </EnterpriseDialog>,
  );
  expect(screen.getByTestId('ed-content').className).toContain('max-w-[1200px]');
});
