import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import {
  WorkspaceContext,
  type WorkspaceContextValue,
} from '../../workspace/state/workspace.context';
import { AuthContext, type AuthContextValue } from '../../auth/state/auth.context';
import type { PullRequestSummary } from '@bevel-software/platform-shared';
import type { ToolSecrets } from '../../secrets-vault/services/tool-secrets.api';
import type { LibraryContextValue } from '../state/library-data';

// The page's data loading goes through the module's api service (which wraps
// authFetch), so the mocks sit there — same pattern as the other modules.
const apiMock = vi.hoisted(() => ({
  getSkill: vi.fn(),
  getSkillFile: vi.fn(),
  readFileOnBranch: vi.fn(),
  proposeChange: vi.fn(),
  mergePullRequest: vi.fn(),
  cancelPullRequest: vi.fn(),
}));
vi.mock('../services/library.api', () => ({
  DEFAULT_WORKSPACE_ID: 'target-company-state',
  getSkill: apiMock.getSkill,
  getSkillFile: apiMock.getSkillFile,
  readFileOnBranch: apiMock.readFileOnBranch,
  proposeChange: apiMock.proposeChange,
  listSkills: vi.fn(),
  listOpenChangeRequests: vi.fn(),
  listMyChangeRequests: vi.fn(),
  // Real behaviour, not a stub: the page resolves the caller's own request by
  // this branch name, so a `vi.fn()` returning undefined would quietly disable
  // the very lookup these tests are checking.
  suggestionBranchFor: (email: string, skill: string) =>
    `suggestions/${email.split('@')[0]}/${skill}`,
}));
vi.mock('../../pr/services/pr-merge.api', () => ({ mergePullRequest: apiMock.mergePullRequest }));
vi.mock('../../pr/services/pr-cancel.api', () => ({
  cancelPullRequest: apiMock.cancelPullRequest,
}));

// Keep the markdown pipeline (mermaid etc.) out of this test — the stub renders
// the raw source so assertions can see the body text.
vi.mock('../../workspace/components/renderers/KbMarkdownView', () => ({
  KbMarkdownView: ({ source }: { source: string }) => <div data-testid="md-view">{source}</div>,
}));

// The page reads the catalog through `useLibrary()`. Mocking the hook rather
// than mounting `LibraryProvider` keeps the provider's real fetch (and its N+1
// `getSkill`) out of a test about one page.
const libraryMock = vi.hoisted(() => ({ value: null as unknown }));
vi.mock('../state/library-data', () => ({
  useLibrary: () => libraryMock.value,
}));

import { SkillPage } from '../components/skill-page/SkillPage';

const workspace = {
  workspaceId: 'target-company-state',
  kbDirName: 'knowledge-base',
} as unknown as WorkspaceContextValue;

const auth = {
  user: { id: 'u1', email: 'razvan@bevel.software', name: 'Razvan' },
  token: 't',
  isLoading: false,
  login: async () => {},
  logout: () => {},
} as AuthContextValue;

const skillSummary = {
  name: 'newsletter',
  description: 'Drafts the Friday newsletter for review.',
  path: 'Skills/newsletter',
};

const skillDetail = {
  ...skillSummary,
  body: '# Newsletter drafter\nCollect the news and draft the letter.',
  allowedTools: ['slack_post_message'],
  files: ['Skills/newsletter/sources.yaml'],
};

const slackTool: ToolSecrets = {
  slug: 'slack',
  name: 'slack',
  path: 'Tools/slack.tool',
  type: 'http',
  setup: null,
  canWrite: false,
  variables: [
    {
      name: 'SIGNIN',
      scope: 'user',
      label: 'Slack sign-in',
      key: 'slack_SIGNIN',
      adminConfigured: true,
      userConfigured: false,
      oauth: true,
      authorized: false,
    },
  ],
};

/** An open change request from someone else, touching SKILL.md. */
const foreignCr = {
  number: 7,
  title: 'Changes from Olga — newsletter',
  author: { login: 'bevel-bot', name: 'Bevel Bot' },
  appAuthor: { name: 'Olga Martin' },
  branch: 'suggestions/olga/newsletter',
  base: 'main',
  state: 'open',
  createdAt: new Date().toISOString(),
  touchedNodePaths: ['Skills/newsletter/SKILL.md'],
  review: {},
  url: '',
} as unknown as PullRequestSummary;

function libraryValue(owned: boolean, crs: PullRequestSummary[] = [], mine: number[] = []): LibraryContextValue {
  return {
    crs,
    myCrNumbers: new Set(mine),
    items: [
      {
        kind: 'skill',
        id: 'newsletter',
        name: 'newsletter',
        description: skillSummary.description,
        owned,
        group: null,
        path: skillSummary.path,
        status: { state: 'ok', text: '' },
      },
    ],
    skills: [skillSummary],
    tools: [slackTool],
    allowedToolsBySkill: new Map([['newsletter', ['slack_post_message']]]),
    ownedSkills: owned ? new Set(['newsletter']) : new Set<string>(),
    loading: false,
    error: null,
    reload: () => {},
    groupSummaries: [],
    groupsLoading: false,
    groupsError: null,
    reloadGroups: () => {},
  } as unknown as LibraryContextValue;
}

function renderPage(owned: boolean, crs: PullRequestSummary[] = [], mine: number[] = []) {
  libraryMock.value = libraryValue(owned, crs, mine);
  return render(
    <MemoryRouter initialEntries={['/skills-and-tools/skills/newsletter']}>
      <AuthContext.Provider value={auth}>
        <WorkspaceContext.Provider value={workspace}>
          <Routes>
            <Route path="/skills-and-tools/skills/:name" element={<SkillPage />} />
          </Routes>
        </WorkspaceContext.Provider>
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

/**
 * SKILL.md as it sits in git — frontmatter and all. The skills API strips the
 * frontmatter off `skill.body`, so the difference between these two is exactly
 * the bug the raw-vs-raw rule exists to prevent.
 */
const RAW_MAIN = `---
name: newsletter
allowed-tools: [slack_post_message]
---
# Newsletter drafter
Collect the news and draft the letter.`;
const RAW_BRANCH = RAW_MAIN.replace('draft the letter', 'ship the letter');

beforeEach(() => {
  apiMock.getSkill.mockReset().mockResolvedValue(skillDetail);
  apiMock.getSkillFile.mockReset().mockResolvedValue('watchlist:\n  - topic: AI');
  apiMock.readFileOnBranch
    .mockReset()
    .mockImplementation((branch: string) =>
      Promise.resolve(branch.startsWith('suggestions/') ? RAW_BRANCH : RAW_MAIN),
    );
  apiMock.proposeChange.mockReset().mockResolvedValue({ branch: 'b' });
  apiMock.mergePullRequest.mockReset().mockResolvedValue(undefined);
  apiMock.cancelPullRequest.mockReset().mockResolvedValue(undefined);
});

describe('SkillPage', () => {
  it('loads the skill and shows its name, description, needed integrations and files', async () => {
    renderPage(false);

    expect(await screen.findByRole('heading', { name: 'newsletter' })).toBeInTheDocument();
    expect(screen.getByText('Drafts the Friday newsletter for review.')).toBeInTheDocument();
    expect(apiMock.getSkill).toHaveBeenCalledWith('newsletter');

    // Needed integration derived from allowed-tools, with its connection state.
    expect(screen.getByText('slack')).toBeInTheDocument();
    expect(screen.getByText('Needs your sign-in')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Connect/ })).toBeInTheDocument();

    // The files are TABS now, not a stacked list.
    expect(screen.getByRole('tab', { name: /SKILL\.md/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /sources\.yaml/ })).toBeInTheDocument();

    // SKILL.md body renders through the markdown view.
    expect(screen.getByTestId('md-view').textContent).toContain('Collect the news');
  });

  it('marks the open tab selected and loads a bundled file on click', async () => {
    renderPage(false);
    const tab = await screen.findByRole('tab', { name: /sources\.yaml/ });

    expect(screen.getByRole('tab', { name: /SKILL\.md/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    fireEvent.click(tab);
    await waitFor(() =>
      expect(apiMock.getSkillFile).toHaveBeenCalledWith('newsletter', 'sources.yaml'),
    );
    expect(await screen.findByText(/topic: AI/)).toBeInTheDocument();
    expect(tab).toHaveAttribute('aria-selected', 'true');
  });

  /**
   * `role="tablist"` promises a screen-reader user that arrows work. Selection
   * alone is not enough: the roving tabindex moves the tab stop, so focus has
   * to move with it or the ring is left on a tab that is no longer selected.
   */
  it('moves selection AND focus with the arrow keys', async () => {
    renderPage(false);
    const skillTab = await screen.findByRole('tab', { name: /SKILL\.md/ });
    const sourcesTab = screen.getByRole('tab', { name: /sources\.yaml/ });

    skillTab.focus();
    fireEvent.keyDown(skillTab, { key: 'ArrowRight' });

    expect(sourcesTab).toHaveAttribute('aria-selected', 'true');
    expect(sourcesTab).toHaveFocus();

    fireEvent.keyDown(sourcesTab, { key: 'ArrowLeft' });
    expect(skillTab).toHaveAttribute('aria-selected', 'true');
    expect(skillTab).toHaveFocus();
  });

  it('jumps to the first and last file with Home and End', async () => {
    renderPage(false);
    const skillTab = await screen.findByRole('tab', { name: /SKILL\.md/ });
    const sourcesTab = screen.getByRole('tab', { name: /sources\.yaml/ });

    skillTab.focus();
    fireEvent.keyDown(skillTab, { key: 'End' });
    expect(sourcesTab).toHaveAttribute('aria-selected', 'true');
    expect(sourcesTab).toHaveFocus();

    fireEvent.keyDown(sourcesTab, { key: 'Home' });
    expect(skillTab).toHaveAttribute('aria-selected', 'true');
    expect(skillTab).toHaveFocus();
  });

  it('wires each tab to a real panel, labelled by the open tab', async () => {
    renderPage(false);
    const skillTab = await screen.findByRole('tab', { name: /SKILL\.md/ });
    const panel = screen.getByRole('tabpanel');

    // Every tab points at a panel that actually exists…
    for (const tab of screen.getAllByRole('tab')) {
      expect(tab.getAttribute('aria-controls')).toBe(panel.id);
      expect(document.getElementById(tab.getAttribute('aria-controls')!)).not.toBeNull();
    }
    // …and the panel names the tab that is open.
    expect(panel.getAttribute('aria-labelledby')).toBe(skillTab.id);
  });

  /**
   * `aria-labelledby` is a space-separated IDREF list, so an unencoded
   * `notes draft.md` would reference two ids that do not exist and the panel
   * would lose its name. KB paths with spaces are ordinary here.
   */
  it('keeps a filename with a space as one valid IDREF', async () => {
    apiMock.getSkill.mockResolvedValue({
      ...skillDetail,
      files: ['Skills/newsletter/notes draft.md'],
    });
    renderPage(false);

    const tab = await screen.findByRole('tab', { name: /notes draft\.md/ });
    expect(tab.id).toContain('notes%20draft.md');
    expect(tab.id).not.toMatch(/\s/);

    fireEvent.click(tab);

    // One token, and it resolves to this tab.
    const labelledBy = screen.getByRole('tabpanel').getAttribute('aria-labelledby')!;
    expect(labelledBy).not.toMatch(/\s/);
    expect(labelledBy.split(' ')).toHaveLength(1);
    expect(document.getElementById(labelledBy)).toBe(tab);
  });

  it('keeps the panel wired while the editor replaces the reading pane', async () => {
    renderPage(false);
    fireEvent.click(await screen.findByRole('button', { name: 'Propose changes' }));
    await screen.findByRole('textbox', { name: /Propose changes to SKILL\.md/ });

    // aria-controls must not dangle just because the panel's contents swapped.
    const panel = screen.getByRole('tabpanel');
    expect(screen.getByRole('tab', { name: /SKILL\.md/ })).toHaveAttribute(
      'aria-controls',
      panel.id,
    );
  });

  it('shows the Owner badge to an owner — but never access', async () => {
    renderPage(true);
    await screen.findByRole('heading', { name: 'newsletter' });

    expect(screen.getByText('Owner')).toBeInTheDocument();
    // A skill inherits its group folder's rules; the group's Share panel is the
    // one place they are decided, for owner and non-owner alike.
    expect(screen.queryByRole('button', { name: 'Manage access' })).toBeNull();
  });

  it('hides the Owner badge from non-owners', async () => {
    renderPage(false);
    await screen.findByRole('heading', { name: 'newsletter' });

    expect(screen.queryByText('Owner')).toBeNull();
  });

  /**
   * One way to change a skill, for everyone. A direct-to-`main` `Edit` used to
   * sit beside Propose; it bypassed review and, on a protected branch, usually
   * ended in an AccessDenied after the user had already navigated away.
   */
  it('offers exactly one way to change the file — no direct-edit escape hatch', async () => {
    renderPage(true);
    // Propose appears once the file's raw text is in hand, so wait for it —
    // asserting Edit's absence before the bar has rendered proves nothing.
    expect(await screen.findByRole('button', { name: 'Propose changes' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  });

  /**
   * `getSkill` can take a while, and a page with no way out of it is a dead
   * end — the error and loaded states both carry the link, so this one does too.
   */
  it('keeps the way back on screen while the skill is loading', async () => {
    apiMock.getSkill.mockReturnValueOnce(new Promise(() => {}));
    renderPage(false);

    expect(await screen.findByText('Loading…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /All skills & tools/ })).toBeInTheDocument();
  });

  it('says so plainly when the skill cannot be loaded', async () => {
    apiMock.getSkill.mockRejectedValueOnce(new Error('nope'));
    renderPage(false);

    expect(
      await screen.findByText(/doesn't exist, or you don't have access to it/),
    ).toBeInTheDocument();
  });
});

describe('SkillPage — proposing a change', () => {
  it('seeds the editor from the RAW file, so frontmatter survives a proposal', async () => {
    renderPage(false);
    fireEvent.click(await screen.findByRole('button', { name: 'Propose changes' }));

    const box = await screen.findByRole('textbox', { name: /Propose changes to SKILL\.md/ });
    // Not `skill.body` — that has had the frontmatter parsed off, and the
    // editor's text is written back as the WHOLE file.
    await waitFor(() => expect(box).toHaveValue(RAW_MAIN));
    expect((box as HTMLTextAreaElement).value).toContain('allowed-tools:');
    // The reassurance sits where the fear is.
    expect(screen.getByText(/Nothing changes until .* approves it/)).toBeInTheDocument();
  });

  it('sends the whole new text', async () => {
    renderPage(false);
    fireEvent.click(await screen.findByRole('button', { name: 'Propose changes' }));
    const box = await screen.findByRole('textbox', { name: /Propose changes to SKILL\.md/ });
    await waitFor(() => expect(box).toHaveValue(RAW_MAIN));

    const next = RAW_MAIN.replace('draft the letter', 'rewrite the letter');
    fireEvent.change(box, { target: { value: next } });
    fireEvent.click(screen.getByRole('button', { name: 'Propose changes' }));

    await waitFor(() => expect(apiMock.proposeChange).toHaveBeenCalled());
    expect(apiMock.proposeChange.mock.calls[0][0]).toMatchObject({
      skillName: 'newsletter',
      repoRelativePath: 'Skills/newsletter/SKILL.md',
      content: next,
    });
  });

  it("writes back in the file's own line endings", async () => {
    const crlfMain = RAW_MAIN.replace(/\n/g, '\r\n');
    apiMock.readFileOnBranch.mockImplementation((branch: string) =>
      Promise.resolve(branch.startsWith('suggestions/') ? RAW_BRANCH : crlfMain),
    );
    renderPage(false);
    fireEvent.click(await screen.findByRole('button', { name: 'Propose changes' }));
    const box = await screen.findByRole('textbox', { name: /Propose changes to SKILL\.md/ });
    await waitFor(() => expect((box as HTMLTextAreaElement).value.length).toBeGreaterThan(10));

    // What a real textarea hands back: LF, whatever went in.
    fireEvent.change(box, {
      target: { value: RAW_MAIN.replace('draft the letter', 'ship the letter') },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Propose changes' }));

    await waitFor(() => expect(apiMock.proposeChange).toHaveBeenCalled());
    const sent: string = apiMock.proposeChange.mock.calls[0][0].content;
    // Restored to CRLF, so only the edited line differs on disk.
    expect(sent).toContain('\r\n');
    expect(sent).toBe(crlfMain.replace('draft the letter', 'ship the letter'));
  });

  /**
   * A trailing newline is an edit. The guard used to `.trim()` both sides and
   * answered "Nothing changed yet" to anyone who added one.
   */
  it('treats a whitespace-only edit at the file edges as a real change', async () => {
    renderPage(false);
    fireEvent.click(await screen.findByRole('button', { name: 'Propose changes' }));
    const box = await screen.findByRole('textbox', { name: /Propose changes to SKILL\.md/ });
    await waitFor(() => expect(box).toHaveValue(RAW_MAIN));

    fireEvent.change(box, { target: { value: `${RAW_MAIN}\n` } });
    fireEvent.click(screen.getByRole('button', { name: 'Propose changes' }));

    await waitFor(() => expect(apiMock.proposeChange).toHaveBeenCalled());
    expect(apiMock.proposeChange.mock.calls[0][0].content).toBe(`${RAW_MAIN}\n`);
  });

  /**
   * The other half of the same guard: a CRLF file read back through a textarea
   * comes out LF, so an exact `===` would call an untouched file "changed" and
   * open a change request with no diff in it.
   */
  it('still refuses an untouched CRLF file, which the textarea hands back as LF', async () => {
    const crlfMain = RAW_MAIN.replace(/\n/g, '\r\n');
    apiMock.readFileOnBranch.mockImplementation((branch: string) =>
      Promise.resolve(branch.startsWith('suggestions/') ? RAW_BRANCH : crlfMain),
    );
    renderPage(false);
    fireEvent.click(await screen.findByRole('button', { name: 'Propose changes' }));
    const box = await screen.findByRole('textbox', { name: /Propose changes to SKILL\.md/ });
    await waitFor(() => expect((box as HTMLTextAreaElement).value.length).toBeGreaterThan(10));

    // Exactly what a real textarea yields for untouched CRLF content.
    fireEvent.change(box, { target: { value: RAW_MAIN } });
    fireEvent.click(screen.getByRole('button', { name: 'Propose changes' }));

    expect(await screen.findByText(/Nothing changed yet/)).toBeInTheDocument();
    expect(apiMock.proposeChange).not.toHaveBeenCalled();
  });

  it('refuses to send an unedited file', async () => {
    renderPage(false);
    fireEvent.click(await screen.findByRole('button', { name: 'Propose changes' }));
    const box = await screen.findByRole('textbox', { name: /Propose changes to SKILL\.md/ });
    await waitFor(() => expect(box).toHaveValue(RAW_MAIN));
    fireEvent.click(screen.getByRole('button', { name: 'Propose changes' }));

    expect(await screen.findByText(/Nothing changed yet/)).toBeInTheDocument();
    expect(apiMock.proposeChange).not.toHaveBeenCalled();
  });
});

describe('SkillPage — deciding on a change', () => {
  it("shows a non-owner the change box without a verdict, and names who decides", async () => {
    renderPage(false, [foreignCr]);

    expect(await screen.findByText(/proposed a change/)).toBeInTheDocument();
    expect(screen.getByText('Pending approval')).toBeInTheDocument();
    expect(screen.getByText(/Waiting on/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Decline' })).toBeNull();
  });

  /**
   * Selected by ROLE, not by test id: the dock's `aria-label` only reaches
   * assistive tech because the element is an `<aside>`. On a bare div the name
   * is dropped, and this query is what would notice.
   */
  it('exposes the change-request dock as a named landmark', async () => {
    renderPage(true, [foreignCr]);

    expect(
      await screen.findByRole('complementary', { name: 'Change requests for this skill' }),
    ).toBeInTheDocument();
  });

  /**
   * `author.login` is the shared service account, and arrives as an opaque
   * `user-<hash>`. When the app user can't be resolved the surface must say so
   * neutrally rather than print the id as if it were a person.
   */
  it('never shows the service-account login as the author', async () => {
    const anonymous = { ...foreignCr, appAuthor: undefined } as unknown as PullRequestSummary;
    renderPage(true, [anonymous]);

    // Named in two places for an owner — the change box and the dock — so
    // assert on all of them rather than a single node.
    expect((await screen.findAllByText('Someone')).length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toContain('bevel-bot');
    expect(document.body.textContent).not.toContain('user-');
  });

  it('lets the owner approve, and merges the change request', async () => {
    renderPage(true, [foreignCr]);

    const approve = await screen.findByRole('button', { name: 'Approve' });
    expect(screen.getByText('You decide — you own this.')).toBeInTheDocument();

    fireEvent.click(approve);
    await waitFor(() => expect(apiMock.mergePullRequest).toHaveBeenCalledWith(7));
  });

  it('marks the box blocked when the merge comes back conflicted', async () => {
    apiMock.mergePullRequest.mockRejectedValueOnce(new Error('merge conflict in SKILL.md'));
    renderPage(true, [foreignCr]);

    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));

    expect(
      await screen.findByText(/these lines changed after this was written/),
    ).toBeInTheDocument();
    // A change that cannot land must not keep offering the button that fails.
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  /**
   * The empty string is not a stand-in for "hasn't loaded". Diffing `''`
   * against the branch copy marks every line as a change and paints the whole
   * file as rewritten — right beside an Approve button.
   */
  it('never renders a whole-file change while a side is still loading', async () => {
    // The deferred is built BEFORE the render, not captured as a side effect of
    // the mock being called: capturing it there races the component, and
    // releasing a resolver that was never reassigned hangs the wait below.
    let releaseMain!: (v: string) => void;
    const mainPending = new Promise<string>((res) => {
      releaseMain = res;
    });
    apiMock.readFileOnBranch.mockImplementation((branch: string) =>
      branch.startsWith('suggestions/') ? Promise.resolve(RAW_BRANCH) : mainPending,
    );

    renderPage(true, [foreignCr]);
    await screen.findByText(/proposed a change/);

    // Branch side in, main side still pending: no diff may be asserted yet.
    expect(screen.getByText('Loading the change…')).toBeInTheDocument();
    expect(document.querySelectorAll('ins')).toHaveLength(0);
    expect(document.querySelectorAll('del')).toHaveLength(0);

    releaseMain(RAW_MAIN);
    // Both sides in: exactly the one line that actually differs.
    await waitFor(() => expect(document.querySelectorAll('ins')).toHaveLength(1));
    expect(document.querySelectorAll('del')).toHaveLength(1);
  });

  /**
   * Someone landed the same edit first, so this file already reads as proposed.
   * Both verdicts act on the WHOLE change request, so neither may be offered
   * from a panel with nothing to show.
   */
  it('withholds both verdicts when the file already reads as proposed', async () => {
    // Branch copy identical to main ⇒ the hook reports an overtaken proposal.
    apiMock.readFileOnBranch.mockImplementation(() => Promise.resolve(RAW_MAIN));
    renderPage(true, [foreignCr]);

    expect(await screen.findByText('Already up to date')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Decline' })).toBeNull();
    // The route to the rest of the change request stays.
    expect(screen.getByRole('button', { name: 'Read the whole change' })).toBeInTheDocument();
  });

  /**
   * `touchedNodePaths` is "Empty if not yet computed". In that window every
   * path-derived check collapses together — so the page used to offer a second
   * editor, and submitting it opened a SECOND change request against a branch
   * that already had one. Resolving by branch closes the window.
   */
  it("recognises the caller's own request before its touched paths are computed", async () => {
    const uncomputed = {
      ...foreignCr,
      appAuthor: { name: 'Razvan' },
      branch: 'suggestions/razvan/newsletter',
      touchedNodePaths: [],
    } as unknown as PullRequestSummary;

    renderPage(false, [uncomputed], [uncomputed.number]);
    await screen.findByRole('heading', { name: 'newsletter' });

    // No second editor over the top of a request that already exists.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Propose changes' })).toBeNull(),
    );
  });

  it('offers the author Withdraw instead of a verdict, and only once per file', async () => {
    renderPage(false, [foreignCr], [7]);

    const withdraw = await screen.findByRole('button', { name: 'Withdraw' });
    // You already have a proposal on this file — a second would fork it.
    expect(screen.queryByRole('button', { name: 'Propose changes' })).toBeNull();

    fireEvent.click(withdraw);
    await waitFor(() => expect(apiMock.cancelPullRequest).toHaveBeenCalledWith(7));
  });
});
