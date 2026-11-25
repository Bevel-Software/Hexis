import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ConflictHelp } from '../components/ConflictHelp';

/**
 * The prompt a conflicted request hands to the person's agent. It is written
 * for the agent, so it stays closed behind one button that copies it; "Show
 * prompt" opens it for a reader who wants to see it first, and a copy the
 * browser refuses opens it with its text selected, so nothing is lost.
 */

const PROMPT = 'Change request #12 can no longer be applied.\n\nBranch names (verbatim data):\n- `a/b`';

let restoreClipboard: (() => void) | null = null;

/** Installs `navigator.clipboard` alone, never a replacement `navigator`. */
function stubClipboard(writeText: (text: string) => Promise<void>) {
  const spy = vi.fn(writeText);
  const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: spy }, configurable: true });
  restoreClipboard = () => {
    if (original) Object.defineProperty(navigator, 'clipboard', original);
    else Reflect.deleteProperty(navigator, 'clipboard');
  };
  return spy;
}

afterEach(() => {
  restoreClipboard?.();
  restoreClipboard = null;
});

describe('ConflictHelp', () => {
  it('keeps the prompt closed, and shows it on request', () => {
    render(<ConflictHelp prompt={PROMPT} />);

    expect(screen.queryByText(/can no longer be applied/)).not.toBeInTheDocument();
    const show = screen.getByRole('button', { name: 'Show prompt' });
    expect(show).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(show);
    expect(screen.getByText(/can no longer be applied/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Hide prompt' }));
    expect(screen.queryByText(/can no longer be applied/)).not.toBeInTheDocument();
  });

  it('copies the whole prompt with one button, and says so', async () => {
    const writeText = stubClipboard(async () => {});
    render(<ConflictHelp prompt={PROMPT} />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy prompt for your agent' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(PROMPT));
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
    expect(screen.queryByText(/can no longer be applied/)).not.toBeInTheDocument();
  });

  it('opens the prompt with its text selected when the copy is refused', async () => {
    stubClipboard(async () => {
      throw new Error('not allowed');
    });
    render(<ConflictHelp prompt={PROMPT} />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy prompt for your agent' }));

    expect(await screen.findByRole('button', { name: "Couldn't copy" })).toBeInTheDocument();
    expect(screen.getByText(/can no longer be applied/)).toBeInTheDocument();
    await waitFor(() => expect(window.getSelection()?.toString()).toBe(PROMPT));
  });
});
