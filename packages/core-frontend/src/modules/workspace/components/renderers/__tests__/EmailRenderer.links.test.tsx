import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import {
  WorkspaceContext,
  type WorkspaceContextValue,
} from '../../../state/workspace.context';
import { ConfirmProvider } from '../../../../../shared/components';

const apiMock = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('../../../../../lib/api', () => ({ authFetch: apiMock.authFetch }));

import { EmailRenderer } from '../EmailRenderer';

/**
 * Opening a link inside an email asks first, showing the real address — in
 * the app's own dialog, which the browser cannot silence.
 */

const URL = 'https://example.com/offer?id=7';
const EML = new TextEncoder().encode(
  [
    'From: Ada <ada@example.com>',
    'Subject: Offer',
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=utf-8',
    '',
    `<p>See <a href="${URL}">our offer</a>.</p>`,
    '',
  ].join('\r\n'),
).buffer as ArrayBuffer;

let openSpy: MockInstance<Window['open']>;
let confirmSpy: MockInstance<Window['confirm']>;
beforeEach(() => {
  apiMock.authFetch.mockReset();
  apiMock.authFetch.mockResolvedValue({ ok: true, arrayBuffer: async () => EML });
  openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
  // The browser's dialogs suppressed: never the thing that answers.
  confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
});
afterEach(() => {
  expect(confirmSpy).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

async function clickOpen() {
  render(
    <ConfirmProvider>
      <WorkspaceContext.Provider value={{ workspaceId: 'ws-1' } as unknown as WorkspaceContextValue}>
        <EmailRenderer filePath="Inbox/offer.eml" content="" onSave={async () => {}} />
      </WorkspaceContext.Provider>
    </ConfirmProvider>,
  );
  fireEvent.click(await screen.findByTitle('Open in a new tab'));
  return screen.findByRole('dialog');
}

describe('a link in an email', () => {
  it("asks with today's question and the address; Cancel opens nothing", async () => {
    const dialog = await clickOpen();
    expect(dialog.textContent).toContain(`Open this link?\n\n${URL}`);
    expect(within(dialog).queryByText("Don't ask again")).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('Open opens it in a new tab', async () => {
    const dialog = await clickOpen();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Open' }));
    await waitFor(() => expect(openSpy).toHaveBeenCalledWith(URL, '_blank', 'noopener,noreferrer'));
  });
});
