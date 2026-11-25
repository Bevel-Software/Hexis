import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { FileApprovalState, PullRequestSummary } from '@bevel-software/platform-shared';

/**
 * A request that conflicts with its target names the files that conflict.
 *
 * The request below changes two files and only one of them conflicts. When
 * the dialog's own bring-up-to-date is refused, the server's 409 names that
 * file (`conflictedPaths`); when this tab's apply is refused on a conflict,
 * the clicker's refusal event names them. The dialog used to drop the list:
 * its banner, the prompt it offers to copy and its file tree said nothing
 * about WHICH file, so the person could not tell the conflicting file from
 * the clean one.
 */

const prApi = vi.hoisted(() => ({
  fetchPrDetail: vi.fn(),
  refreshChangeRequestFromTarget: vi.fn(),
  mergePullRequest: vi.fn(),
  approvePrFile: vi.fn(),
}));
vi.mock('../../pr', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../pr')>()),
  ...prApi,
}));
/** The one clipboard helper the prompt's Copy goes through. */
const clipboard = vi.hoisted(() => ({ copyToClipboard: vi.fn() }));
vi.mock('../../../lib/clipboard', () => clipboard);
vi.mock('../services/change-requests.api', () => ({
  readFileOnBranch: vi.fn(async () => 'proposed\n'),
  readFileAtForkPoint: vi.fn(async (_n: number, sha: string) => ({ content: 'before\n', forkSha: sha })),
}));
/** The event bus the dialog and its apply listen on, driven by the test. */
const bus = vi.hoisted(() => {
  const handlers = new Map<string, Set<(e: unknown) => void>>();
  return {
    value: {
      subscribe: (kind: string, handler: (e: unknown) => void) => {
        const set = handlers.get(kind) ?? new Set();
        set.add(handler);
        handlers.set(kind, set);
        return () => set.delete(handler);
      },
      setFocus: () => {},
      watchWorkspace: () => () => {},
    },
    emit(event: { kind: string } & Record<string, unknown>) {
      for (const h of handlers.get(event.kind) ?? []) h({ id: 1, ts: '', ...event });
    },
    reset: () => handlers.clear(),
  };
});
vi.mock('../../version-control', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../version-control')>()),
  useEventBus: () => bus.value,
}));

import { ChangeRequestDialog } from '../components/ChangeRequestDialog';
import { GitApiError } from '../../git';
import { contrast, over, token } from '../../../__tests__/token-contrast';

const CONFLICTING = 'Docs/alpha.md';
const CLEAN = 'Docs/gamma.md';
/** The tree mark's accessible name, and the tooltip it carries. */
const CONFLICT_MARK = "Can't be combined with what everyone sees";
const COPY = 'Copy prompt for your agent';

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

const approval = (path: string, over: Partial<FileApprovalState> = {}): FileApprovalState => ({
  path,
  eligibleApprovers: { roles: ['Admin'], users: [] },
  approvedBy: [],
  inMergeGate: true,
  isApproved: false,
  viewerCanApprove: true,
  ...over,
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

/** The request's detail, changing `paths`, for its author (who may update it). */
function detail(paths: string[] = [CONFLICTING, CLEAN], over: Record<string, unknown> = {}) {
  return {
    ...CR,
    touchedNodePaths: paths,
    body: '',
    headSha: 'h'.repeat(40),
    baseSha: 'b'.repeat(40),
    mergeBaseSha: 'f'.repeat(40),
    files: paths.map(file),
    approvals: paths.map((p) => approval(p)),
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
    ...over,
  };
}

/** The route's 409, in the shape `ChangeRequestConflictsError` sends. */
const conflict = (conflictedPaths: string[] = [CONFLICTING]) =>
  new GitApiError(409, `Conflicts merging "main" into "ali/two-files".`, {
    kind: 'change-request-conflicts',
    sourceBranch: 'ali/two-files',
    targetBranch: 'main',
    conflictedPaths,
    error: `Conflicts merging "main" into "ali/two-files".`,
  });

beforeEach(() => {
  bus.reset();
  prApi.fetchPrDetail.mockReset().mockResolvedValue(detail());
  prApi.refreshChangeRequestFromTarget.mockReset().mockRejectedValue(conflict());
  prApi.mergePullRequest.mockReset().mockResolvedValue({ status: 'merging', number: 41 });
  prApi.approvePrFile.mockReset().mockResolvedValue(undefined);
  clipboard.copyToClipboard.mockReset().mockResolvedValue(true);
});

async function openConflicted() {
  render(<ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />);
  await waitFor(() => expect(prApi.refreshChangeRequestFromTarget).toHaveBeenCalledWith(41));
  return screen.findByRole('alert');
}

/** The tree row of `path`. */
function row(path: string): HTMLElement {
  return screen.getAllByRole('treeitem').find((r) => within(r).queryByTitle(path) !== null)!;
}

/** The text of what the reader can copy: the prompt, as it reached the clipboard. */
async function copiedPrompt(banner: HTMLElement): Promise<string> {
  fireEvent.click(within(banner).getByRole('button', { name: COPY }));
  await waitFor(() => expect(clipboard.copyToClipboard).toHaveBeenCalledTimes(1));
  return clipboard.copyToClipboard.mock.calls[0][0] as string;
}

describe('ChangeRequestDialog: a conflicted request names the files that conflict', () => {
  it('names the conflicting file in the banner, and not the clean one', async () => {
    const banner = await openConflicted();

    expect(banner.textContent).toContain("the two can't be combined automatically");
    // By the name the tree shows it under, with its full path on hover.
    expect(within(banner).getByTitle(CONFLICTING).textContent).toBe('alpha.md');
    expect(banner.textContent).not.toContain('gamma.md');
  });

  it('names it in the prompt it offers to copy, and not the clean one', async () => {
    const banner = await openConflicted();

    const copied = await copiedPrompt(banner);
    expect(copied).toContain(`\`${CONFLICTING}\``);
    expect(copied).not.toContain(CLEAN);
  });

  it('marks the conflicting file in the file tree, and not the clean one', async () => {
    await openConflicted();

    expect(within(row(CONFLICTING)).getByRole('img', { name: CONFLICT_MARK })).toBeInTheDocument();
    expect(within(row(CLEAN)).queryByRole('img', { name: CONFLICT_MARK })).not.toBeInTheDocument();
  });

  it('names the files an apply refused on a conflict carries, without reopening the request', async () => {
    // Nothing to bring up to date on open, every file approved: Apply is the
    // one way to learn of the conflict.
    prApi.fetchPrDetail.mockResolvedValue(
      detail([CONFLICTING, CLEAN], {
        needsUpdate: false,
        behind: false,
        approvals: [CONFLICTING, CLEAN].map((p) => approval(p, { isApproved: true })),
      }),
    );
    render(<ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Apply changes' }));
    await waitFor(() => expect(prApi.mergePullRequest).toHaveBeenCalledWith(41));

    act(() =>
      bus.emit({
        kind: 'change-request-merge-failed',
        forUserId: 'u1',
        number: 41,
        reason: 'This draft conflicts with the target and needs resolving first.',
        conflicts: true,
        conflictedPaths: [CONFLICTING],
      }),
    );

    const banner = await screen.findByRole('alert');
    expect(banner.textContent).toContain("Can't apply");
    expect(within(banner).getByTitle(CONFLICTING).textContent).toBe('alpha.md');
    expect(banner.textContent).not.toContain('gamma.md');
    expect(within(row(CONFLICTING)).getByRole('img', { name: CONFLICT_MARK })).toBeInTheDocument();
    expect(await copiedPrompt(banner)).toContain(`\`${CONFLICTING}\``);
  });
});

describe('ChangeRequestDialog: many conflicting files', () => {
  // Real names: spaces, a deep folder, a letter outside ASCII.
  const MANY = [
    'Projects/Customer Programmes/Region APAC/Launch plan.md',
    'Projects/Customer Programmes/Region APAC/Launch plan (copy).md',
    'Projects/Customer Programmes/Region EMEA/Escalation path for delayed purchase orders.md',
    'Projects/Übersicht Preise.md',
    'Projects/beta.md',
    'Projects/delta.md',
    'Projects/epsilon.md',
    'Projects/zeta.md',
  ];
  const ALL = [...MANY, 'Projects/clean.md'];

  beforeEach(() => {
    prApi.fetchPrDetail.mockResolvedValue(detail(ALL));
    prApi.refreshChangeRequestFromTarget.mockRejectedValue(conflict(MANY));
  });

  it('names three, then says how many more, one name per line', async () => {
    const banner = await openConflicted();

    const items = within(banner).getAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual([
      'Launch plan.md',
      'Launch plan (copy).md',
      'Escalation path for delayed purchase orders.md',
      'and 5 more files',
    ]);
    expect(banner.textContent).not.toContain('beta.md');
  });

  it('still hands the agent every file, and marks every one in the tree', async () => {
    const banner = await openConflicted();

    const copied = await copiedPrompt(banner);
    for (const p of MANY) expect(copied).toContain(`- \`${p}\``);
    for (const p of MANY) expect(within(row(p)).getByRole('img', { name: CONFLICT_MARK })).toBeInTheDocument();
    expect(within(row('Projects/clean.md')).queryByRole('img', { name: CONFLICT_MARK })).not.toBeInTheDocument();
  });

  it('scrolls the banner and the files as one, with a floor under the files and the verdict outside', async () => {
    const banner = await openConflicted();

    const files = screen.getByTestId('cr-files');
    const body = files.parentElement!;
    expect(body).toContainElement(banner);
    expect(body.className).toContain('overflow-y-auto');
    expect(files.className).toContain('min-h-80');
    expect(body).not.toContainElement(screen.getByText(/Nothing changes for anyone until/));
  });
});

describe('ChangeRequestDialog: the names in the banner', () => {
  it('shows the folder beside two names that would read the same', async () => {
    const twins = ['Docs/Sales/alpha.md', 'Docs/Finance/alpha.md'];
    prApi.fetchPrDetail.mockResolvedValue(detail([...twins, CLEAN]));
    prApi.refreshChangeRequestFromTarget.mockRejectedValue(conflict(twins));
    const banner = await openConflicted();

    expect(within(banner).getByTitle('Docs/Sales/alpha.md').textContent).toBe('alpha.mdDocs/Sales');
    expect(within(banner).getByTitle('Docs/Finance/alpha.md').textContent).toBe('alpha.mdDocs/Finance');
  });

  it('opens the file a name is clicked on', async () => {
    prApi.refreshChangeRequestFromTarget.mockRejectedValue(conflict([CLEAN]));
    const banner = await openConflicted();
    // The dialog opens on the request's first file, not the conflicting one.
    expect(row(CONFLICTING)).toHaveAttribute('aria-selected', 'true');

    fireEvent.click(within(banner).getByRole('button', { name: 'gamma.md' }));

    expect(row(CLEAN)).toHaveAttribute('aria-selected', 'true');
  });
});

describe('ChangeRequestDialog: the tree mark', () => {
  // The mark is the only sign on its row, so it must read as a graphic does:
  // 3:1 or more (WCAG 1.4.11), on a plain row and on the selected one.
  it('reads at 3:1 or more on a row and on the selected row', async () => {
    await openConflicted();
    const mark = within(row(CONFLICTING)).getByRole('img', { name: CONFLICT_MARK });
    const colourClass = [...mark.classList].find((c) => c.startsWith('text-'));
    expect(colourClass).toBeDefined();
    const colour = token(colourClass!.slice('text-'.length));

    const surface = token('surface');
    // The selected row is `bg-hover`, a tint of ink over the surface.
    const selected = over(token('hover'), surface);
    expect(contrast(colour, surface)).toBeGreaterThanOrEqual(3);
    expect(contrast(colour, selected)).toBeGreaterThanOrEqual(3);
  });
});
