import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  WorkspaceContext,
  type WorkspaceContextValue,
} from '../../../state/workspace.context';

const apiMock = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('../../../../../lib/api', () => ({ authFetch: apiMock.authFetch }));

import { getFileRenderer } from '../index';
import { LegacyOfficeRenderer } from '../LegacyOfficeRenderer';
import { TextRenderer } from '../TextRenderer';
import { ImageRenderer } from '../ImageRenderer';

/**
 * The extension → renderer routing. The document viewers are code-split, so
 * the map holds anonymous lazy wrappers rather than the components
 * themselves — `lazyRenderer` stamps each wrapper with a
 * `displayName` naming what it loads, and THAT is the identity pinned here.
 * Asserting through the display name keeps this test from importing (and
 * thereby eagerly loading) the heavy chunks the wrappers exist to defer.
 */
function rendererName(component: unknown): string {
  const c = component as { displayName?: string; name?: string };
  return c.displayName ?? c.name ?? '';
}

describe('getFileRenderer: document routing', () => {
  it.each([
    ['Inbox/brief.pdf', 'LazyRenderer(PDF)'],
    ['Inbox/BRIEF.PDF', 'LazyRenderer(PDF)'],
    ['Data/book.xlsx', 'LazyRenderer(spreadsheet)'],
    ['Inbox/report.docx', 'LazyRenderer(document)'],
    ['Inbox/all-hands.pptx', 'LazyRenderer(presentation)'],
  ])('routes %s to its lazy viewer %s', (path, expected) => {
    expect(rendererName(getFileRenderer(path))).toBe(expected);
  });

  it.each(['old/memo.doc', 'old/deck.ppt', 'old/sheet.xls', 'old/SHOUTY.DOC'])(
    'routes the legacy %s to the legacy-format note, never the text fallback',
    (path) => {
      expect(getFileRenderer(path)).toBe(LegacyOfficeRenderer);
    },
  );

  it('keeps the existing routes: unknown extensions fall back to text, images stay images', () => {
    expect(getFileRenderer('notes/scratch.unknown')).toBe(TextRenderer);
    expect(getFileRenderer('pics/logo.png')).toBe(ImageRenderer);
  });
});

describe('LegacyOfficeRenderer', () => {
  beforeEach(() => {
    apiMock.authFetch.mockReset();
  });

  function renderLegacy(filePath: string) {
    return render(
      <WorkspaceContext.Provider
        value={{ workspaceId: 'ws-1' } as unknown as WorkspaceContextValue}
      >
        <LegacyOfficeRenderer filePath={filePath} content="" onSave={async () => {}} />
      </WorkspaceContext.Provider>,
    );
  }

  it.each([
    ['old/memo.doc', 'Word', '.docx'],
    ['old/deck.ppt', 'PowerPoint', '.pptx'],
    ['old/sheet.xls', 'Excel', '.xlsx'],
  ])('for %s: names the format, points at %s → %s, and offers Download', (path, label, modern) => {
    renderLegacy(path);
    const note = screen.getByText(/legacy .* format/);
    expect(note.textContent).toContain(label);
    expect(note.textContent).toContain(modern);
    expect(screen.getByRole('button', { name: /Download/ })).toBeInTheDocument();
    // A note, not a parse attempt: nothing was fetched.
    expect(apiMock.authFetch).not.toHaveBeenCalled();
  });
});
