import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { SnippetBlock } from '../SnippetBlock';

const { copyMock } = vi.hoisted(() => ({ copyMock: vi.fn<(text: string) => Promise<boolean>>() }));
vi.mock('../../../lib/clipboard', () => ({ copyToClipboard: copyMock }));

/** One click, then the copy's answer and the zero-delay state change it schedules. */
async function clickCopy() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Copy key' }));
  });
  await act(async () => {
    vi.advanceTimersByTime(0);
  });
}

describe('SnippetBlock', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    copyMock.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it('says Copied, then goes quiet again', async () => {
    copyMock.mockResolvedValue(true);
    render(<SnippetBlock value="bvl_key" copyLabel="Copy key" />);
    await clickCopy();
    expect(copyMock).toHaveBeenCalledWith('bvl_key');
    expect(screen.getByRole('status')).toHaveTextContent('Copied');
    act(() => {
      vi.advanceTimersByTime(1600);
    });
    expect(screen.getByRole('status')).toHaveTextContent('');
  });

  it('announces a repeat copy again', async () => {
    copyMock.mockResolvedValue(true);
    render(<SnippetBlock value="bvl_key" copyLabel="Copy key" />);
    await clickCopy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy key' }));
    });
    // Back to idle first, so the live region changes and is read again.
    expect(screen.getByRole('status')).toHaveTextContent('');
    await act(async () => {
      vi.advanceTimersByTime(0);
    });
    expect(screen.getByRole('status')).toHaveTextContent('Copied');
  });

  it('keeps a refused copy said, selects the text and calls onCopyFailed', async () => {
    copyMock.mockResolvedValue(false);
    const onCopyFailed = vi.fn();
    render(<SnippetBlock value="bvl_key" copyLabel="Copy key" onCopyFailed={onCopyFailed} />);
    await clickCopy();
    expect(onCopyFailed).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status')).toHaveTextContent('Copy failed');
    expect(window.getSelection()?.toString()).toBe('bvl_key');
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    // Still said long after a flash would have gone.
    expect(screen.getByText(/Your browser did not allow copying/)).toBeInTheDocument();
  });
});
