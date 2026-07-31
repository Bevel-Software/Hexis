import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import type { WorkspaceService } from '../../workspace/workspace.service.js';
import { AccessControlService } from '../access-control.service.js';
import { CreatorAccessService } from '../creator-access.js';

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
  } as unknown as WorkspaceService;
}

describe('CreatorAccessService.planForCreate', () => {
  let root: string;
  let repo: string;
  let svc: CreatorAccessService;

  beforeEach(async () => {
    root = await mkTmpRoot();
    const workspaceDir = path.join(root, WS);
    repo = path.join(workspaceDir, KB);
    await fs.mkdir(path.join(repo, 'KnowledgeBase'), { recursive: true });
    await write(repo, 'roles.yaml', ROLES_YAML);
    const ws = stubWorkspaceService(workspaceDir);
    svc = new CreatorAccessService(ws, new AccessControlService(ws, KB), KB);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('returns null when the creator can already read via the folder chain', async () => {
    await write(repo, 'KnowledgeBase/access.md', '---\nread:\n  - everyone\n---\n');
    const plan = await svc.planForCreate(WS, ALICE, `${KB}/KnowledgeBase/note.md`, 'file');
    expect(plan).toBeNull();
  });

  it('a write grant folds into read — creating where you can write needs no grant', async () => {
    await write(repo, 'KnowledgeBase/access.md', '---\nwrite:\n  - Alice <alice@example.com>\n---\n');
    const plan = await svc.planForCreate(WS, ALICE, `${KB}/KnowledgeBase/note.md`, 'file');
    expect(plan).toBeNull();
  });

  it('a loose .md in a pre-existing unreadable folder gets a frontmatter grant', async () => {
    const plan = await svc.planForCreate(WS, ALICE, `${KB}/KnowledgeBase/note.md`, 'file');
    expect(plan?.kind).toBe('frontmatter');
    if (plan?.kind !== 'frontmatter') return;
    const granted = plan.apply('# Hello\n');
    expect(granted).toBe('---\nread: Alice <alice@example.com>\n---\n# Hello\n');
  });

  it('frontmatter grant splices into existing frontmatter without touching the body', async () => {
    const plan = await svc.planForCreate(WS, ALICE, `${KB}/KnowledgeBase/node.md`, 'file');
    expect(plan?.kind).toBe('frontmatter');
    if (plan?.kind !== 'frontmatter') return;
    const granted = plan.apply('---\nnodeType: Process\n---\nBody\n');
    expect(granted).toContain('nodeType: Process');
    expect(granted).toContain('read: Alice <alice@example.com>');
    expect(granted).toContain('Body');
  });

  it('a new folder gets its own access.md seeded, naming the creator under read:', async () => {
    const plan = await svc.planForCreate(WS, ALICE, `${KB}/KnowledgeBase/Projects`, 'dir');
    expect(plan?.kind).toBe('seed-access-md');
    if (plan?.kind !== 'seed-access-md') return;
    expect(plan.wsRelPath).toBe(`${KB}/KnowledgeBase/Projects/access.md`);
    expect(plan.apply('')).toBe('---\nread:\n  - Alice <alice@example.com>\n---\n');
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

  it('a nested create seeds at the TOPMOST new directory, not the leaf', async () => {
    const plan = await svc.planForCreate(WS, ALICE, `${KB}/KnowledgeBase/A/B/c.md`, 'file');
    expect(plan?.kind).toBe('seed-access-md');
    if (plan?.kind !== 'seed-access-md') return;
    expect(plan.wsRelPath).toBe(`${KB}/KnowledgeBase/A/access.md`);
  });

  it('never targets a pre-existing directory: only new dirs are seeded', async () => {
    await fs.mkdir(path.join(repo, 'KnowledgeBase/Existing'), { recursive: true });
    const plan = await svc.planForCreate(WS, ALICE, `${KB}/KnowledgeBase/Existing/new.md`, 'file');
    // Existing dir → the grant must land in the file's own frontmatter, not
    // Existing/access.md (that would leak read on all its siblings).
    expect(plan?.kind).toBe('frontmatter');
  });

  it('returns null for paths that already exist (an edit, not a create)', async () => {
    await write(repo, 'KnowledgeBase/existing.md', 'x');
    const plan = await svc.planForCreate(WS, ALICE, `${KB}/KnowledgeBase/existing.md`, 'file');
    expect(plan).toBeNull();
  });

  it('returns null for access.md, roles.yaml, .gitkeep, and non-KB paths', async () => {
    expect(await svc.planForCreate(WS, ALICE, `${KB}/KnowledgeBase/access.md`, 'file')).toBeNull();
    expect(await svc.planForCreate(WS, ALICE, `${KB}/roles.yaml`, 'file')).toBeNull();
    expect(await svc.planForCreate(WS, ALICE, `${KB}/KnowledgeBase/.gitkeep`, 'file')).toBeNull();
    expect(await svc.planForCreate(WS, ALICE, 'reserved-config.json', 'file')).toBeNull();
  });

  it('returns null (never throws) for a non-markdown loose file in an existing folder', async () => {
    const plan = await svc.planForCreate(WS, ALICE, `${KB}/KnowledgeBase/pic.png`, 'file');
    expect(plan).toBeNull();
  });

  it('returns null (never throws) when the access config is unusable', async () => {
    await fs.rm(path.join(repo, 'roles.yaml'));
    const plan = await svc.planForCreate(WS, ALICE, `${KB}/KnowledgeBase/note.md`, 'file');
    expect(plan).toBeNull();
  });

  it('sanitises a display name that would break the Name <email> entry shape', async () => {
    const evil = { name: 'Al<ce # ', email: 'alice@example.com' };
    const plan = await svc.planForCreate(WS, evil, `${KB}/KnowledgeBase/Dir`, 'dir');
    expect(plan?.kind).toBe('seed-access-md');
    if (plan?.kind !== 'seed-access-md') return;
    expect(plan.apply('')).toContain('- Al ce <alice@example.com>');
  });

  it('the seeded grant makes the new folder readable — including via the batched tree check', async () => {
    const ws = stubWorkspaceService(path.join(root, WS));
    const access = new AccessControlService(ws, KB);
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

  it('the frontmatter grant makes a loose file readable via the FULL check', async () => {
    const ws = stubWorkspaceService(path.join(root, WS));
    const access = new AccessControlService(ws, KB);
    const plan = await svc.planForCreate(WS, ALICE, `${KB}/KnowledgeBase/loose.md`, 'file');
    expect(plan?.kind).toBe('frontmatter');
    if (plan?.kind !== 'frontmatter') return;
    await write(repo, 'KnowledgeBase/loose.md', plan.apply('# Loose\n'));
    expect(await access.canRead(WS, ALICE.email, 'KnowledgeBase/loose.md')).toBe(true);
  });
});

describe('CreatorAccessService.grantInExtractedFile', () => {
  let root: string;
  let repo: string;
  let svc: CreatorAccessService;

  beforeEach(async () => {
    root = await mkTmpRoot();
    const workspaceDir = path.join(root, WS);
    repo = path.join(workspaceDir, KB);
    await fs.mkdir(path.join(repo, 'KnowledgeBase'), { recursive: true });
    await write(repo, 'roles.yaml', ROLES_YAML);
    const ws = stubWorkspaceService(workspaceDir);
    svc = new CreatorAccessService(ws, new AccessControlService(ws, KB), KB);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('splices the creator grant into an on-disk .md the creator cannot read', async () => {
    await write(repo, 'KnowledgeBase/extracted.md', '# From zip\n');
    const text = await svc.grantInExtractedFile(WS, ALICE, `${KB}/KnowledgeBase/extracted.md`);
    expect(text).toBe('---\nread: Alice <alice@example.com>\n---\n# From zip\n');
  });

  it('returns null when the file is already readable, non-markdown, or non-KB', async () => {
    await write(repo, 'KnowledgeBase/access.md', '---\nread:\n  - everyone\n---\n');
    await write(repo, 'KnowledgeBase/extracted.md', '# From zip\n');
    expect(await svc.grantInExtractedFile(WS, ALICE, `${KB}/KnowledgeBase/extracted.md`)).toBeNull();
    expect(await svc.grantInExtractedFile(WS, ALICE, `${KB}/KnowledgeBase/pic.png`)).toBeNull();
    expect(await svc.grantInExtractedFile(WS, ALICE, 'reserved.md')).toBeNull();
  });
});
