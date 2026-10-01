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
  ghMerged,
  ghState,
  isAuthor,
  loginFor,
  matchesAuthor,
  maySeeChangeRequest,
  pageOf,
  pagingOf,
  pathsOf,
  statesFor,
  toGhAccess,
  toGhChangeRequest,
  toGhComment,
  toGhFile,
  toGhReviews,
  visibleBlockers,
} from '../github-shape.js';

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

describe('state mapping — GitHub has two states and a flag where Hexis has three', () => {
  // Scenario: WHEN the request is merged THEN `state` is `closed` and `merged`
  // is true, as on GitHub.
  it('a merged request is closed and merged', () => {
    expect(ghState('merged')).toBe('closed');
    expect(ghMerged('merged')).toBe(true);
  });

  it('a declined or withdrawn request is closed and NOT merged', () => {
    expect(ghState('closed')).toBe('closed');
    expect(ghMerged('closed')).toBe(false);
  });

  it('an open request is open and not merged', () => {
    expect(ghState('open')).toBe('open');
    expect(ghMerged('open')).toBe(false);
  });

  it('the `closed` filter covers applied and declined alike; `all` covers everything', () => {
    expect(statesFor('open')).toEqual(['open']);
    expect(statesFor('closed').sort()).toEqual(['closed', 'merged']);
    expect(statesFor('all').sort()).toEqual(['closed', 'merged', 'open']);
  });
});

describe('summary mapping', () => {
  it("uses GitHub's field names, with `head` and `base` as refs", () => {
    expect(toGhChangeRequest(summary(), { readable: 1, withheld: 0 })).toEqual({
      number: 12,
      state: 'open',
      title: 'Rework the onboarding note',
      user: { login: loginFor(AUTHOR), name: 'Juan' },
      head: { ref: 'juan/my-draft' },
      base: { ref: 'main' },
      created_at: '2026-09-28T10:00:00.000Z',
      updated_at: '2026-09-28T10:00:00.000Z',
      merged: false,
      html_url: 'https://hexis.example.com/change-requests/12',
      changed_files: 1,
      withheld_files: 0,
    });
  });

  it('carries the note through when the deployment has no public address', () => {
    const cr = summary({ url: '/change-requests/12', urlNote: 'Configure a public address.' });
    expect(toGhChangeRequest(cr, { readable: 1, withheld: 0 })).toMatchObject({
      html_url: '/change-requests/12',
      url_note: 'Configure a public address.',
    });
  });

  it('falls back to the creation time when the row records no later moment', () => {
    const cr = summary();
    delete cr.updatedAt;
    expect(toGhChangeRequest(cr, { readable: 1, withheld: 0 }).updated_at).toBe(cr.createdAt);
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
    expect(first).toMatchObject({ total_count: 40, page: 1, per_page: 30, has_next_page: true });
    const second = pageOf(all, 30, 2);
    expect(second.items).toHaveLength(10);
    expect(second.has_next_page).toBe(false);
  });

  it('a page past the end is empty rather than an error', () => {
    expect(pageOf([1, 2], 30, 9)).toMatchObject({ items: [], total_count: 2, has_next_page: false });
  });
});

describe('files', () => {
  it("uses GitHub's `filename` and `previous_filename`, and Hexis's approval fields", () => {
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
    expect(toGhFile(file, approved, { patches: false })).toEqual({
      filename: 'Knowledge/A.md',
      previous_filename: 'Knowledge/Old.md',
      status: 'renamed',
      additions: 3,
      deletions: 1,
      changes: 4,
      sha: 'blob-1',
      is_binary: false,
      required_approvers: { roles: ['Engineering'], users: [] },
      required_approvers_resolved: true,
      approved_by: [
        {
          user: { login: loginFor('mia@bevel.software'), name: 'Mia', email: 'mia@bevel.software' },
          approved_at: '2026-09-29T08:00:00.000Z',
          stale: false,
          self_approval: false,
        },
      ],
      approved: true,
      in_merge_gate: true,
      viewer_may_approve: true,
    });
  });

  it('returns a patch only when one was asked for', () => {
    const file = { path: 'A.md', status: 'modified' as const, additions: 1, deletions: 0, isBinary: false, sha: 's', rawUrl: '', patch: '@@' };
    expect(toGhFile(file, undefined, { patches: false }).patch).toBeUndefined();
    expect(toGhFile(file, undefined, { patches: true }).patch).toBe('@@');
  });

  it('says the approver set is unresolved when nothing could answer for the file', () => {
    const file = { path: 'A.md', status: 'modified' as const, additions: 1, deletions: 0, isBinary: false, sha: 's', rawUrl: '' };
    expect(toGhFile(file, undefined, { patches: false })).toMatchObject({
      required_approvers: { roles: [], users: [] },
      required_approvers_resolved: false,
      approved: false,
      in_merge_gate: false,
      viewer_may_approve: false,
    });
    expect(toGhFile(file, approval({ eligibilityResolved: false }), { patches: false })
      .required_approvers_resolved).toBe(false);
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
    const { reviews, withheldReviews } = toGhReviews([
      approval({ path: 'A.md', approvedBy: [mia('2026-09-29T08:00:00.000Z')] }),
      approval({ path: 'B.md', approvedBy: [mia('2026-09-29T09:00:00.000Z')] }),
      approval({ path: 'C.md', approvedBy: [] }),
    ]);
    expect(reviews).toEqual([
      {
        id: `${loginFor('mia@bevel.software')}:APPROVED`,
        user: { login: loginFor('mia@bevel.software'), name: 'Mia', email: 'mia@bevel.software' },
        state: 'APPROVED',
        submitted_at: '2026-09-29T09:00:00.000Z',
        files: ['A.md', 'B.md'],
        withheld_files: 0,
      },
    ]);
    expect(withheldReviews).toBe(0);
  });

  it('reports an approval a later push invalidated as DISMISSED, separately', () => {
    const mia = (at: string, isStale: boolean) => ({ email: 'mia@x', name: 'Mia', approvedAt: at, isStale, isSelfApproval: false });
    const { reviews } = toGhReviews([
      approval({ path: 'A.md', approvedBy: [mia('2026-09-29T08:00:00.000Z', false)] }),
      approval({ path: 'B.md', approvedBy: [mia('2026-09-28T08:00:00.000Z', true)] }),
    ]);
    expect(reviews.map((r) => [r.state, r.files])).toEqual([
      ['DISMISSED', ['B.md']],
      ['APPROVED', ['A.md']],
    ]);
  });

  it("keeps a review's readable files and counts the rest, naming none of them", () => {
    const entry = (at: string) => ({ email: 'mia@x', name: 'Mia', approvedAt: at, isStale: false, isSelfApproval: false });
    const { reviews, withheldReviews } = toGhReviews(
      [
        approval({ path: 'Knowledge/A.md', approvedBy: [entry('2026-09-29T08:00:00.000Z')] }),
        approval({ path: 'Secret/Pay.md', approvedBy: [entry('2026-09-29T10:00:00.000Z')] }),
      ],
      (path) => path === 'Knowledge/A.md',
    );
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ files: ['Knowledge/A.md'], withheld_files: 1 });
    // Neither the path nor the moment it was approved leaks out.
    expect(JSON.stringify(reviews)).not.toContain('Secret');
    expect(JSON.stringify(reviews)).not.toContain('10:00:00');
    expect(withheldReviews).toBe(0);
  });

  it('drops a review whose every file is withheld, and counts it instead', () => {
    const entry = { email: 'mia@x', name: 'Mia', approvedAt: '2026-09-29T08:00:00.000Z', isStale: false, isSelfApproval: false };
    const { reviews, withheldReviews } = toGhReviews(
      [approval({ path: 'Secret/Pay.md', approvedBy: [entry] })],
      () => false,
    );
    expect(reviews).toEqual([]);
    expect(withheldReviews).toBe(1);
  });

  it('answers with no reviews when nobody has approved anything', () => {
    expect(toGhReviews([approval({ path: 'A.md' })])).toEqual({ reviews: [], withheldReviews: 0 });
  });
});

describe('comments', () => {
  // Scenario: WHEN a reviewer left an inline comment and a reply followed THEN
  // `list_change_request_comments` returns both, the reply with `in_reply_to`.
  it('maps an inline comment and a reply, the reply carrying `in_reply_to`', () => {
    const inline = toGhComment({
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
      user: { login: loginFor('mia@bevel.software'), name: 'Mia', email: 'mia@bevel.software' },
      body: 'This line is out of date.',
      path: 'Knowledge/A.md',
      line: 14,
      commit_id: 'head-1',
      created_at: '2026-09-29T08:00:00.000Z',
    });
    const reply = toGhComment({
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
    expect(reply).toMatchObject({ in_reply_to: 'c-1', updated_at: '2026-09-29T09:05:00.000Z' });
  });

  it('leaves `path`, `line` and `in_reply_to` off a general comment', () => {
    const general = toGhComment({
      id: 'c-3',
      author: { email: AUTHOR, name: 'Juan' },
      body: 'Ready for review.',
      headSha: 'head-1',
      createdAt: '2026-09-29T07:00:00.000Z',
    });
    expect(general.path).toBeUndefined();
    expect(general.line).toBeUndefined();
    expect(general.in_reply_to).toBeUndefined();
  });
});

describe('the access block', () => {
  const detail = (over: Partial<ChangeRequestDetail> = {}) =>
    ({
      state: 'open',
      mergeBlockedReasons: [],
      mergeWarnings: [],
      viewerCanBypassMerge: false,
      approvals: [],
      ...over,
    }) as ChangeRequestDetail;

  it('may_merge is true when the gate waits on nothing', () => {
    expect(toGhAccess(detail(), { visible: [], withheld: 0 }, false)).toEqual({
      merge_blockers: [],
      withheld_merge_blockers: 0,
      may_approve: false,
      may_merge: true,
      is_author: false,
    });
  });

  it('may_merge is false on a missing approval, and true for an admin who may bypass it', () => {
    const waiting = ['Waiting on approval for A.md from Engineering.'];
    expect(
      toGhAccess(detail({ mergeBlockedReasons: waiting, mergeWarnings: waiting }), { visible: waiting, withheld: 0 }, false).may_merge,
    ).toBe(false);
    expect(
      toGhAccess(
        detail({ mergeBlockedReasons: waiting, mergeWarnings: waiting, viewerCanBypassMerge: true }),
        { visible: waiting, withheld: 0 },
        false,
      ).may_merge,
    ).toBe(true);
  });

  it('may_merge is false on a hard block, bypass or not', () => {
    const hard = ['This pull request is closed.'];
    expect(
      toGhAccess(detail({ state: 'closed', mergeBlockedReasons: hard, viewerCanBypassMerge: true }), { visible: hard, withheld: 0 }, false).may_merge,
    ).toBe(false);
  });

  it('may_approve is true when the caller may approve any one file', () => {
    expect(
      toGhAccess(detail({ approvals: [approval(), approval({ path: 'B.md', viewerCanApprove: true })] }), { visible: [], withheld: 0 }, false)
        .may_approve,
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

  it('cuts at the first generated heading, the same rule the app\'s dialog reads by', () => {
    // `authorsReason` in ChangeRequestDialog.tsx splits on /^##\s+/m too, so a
    // person and an agent are shown the same text. An author's own `##` heading
    // is cut by both — one rule, not two that drift.
    expect(authorsDescription('Lead.\n\n## My own heading\n\nmore')).toBe('Lead.');
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
