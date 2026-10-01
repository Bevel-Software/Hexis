import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { READ_PANE } from '../readPane';
import { RetryReadButton } from '../RetryReadButton';

/**
 * Where focus goes when a viewer's "Try again" removes itself from the page.
 *
 * Every byte-reading renderer returns its error block as its WHOLE output, so
 * the retry unmounts the button the reader just pressed and focus falls to
 * `document.body` — the next Tab then starts at the top of the page. The
 * handoff is in `RetryReadButton`, shared by all six viewers; the destination
 * is the host pane's own region, which it declares by spreading `READ_PANE`.
 */
describe('a viewer\'s retry hands focus to its host pane', () => {
  it('focuses the nearest READ_PANE ancestor, and does so before the retry runs', () => {
    // The order matters: the retry is what unmounts the button, so a handoff
    // that happened afterwards would be looking for focus on an element that
    // had already gone. Asserted by capturing `document.activeElement` from
    // inside the retry callback.
    const focusedWhenRetryRan = vi.fn();
    render(
      <div {...READ_PANE} data-testid="host">
        <RetryReadButton onRetry={() => focusedWhenRetryRan(document.activeElement)} />
      </div>,
    );
    const host = screen.getByTestId('host');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(focusedWhenRetryRan).toHaveBeenCalledWith(host);
    expect(document.activeElement).toBe(host);
  });

  it('leaves focus alone when no host declares a region', () => {
    // A pane that names no region keeps today's behaviour rather than throwing:
    // `closest` simply finds nothing.
    const onRetry = vi.fn();
    render(<RetryReadButton onRetry={onRetry} />);
    expect(() => fireEvent.click(screen.getByRole('button', { name: 'Try again' }))).not.toThrow();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  /**
   * The handoff only works where the HOST declares the region, so every place
   * that mounts a viewer has to. Read from the source rather than rendered,
   * because rendering `FileViewer` needs most of the app around it — and what
   * would regress here is a new host, or an old one losing the spread.
   */
  it.each([
    ['the file page', 'workspace/components/FileViewer.tsx'],
    ['Version history', 'git/components/HistoryVersionPreview.tsx'],
    ['the change-request dialog', 'change-requests/components/BranchFilePreview.tsx'],
  ])('%s marks its viewer host as a region', (_where, file) => {
    // Package root is vitest's working directory.
    expect(readFileSync(`src/modules/${file}`, 'utf8')).toContain('{...READ_PANE}');
  });
});
