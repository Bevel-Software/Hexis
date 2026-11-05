import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ToolRenderer } from '../ToolRenderer';
import { ConfirmProvider } from '../../../../../shared/components';

/**
 * "Replace with scaffold" over a file that already has contents asks first —
 * in the app's own dialog, which the browser cannot silence. Without it, a
 * suppressed built-in confirm answered "no" and the button did nothing.
 */

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ secrets: [], tools: [] }) })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderTool(content: string) {
  const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
  render(
    <ConfirmProvider>
      <ToolRenderer content={content} filePath="Tools/my_tool.tool" onSave={async () => undefined} />
    </ConfirmProvider>,
  );
  const textarea = () => document.querySelector('textarea') as HTMLTextAreaElement;
  return { confirmSpy, textarea };
}

describe('the .tool scaffold', () => {
  it("asks with today's question; Cancel keeps the contents", async () => {
    const { confirmSpy, textarea } = renderTool('not: [a manual');
    fireEvent.click(screen.getByRole('button', { name: 'http' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Replace the file contents with this scaffold?');
    expect(within(dialog).queryByText("Don't ask again")).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(textarea().value).toBe('not: [a manual');
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('Replace puts the scaffold in, even with the browser\'s dialogs suppressed', async () => {
    const { confirmSpy, textarea } = renderTool('not: [a manual');
    fireEvent.click(screen.getByRole('button', { name: 'http' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Replace' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(textarea().value).toContain('type: http'));
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('an empty file takes the scaffold without a question, as today', async () => {
    renderTool('');
    fireEvent.click(screen.getByRole('button', { name: 'inline' }));
    // An empty file opens in the form view; the scaffold makes it unsaved.
    expect(await screen.findByText('● unsaved')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
