import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type {
  BranchInfo,
  CommitAttribution,
  WorkingTreeStatus,
} from '@bevel-software/platform-shared';

// BranchSwitcher fetches `roles.yaml` access on mount to determine whether the
// current user is an admin (the backend treats "can write roles.yaml" as the
// admin-membership signal). Default the mock to `canWrite: false` so the
// existing author-only / dropdown tests keep their non-admin semantics;
// admin-specific cases below override the resolved value in `beforeEach`.
vi.mock('../../access/api', () => ({
  fetchFileAccess: vi.fn().mockResolvedValue({
    canWrite: false,
      canDownload: false,
    eligible: { roles: [], users: [] },
  }),
}));
import { fetchFileAccess } from '../../access/api';

import { BranchSwitcher } from '../components/BranchSwitcher';
import { GitContext, type GitContextValue } from '../state/git.context';
import { ReviewContext, type ReviewContextValue } from '../../review/state/review.context';
import { AuthContext, type AuthContextValue } from '../../auth/state/auth.context';
import {
  WorkspaceContext,
  type WorkspaceContextValue,
} from '../../workspace/state/workspace.context';

function makeAttr(): CommitAttribution {
  return {
    sha: 'abcdef1234567890',
    authorName: 'Alice',
    authorEmail: 'alice@example.com',
    subject: 's',
    committedAt: '2026-04-29T00:00:00Z',
  };
}

function makeStatus(overrides: Partial<WorkingTreeStatus> = {}): WorkingTreeStatus {
  return {
    branch: 'alice/draft',
    hasUpstream: true,
    unmergedFromUpstream: false,
    ...overrides,
  };
}

function makeGit(overrides: Partial<GitContextValue> = {}): GitContextValue {
  const branches: BranchInfo[] = [];
  return {
    status: makeStatus(),
    branches,
    availability: 'ready',
    lastError: null,
    refreshStatus: async () => null,
    refreshBranches: async () => {},
    createBranch: async () => {},
    deleteBranch: async () => {},
    pull: async () => {},
    fetchForkBase: async () => null,
    revert: async () => makeAttr(),
    fetchFileHistory: async () => [],
    fetchFileDiff: async () => '',
    fetchFileAtChange: async () => ({ baseline: null, current: null }),
    fetchFileComparison: async () => '',
    ...overrides,
  };
}

function makeReview(overrides: Partial<ReviewContextValue> = {}): ReviewContextValue {
  return {
    session: null,
    selectedPath: null,
    fileDiff: null,
    isLoadingDiff: false,
    lastError: null,
    isLoading: false,
    refresh: async () => {},
    selectPath: async () => {},
    acceptOne: async () => {},
    rejectOne: async () => {},
    acceptAll: async () => {},
    rejectAll: async () => {},
    clearError: () => {},
    ...overrides,
  };
}

// BranchSwitcher mounts DirtySwitchDialog + ShareChangesDialog (both closed),
// whose hook bodies still reach into Auth / Chat / Workspace / Review on mount.
const auth = {
  user: { id: 'u1', email: 'alice@example.com', name: 'Alice' },
  token: 't',
  isLoading: false,
  login: async () => {},
  logout: () => {},
} as unknown as AuthContextValue;

const workspace = {
  workspaceId: 'ws-1',
  openFilePath: null,
} as unknown as WorkspaceContextValue;

function renderSwitcher(git: GitContextValue = makeGit()) {
  return render(
    <MemoryRouter>
      <AuthContext.Provider value={auth}>
        <WorkspaceContext.Provider value={workspace}>
          <GitContext.Provider value={git}>
            <ReviewContext.Provider value={makeReview()}>
              <BranchSwitcher />
            </ReviewContext.Provider>
          </GitContext.Provider>
        </WorkspaceContext.Provider>
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

// The dropdown is portaled to document.body (position: fixed) so the toolbar's
// mobile second row — which clips with overflow-x-auto/overflow-y-hidden —
// cannot hide it. These tests guard that portal and the click-outside handler,
// which now has to span both the trigger and the portaled panel.
describe('BranchSwitcher dropdown', () => {
  const PANEL_ANCHOR = 'Start a shared draft…';

  it('portals the dropdown panel to document.body, outside the trigger wrapper', () => {
    renderSwitcher();
    const trigger = screen.getByTitle('Your active shared draft');
    expect(screen.queryByText(PANEL_ANCHOR)).toBeNull();

    fireEvent.click(trigger);

    const anchor = screen.getByText(PANEL_ANCHOR);
    const panel = anchor.closest('div.fixed');
    expect(panel).not.toBeNull();
    // Portaled straight to <body>, not nested in the BranchSwitcher wrapper —
    // that is what escapes the toolbar's overflow clip on mobile.
    expect(panel?.parentElement).toBe(document.body);
    const wrapper = trigger.closest('div.relative');
    expect(wrapper).not.toBeNull();
    expect(wrapper).not.toContainElement(anchor);
  });

  it('keeps the menu open when a click lands inside the portaled panel', () => {
    renderSwitcher();
    fireEvent.click(screen.getByTitle('Your active shared draft'));
    const anchor = screen.getByText(PANEL_ANCHOR);

    // Regression guard: the panel lives outside the trigger ref, so the
    // click-outside handler must also check panelRef — otherwise the first
    // mousedown inside the panel would close the menu before any click lands.
    fireEvent.mouseDown(anchor);

    expect(screen.getByText(PANEL_ANCHOR)).toBeInTheDocument();
  });

  it('closes the menu when a click lands outside both trigger and panel', () => {
    renderSwitcher();
    fireEvent.click(screen.getByTitle('Your active shared draft'));
    expect(screen.getByText(PANEL_ANCHOR)).toBeInTheDocument();

    fireEvent.mouseDown(document.body);

    expect(screen.queryByText(PANEL_ANCHOR)).toBeNull();
  });
});

// Delete affordance: a freshly-published draft has `hasRemote: true`, which
// the legacy `canDelete = !hasRemote && !isProtected && !current` rule hid
// (the orphan-cleanup mental model). Now the picker also offers delete for
// drafts authored by the current user (per `<email-localpart>/...` naming),
// and routes the destructive remote-delete through a confirm dialog.
describe('BranchSwitcher — author-can-delete affordance', () => {
  beforeEach(() => {
    vi.mocked(fetchFileAccess).mockResolvedValue({
      canRead: true,
      canWrite: false,
      canDownload: false,
      canOwner: false,
      eligible: { roles: [], users: [] },
      readers: { restricted: false, roles: [], users: [] },
      owners: { roles: [], users: [] },
      downloaders: { roles: [], users: [] },
      sources: {},
    });
  });

  function makeGitWithBranches(branches: BranchInfo[]): GitContextValue {
    // Status branch must be a non-protected draft (so the trigger label
    // stays "Your active shared draft") AND must NOT match any picker row
    // name (otherwise that row gets the `current` flag and canDelete
    // collapses regardless of authorship — different code path from the
    // one we're trying to test here).
    return makeGit({
      status: makeStatus({ branch: 'alice/elsewhere' }),
      branches,
    });
  }

  it("shows the delete button for the current user's own published draft", () => {
    renderSwitcher(makeGitWithBranches([
      {
        name: 'alice/my-draft',
        isProtected: false,
        ahead: 0,
        behind: 0,
        hasRemote: true,
      },
    ]));
    fireEvent.click(screen.getByTitle('Your active shared draft'));
    // aria-label mirrors the tooltip so screen-reader users hear the
    // destructive-action warning, not just "delete".
    expect(
      screen.getByLabelText(
        'Delete shared draft "alice/my-draft" — removes it for everyone',
      ),
    ).toBeInTheDocument();
  });

  it("hides the delete button for another user's draft", () => {
    renderSwitcher(makeGitWithBranches([
      {
        name: 'bob/other-draft',
        isProtected: false,
        ahead: 0,
        behind: 0,
        hasRemote: true,
      },
    ]));
    fireEvent.click(screen.getByTitle('Your active shared draft'));
    expect(
      screen.queryByLabelText(
        'Delete shared draft "bob/other-draft" — removes it for everyone',
      ),
    ).toBeNull();
  });

  it('keeps the orphan-cleanup path (hasRemote=false) deletable for anyone', () => {
    // PR merged + remote head pruned scenario: branch is local-only, anyone
    // who has it in their picker can tidy it up because there's nothing on
    // origin left to authorise against.
    renderSwitcher(makeGitWithBranches([
      {
        name: 'bob/merged-and-pruned',
        isProtected: false,
        ahead: 0,
        behind: 0,
        hasRemote: false,
      },
    ]));
    fireEvent.click(screen.getByTitle('Your active shared draft'));
    expect(
      screen.getByLabelText('Delete this draft (no longer shared)'),
    ).toBeInTheDocument();
  });
});

// Admin-can-delete affordance: when the current user is admin per the
// workspace's `roles.yaml` (signal: `canWrite('roles.yaml') === true`), the
// picker offers delete on any non-protected, non-current branch — including
// teammates' drafts AND unprefixed CLI branches with no author. Backend gate
// at `GitService.deleteBranch` is the authoritative check; this suite covers
// the UI surface only.
describe('BranchSwitcher — admin-can-delete affordance', () => {
  beforeEach(() => {
    vi.mocked(fetchFileAccess).mockResolvedValue({
      canRead: true,
      canWrite: true,
      canDownload: false,
      canOwner: false,
      eligible: { roles: ['Admin'], users: [] },
      readers: { restricted: false, roles: [], users: [] },
      owners: { roles: [], users: [] },
      downloaders: { roles: [], users: [] },
      sources: {},
    });
  });

  function makeGitWithBranches(branches: BranchInfo[]): GitContextValue {
    // Status branch is alice's elsewhere-draft so no row collides with
    // `current` (which would short-circuit canDelete regardless of admin).
    return makeGit({
      status: makeStatus({ branch: 'alice/elsewhere' }),
      branches,
    });
  }

  it("shows the delete button on another user's draft when the current user is admin", async () => {
    renderSwitcher(makeGitWithBranches([
      {
        name: 'bob/other-draft',
        isProtected: false,
        ahead: 0,
        behind: 0,
        hasRemote: true,
      },
    ]));
    fireEvent.click(screen.getByTitle('Your active shared draft'));
    // `findBy` waits for the admin-status fetch to resolve and re-render.
    expect(
      await screen.findByLabelText(
        'Delete shared draft "bob/other-draft" — removes it for everyone',
      ),
    ).toBeInTheDocument();
  });

  it('shows the delete button on an unprefixed CLI branch when the current user is admin', async () => {
    renderSwitcher(makeGitWithBranches([
      {
        name: 'fix/some-cli-branch',
        isProtected: false,
        ahead: 0,
        behind: 0,
        hasRemote: true,
      },
    ]));
    fireEvent.click(screen.getByTitle('Your active shared draft'));
    expect(
      await screen.findByLabelText(
        'Delete shared draft "fix/some-cli-branch" — removes it for everyone',
      ),
    ).toBeInTheDocument();
  });

  it('still hides delete on protected branches (admin power does not extend here)', async () => {
    renderSwitcher(makeGitWithBranches([
      {
        name: 'current-company-state',
        isProtected: true,
        ahead: 0,
        behind: 0,
        hasRemote: true,
      },
    ]));
    fireEvent.click(screen.getByTitle('Your active shared draft'));
    // Wait for the admin-status fetch to land so the assertion isn't racing
    // an in-flight re-render.
    await waitFor(() => {
      expect(vi.mocked(fetchFileAccess)).toHaveBeenCalled();
    });
    expect(screen.queryByLabelText(/^Delete /)).toBeNull();
  });
});
