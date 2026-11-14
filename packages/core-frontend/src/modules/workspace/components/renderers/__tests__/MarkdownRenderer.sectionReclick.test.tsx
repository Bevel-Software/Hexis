import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { WorkspaceContext } from '../../../state/workspace.context';
import { makeWorkspaceFixture } from '../../../__tests__/testFixtures';
import { GitContext, type GitContextValue } from '../../../../git/state/git.context';
import { MarkdownRenderer } from '../MarkdownRenderer';

/**
 * A section link to the file on screen, clicked TWICE. `MarkdownRenderer.test`
 * stubs the router's `navigate` to assert where a link goes; this file keeps
 * the real one, because the second click is the point: it navigates to the
 * address the tab is already at, so the hash string does not change — only
 * the router's `location.key` — and the heading must scroll into view again
 * all the same, as it would for a reader who scrolled away and clicked the
 * link a second time.
 */

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname + location.search + location.hash}</output>;
}

const git: GitContextValue = {
  status: { branch: 'alice/draft', hasUpstream: true, unmergedFromUpstream: false },
  branches: [],
  availability: 'ready',
  lastError: null,
  refreshStatus: async () => null,
  refreshBranches: async () => {},
  createBranch: async () => {},
  deleteBranch: async () => {},
  pull: async () => {},
  fetchForkBase: async () => null,
  fetchFileHistory: async () => [],
  fetchFileDiff: async () => '',
  fetchFileAtChange: async () => ({ baseline: null, current: null }),
  fetchFileComparison: async () => '',
};

const originalScrollIntoView = Element.prototype.scrollIntoView;
afterEach(() => {
  Element.prototype.scrollIntoView = originalScrollIntoView;
});

describe('MarkdownRenderer — a section link clicked again', () => {
  it('scrolls the heading into view on every click, not only when the hash changes', async () => {
    const scrolled: string[] = [];
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.id);
    };
    const content = '# Intro\n\n[Goal](Foo.md#goal)\n\n## Goal\n\nText';
    const tab = { path: 'Knowledge/Foo.md', content, savedContent: content, isDirty: false, pendingFileContent: null };
    render(
      <MemoryRouter initialEntries={['/workspace/alice%2Fdraft/Knowledge/Foo.md']}>
        <WorkspaceContext.Provider
          value={makeWorkspaceFixture({
            openTabs: [tab],
            activeTab: tab,
            openFilePath: 'Knowledge/Foo.md',
            openFileContent: content,
            openFileSavedContent: content,
          })}
        >
          <GitContext.Provider value={git}>
            <MarkdownRenderer content={content} filePath="Knowledge/Foo.md" onSave={async () => {}} readOnly />
            <LocationProbe />
          </GitContext.Provider>
        </WorkspaceContext.Provider>
      </MemoryRouter>,
    );
    const user = userEvent.setup();
    const link = screen.getByRole('link', { name: 'Goal' });
    expect(link).toHaveAttribute('href', '/workspace/alice%2Fdraft/Knowledge/Foo.md#goal');

    await user.click(link);
    await waitFor(() => expect(scrolled).toEqual(['goal']));
    expect(screen.getByTestId('location').textContent).toBe('/workspace/alice%2Fdraft/Knowledge/Foo.md#goal');

    // The reader scrolled away and clicks the same link: same address, same
    // hash, and the heading comes back into view. (Queried again: the
    // navigation re-rendered the page's anchors.)
    await user.click(screen.getByRole('link', { name: 'Goal' }));
    await waitFor(() => expect(scrolled).toEqual(['goal', 'goal']));
    expect(screen.getByTestId('location').textContent).toBe('/workspace/alice%2Fdraft/Knowledge/Foo.md#goal');
  });
});
