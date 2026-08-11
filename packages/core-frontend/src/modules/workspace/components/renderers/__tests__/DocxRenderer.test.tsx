import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import {
  WorkspaceContext,
  type WorkspaceContextValue,
} from '../../../state/workspace.context';

// mammoth is the untrusted-content boundary under test: it faithfully copies
// a hyperlink's target out of the `.docx`, so we make it return exactly what
// it would emit for a document crafted with a `javascript:` hyperlink.
const mammothMock = vi.hoisted(() => ({ convertToHtml: vi.fn() }));
vi.mock('mammoth/mammoth.browser.js', () => ({ default: mammothMock }));

const apiMock = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('../../../../../lib/api', () => ({ authFetch: apiMock.authFetch }));

import { DocxRenderer } from '../DocxRenderer';

function renderDocx() {
  return render(
    <WorkspaceContext.Provider
      value={{ workspaceId: 'ws-1' } as unknown as WorkspaceContextValue}
    >
      <DocxRenderer filePath="Inbox/report.docx" content="" onSave={async () => {}} />
    </WorkspaceContext.Provider>,
  );
}

beforeEach(() => {
  apiMock.authFetch.mockReset().mockResolvedValue({
    ok: true,
    arrayBuffer: async () => new ArrayBuffer(8),
  });
  mammothMock.convertToHtml.mockReset();
});

/**
 * The sanitizer has its own unit tests; this one proves it is actually WIRED
 * into the sink. `DocxRenderer` injects with `dangerouslySetInnerHTML` into
 * the app origin, so a regression that drops the sanitize call would be
 * invisible to the sanitizer's own tests — and would hand every reader of an
 * uploaded document a one-click XSS.
 */
describe('DocxRenderer', () => {
  it('renders no script-capable link from a malicious document', async () => {
    mammothMock.convertToHtml.mockResolvedValue({
      value: '<p><a href="javascript:fetch(\'/api/steal\')">Download the Q3 figures</a></p>',
    });
    const { container } = renderDocx();

    await waitFor(() => expect(screen.getByText('Download the Q3 figures')).toBeInTheDocument());
    const anchor = container.querySelector('a')!;
    expect(anchor.getAttribute('href')).toBeNull();
    expect(container.innerHTML).not.toContain('javascript:');
  });

  it('leaves an ordinary document intact', async () => {
    mammothMock.convertToHtml.mockResolvedValue({
      value: '<h1>Quarterly report</h1><p><a href="https://example.com">source</a></p>',
    });
    const { container } = renderDocx();

    await waitFor(() => expect(screen.getByText('Quarterly report')).toBeInTheDocument());
    expect(container.querySelector('a')!.getAttribute('href')).toBe('https://example.com');
  });
});
