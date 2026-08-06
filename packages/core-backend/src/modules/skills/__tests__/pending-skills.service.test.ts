import { describe, test, expect } from 'vitest';
import type { ChangeRequest, IWorkflowService } from '@bevel-software/platform-shared';
import { PendingSkillsService } from '../pending-skills.service.js';
import { hashEmail } from '../../../shared/hash-email.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import type { IAccessControl } from '../../access/access-control.interface.js';
import type { ISkillService, SkillSummary } from '../skills.contract.js';

/**
 * The half of the catalog that is NOT on the default branch.
 *
 * The bug this exists for: an agent opened a change request adding a skill, and
 * the skill was nowhere in the product until somebody merged it — not for the
 * author, not for the person who had to approve it. So the tests below are
 * mostly about who gets to see one, because "show it" and "show it to the wrong
 * people" are the two ways to get this wrong.
 */

const AUTHOR = 'ali@bevel.software';
const ADMIN = 'olga@bevel.software';
const BYSTANDER = 'sam@bevel.software';

const SKILL_MD = `---
name: weekly-newsletter
version: 0.1.0
description: Drafts the Friday newsletter.
---

# Weekly newsletter
`;

function cr(over: Partial<ChangeRequest> = {}): ChangeRequest {
  return {
    number: 7,
    title: 'Add the weekly-newsletter skill',
    authorId: hashEmail(AUTHOR),
    author: { login: 'user-abc', name: 'service' },
    appAuthor: { name: 'Ali Raza' },
    branch: 'agent/weekly-newsletter',
    base: 'main',
    state: 'open',
    createdAt: '2026-08-06T09:00:00.000Z',
    touchedNodePaths: ['Groups/Engineering/weekly-newsletter/SKILL.md'],
    review: { approvals: 0, changesRequested: 0, pendingLogins: [] },
    url: '/change-requests/7',
    ...over,
  };
}

/** Files present on a change request's branch, keyed `<branch>:<path>`. */
function harness(opts: {
  crs: ChangeRequest[];
  released?: SkillSummary[];
  branchFiles?: Record<string, string>;
  /** Emails allowed to write each path. Absent path ⇒ nobody. */
  writers?: Record<string, string[]>;
}) {
  const branchFiles = opts.branchFiles ?? {
    'agent/weekly-newsletter:Groups/Engineering/weekly-newsletter/SKILL.md': SKILL_MD,
  };
  const workspaceService = {
    ensureRemotesFetched: async () => undefined,
    readFileAtRef: async (_ws: string, ref: string, rel: string) =>
      branchFiles[`${ref.replace(/^origin\//, '')}:${rel}`] ?? null,
  } as unknown as WorkspaceService;

  const accessControl = {
    canWriteBatch: async (_ws: string, email: string, paths: string[]) =>
      new Map(paths.map((p) => [p, (opts.writers?.[p] ?? []).includes(email)])),
  } as unknown as IAccessControl;

  const skillService = {
    listSkills: async () => opts.released ?? [],
  } as unknown as ISkillService;

  const workflow = {
    listChangeRequests: async () => opts.crs,
  } as unknown as IWorkflowService;

  return new PendingSkillsService(workspaceService, accessControl, skillService, workflow);
}

const ADMIN_WRITES = {
  'Groups/Engineering/weekly-newsletter/SKILL.md': [ADMIN],
};

describe('PendingSkillsService', () => {
  test('surfaces a skill that exists only on a change request, to its author', async () => {
    const pending = await harness({ crs: [cr()], writers: ADMIN_WRITES }).listPendingSkills(AUTHOR);

    expect(pending).toEqual([
      {
        name: 'weekly-newsletter',
        description: 'Drafts the Friday newsletter.',
        version: '0.1.0',
        path: 'Groups/Engineering/weekly-newsletter',
        changeRequestNumber: 7,
        branch: 'agent/weekly-newsletter',
        authorName: 'Ali Raza',
        createdAt: '2026-08-06T09:00:00.000Z',
        isAuthor: true,
      },
    ]);
  });

  test('surfaces it to whoever could approve it, marked as not theirs', async () => {
    const pending = await harness({ crs: [cr()], writers: ADMIN_WRITES }).listPendingSkills(ADMIN);
    expect(pending.map((p) => [p.name, p.isAuthor])).toEqual([['weekly-newsletter', false]]);
  });

  /**
   * The decision that shapes this surface: a proposal is between its author and
   * the people who can approve it, and nobody else. A member of the group who
   * cannot write the folder is not one of those people.
   */
  test('hides it from everyone else', async () => {
    expect(await harness({ crs: [cr()], writers: ADMIN_WRITES }).listPendingSkills(BYSTANDER))
      .toEqual([]);
  });

  /**
   * Fail closed like the catalog: an access lookup that cannot answer is a
   * denial, never a disclosure. Without this a broken access tree would show
   * every open proposal to everyone.
   */
  test('shows nothing to a non-author when the access tree cannot be read', async () => {
    // No writer on any path is what an unreadable tree looks like from here.
    const broken = harness({ crs: [cr()], writers: {} });
    expect(await broken.listPendingSkills(ADMIN)).toEqual([]);
    // …and the author still sees their own, because that verdict needs no tree.
    expect(await broken.listPendingSkills(AUTHOR)).toHaveLength(1);
  });

  /**
   * A change request that EDITS a released skill is not a pending skill — the
   * skill page already carries those, and duplicating them here would put a
   * second, ghost card beside every skill under review.
   */
  test('ignores a change request against a skill that is already released', async () => {
    const svc = harness({
      crs: [cr()],
      released: [
        {
          name: 'weekly-newsletter',
          description: 'Drafts the Friday newsletter.',
          path: 'Groups/Engineering/weekly-newsletter',
        },
      ],
      writers: ADMIN_WRITES,
    });
    expect(await svc.listPendingSkills(AUTHOR)).toEqual([]);
  });

  test('ignores touched paths that are not a skill of their own', async () => {
    const svc = harness({
      crs: [
        cr({
          touchedNodePaths: [
            'Groups/Engineering/access.md',
            'Groups/Engineering/SKILL.md', // a group folder is not a skill
            'Groups/Engineering/weekly-newsletter/reference.md',
          ],
        }),
      ],
      writers: ADMIN_WRITES,
    });
    expect(await svc.listPendingSkills(AUTHOR)).toEqual([]);
  });

  /**
   * The proposal is read at the request's own branch. Reading the default
   * branch would find nothing and drop the card — which is the original bug.
   */
  test('drops a proposal whose SKILL.md cannot be read on its branch', async () => {
    const svc = harness({ crs: [cr()], branchFiles: {}, writers: ADMIN_WRITES });
    expect(await svc.listPendingSkills(AUTHOR)).toEqual([]);
  });

  test('ignores change requests that are not open', async () => {
    const svc = harness({ crs: [cr({ state: 'merged' })], writers: ADMIN_WRITES });
    expect(await svc.listPendingSkills(AUTHOR)).toEqual([]);
  });

  test('falls back to the folder name when the frontmatter declares no id', async () => {
    const svc = harness({
      crs: [cr()],
      branchFiles: {
        'agent/weekly-newsletter:Groups/Engineering/weekly-newsletter/SKILL.md':
          '---\ndescription: No name declared.\n---\n\n# Body\n',
      },
      writers: ADMIN_WRITES,
    });
    const [pending] = await svc.listPendingSkills(AUTHOR);
    expect(pending.name).toBe('weekly-newsletter');
    expect(pending.version).toBeUndefined();
  });

  /**
   * This hangs off the library's list load. A workflow service that cannot
   * answer must cost the reader an empty review shelf, not their whole library.
   */
  test('degrades to nothing pending when the change requests cannot be listed', async () => {
    const workflow = {
      listChangeRequests: async () => {
        throw new Error('offline');
      },
    } as unknown as IWorkflowService;
    const svc = new PendingSkillsService(
      {} as unknown as WorkspaceService,
      {} as unknown as IAccessControl,
      { listSkills: async () => [] } as unknown as ISkillService,
      workflow,
    );
    await expect(svc.listPendingSkills(AUTHOR)).resolves.toEqual([]);
  });

  test('oldest first — the request that has waited longest is the one to answer', async () => {
    const svc = harness({
      crs: [
        cr({ number: 9, createdAt: '2026-08-06T12:00:00.000Z' }),
        cr({
          number: 3,
          createdAt: '2026-08-01T12:00:00.000Z',
          branch: 'agent/older',
          touchedNodePaths: ['Groups/Engineering/older/SKILL.md'],
        }),
      ],
      branchFiles: {
        'agent/weekly-newsletter:Groups/Engineering/weekly-newsletter/SKILL.md': SKILL_MD,
        'agent/older:Groups/Engineering/older/SKILL.md':
          '---\nname: older\ndescription: Older.\n---\n',
      },
      writers: {
        ...ADMIN_WRITES,
        'Groups/Engineering/older/SKILL.md': [ADMIN],
      },
    });
    expect((await svc.listPendingSkills(ADMIN)).map((p) => p.changeRequestNumber)).toEqual([3, 9]);
  });
});
