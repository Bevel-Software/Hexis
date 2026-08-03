import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentType } from 'react';
import { lazyRenderer } from '../lazyRenderer';
import type { FileRendererProps } from '../types';

/**
 * The retry path, which is the only reason this factory is more than three
 * lines. `React.lazy` memoises the loader's REJECTION as well as its success:
 * the obvious implementation — one `lazy()` per renderer, an error boundary
 * that clears its own flag — renders a "Try again" button that can never
 * succeed, because it re-renders the same poisoned lazy component.
 */

function Loaded({ content }: FileRendererProps) {
  return <div>loaded: {content}</div>;
}

const props: FileRendererProps = {
  content: 'hello',
  filePath: 'book.xlsx',
  onSave: async () => {},
};

beforeEach(() => {
  // The boundary logs the caught chunk error; keep the run's output readable.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('lazyRenderer', () => {
  it('recovers when the first import fails and the retry succeeds', async () => {
    const loader = vi
      .fn<() => Promise<{ default: ComponentType<FileRendererProps> }>>()
      .mockRejectedValueOnce(new Error('chunk 404'))
      .mockResolvedValue({ default: Loaded });

    const Renderer = lazyRenderer('spreadsheet', loader);
    render(<Renderer {...props} />);

    // First attempt fails: the boundary catches and offers a way back.
    expect(await screen.findByText(/could not load the spreadsheet viewer/i)).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: /try again/i }));

    // The retry has to actually re-run the import — this is the assertion that
    // fails if `Try again` merely re-renders the cached rejection.
    await waitFor(() => {
      expect(screen.getByText(/loaded: hello/)).toBeTruthy();
    });
    expect(loader).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/could not load/i)).toBeNull();
  });

  it('renders the chunk without a retry when the first import succeeds', async () => {
    const loader = vi.fn().mockResolvedValue({ default: Loaded });

    const Renderer = lazyRenderer('document', loader);
    render(<Renderer {...props} />);

    expect(await screen.findByText(/loaded: hello/)).toBeTruthy();
    expect(loader).toHaveBeenCalledTimes(1);
  });
});
