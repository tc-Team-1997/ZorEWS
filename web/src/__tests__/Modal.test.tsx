// Unit tests for the shared ui/Modal primitive.
//
// Covers the contract surface exposed in ModalProps:
//   - open=false renders nothing
//   - open=true renders backdrop + content with correct ARIA
//   - backdrop click → onClose
//   - inner content click does NOT trigger onClose
//   - Escape key → onClose
//   - closeOnBackdrop=false disables backdrop click
//   - closeOnEsc=false disables Escape
//   - showCloseButton renders the X
//   - body scroll lock applied on open, restored on unmount

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Modal } from '@/components/ui/Modal';

afterEach(() => {
  cleanup();
  // Tests may unmount with a still-locked body — reset for the next test.
  document.body.style.overflow = '';
});

describe('Modal', () => {
  it('renders nothing when open=false', () => {
    const { container } = render(
      <Modal open={false} onClose={vi.fn()} ariaLabel="x" testId="t">
        <div>hidden</div>
      </Modal>,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders backdrop + content with role=dialog + aria-modal + aria-label', () => {
    render(
      <Modal open onClose={vi.fn()} ariaLabel="Create rule" testId="m">
        <div>inside</div>
      </Modal>,
    );
    const dialog = screen.getByRole('dialog', { name: /create rule/i });
    expect(dialog).toBeInTheDocument();
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(screen.getByText('inside')).toBeInTheDocument();
    expect(screen.getByTestId('m')).toBe(dialog);
    expect(screen.getByTestId('m-content')).toBeInTheDocument();
  });

  it('fires onClose on backdrop click', () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} ariaLabel="x" testId="m">
        <div>body</div>
      </Modal>,
    );
    fireEvent.click(screen.getByTestId('m'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire onClose when clicking inside the content', () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} ariaLabel="x" testId="m">
        <div data-testid="inner">body</div>
      </Modal>,
    );
    fireEvent.click(screen.getByTestId('inner'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('fires onClose on Escape key', () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} ariaLabel="x" testId="m">
        <div>body</div>
      </Modal>,
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('respects closeOnBackdrop=false', () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} ariaLabel="x" testId="m" closeOnBackdrop={false}>
        <div>body</div>
      </Modal>,
    );
    fireEvent.click(screen.getByTestId('m'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('respects closeOnEsc=false', () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} ariaLabel="x" testId="m" closeOnEsc={false}>
        <div>body</div>
      </Modal>,
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows the X close button by default + clicking it fires onClose', () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} ariaLabel="x" testId="m">
        <div>body</div>
      </Modal>,
    );
    const closeBtn = screen.getByTestId('m-close');
    expect(closeBtn).toBeInTheDocument();
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('hides the X when showCloseButton=false', () => {
    render(
      <Modal open onClose={vi.fn()} ariaLabel="x" testId="m" showCloseButton={false}>
        <div>body</div>
      </Modal>,
    );
    expect(screen.queryByTestId('m-close')).toBeNull();
  });

  it('locks body scroll while open + restores on unmount', () => {
    const { unmount } = render(
      <Modal open onClose={vi.fn()} ariaLabel="x" testId="m">
        <div>body</div>
      </Modal>,
    );
    expect(document.body.style.overflow).toBe('hidden');
    unmount();
    expect(document.body.style.overflow).toBe('');
  });

  it('applies the size prop to the content container max-width', () => {
    render(
      <Modal open onClose={vi.fn()} ariaLabel="x" testId="m" size="sm">
        <div>body</div>
      </Modal>,
    );
    expect(screen.getByTestId('m-content').className).toContain('max-w-sm');
  });

  it('uses widthClass override instead of the size default when provided', () => {
    render(
      <Modal open onClose={vi.fn()} ariaLabel="x" testId="m" widthClass="max-w-[720px]">
        <div>body</div>
      </Modal>,
    );
    const content = screen.getByTestId('m-content');
    expect(content.className).toContain('max-w-[720px]');
    expect(content.className).not.toContain('max-w-2xl');
  });

  it('falls back to the size default (max-w-2xl) when no widthClass is given', () => {
    render(
      <Modal open onClose={vi.fn()} ariaLabel="x" testId="m">
        <div>body</div>
      </Modal>,
    );
    expect(screen.getByTestId('m-content').className).toContain('max-w-2xl');
  });
});
