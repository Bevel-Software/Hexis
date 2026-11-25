import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_BRANCH } from '@bevel-software/platform-shared';
import { NodeFs } from '../../kb-fs/node-fs.js';
import { SkillService } from '../skills.service.js';
import { workspaceIdForBranch } from '../../../shared/workspace-id.js';
import { testKbContext } from '../../../__tests__/kb-context.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import type { IAccessControl } from '../../access/access-control.interface.js';

/**
 * ONE PERSON'S PRIVATE SKILL NEVER TAKES ANOTHER PERSON'S AWAY.
 *
 * A skill name used to be unique across the whole catalog, decided by path
 * order before anyone's access was asked: a second person writing a personal
 * skill of the same name into a folder that sorted first took the first
 * person's skill away from them (`get_skill` answered `forbidden`, the
 * listing and their plugin page lost it). A name is unique per owner now;
 * each person reads their own.
 */

const KB_DIR = 'knowledge-base';
const wsId = workspaceIdForBranch(DEFAULT_BRANCH);
const NAME = 'qa-standup-notes';
const AAA = 'Plugins/personal-aaa/skills/qa-standup-notes';
const ZZZ = 'Plugins/personal-zzz/skills/qa-standup-notes';
const OWNER = { [AAA]: 'aaa@x.eu', [ZZZ]: 'zzz@x.eu' } as const;

/** Each person reads their own personal folder and nothing of the other's. */
function readsOwn(email: string, p: string): boolean {
  if (p.startsWith('Plugins/personal-aaa/')) return email === 'aaa@x.eu';
  if (p.startsWith('Plugins/personal-zzz/')) return email === 'zzz@x.eu';
  return true;
}
const ownFolderOnly: IAccessControl = {
  canRead: async (_w: string, email: string, p: string) => readsOwn(email, p),
  canReadBatch: async (_w: string, email: string, paths: string[]) =>
    new Map(paths.map((p) => [p, readsOwn(email, p)])),
} as unknown as IAccessControl;

describe('two people, one skill name, each in their own personal plugin', () => {
  let root: string;

  const workspaceService = {
    getOrCreateForBranch: async () => ({ id: wsId }),
    getWorkspacePath: async (id: string) => join(root, id),
    readFile: async (id: string, rel: string) => readFile(join(root, id, rel), 'utf-8'),
  } as unknown as WorkspaceService;

  const svc = () => new SkillService(workspaceService, ownFolderOnly, testKbContext({ kbDirName: KB_DIR }), new NodeFs());
  const writeSkill = async (folder: string, body: string) => {
    const dir = join(root, wsId, KB_DIR, folder);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'SKILL.md'), `---\nname: ${NAME}\ndescription: ${body}\n---\n\n# ${body}\n`);
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'skills-personal-clash-'));
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  // Both directions: the existing skill's folder sorting LAST (zzz, the QA
  // report's case) and FIRST (aaa). The write order cannot matter to a disk
  // scan, so each case writes the existing one first and the newcomer second.
  describe.each([
    { existing: ZZZ, newcomer: AAA },
    { existing: AAA, newcomer: ZZZ },
  ])('$newcomer written beside $existing', ({ existing, newcomer }) => {
    test('each owner lists and loads their own skill, and nothing of the other', async () => {
      await writeSkill(existing, 'existing');
      const before = await svc().getSkill(OWNER[existing], NAME);
      expect(before.ok && before.kind === 'skill' && before.skill.path).toBe(existing);

      await writeSkill(newcomer, 'newcomer');
      const service = svc();
      for (const [folder, body] of [
        [existing, 'existing'],
        [newcomer, 'newcomer'],
      ] as const) {
        const email = OWNER[folder];
        const listed = await service.listSkills(email);
        expect(listed.filter((s) => s.name === NAME).map((s) => s.path)).toEqual([folder]);
        const got = await service.getSkill(email, NAME);
        expect(got.ok && got.kind === 'skill' && [got.skill.path, got.skill.description]).toEqual([folder, body]);
      }
      // The unfiltered catalog (plugin pages' counts) holds both: neither
      // person's plugin reads as "no skills of your own".
      expect((await service.listSkills()).filter((s) => s.name === NAME).map((s) => s.path).sort()).toEqual(
        [AAA, ZZZ].sort(),
      );
      // A third person reads neither, and is not told whose they are.
      expect((await service.listSkills('third@x.eu')).some((s) => s.name === NAME)).toBe(false);
      expect(await service.getSkill('third@x.eu', NAME)).toEqual({ ok: false, error: 'forbidden' });
    });
  });

  test('a shared skill of the same name still wins for the owner of a personal copy', async () => {
    await writeSkill('Skills/qa-standup-notes', 'shared');
    await writeSkill(ZZZ, 'personal');
    const got = await svc().getSkill('zzz@x.eu', NAME);
    expect(got.ok && got.kind === 'skill' && got.skill.path).toBe('Skills/qa-standup-notes');
    expect((await svc().listSkills('zzz@x.eu')).filter((s) => s.name === NAME).map((s) => s.path)).toEqual([
      'Skills/qa-standup-notes',
    ]);
  });

  test('one owner holding the name twice still keeps one: the dedup is per owner, not abolished', async () => {
    await writeSkill('Plugins/personal-zzz/a/qa-standup-notes', 'first');
    await writeSkill('Plugins/personal-zzz/b/qa-standup-notes', 'second');
    expect((await svc().listSkills()).filter((s) => s.name === NAME).map((s) => s.path)).toEqual([
      'Plugins/personal-zzz/a/qa-standup-notes',
    ]);
  });
});
