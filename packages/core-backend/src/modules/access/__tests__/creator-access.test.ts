import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NodeFs } from '../../kb-fs/node-fs.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import type { WorkspaceService } from '../../workspace/workspace.service.js';
import { AccessControlService } from '../access-control.service.js';
import { CreatorAccessService } from '../creator-access.js';
import { testKbContext } from '../../../__tests__/kb-context.js';

const KB = 'knowledge-base';
const WS = 'ws-creator';

const ALICE = { name: 'Alice', email: 'alice@example.com' };

const ROLES_YAML = `roles:
  Admin:
    - razvan@bevel.software
`;

async function mkTmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'bevel-creator-access-'));
}

async function write(repo: string, rel: string, contents: string): Promise<void> {
  const abs = path.join(repo, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, contents);
}

function stubWorkspaceService(workspaceDir: string): WorkspaceService {
  return {
    getWorkspacePath: async (id: string) => {
      if (id !== WS) throw new Error(`unexpected workspace ${id}`);
      return workspaceDir;
    },
    readFile: async (_id: string, wsRel: string) =>
      fs.readFile(path.join(workspaceDir, wsRel), 'utf-8'),
    readFileBinary: async (_id: string, wsRel: string) => fs.readFile(path.join(workspaceDir, wsRel)),
  } as unknown as WorkspaceService;
}

/**
 * The creator grant covers ONE creation: a new folder directly under one of
 * the three roots, by someone the root does not let read. Everything else is
 * the read-before-write gate's business (`change-read-gate.test.ts`): a
 * creation the creator cannot see is refused there, and one they can see
 * inherits its folder's rules and needs no grant.
 */
describe('CreatorAccessService.planForCreate', () => {
  let root: string;
  let repo: string;
  let svc: CreatorAccessService;

  beforeEach(async () => {
    root = await mkTmpRoot();
    const workspaceDir = path.join(root, WS);
    repo = path.join(workspaceDir, KB);
    await fs.mkdir(path.join(repo, 'KnowledgeBase'), { recursive: true });
    await fs.mkdir(path.join(repo, 'Skills'), { recursive: true });
    await fs.mkdir(path.join(repo, 'Plugins'), { recursive: true });
    await write(repo, 'roles.yaml', ROLES_YAML);
    const ws = stubWorkspaceService(workspaceDir);
    svc = new CreatorAccessService(ws, new AccessControlService(ws, KB, new NodeFs()), testKbContext({ kbDirName: KB }), new NodeFs());
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('returns null when the creator can already read via the folder chain', async () => {
    await write(repo, 'KnowledgeBase/access.md', '---\nread:\n  - everyone\n---\n');
    const plan = await svc.planForCreate(WS, ALICE, `${KB}/KnowledgeBase/Projects`, 'dir');
    expect(plan).toBeNull();
  });

  it('a write grant folds into read — creating where you can write needs no grant', async () => {
    await write(repo, 'KnowledgeBase/access.md', '---\nwrite:\n  - Alice <alice@example.com>\n---\n');
    const plan = await svc.planForCreate(WS, ALICE, `${KB}/KnowledgeBase/Projects`, 'dir');
    expect(plan).toBeNull();
  });

  it('a new folder directly under a root gets its own access.md seeded, naming the creator under read:', async () => {
    const plan = await svc.planForCreate(WS, ALICE, `${KB}/KnowledgeBase/Projects`, 'dir');
    expect(plan?.kind).toBe('seed-access-md');
    if (plan?.kind !== 'seed-access-md') return;
    expect(plan.wsRelPath).toBe(`${KB}/KnowledgeBase/Projects/access.md`);
    // The platform's two-block file: a comment-only frontmatter (the file
    // follows the folder's rules), then the body that governs the folder,
    // explained in place, with the creator's grant as its one rule.
    const seeded = plan.apply('');
    expect(seeded.startsWith('---\n# THIS BLOCK (the frontmatter) governs this access.md FILE only')).toBe(true);
    expect(seeded).toContain('\n---\n# THIS BLOCK (the body) governs the FOLDER');
    expect(seeded.endsWith('\nread:\n  - Alice <alice@example.com>\n')).toBe(true);
  });

  it('all three roots are creatable: skills and plugins seed the same way', async () => {
    const skill = await svc.planForCreate(WS, ALICE, `${KB}/Skills/my-skill/SKILL.md`, 'file');
    expect(skill?.kind).toBe('seed-access-md');
    expect(skill?.wsRelPath).toBe(`${KB}/Skills/my-skill/access.md`);
    const plugin = await svc.planForCreate(WS, ALICE, `${KB}/Plugins/team/mcp.json`, 'file');
    expect(plugin?.kind).toBe('seed-access-md');
    expect(plugin?.wsRelPath).toBe(`${KB}/Plugins/team/access.md`);
  });

  it('the seed MERGES into existing access.md text — a concurrent creator grant survives', async () => {
    const plan = await svc.planForCreate(WS, ALICE, `${KB}/KnowledgeBase/Projects`, 'dir');
    expect(plan?.kind).toBe('seed-access-md');
    if (plan?.kind !== 'seed-access-md') return;
    // Simulate the two-creator race: by write time, Bob's seed already landed.
    const bobs = '---\nread:\n  - Bob <bob@example.com>\n---\n';
    const merged = plan.apply(bobs);
    expect(merged).toContain('- Bob <bob@example.com>');
    expect(merged).toContain('- Alice <alice@example.com>');
    // Idempotent: applying again changes nothing.
    expect(plan.apply(merged)).toBe(merged);
  });

  it('a nested create seeds at the new TOP-LEVEL folder, not the leaf', async () => {
    const plan = await svc.planForCreate(WS, ALICE, `${KB}/KnowledgeBase/A/B/c.md`, 'file');
    expect(plan?.kind).toBe('seed-access-md');
    if (plan?.kind !== 'seed-access-md') return;
    expect(plan.wsRelPath).toBe(`${KB}/KnowledgeBase/A/access.md`);
  });

  it('plans nothing inside a folder that already exists — the read gate decides there', async () => {
    await fs.mkdir(path.join(repo, 'KnowledgeBase/Existing'), { recursive: true });
    expect(await svc.planForCreate(WS, ALICE, `${KB}/KnowledgeBase/Existing/new.md`, 'file')).toBeNull();
    expect(await svc.planForCreate(WS, ALICE, `${KB}/KnowledgeBase/Existing/Sub`, 'dir')).toBeNull();
  });

  it('plans nothing for a loose file directly at a root — it has no folder to carry a grant', async () => {
    expect(await svc.planForCreate(WS, ALICE, `${KB}/KnowledgeBase/note.md`, 'file')).toBeNull();
    expect(await svc.planForCreate(WS, ALICE, `${KB}/KnowledgeBase/pic.png`, 'file')).toBeNull();
  });

  it('plans nothing through a link standing where the new folder would be', async () => {
    // Dangling on purpose: a stat that followed it would say "nothing there".
    await fs.symlink(path.join(root, 'elsewhere'), path.join(repo, 'KnowledgeBase/Linked'));
    expect(await svc.planForCreate(WS, ALICE, `${KB}/KnowledgeBase/Linked/a.md`, 'file')).toBeNull();
    expect(await svc.planForCreate(WS, ALICE, `${KB}/KnowledgeBase/Linked`, 'dir')).toBeNull();
  });

  it('plans nothing under a root that is not one of the three', async () => {
    expect(await svc.planForCreate(WS, ALICE, `${KB}/Data/Engineering`, 'dir')).toBeNull();
    expect(await svc.planForCreate(WS, ALICE, `${KB}/Elsewhere/Thing/a.md`, 'file')).toBeNull();
  });

  it('returns null for paths that already exist (an edit, not a create)', async () => {
    await write(repo, 'KnowledgeBase/Mine/existing.md', 'x');
    const plan = await svc.planForCreate(WS, ALICE, `${KB}/KnowledgeBase/Mine/existing.md`, 'file');
    expect(plan).toBeNull();
  });

  it('returns null for access.md, roles.yaml, .gitkeep, and non-KB paths', async () => {
    expect(await svc.planForCreate(WS, ALICE, `${KB}/KnowledgeBase/New/access.md`, 'file')).toBeNull();
    expect(await svc.planForCreate(WS, ALICE, `${KB}/roles.yaml`, 'file')).toBeNull();
    expect(await svc.planForCreate(WS, ALICE, `${KB}/KnowledgeBase/New/.gitkeep`, 'file')).toBeNull();
    expect(await svc.planForCreate(WS, ALICE, 'reserved-config.json', 'file')).toBeNull();
  });

  it('plans nothing when the probe for the new top-level folder fails — a failed probe is not "not there"', async () => {
    // A disk that cannot say whether `KnowledgeBase/Projects` exists: planning
    // on "not there" would seed a grant into a folder that may well exist.
    const real = new NodeFs();
    const failing = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop !== 'lstatOrNull') return Reflect.get(target, prop, receiver) as unknown;
        return async (abs: string) => {
          if (abs.endsWith(path.join('KnowledgeBase', 'Projects'))) {
            throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
          }
          return real.lstatOrNull(abs);
        };
      },
    });
    const ws = stubWorkspaceService(path.join(root, WS));
    const withFailingDisk = new CreatorAccessService(ws, new AccessControlService(ws, KB, real), testKbContext({ kbDirName: KB }), failing);
    expect(await withFailingDisk.planForCreate(WS, ALICE, `${KB}/KnowledgeBase/Projects`, 'dir')).toBeNull();
    expect(await withFailingDisk.planForCreate(WS, ALICE, `${KB}/KnowledgeBase/Projects/a.md`, 'file')).toBeNull();
    // The same creation on a disk that answers is planned, so it was the
    // probe's failure and not the path that made the difference.
    expect(await svc.planForCreate(WS, ALICE, `${KB}/KnowledgeBase/Projects`, 'dir')).not.toBeNull();
  });

  it('returns null (never throws) when the access config is unusable', async () => {
    await fs.rm(path.join(repo, 'roles.yaml'));
    const plan = await svc.planForCreate(WS, ALICE, `${KB}/KnowledgeBase/Projects`, 'dir');
    expect(plan).toBeNull();
  });

  it('sanitises a display name that would break the Name <email> entry shape', async () => {
    const evil = { name: 'Al<ce # ', email: 'alice@example.com' };
    const plan = await svc.planForCreate(WS, evil, `${KB}/KnowledgeBase/Dir`, 'dir');
    expect(plan?.kind).toBe('seed-access-md');
    if (plan?.kind !== 'seed-access-md') return;
    expect(plan.apply('')).toContain('- Al ce <alice@example.com>');
  });

  it('the seeded grant makes the new folder readable — including via the batched tree check', async () => {
    const ws = stubWorkspaceService(path.join(root, WS));
    const access = new AccessControlService(ws, KB, new NodeFs());
    const plan = await svc.planForCreate(WS, ALICE, `${KB}/KnowledgeBase/Mine`, 'dir');
    expect(plan?.kind).toBe('seed-access-md');
    if (plan?.kind !== 'seed-access-md') return;
    await write(repo, 'KnowledgeBase/Mine/access.md', plan.apply(''));
    expect(await access.canRead(WS, ALICE.email, 'KnowledgeBase/Mine')).toBe(true);
    const batch = await access.canReadBatch(WS, ALICE.email, [
      'KnowledgeBase/Mine',
      'KnowledgeBase/Mine/anything.md',
    ]);
    expect(batch.get('KnowledgeBase/Mine')).toBe(true);
    expect(batch.get('KnowledgeBase/Mine/anything.md')).toBe(true);
  });
});
