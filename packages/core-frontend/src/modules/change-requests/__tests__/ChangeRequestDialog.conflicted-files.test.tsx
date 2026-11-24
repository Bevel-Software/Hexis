import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { FileApprovalState, PullRequestSummary } from '@bevel-software/platform-shared';

/**
 * A request that conflicts with its target names the files that conflict.
 *
 * The request below changes two files and only one of them conflicts. When
 * the dialog's own bring-up-to-date is refused, the server's 409 names that
 * file (`conflictedPaths`). The dialog used to drop the list: its banner, the
 * prompt it offers to copy and its file tree said nothing about WHICH file,
 * so the person could not tell the conflicting file from the clean one.
 */

const prApi = vi.hoisted(() => ({
  fetchPrDetail: vi.fn(),
  refreshChangeRequestFromTarget: vi.fn(),
}));
vi.mock('../../pr', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../pr')>()),
  fetchPrDetail: prApi.fetchPrDetail,
  refreshChangeRequestFromTarget: prApi.refreshChangeRequestFromTarget,
}));
vi.mock('../services/change-requests.api', () => ({
  readFileOnBranch: vi.fn(async () => 'proposed\n'),
  readFileAtForkPoint: vi.fn(async (_n: number, sha: string) => ({ content: 'before\n', forkSha: sha })),
}));

import { ChangeRequestDialog } from '../components/ChangeRequestDialog';
import { GitApiError } from '../../git';

const CONFLICTING = 'Docs/alpha.md';
const CLEAN = 'Docs/gamma.md';
/** The tree mark's accessible name, and the tooltip it carries. */
const CONFLICT_MARK = "Can't be combined with what everyone sees";

const CR = {
  number: 41,
  title: 'Two files',
  authorId: 'abc',
  author: { login: 'user-abc', name: 'Ali' },
  appAuthor: { name: 'Ali' },
  branch: 'ali/two-files',
  base: 'main',
  state: 'open',
  createdAt: '2026-11-03T00:00:00.000Z',
  touchedNodePaths: [CONFLICTING, CLEAN],
  review: { approvals: 0, changesRequested: 0, pendingLogins: [] },
  url: '/change-requests/41',
} as unknown as PullRequestSummary;

const approval = (path: string): FileApprovalState => ({
  path,
  eligibleApprovers: { roles: ['Admin'], users: [] },
  approvedBy: [],
  inMergeGate: true,
  isApproved: false,
  viewerCanApprove: true,
});

const file = (path: string) => ({
  path,
  status: 'modified' as const,
  additions: 1,
  deletions: 1,
  isBinary: false,
  sha: '',
  rawUrl: '',
});

const DETAIL = {
  ...CR,
  body: '',
  headSha: 'h'.repeat(40),
  baseSha: 'b'.repeat(40),
  mergeBaseSha: 'f'.repeat(40),
  files: [file(CONFLICTING), file(CLEAN)],
  approvals: [approval(CONFLICTING), approval(CLEAN)],
  mergeableInBevel: true,
  mergeBlockedReasons: [],
  mergeWarnings: [],
  viewerCanBypassMerge: false,
  viewerCanCancel: true,
  behind: true,
  // The target moved in a file this request changes, and the reader (its
  // author) may bring it up to date, so opening the dialog runs the update.
  needsUpdate: true,
  viewerCanUpdate: true,
};

/** The route's 409, in the shape `ChangeRequestConflictsError` sends. */
const conflict = () =>
  new GitApiError(409, `Conflicts merging "main" into "ali/two-files".`, {
    kind: 'change-request-conflicts',
    sourceBranch: 'ali/two-files',
    targetBranch: 'main',
    conflictedPaths: [CONFLICTING],
    error: `Conflicts merging "main" into "ali/two-files".`,
  });

/** What the banner SAYS to the reader, without the prompt block it holds. */
function prose(el: HTMLElement): string {
  const copy = el.cloneNode(true) as HTMLElement;
  for (const block of copy.querySelectorAll('pre')) block.remove();
  return copy.textContent ?? '';
}

let restoreClipboard: (() => void) | null = null;

/** Installs `navigator.clipboard` alone, never a replacement `navigator`. */
function stubClipboard() {
  const writeText = vi.fn().mockResolvedValue(undefined);
  const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  restoreClipboard = () => {
    if (original) Object.defineProperty(navigator, 'clipboard', original);
    else Reflect.deleteProperty(navigator, 'clipboard');
  };
  return writeText;
}

beforeEach(() => {
  prApi.fetchPrDetail.mockReset().mockResolvedValue(DETAIL);
  prApi.refreshChangeRequestFromTarget.mockReset().mockRejectedValue(conflict());
});

afterEach(() => {
  restoreClipboard?.();
  restoreClipboard = null;
});

async function openConflicted() {
  render(<ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />);
  await waitFor(() => expect(prApi.refreshChangeRequestFromTarget).toHaveBeenCalledWith(41));
  return screen.findByRole('alert');
}

describe('ChangeRequestDialog: a conflicted request names the files that conflict', () => {
  it('names the conflicting file in the banner, and not the clean one', async () => {
    const banner = await openConflicted();

    expect(prose(banner)).toContain("the two can't be combined automatically");
    // By the name the tree shows it under, with its full path on hover.
    expect(within(banner).getByTitle(CONFLICTING).textContent).toBe('alpha.md');
    expect(prose(banner)).not.toContain('gamma.md');
  });

  it('names it in the prompt it offers to copy, and not the clean one', async () => {
    const writeText = stubClipboard();
    const banner = await openConflicted();

    fireEvent.click(within(banner).getByRole('button', { name: 'Copy' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const copied = writeText.mock.calls[0][0] as string;
    expect(copied).toContain(`\`${CONFLICTING}\``);
    expect(copied).not.toContain(CLEAN);
  });

  it('marks the conflicting file in the file tree, and not the clean one', async () => {
    await openConflicted();

    const rows = screen.getAllByRole('treeitem');
    const row = (path: string) => rows.find((r) => within(r).queryByTitle(path) !== null)!;
    expect(within(row(CONFLICTING)).getByRole('img', { name: CONFLICT_MARK })).toBeInTheDocument();
    expect(within(row(CLEAN)).queryByRole('img', { name: CONFLICT_MARK })).not.toBeInTheDocument();
  });
});
