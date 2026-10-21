import type { Server as HttpServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalFilesystem } from '@mastra/core/workspace';
import { testKbContext } from '../../../__tests__/kb-context.js';
import { ToolRegistry } from '../../tool-registry/tool-registry.js';
import { createToolHandlerFactory } from '../tool-handler.js';
import { ToolError, type ToolContext } from '../tool.contract.js';
import type { ToolAuth } from '../../tool-auth/tool-auth.middleware.js';
import { registerWorkspaceTools } from '../../workspace/workspace.tools.js';
import { RoutineWritePolicyService } from '../../workspace/routine-write-policy.js';
import { WorkflowHooks } from '../../workflow/workflow-hooks.js';
import { ToolDescriptionNotes } from '../../workspace/agent-access.gate.js';
import { SpillStore } from '../../workspace/spill-store.js';
import { DocExtractService, WorkerDocumentExtractor } from '../../workspace/index.js';
import { AccessControlService } from '../../access/access-control.service.js';
import type { IAccessControl } from '../../access/access-control.interface.js';
import { NodeFs } from '../../kb-fs/node-fs.js';
import { workspaceIdForBranch } from '../../../shared/workspace-id.js';
import { BranchNotFoundError } from '../../../shared/domain-errors.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import { SkillService, registerSkillsTools } from '../../skills/index.js';
import { defaultBranchWriteVerdicts } from '../index.js';

/**
 * `canWrite` on `list_skills`, `get_skill`, `list_files` and `read_file`,
 * driven over the REAL resolver and the real skill catalog on two on-disk
 * clones: the default branch, and a draft whose access rules let anyone
 * write. The verdict must be the default branch's — what can LAND directly —
 * whichever branch the call reads.
 */

const KB = 'knowledge-base';
const MAIN = 'main';
const DRAFT = 'eng/draft';
const ADMIN = 'admin@x.io';
const ENG = 'eng@x.io';

const SKILL = (name: string) => `---\nname: ${name}\ndescription: The ${name} skill.\n---\n\n# ${name}\n`;

/** The default branch: write is Admin's, except where a folder opens it. */
const MAIN_TREE: Record<string, string> = {
  'roles.yaml': `roles:\n  Admin:\n    - ${ADMIN}\n  Engineer:\n    - ${ENG}\n`,
  'access.md': '---\nread:\n  - everyone\nwrite:\n  - Admin\n---\n',
  // The knowledge base's own conventions file, whose frontmatter opens it.
  'AGENTS.md': '---\nwrite:\n  - everyone\n---\n# Our conventions\n',
  // A plugin whose access.md grants write to Admin only.
  'Plugins/Everyone/access.md': '---\nread:\n  - everyone\nwrite:\n  - Admin\n---\n',
  'Plugins/Everyone/html-knowledge-view/SKILL.md': SKILL('html-knowledge-view'),
  // A plugin anyone may write, with one bundled file whose own rules refuse Eng.
  'Plugins/Shared/access.md': '---\nwrite:\n  - everyone\n---\n',
  'Plugins/Shared/deck/SKILL.md': SKILL('deck'),
  'Plugins/Shared/deck/reference.md': `---\nwrite:\n  - deny Eng <${ENG}>\n---\n# Reference\n`,
  'Plugins/Shared/notes/SKILL.md': SKILL('notes'),
  'Plugins/Shared/notes/scripts/run.sh': 'echo hi\n',
  // Files and folders for list_files.
  'Notes/access.md': '---\nwrite:\n  - everyone\n---\n',
  'Notes/open.md': '# Open\n',
  'Notes/locked.md': `---\nwrite:\n  - deny Eng <${ENG}>\n---\n# Locked\n`,
  'Notes/Open/inside.md': '# Inside\n',
  'Notes/Sub/access.md': `---\nwrite:\n  - deny Eng <${ENG}>\n---\n`,
  'Notes/Sub/inside.md': '# Inside\n',
};

/** The draft: the same tree with every write rule thrown open, and two skills only it has. */
const DRAFT_TREE: Record<string, string> = {
  ...MAIN_TREE,
  'access.md': '---\nread:\n  - everyone\nwrite:\n  - everyone\n---\n',
  'Plugins/Everyone/access.md': '---\nread:\n  - everyone\nwrite:\n  - everyone\n---\n',
  'Notes/locked.md': '# Locked, unlocked on the draft\n',
  'Notes/Sub/access.md': '---\nwrite:\n  - everyone\n---\n',
  'Plugins/Everyone/draft-only/SKILL.md': SKILL('draft-only'),
  'Plugins/Shared/shared-draft/SKILL.md': SKILL('shared-draft'),
};

let root = '';
let docCache = '';
let base = '';
let server: HttpServer;
let access: AccessControlService;
let skills: SkillService;
let spills: SpillStore;
let caller = ENG;
let scope: 'read' | 'write' = 'write';
/** Calls the access layer took for write verdicts, by method, since the last reset. */
let writeChecks: { method: string; workspaceId: string; ref?: string; paths: string[] }[] = [];
/** A deployment's read hook: refuses the reads this matches; every read it is asked about is noted. */
let refuseRead: ((branch: string, wsPath: string) => boolean) | null = null;
let readsNoted: { branch: string; wsPath: string }[] = [];
/** Set, the listing of a skill's committed files fails with it — the git behind `get_skill`'s verdict going away. */
let listingFails: Error | null = null;
/** The refs the skill's committed files were listed at, in order. */
let listedAt: string[] = [];
const hooks = new WorkflowHooks();
hooks.onAgentRead(async ({ branch, wsPath = '' }) => {
  readsNoted.push({ branch, wsPath });
  if (refuseRead?.(branch, wsPath)) throw new ToolError('Not in this conversation.', 403);
});

const wsDir = (branch: string) => join(root, workspaceIdForBranch(branch));

const execFileAsync = promisify(execFile);
const git = async (cwd: string, ...args: string[]): Promise<string> =>
  (await execFileAsync('git', ['-C', cwd, '-c', 'user.email=t@x.io', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args])).stdout;
/** Commit everything in the default branch's clone: what a direct write is judged by. */
const commitMain = async (message: string): Promise<void> => {
  const repo = join(wsDir(MAIN), KB);
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-q', '--allow-empty', '-m', message);
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'can-write-'));
  for (const [branch, tree] of [[MAIN, MAIN_TREE], [DRAFT, DRAFT_TREE]] as const) {
    for (const [rel, text] of Object.entries(tree)) {
      const abs = join(wsDir(branch), KB, rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, text);
    }
  }
  // The default branch is a real clone with its rules COMMITTED: a verdict is
  // judged at its HEAD, as a direct write is. The draft stays a plain tree;
  // nothing is judged at a ref there.
  await git(join(wsDir(MAIN), KB), 'init', '-q', '-b', MAIN);
  await commitMain('rules');
  const kb = testKbContext({ kbDirName: KB, branchModel: { defaultBranch: MAIN, protectedBranches: [MAIN] } });
  const workspaceService = {
    getWorkspacePath: async (id: string) => join(root, id),
    ensureRemotesFetched: async () => undefined,
    getOrCreateForBranch: async (branch: string) => {
      if (branch !== MAIN && branch !== DRAFT) throw new BranchNotFoundError(branch);
      return { id: workspaceIdForBranch(branch) };
    },
    readFile: async (id: string, rel: string) => readFile(join(root, id, rel), 'utf-8'),
  } as unknown as WorkspaceService;
  access = new AccessControlService(workspaceService, KB, new NodeFs());
  // The real resolver, with its write checks counted: the cost criterion is
  // ONE batched check per call, against the default branch.
  const counted = new Proxy(access, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === 'canWriteBatchAtRef') {
        return (workspaceId: string, ref: string, email: string, paths: string[]) => {
          writeChecks.push({ method: prop, workspaceId, ref, paths });
          return (value as (...a: unknown[]) => unknown).call(target, workspaceId, ref, email, paths);
        };
      }
      if (prop === 'canWriteBatch' || prop === 'canWrite') {
        return (workspaceId: string, email: string, paths: string[] | string) => {
          writeChecks.push({ method: prop, workspaceId, paths: Array.isArray(paths) ? paths : [paths] });
          return (value as (...a: unknown[]) => unknown).call(target, workspaceId, email, paths);
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as unknown as IAccessControl;
  skills = new SkillService(workspaceService, counted, kb, new NodeFs());
  spills = new SpillStore(join(root, 'spills'));

  const resolve = async (auth: ToolAuth, signal: AbortSignal, sessionId?: string): Promise<ToolContext> => ({
    user: { id: caller, email: caller, name: caller },
    scope: auth.scope,
    source: auth.source,
    sessionId,
    abortSignal: signal,
    workspaceService: workspaceService as never,
    workflowService: {} as never,
    events: {} as never,
    getFilesystem: async (branch: string) => new LocalFilesystem({ basePath: wsDir(branch), contained: true }),
  });
  const app = express();
  app.use(express.json());
  const router = express.Router();
  const toolAuth = ((req, _res, next) => {
    req.toolAuth = { source: 'internal', userId: caller, scope };
    next();
  }) as express.RequestHandler;
  const toolHandler = createToolHandlerFactory(resolve);
  docCache = await mkdtemp(join(tmpdir(), 'can-write-doc-'));
  registerWorkspaceTools(
    new ToolRegistry(),
    router,
    toolAuth,
    toolHandler,
    spills,
    new DocExtractService(docCache, new WorkerDocumentExtractor()),
    counted,
    kb,
    { recoveryBotEmail: 'recovery-bot@bevel.local', hooks, notes: new ToolDescriptionNotes() },
    new RoutineWritePolicyService(),
    {} as never,
    undefined,
    undefined,
    undefined,
    async () => 'THE PLATFORM GUIDE\n',
  );
  registerSkillsTools(new ToolRegistry(), router, toolAuth, toolHandler, skills, undefined, {
    accessControl: counted,
    defaultWorkspaceId: () => kb.defaultWorkspaceId(),
    // The skill's files as committed: read off the default branch's clone
    // with git, as the server reads them, so a deletion on disk alone does
    // not reach the verdict.
    committedFiles: {
      commitAtRef: async (workspaceId, ref) => (await git(join(root, workspaceId, KB), 'rev-parse', '--verify', `${ref}^{commit}`)).trim(),
      listFilesAtRef: async (workspaceId, ref, folder) => {
        if (listingFails) throw listingFails;
        listedAt.push(ref);
        const out = await git(join(root, workspaceId, KB), 'ls-tree', '-r', '-z', '--name-only', ref, '--', folder);
        return out.split('\0').filter((line) => line.length > 0);
      },
    },
  });
  app.use('/api', router);
  server = await new Promise<HttpServer>((r) => {
    const s = app.listen(0, () => r(s));
  });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await rm(root, { recursive: true, force: true });
  await rm(docCache, { recursive: true, force: true });
});

beforeEach(() => {
  caller = ENG;
  scope = 'write';
  writeChecks = [];
  refuseRead = null;
  readsNoted = [];
});

async function call<T>(tool: string, body: Record<string, unknown>, as = caller): Promise<T> {
  caller = as;
  const res = await fetch(`${base}/api/agent/tools/${tool}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer x' },
    body: JSON.stringify(body),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as T;
}

type Listed = { skills: { name: string; canWrite: boolean }[] };
const verdictsOf = (listed: Listed) => Object.fromEntries(listed.skills.map((s) => [s.name, s.canWrite]));

describe('list_skills carries canWrite, judged on SKILL.md by the default branch', () => {
  it('a plugin that grants write to Admin only: false for a non-admin, true for an admin', async () => {
    expect(verdictsOf(await call<Listed>('list_skills', {}, ENG))).toMatchObject({
      'html-knowledge-view': false,
      deck: true,
      notes: true,
    });
    expect(verdictsOf(await call<Listed>('list_skills', {}, ADMIN))).toMatchObject({
      'html-knowledge-view': true,
      deck: true,
      notes: true,
    });
  });

  it('on a draft, every verdict is the default branch\'s — a draft-only skill judged where it would land', async () => {
    // The draft's rules let Eng write everything; what lands is the default branch's call.
    expect(verdictsOf(await call<Listed>('list_skills', { branch: DRAFT }, ENG))).toEqual({
      'html-knowledge-view': false,
      'draft-only': false,
      deck: true,
      notes: true,
      'shared-draft': true,
    });
    expect(writeChecks.every((c) => c.workspaceId === workspaceIdForBranch(MAIN))).toBe(true);
  });

  it('two users in turn, within the catalog cache, each see only their own verdicts', async () => {
    const first = verdictsOf(await call<Listed>('list_skills', {}, ENG));
    const second = verdictsOf(await call<Listed>('list_skills', {}, ADMIN));
    const third = verdictsOf(await call<Listed>('list_skills', {}, ENG));
    expect(first['html-knowledge-view']).toBe(false);
    expect(second['html-knowledge-view']).toBe(true);
    expect(third).toEqual(first);
    // The shared catalog itself never carries a verdict.
    for (const s of await skills.listSkills()) expect(s).not.toHaveProperty('canWrite');
    for (const s of await skills.listSkills(ENG)) expect(s).not.toHaveProperty('canWrite');
  });

  it('makes one batched write check per call, against the default branch at its HEAD', async () => {
    await call<Listed>('list_skills', { branch: DRAFT });
    expect(writeChecks).toEqual([
      expect.objectContaining({ method: 'canWriteBatchAtRef', workspaceId: workspaceIdForBranch(MAIN), ref: 'HEAD' }),
    ]);
  });
});

describe('get_skill carries canWrite for the whole skill', () => {
  type Got = { skill: { canWrite: boolean; files: string[] } };

  it('is true only when every file of the skill may be written', async () => {
    // SKILL.md is writable (list says true) but a bundled file's own rules refuse Eng.
    expect((await call<Got>('get_skill', { name: 'deck' }, ENG)).skill.canWrite).toBe(false);
    expect((await call<Got>('get_skill', { name: 'notes' }, ENG)).skill.canWrite).toBe(true);
    expect((await call<Got>('get_skill', { name: 'html-knowledge-view' }, ENG)).skill.canWrite).toBe(false);
    expect((await call<Got>('get_skill', { name: 'html-knowledge-view' }, ADMIN)).skill.canWrite).toBe(true);
  });

  it('judges a bundled `file` on its own, and a draft read by the default branch', async () => {
    const file = await call<{ file: { canWrite: boolean } }>('get_skill', { name: 'deck', file: 'reference.md' }, ENG);
    expect(file.file.canWrite).toBe(false);
    writeChecks = [];
    const onDraft = await call<Got>('get_skill', { name: 'html-knowledge-view', branch: DRAFT }, ENG);
    expect(onDraft.skill.canWrite).toBe(false);
    expect(writeChecks).toHaveLength(1);
    expect(writeChecks[0].workspaceId).toBe(workspaceIdForBranch(MAIN));
  });

  it('judges the files the skill has on the default branch, so a draft that drops a denied file stays false', async () => {
    const onDraft = join(wsDir(DRAFT), KB, 'Plugins/Shared/deck/reference.md');
    await rm(onDraft);
    try {
      const draft = await call<Got>('get_skill', { name: 'deck', branch: DRAFT }, ENG);
      // The draft's copy no longer bundles reference.md, but the default branch's does, and its rules refuse Eng.
      expect(draft.skill.files.some((f) => f.endsWith('reference.md'))).toBe(false);
      expect(draft.skill.canWrite).toBe(false);
      expect((await call<Got>('get_skill', { name: 'deck', branch: MAIN }, ENG)).skill.canWrite).toBe(false);
      expect(writeChecks.filter((c) => c.method === 'canWriteBatchAtRef')).toHaveLength(2);
    } finally {
      await writeFile(onDraft, MAIN_TREE['Plugins/Shared/deck/reference.md']);
    }
  });

  it('judges the files as COMMITTED on the default branch: a bundled file deleted on disk but not committed still counts', async () => {
    const onMain = join(wsDir(MAIN), KB, 'Plugins/Shared/deck/reference.md');
    await rm(onMain);
    try {
      // Gone from the clone's working tree, still at HEAD with its rules: the
      // verdict stays false, as the direct write of it would be refused.
      expect((await call<Got>('get_skill', { name: 'deck' }, ENG)).skill.canWrite).toBe(false);
      // Committed, the skill is SKILL.md alone, which Eng may write.
      await commitMain('drop reference.md');
      expect((await call<Got>('get_skill', { name: 'deck' }, ENG)).skill.canWrite).toBe(true);
    } finally {
      await writeFile(onMain, MAIN_TREE['Plugins/Shared/deck/reference.md']);
      await commitMain('reference.md again');
    }
    expect((await call<Got>('get_skill', { name: 'deck' }, ENG)).skill.canWrite).toBe(false);
  });

  it('judges a skill only the draft has by its draft files, where they would land', async () => {
    expect((await call<Got>('get_skill', { name: 'draft-only', branch: DRAFT }, ENG)).skill.canWrite).toBe(false);
    expect((await call<Got>('get_skill', { name: 'draft-only', branch: DRAFT }, ADMIN)).skill.canWrite).toBe(true);
    expect((await call<Got>('get_skill', { name: 'shared-draft', branch: DRAFT }, ENG)).skill.canWrite).toBe(true);
  });

  it('lists the files and judges them at ONE commit, the one HEAD named when asked', async () => {
    listedAt = [];
    writeChecks = [];
    expect((await call<Got>('get_skill', { name: 'notes' }, ENG)).skill.canWrite).toBe(true);
    const head = (await git(join(wsDir(MAIN), KB), 'rev-parse', 'HEAD')).trim();
    // Not "HEAD", which a commit landing in between would move: the commit itself.
    expect(listedAt).toEqual([head]);
    expect(writeChecks.map((c) => c.ref)).toEqual([head]);
  });

  it('a folder of the skill\'s name holding other tracked files on the default branch is not the skill', async () => {
    // The default branch has no shared-draft SKILL.md, only an unrelated file
    // under that folder whose rules refuse Eng: not the skill, so the draft's
    // own files are what is judged, and Eng may write those.
    const stray = join(wsDir(MAIN), KB, 'Plugins/Shared/shared-draft/locked.md');
    await mkdir(dirname(stray), { recursive: true });
    await writeFile(stray, `---\nwrite:\n  - deny Eng <${ENG}>\n---\n# Not the skill\n`);
    await commitMain('a stray under the draft-only skill\'s folder');
    try {
      expect((await call<Got>('get_skill', { name: 'shared-draft', branch: DRAFT }, ENG)).skill.canWrite).toBe(true);
    } finally {
      await rm(stray);
      await commitMain('stray gone');
    }
  });

  it('a blank `version` is the latest default copy: no second lookup of the released skill', async () => {
    const loads = vi.spyOn(skills, 'getSkill');
    try {
      expect((await call<Got>('get_skill', { name: 'notes', version: '  ' }, ENG)).skill.canWrite).toBe(true);
      expect(loads).toHaveBeenCalledTimes(1);
    } finally {
      loads.mockRestore();
    }
  });

  it('fails closed when the files committed on the default branch cannot be listed', async () => {
    const draftRead = { name: 'html-knowledge-view', branch: DRAFT };
    // The baseline: the admin may write every file of it on the default branch.
    expect((await call<Got>('get_skill', draftRead, ADMIN)).skill.canWrite).toBe(true);
    // The draft read itself goes through; the listing of the skill's committed files fails.
    listingFails = new Error('git is unavailable');
    writeChecks = [];
    try {
      const got = await call<Got>('get_skill', draftRead, ADMIN);
      expect(got.skill.canWrite).toBe(false);
      // Nothing to judge, so the access layer is not asked.
      expect(writeChecks).toEqual([]);
    } finally {
      listingFails = null;
    }
  });
});

describe('list_files carries canWrite per entry', () => {
  type Listing = { entries: { name: string; type: string; canWrite: boolean }[] };
  const byName = (l: Listing) => Object.fromEntries(l.entries.map((e) => [e.name, e.canWrite]));

  it('a file by its own rules, a folder by whether a file may be added directly inside it', async () => {
    const listing = await call<Listing>('list_files', { branch: MAIN, path: `${KB}/Notes` }, ENG);
    expect(byName(listing)).toMatchObject({
      'open.md': true,
      'locked.md': false, // its own frontmatter denies Eng
      Open: true, // inherits Notes/'s grant
      Sub: false, // its own access.md denies Eng
    });
    expect(writeChecks).toHaveLength(1);
  });

  it('on a draft, reports what the default branch would accept', async () => {
    const listing = await call<Listing>('list_files', { branch: DRAFT, path: `${KB}/Notes` }, ENG);
    expect(byName(listing)).toMatchObject({ 'open.md': true, 'locked.md': false, Open: true, Sub: false });
    const plugin = await call<Listing>('list_files', { branch: DRAFT, path: `${KB}/Plugins/Everyone` }, ENG);
    expect(byName(plugin)).toMatchObject({ 'html-knowledge-view': false, 'draft-only': false });
  });

  it('the repository folder at the workspace root is judged as the repository root', async () => {
    const asEng = await call<Listing>('list_files', { branch: MAIN }, ENG);
    const asAdmin = await call<Listing>('list_files', { branch: MAIN }, ADMIN);
    expect(byName(asEng)[KB]).toBe(false);
    expect(byName(asAdmin)[KB]).toBe(true);
  });

  // The verdict is what a direct write is judged by: the rules COMMITTED on
  // the default branch. A grant written to the clone's working tree but not
  // yet committed — a queued save, an edit in flight — is not yet in force.
  it('judges the rules as committed, not a grant still only in the working tree', async () => {
    const rules = join(wsDir(MAIN), KB, 'Notes/Sub/access.md');
    try {
      await writeFile(rules, '---\nwrite:\n  - everyone\n---\n');
      expect(byName(await call<Listing>('list_files', { branch: MAIN, path: `${KB}/Notes` }, ENG)).Sub).toBe(false);
      await commitMain('open Sub');
      expect(byName(await call<Listing>('list_files', { branch: MAIN, path: `${KB}/Notes` }, ENG)).Sub).toBe(true);
    } finally {
      await writeFile(rules, MAIN_TREE['Notes/Sub/access.md']);
      await commitMain('close Sub again');
    }
    expect(byName(await call<Listing>('list_files', { branch: MAIN, path: `${KB}/Notes` }, ENG)).Sub).toBe(false);
  });
});

describe('read_file carries canWrite for the file read', () => {
  type Read = { path: string; content: string; canWrite?: boolean };

  it('says what the default branch would accept, on either branch', async () => {
    expect((await call<Read>('read_file', { branch: MAIN, path: `${KB}/Notes/open.md` })).canWrite).toBe(true);
    expect((await call<Read>('read_file', { branch: MAIN, path: `${KB}/Notes/locked.md` })).canWrite).toBe(false);
    expect((await call<Read>('read_file', { branch: DRAFT, path: `${KB}/Notes/locked.md` })).canWrite).toBe(false);
    expect((await call<Read>('read_file', { branch: MAIN, path: `${KB}/Notes/locked.md` }, ADMIN)).canWrite).toBe(true);
  });

  it('answers for the knowledge base\'s own file at the root AGENTS.md', async () => {
    const read = await call<Read>('read_file', { branch: MAIN, path: `${KB}/AGENTS.md` }, ENG);
    expect(read.content).toContain('THE PLATFORM GUIDE');
    // Root write is Admin's; the file's own frontmatter opens it to everyone.
    expect(read.canWrite).toBe(true);
  });

  it('gives the default branch\'s AGENTS.md verdict on a draft that deleted the file', async () => {
    const onDraft = join(wsDir(DRAFT), KB, 'AGENTS.md');
    await rm(onDraft);
    try {
      for (const as of [ADMIN, ENG]) {
        const main = await call<Read>('read_file', { branch: MAIN, path: `${KB}/AGENTS.md` }, as);
        const draft = await call<Read>('read_file', { branch: DRAFT, path: `${KB}/AGENTS.md` }, as);
        // The draft serves the platform's guide alone; what lands is still the default branch's file.
        expect(draft.content).not.toContain('Our conventions');
        expect(draft.content).toBe('THE PLATFORM GUIDE\n');
        expect(main.canWrite, as).toBe(true);
        expect(draft.canWrite, as).toBe(true);
      }
    } finally {
      await writeFile(onDraft, MAIN_TREE['AGENTS.md']);
    }
  });

  it('gives false on a draft that added AGENTS.md when the default branch has none', async () => {
    const onMain = join(wsDir(MAIN), KB, 'AGENTS.md');
    // Gone from the default branch as COMMITTED, where the verdict is judged,
    // not only from its working tree.
    await rm(onMain);
    await commitMain('no AGENTS.md');
    try {
      for (const as of [ADMIN, ENG]) {
        const main = await call<Read>('read_file', { branch: MAIN, path: `${KB}/AGENTS.md` }, as);
        const draft = await call<Read>('read_file', { branch: DRAFT, path: `${KB}/AGENTS.md` }, as);
        expect(draft.content).toContain('Our conventions');
        expect(main.canWrite, as).toBe(false);
        expect(draft.canWrite, as).toBe(false);
      }
    } finally {
      await writeFile(onMain, MAIN_TREE['AGENTS.md']);
      await commitMain('AGENTS.md again');
    }
  });

  it('asks the default branch\'s read hook before judging AGENTS.md from a draft, and gives false on refusal', async () => {
    const path = `${KB}/AGENTS.md`;
    const allowed = await call<Read>('read_file', { branch: DRAFT, path }, ADMIN);
    expect(allowed.canWrite).toBe(true);
    expect(readsNoted).toContainEqual({ branch: MAIN, wsPath: path });
    // The draft read itself is allowed; only the look at the default branch's file is refused.
    refuseRead = (branch, wsPath) => branch === MAIN && wsPath === path;
    writeChecks = [];
    const refused = await call<Read>('read_file', { branch: DRAFT, path }, ADMIN);
    expect(refused.content).toContain('Our conventions');
    expect(refused.canWrite).toBe(false);
    expect(writeChecks).toEqual([]);
  });

  it('carries no canWrite for a spill ref', async () => {
    const { ref } = await spills.write('spilled');
    const read = await call<Read>('read_file', { branch: MAIN, path: ref });
    expect(read.content).toBe('spilled');
    expect(read).not.toHaveProperty('canWrite');
    expect(writeChecks).toEqual([]);
  });
});

describe('a read-only credential', () => {
  it('always gets canWrite: false, without asking the access layer', async () => {
    scope = 'read';
    const listed = await call<Listed>('list_skills', {}, ADMIN);
    expect(listed.skills.length).toBeGreaterThan(0);
    expect(listed.skills.every((s) => s.canWrite === false)).toBe(true);
    expect((await call<{ skill: { canWrite: boolean } }>('get_skill', { name: 'notes' }, ADMIN)).skill.canWrite).toBe(false);
    const listing = await call<{ entries: { canWrite: boolean }[] }>('list_files', { branch: MAIN, path: `${KB}/Notes` }, ADMIN);
    expect(listing.entries.every((e) => e.canWrite === false)).toBe(true);
    expect((await call<{ canWrite: boolean }>('read_file', { branch: MAIN, path: `${KB}/Notes/open.md` }, ADMIN)).canWrite).toBe(false);
    expect(writeChecks).toEqual([]);
  });
});

describe('defaultBranchWriteVerdicts fails closed', () => {
  const ctx = { scope: 'write' as const, user: { id: 'u', email: ENG, name: 'u' } };

  it('a check that throws is false for every path', async () => {
    const verdicts = await defaultBranchWriteVerdicts(
      { accessControl: { canWriteBatchAtRef: async () => Promise.reject(new Error('no clone')) }, defaultWorkspaceId: () => 'ws' },
      ctx,
      ['a.md', 'b.md'],
    );
    expect([...verdicts]).toEqual([['a.md', false], ['b.md', false]]);
  });

  it('no rules at HEAD yet (null) is the gate\'s bootstrap: true for every path, as the direct write is allowed', async () => {
    const verdicts = await defaultBranchWriteVerdicts(
      { accessControl: { canWriteBatchAtRef: async () => null }, defaultWorkspaceId: () => 'ws' },
      ctx,
      ['a.md', 'b.md'],
    );
    expect([...verdicts]).toEqual([['a.md', true], ['b.md', true]]);
  });

  it('a path the answer leaves out is false', async () => {
    const verdicts = await defaultBranchWriteVerdicts(
      { accessControl: { canWriteBatchAtRef: async () => new Map([['a.md', true]]) }, defaultWorkspaceId: () => 'ws' },
      ctx,
      ['a.md', 'b.md'],
    );
    expect(verdicts.get('a.md')).toBe(true);
    expect(verdicts.get('b.md')).toBe(false);
  });
});
