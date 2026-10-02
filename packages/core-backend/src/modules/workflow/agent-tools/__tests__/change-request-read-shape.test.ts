import { describe, expect, it } from 'vitest';
import type {
  ChangeRequest,
  ChangeRequestDetail,
  FileApproval,
} from '@bevel-software/platform-shared';
import { hashEmail } from '../../../../shared/email-identity.js';
import {
  authorsDescription,
  fileIsReadable,
  isAuthor,
  loginFor,
  matchesAuthor,
  maySeeChangeRequest,
  pageOf,
  pagingOf,
  pathsOf,
  statesFor,
  toCrViewer,
  toCrSummary,
  visibleComments,
  toCrComment,
  toCrFile,
  toCrReviews,
  visibleBlockers,
} from '../change-request-read-shape.js';

const AUTHOR = 'juan@bevel.software';

function summary(over: Partial<ChangeRequest> = {}): ChangeRequest {
  return {
    number: 12,
    title: 'Rework the onboarding note',
    authorId: hashEmail(AUTHOR),
    author: { login: loginFor(AUTHOR), name: 'Juan' },
    appAuthor: { name: 'Juan' },
    branch: 'juan/my-draft',
    base: 'main',
    state: 'open',
    createdAt: '2026-09-28T10:00:00.000Z',
    updatedAt: '2026-09-28T10:00:00.000Z',
    touchedNodePaths: ['Knowledge/A.md'],
    review: { approvals: 0, changesRequested: 0, pendingLogins: [] },
    url: 'https://hexis.example.com/change-requests/12',
    ...over,
  };
}

function approval(over: Partial<FileApproval> = {}): FileApproval {
  return {
    path: 'Knowledge/A.md',
    eligibleApprovers: { roles: ['Engineering'], users: [] },
    approvedBy: [],
    eligibilityResolved: true,
    isApproved: false,
    inMergeGate: true,
    viewerCanApprove: false,
    ...over,
  };
}

describe("state is Hexis's own, and only the filter speaks GitHub's", () => {
  // Scenario: WHEN the request is merged THEN `state` says `merged`. GitHub
  // would say `closed` with a `merged` flag beside it; Hexis has the word, so
  // it uses it, and no answer carries the flag (Razvan, 2026-10-02).
  it('reports each of the three states as itself, with no flag to cross-read', () => {
    for (const state of ['open', 'merged', 'closed'] as const) {
      const answer = toCrSummary(summary({ state }), { readable: 1, withheld: 0 });
      expect(answer.state).toBe(state);
      expect(answer).not.toHaveProperty('merged');
    }
  });

  it('the `closed` filter covers applied and declined alike; `all` covers everything', () => {
    expect(statesFor('open')).toEqual(['open']);
    expect(statesFor('closed').sort()).toEqual(['closed', 'merged']);
    expect(statesFor('all').sort()).toEqual(['closed', 'merged', 'open']);
  });
});

describe('summary mapping', () => {
  it("uses the field names `open_change_request` answers in, `url` first", () => {
    const answer = toCrSummary(summary(), { readable: 1, withheld: 0 });
    expect(answer).toEqual({
      url: 'https://hexis.example.com/change-requests/12',
      number: 12,
      title: 'Rework the onboarding note',
      state: 'open',
      author: { login: loginFor(AUTHOR), name: 'Juan' },
      sourceBranch: 'juan/my-draft',
      targetBranch: 'main',
      createdAt: '2026-09-28T10:00:00.000Z',
      updatedAt: '2026-09-28T10:00:00.000Z',
      changedFiles: 1,
      withheldFiles: 0,
    });
    // `url` first on purpose: it is the field an agent must hand a person, so a
    // truncation of the answer cannot take it. `toEqual` above pins the set of
    // keys; this pins the order.
    expect(Object.keys(answer)[0]).toBe('url');
  });

  it('carries the note through when the deployment has no public address', () => {
    const cr = summary({ url: '/change-requests/12', urlNote: 'Configure a public address.' });
    expect(toCrSummary(cr, { readable: 1, withheld: 0 })).toMatchObject({
      url: '/change-requests/12',
      urlNote: 'Configure a public address.',
    });
  });

  it('falls back to the creation time when the row records no later moment', () => {
    const cr = summary();
    delete cr.updatedAt;
    expect(toCrSummary(cr, { readable: 1, withheld: 0 }).updatedAt).toBe(cr.createdAt);
  });
});

describe('the author filter', () => {
  it('matches an email through the stored author hash', () => {
    expect(matchesAuthor(summary(), AUTHOR)).toBe(true);
    expect(matchesAuthor(summary(), ' JUAN@Bevel.Software ')).toBe(true);
    expect(matchesAuthor(summary(), 'mia@bevel.software')).toBe(false);
  });

  it('matches a login by name', () => {
    expect(matchesAuthor(summary(), loginFor(AUTHOR))).toBe(true);
    expect(matchesAuthor(summary(), 'user-000000000000')).toBe(false);
  });

  it('matches nothing on an empty needle, and nothing on a request with no author hash', () => {
    expect(matchesAuthor(summary(), '  ')).toBe(false);
    expect(matchesAuthor(summary({ authorId: undefined }), AUTHOR)).toBe(false);
  });

  it('knows the viewer is the author only when the hashes agree', () => {
    expect(isAuthor(summary(), AUTHOR)).toBe(true);
    expect(isAuthor(summary(), 'mia@bevel.software')).toBe(false);
    expect(isAuthor(summary(), undefined)).toBe(false);
  });
});

describe('visibility', () => {
  it('shows a request with at least one readable file', () => {
    expect(maySeeChangeRequest({ readableFiles: 1, isAuthor: false })).toBe(true);
  });

  // Scenario: WHEN the caller may read none of the request's files and is not
  // its author THEN `get_change_request` answers 404.
  it('hides a request whose every file is closed to a caller who is not its author', () => {
    expect(maySeeChangeRequest({ readableFiles: 0, isAuthor: false })).toBe(false);
  });

  it('shows the author their own request even when they may read none of it', () => {
    expect(maySeeChangeRequest({ readableFiles: 0, isAuthor: true })).toBe(true);
  });
});

describe('paging', () => {
  it("reads GitHub's defaults and clamps what is out of range", () => {
    expect(pagingOf({})).toEqual({ perPage: 30, page: 1 });
    expect(pagingOf({ per_page: 100, page: 3 })).toEqual({ perPage: 100, page: 3 });
    expect(pagingOf({ per_page: 500 })).toEqual({ perPage: 100, page: 1 });
    expect(pagingOf({ per_page: 0, page: 0 })).toEqual({ perPage: 1, page: 1 });
    expect(pagingOf({ per_page: 'lots', page: null })).toEqual({ perPage: 30, page: 1 });
  });

  // Scenario: WHEN the request has 40 files THEN the first page holds 30 and
  // says there is a second.
  it('a first page of 40 holds 30 and says there is a second', () => {
    const all = Array.from({ length: 40 }, (_, i) => i);
    const first = pageOf(all, 30, 1);
    expect(first.items).toHaveLength(30);
    expect(first).toMatchObject({ totalCount: 40, page: 1, perPage: 30, hasNextPage: true });
    const second = pageOf(all, 30, 2);
    expect(second.items).toHaveLength(10);
    expect(second.hasNextPage).toBe(false);
  });

  it('a page past the end is empty rather than an error', () => {
    expect(pageOf([1, 2], 30, 9)).toMatchObject({ items: [], totalCount: 2, hasNextPage: false });
  });
});

describe('files', () => {
  it("names the path `path`, the kind of change `change`, and the old name `previousPath`", () => {
    const file = {
      path: 'Knowledge/A.md',
      previousPath: 'Knowledge/Old.md',
      status: 'renamed' as const,
      additions: 3,
      deletions: 1,
      isBinary: false,
      sha: 'blob-1',
      rawUrl: '',
      patch: '@@ -1 +1 @@',
    };
    const approved = approval({
      approvedBy: [
        { email: 'mia@bevel.software', name: 'Mia', approvedAt: '2026-09-29T08:00:00.000Z', isStale: false, isSelfApproval: false },
      ],
      isApproved: true,
      viewerCanApprove: true,
    });
    expect(toCrFile(file, approved, { patches: false })).toEqual({
      path: 'Knowledge/A.md',
      previousPath: 'Knowledge/Old.md',
      // git's `renamed` through `open_change_request`'s own `changeKindOf`.
      change: 'moved',
      additions: 3,
      deletions: 1,
      // No `sha`: nothing in Hexis populates a blob sha, so answering one would
      // answer `""` for every file. See `toCrFile`.
      isBinary: false,
      requiredApprovers: { roles: ['Engineering'], users: [] },
      approvedBy: [
        {
          user: { login: loginFor('mia@bevel.software'), name: 'Mia', email: 'mia@bevel.software' },
          approvedAt: '2026-09-29T08:00:00.000Z',
          stale: false,
          selfApproval: false,
        },
      ],
      approved: true,
      inMergeGate: true,
      viewerMayApprove: true,
    });
  });

  it('returns a patch only when one was asked for', () => {
    const file = { path: 'A.md', status: 'modified' as const, additions: 1, deletions: 0, isBinary: false, sha: 's', rawUrl: '', patch: '@@' };
    expect(toCrFile(file, undefined, { patches: false }).patch).toBeUndefined();
    expect(toCrFile(file, undefined, { patches: true }).patch).toBe('@@');
  });

  // `approversUnknown` is PRESENT or absent, never `false` — the same shape
  // `open_change_request` answers in, so the fail-closed reading ("empty means
  // not known") is the one a caller gets by default rather than one they have to
  // look for.
  it('says the approver set is unknown when nothing could answer for the file', () => {
    const file = { path: 'A.md', status: 'modified' as const, additions: 1, deletions: 0, isBinary: false, sha: 's', rawUrl: '' };
    expect(toCrFile(file, undefined, { patches: false })).toMatchObject({
      requiredApprovers: { roles: [], users: [] },
      approversUnknown: true,
      approved: false,
      inMergeGate: false,
      viewerMayApprove: false,
    });
    expect(toCrFile(file, approval({ eligibilityResolved: false }), { patches: false })
      .approversUnknown).toBe(true);
    // Resolved: the key is absent, not false.
    expect(toCrFile(file, approval(), { patches: false })).not.toHaveProperty('approversUnknown');
  });

  it('reads each of git\'s statuses as one of the four words', () => {
    const kind = (status: 'added' | 'removed' | 'renamed' | 'copied' | 'modified' | 'changed' | 'unchanged') =>
      toCrFile(
        { path: 'A.md', status, additions: 0, deletions: 0, isBinary: false, sha: 's', rawUrl: '' },
        undefined,
        { patches: false },
      ).change;
    expect(kind('added')).toBe('added');
    expect(kind('removed')).toBe('deleted');
    expect(kind('renamed')).toBe('moved');
    expect(kind('copied')).toBe('moved');
    expect(kind('modified')).toBe('changed');
    expect(kind('unchanged')).toBe('changed');
  });
});

describe('reviews, gathered out of the per-file approvals', () => {
  // Scenario: WHEN a reviewer approved two of three files THEN
  // `list_change_request_reviews` names the reviewer and the two files.
  it('names a reviewer once with the files they approved and the latest time', () => {
    const mia = (at: string, isStale = false) => ({
      email: 'mia@bevel.software',
      name: 'Mia',
      approvedAt: at,
      isStale,
      isSelfApproval: false,
    });
    const { reviews, withheldReviews } = toCrReviews([
      approval({ path: 'A.md', approvedBy: [mia('2026-09-29T08:00:00.000Z')] }),
      approval({ path: 'B.md', approvedBy: [mia('2026-09-29T09:00:00.000Z')] }),
      approval({ path: 'C.md', approvedBy: [] }),
    ]);
    expect(reviews).toEqual([
      {
        id: `${loginFor('mia@bevel.software')}:current`,
        reviewer: { login: loginFor('mia@bevel.software'), name: 'Mia', email: 'mia@bevel.software' },
        stale: false,
        submittedAt: '2026-09-29T09:00:00.000Z',
        files: ['A.md', 'B.md'],
        withheldFiles: 0,
      },
    ]);
    expect(withheldReviews).toBe(0);
  });

  // GitHub's word for this is `DISMISSED`; Hexis's is `isStale`, and the answer
  // uses Hexis's.
  it("reports an approval a later push invalidated as `stale`, separately", () => {
    const mia = (at: string, isStale: boolean) => ({ email: 'mia@x', name: 'Mia', approvedAt: at, isStale, isSelfApproval: false });
    const { reviews } = toCrReviews([
      approval({ path: 'A.md', approvedBy: [mia('2026-09-29T08:00:00.000Z', false)] }),
      approval({ path: 'B.md', approvedBy: [mia('2026-09-28T08:00:00.000Z', true)] }),
    ]);
    expect(reviews.map((r) => [r.stale, r.files])).toEqual([
      [true, ['B.md']],
      [false, ['A.md']],
    ]);
    expect(JSON.stringify(reviews)).not.toContain('DISMISSED');
  });

  it("keeps a review's readable files and counts the rest, naming none of them", () => {
    const entry = (at: string) => ({ email: 'mia@x', name: 'Mia', approvedAt: at, isStale: false, isSelfApproval: false });
    const { reviews, withheldReviews } = toCrReviews(
      [
        approval({ path: 'Knowledge/A.md', approvedBy: [entry('2026-09-29T08:00:00.000Z')] }),
        approval({ path: 'Secret/Pay.md', approvedBy: [entry('2026-09-29T10:00:00.000Z')] }),
      ],
      (path) => path === 'Knowledge/A.md',
    );
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ files: ['Knowledge/A.md'], withheldFiles: 1 });
    // Neither the path nor the moment it was approved leaks out.
    expect(JSON.stringify(reviews)).not.toContain('Secret');
    expect(JSON.stringify(reviews)).not.toContain('10:00:00');
    expect(withheldReviews).toBe(0);
  });

  it('drops a review whose every file is withheld, and counts it instead', () => {
    const entry = { email: 'mia@x', name: 'Mia', approvedAt: '2026-09-29T08:00:00.000Z', isStale: false, isSelfApproval: false };
    const { reviews, withheldReviews } = toCrReviews(
      [approval({ path: 'Secret/Pay.md', approvedBy: [entry] })],
      () => false,
    );
    expect(reviews).toEqual([]);
    expect(withheldReviews).toBe(1);
  });

  it('answers with no reviews when nobody has approved anything', () => {
    expect(toCrReviews([approval({ path: 'A.md' })])).toEqual({ reviews: [], withheldReviews: 0 });
  });
});

describe('comments', () => {
  // Scenario: WHEN a reviewer left an inline comment and a reply followed THEN
  // `list_change_request_comments` returns both, the reply with `parentId`.
  it('maps an inline comment and a reply, the reply carrying `parentId`', () => {
    const inline = toCrComment({
      id: 'c-1',
      author: { email: 'mia@bevel.software', name: 'Mia' },
      body: 'This line is out of date.',
      path: 'Knowledge/A.md',
      line: 14,
      headSha: 'head-1',
      createdAt: '2026-09-29T08:00:00.000Z',
    });
    expect(inline).toEqual({
      id: 'c-1',
      author: { login: loginFor('mia@bevel.software'), name: 'Mia', email: 'mia@bevel.software' },
      body: 'This line is out of date.',
      path: 'Knowledge/A.md',
      line: 14,
      headSha: 'head-1',
      createdAt: '2026-09-29T08:00:00.000Z',
    });
    const reply = toCrComment({
      id: 'c-2',
      author: { email: AUTHOR, name: 'Juan' },
      body: 'Fixed.',
      path: 'Knowledge/A.md',
      line: 14,
      headSha: 'head-1',
      parentId: 'c-1',
      createdAt: '2026-09-29T09:00:00.000Z',
      updatedAt: '2026-09-29T09:05:00.000Z',
    });
    expect(reply).toMatchObject({ parentId: 'c-1', updatedAt: '2026-09-29T09:05:00.000Z' });
  });

  it('leaves `path`, `line` and `parentId` off a general comment', () => {
    const general = toCrComment({
      id: 'c-3',
      author: { email: AUTHOR, name: 'Juan' },
      body: 'Ready for review.',
      headSha: 'head-1',
      createdAt: '2026-09-29T07:00:00.000Z',
    });
    expect(general.path).toBeUndefined();
    expect(general.line).toBeUndefined();
    expect(general.parentId).toBeUndefined();
  });
});

describe('the viewer block — what this caller may do', () => {
  const detail = (over: Partial<ChangeRequestDetail> = {}) =>
    ({
      state: 'open',
      mergeBlockedReasons: [],
      mergeWarnings: [],
      viewerCanBypassMerge: false,
      approvals: [],
      ...over,
    }) as ChangeRequestDetail;

  it('mayMerge is true when the gate waits on nothing', () => {
    // Only the three verbs. The blockers live beside it on the answer, under
    // `open_change_request`'s own `mergeBlockedReasons`, so this block holds
    // exactly what is about the CALLER and nothing about the request.
    expect(toCrViewer(detail(), false, [])).toEqual({
      mayApprove: false,
      mayMerge: true,
      isAuthor: false,
    });
  });

  it('mayMerge is false on a missing approval, and true for an admin who may bypass it', () => {
    const waiting = ['Waiting on approval for A.md from Engineering.'];
    expect(
      toCrViewer(detail({ mergeBlockedReasons: waiting, mergeWarnings: waiting }), false, []).mayMerge,
    ).toBe(false);
    expect(
      toCrViewer(
        detail({ mergeBlockedReasons: waiting, mergeWarnings: waiting, viewerCanBypassMerge: true }),
        false,
        [],
      ).mayMerge,
    ).toBe(true);
  });

  it('mayMerge is false on a hard block, bypass or not', () => {
    const hard = ['This pull request is closed.'];
    expect(
      toCrViewer(detail({ state: 'closed', mergeBlockedReasons: hard, viewerCanBypassMerge: true }), false, []).mayMerge,
    ).toBe(false);
  });

  it('mayApprove is true when the caller may approve any one file they are shown', () => {
    expect(
      toCrViewer(detail(), false, [
        approval(),
        approval({ path: 'B.md', viewerCanApprove: true }),
      ]).mayApprove,
    ).toBe(true);
  });

  it('mayApprove follows exactly the approval set it is given', () => {
    // What this pins is the narrow thing the signature can pin: the answer is a
    // function of the SHOWN approvals and of nothing else. The leak it exists to
    // prevent — a write grant outliving a read refusal, so the only approvable
    // file is one the caller is not shown — cannot be staged here at all, since
    // `toCrViewer` no longer receives the request's whole approval set (its
    // `Pick` excludes `approvals` for exactly that reason). That case is driven
    // end to end by 'answers mayApprove false when the only approvable file is
    // the withheld one' in change-request-read.tools.test.ts.
    const shown = [approval({ path: 'Knowledge/A.md' })];
    expect(toCrViewer(detail(), false, shown).mayApprove).toBe(false);
    expect(
      toCrViewer(detail(), false, [
        ...shown,
        approval({ path: 'Knowledge/A.md', viewerCanApprove: true }),
      ]).mayApprove,
    ).toBe(true);
  });
});

describe('merge blockers never name a file the caller may not read', () => {
  it('withholds and counts a blocker that quotes a withheld path', () => {
    const reasons = [
      'Waiting on approval for Knowledge/Open.md from Engineering.',
      'Waiting on approval for Secret/Pay.md from Finance.',
    ];
    const scoped = visibleBlockers(reasons, ['Secret/Pay.md']);
    expect(scoped).toEqual({ visible: [reasons[0]], withheld: 1 });
    expect(JSON.stringify(scoped)).not.toContain('Secret/Pay.md');
  });

  it('keeps every blocker when nothing is withheld', () => {
    const reasons = ['This pull request has no file changes to approve.'];
    expect(visibleBlockers(reasons, [])).toEqual({ visible: reasons, withheld: 0 });
  });
});

/**
 * The leak Local Testing caught on the first attempt: `openChangeRequest`
 * appends a generated `## Affected owners` block to the body, naming every
 * changed path and its approvers, and the detail returned the body verbatim.
 */
describe('the body a caller is handed is the author\'s, not the machine\'s', () => {
  const GENERATED = [
    '## Affected owners',
    '',
    '- `KnowledgeBase/Engineering/Knowledge/Avi-Checkin.md` — Admin',
    '- `KnowledgeBase/GTM/Notes.md` — GTM Team',
  ].join('\n');

  it('drops the generated owners block, keeping what the author typed', () => {
    expect(authorsDescription(`Please take a look.\n\n${GENERATED}`)).toBe('Please take a look.');
    expect(authorsDescription(GENERATED)).toBe('');
  });

  it('names no path of the generated block, readable or not', () => {
    const out = authorsDescription(`Why this is needed.\n\n${GENERATED}`);
    expect(out).not.toContain('Avi-Checkin');
    expect(out).not.toContain('KnowledgeBase');
    expect(out).not.toContain('Affected owners');
  });

  it('strips the hidden identity markers older bodies carry', () => {
    expect(authorsDescription('<!-- bevel:author:abc123 -->\nMy reason.')).toBe('My reason.');
  });

  it('leaves a body that is only the author\'s prose alone', () => {
    expect(authorsDescription('  A multi-line\nreason.  ')).toBe('A multi-line\nreason.');
    expect(authorsDescription('')).toBe('');
  });

  // Razvan's review (2026-10-02): the first cut copied the app's dialog, which
  // drops everything from the first `##` heading on. An author who writes their
  // description in sections lost it from that heading onwards, and was never
  // told. The cut is now the generated block and nothing else.
  it("keeps the author's own headings, and everything under them", () => {
    expect(authorsDescription('Lead.\n\n## My own heading\n\nmore')).toBe(
      'Lead.\n\n## My own heading\n\nmore',
    );
    expect(authorsDescription(`Lead.\n\n## Why now\n\nBecause.\n\n${GENERATED}`)).toBe(
      'Lead.\n\n## Why now\n\nBecause.',
    );
  });

  // Hexis appends the block LAST, so the last such line is always the generated
  // one — which is what makes an author who happens to use that heading
  // themselves no worse off than before.
  it('cuts the LAST such heading, so an author may use the words too', () => {
    const out = authorsDescription(`Lead.\n\n## Affected owners\n\nI mean the GTM ones.\n\n${GENERATED}`);
    expect(out).toBe('Lead.\n\n## Affected owners\n\nI mean the GTM ones.');
    // Their sentence is kept; not one path of the generated block is.
    expect(out).not.toContain('Avi-Checkin');
    expect(out).not.toContain('KnowledgeBase');
  });

  it('cuts an author\'s own owners heading when there is no generated block', () => {
    // Indistinguishable from the generated one with nothing after it, so it is
    // cut — the safe direction, and the only way this can err.
    expect(authorsDescription('Lead.\n\n## Affected owners\n\nI mean the GTM ones.')).toBe('Lead.');
  });
});

/**
 * A rename names TWO paths. The diff of a rename shows the content that was at
 * the old one, so a file renamed out of a folder the caller may not read must
 * not be listed under its new name either.
 */
describe('a renamed file is judged on both of its names', () => {
  const renamed = {
    path: 'Knowledge/Open.md',
    previousPath: 'Payroll/Rates.md',
  };

  it('is readable only when both of its names are', () => {
    expect(fileIsReadable(renamed, () => true)).toBe(true);
    expect(fileIsReadable(renamed, (p) => p === 'Knowledge/Open.md')).toBe(false);
    expect(fileIsReadable(renamed, (p) => p === 'Payroll/Rates.md')).toBe(false);
  });

  it('judges a file that was not renamed on its one name', () => {
    expect(fileIsReadable({ path: 'A.md' }, (p) => p === 'A.md')).toBe(true);
    expect(fileIsReadable({ path: 'A.md' }, () => false)).toBe(false);
  });

  it('offers both names for the access lookup, and one for a plain file', () => {
    expect(pathsOf(renamed)).toEqual(['Knowledge/Open.md', 'Payroll/Rates.md']);
    expect(pathsOf({ path: 'A.md' })).toEqual(['A.md']);
  });
});

/**
 * A reply is shown only when the comment it replies to is (Razvan's review,
 * 2026-10-02, finding 3). A reply posted without a path of its own — which
 * `post_change_request_comment` accepts, taking `parentId` without `path` — read
 * as a general comment when judged on itself, so a reply to a comment on a
 * withheld file came back with its body and a `parentId` naming a comment the
 * caller cannot see.
 */
describe('a reply takes its parent\'s verdict, up the chain', () => {
  const c = (id: string, over: { path?: string; parentId?: string } = {}) => ({ id, ...over });
  const mayShow = (path: string) => path.startsWith('Open/');

  it('withholds a pathless reply to a comment on a file the caller may not read', () => {
    const { visible, withheld } = visibleComments(
      [c('c-1', { path: 'Secret/Pay.md' }), c('c-2', { parentId: 'c-1' })],
      mayShow,
    );
    expect(visible).toEqual([]);
    expect(withheld).toBe(2);
  });

  it('withholds a reply to that reply, however deep the thread goes', () => {
    const { visible, withheld } = visibleComments(
      [
        c('c-1', { path: 'Secret/Pay.md' }),
        c('c-2', { parentId: 'c-1' }),
        c('c-3', { parentId: 'c-2' }),
        c('c-4', { parentId: 'c-3' }),
      ],
      mayShow,
    );
    expect(visible).toEqual([]);
    expect(withheld).toBe(4);
  });

  it('keeps a reply whose whole chain is readable', () => {
    const { visible, withheld } = visibleComments(
      [c('c-1', { path: 'Open/A.md' }), c('c-2', { parentId: 'c-1' }), c('c-3', { parentId: 'c-2' })],
      mayShow,
    );
    expect(visible.map((v) => v.id)).toEqual(['c-1', 'c-2', 'c-3']);
    expect(withheld).toBe(0);
  });

  // Both halves of the rule are needed, and this is the half the inheritance
  // alone would miss: the reply names a withheld file itself.
  it('withholds a reply that names a withheld file under a readable parent', () => {
    const { visible } = visibleComments(
      [c('c-1', { path: 'Open/A.md' }), c('c-2', { path: 'Secret/Pay.md', parentId: 'c-1' })],
      mayShow,
    );
    expect(visible.map((v) => v.id)).toEqual(['c-1']);
  });

  it('keeps a general comment and a reply to one — neither is about a file', () => {
    const { visible, withheld } = visibleComments([c('c-1'), c('c-2', { parentId: 'c-1' })], mayShow);
    expect(visible.map((v) => v.id)).toEqual(['c-1', 'c-2']);
    expect(withheld).toBe(0);
  });

  it('withholds a reply whose parent is not in the list at all', () => {
    // Not provably pathless, so it goes: the parent may have been anchored to
    // anything, including a file this caller was refused.
    const { visible, withheld } = visibleComments([c('c-2', { parentId: 'gone' })], mayShow);
    expect(visible).toEqual([]);
    expect(withheld).toBe(1);
  });

  it('withholds a cycle rather than looping on it', () => {
    const { visible, withheld } = visibleComments(
      [c('c-1', { parentId: 'c-2' }), c('c-2', { parentId: 'c-1' })],
      mayShow,
    );
    expect(visible).toEqual([]);
    expect(withheld).toBe(2);
  });

  it('resolves a long thread without re-walking it per reply', () => {
    // 500 replies in one chain: memoised, this is linear; unmemoised it is
    // quadratic and the suite would feel it.
    const chain = [c('c-0', { path: 'Open/A.md' })];
    for (let i = 1; i <= 500; i++) chain.push(c(`c-${i}`, { parentId: `c-${i - 1}` }));
    const { visible, withheld } = visibleComments(chain, mayShow);
    expect(visible).toHaveLength(501);
    expect(withheld).toBe(0);
  });
});
