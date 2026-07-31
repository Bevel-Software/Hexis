import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { PrCancelConfirmDialog } from '../components/PrCancelConfirmDialog';

describe('PrCancelConfirmDialog', () => {
  it('renders title, body copy, and both action buttons', () => {
    render(<PrCancelConfirmDialog busy={false} onConfirm={() => {}} onCancel={() => {}} />);
    expect(screen.getByRole('heading', { name: /cancel this change request/i })).toBeInTheDocument();
    expect(screen.getByText(/won't delete your draft/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /keep open/i })).toBeInTheDocument();
    // The bottom confirm button has the destructive label.
    expect(screen.getByRole('button', { name: /^cancel change request$/i })).toBeInTheDocument();
  });

  it('Escape key fires onCancel when not busy', () => {
    const onCancel = vi.fn();
    render(<PrCancelConfirmDialog busy={false} onConfirm={() => {}} onCancel={onCancel} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('Escape is suppressed while busy', () => {
    const onCancel = vi.fn();
    render(<PrCancelConfirmDialog busy={true} onConfirm={() => {}} onCancel={onCancel} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('Keep open button fires onCancel; Cancel change request button fires onConfirm', () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(<PrCancelConfirmDialog busy={false} onConfirm={onConfirm} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: /keep open/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: /^cancel change request$/i }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('confirm button shows Cancelling… and is disabled when busy', () => {
    render(<PrCancelConfirmDialog busy={true} onConfirm={() => {}} onCancel={() => {}} />);
    const btn = screen.getByRole('button', { name: /cancelling/i });
    expect(btn).toBeDisabled();
  });
});
