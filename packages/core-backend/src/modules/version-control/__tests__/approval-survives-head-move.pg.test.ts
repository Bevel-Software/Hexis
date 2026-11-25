import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { appendFile, cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { ChangeRequestDetail, ChangeRequestUpdateResult } from '@bevel-software/platform-shared';
import {
  createCoreServices,
  createCoreServer,
  stopCore,
  defaultKbTemplateDir,
  defaultStarterPacksDir,
  type TenantConfig,
} from '../../../index.js';
import { PG_ADMIN_URL, PG_TEST_TIMEOUT, scratchDatabaseUrl, dropScratchDatabases } from '../../../__tests__/pg-scratch.js';

/**
 * An approval survives a commit the SERVER puts on the draft, when that
 * commit left the approved file alone (hx-approval-survives-the-update-apply-makes).
 *
 * The whole server over HTTP, a real git repository and a scratch Postgres.
 * The server moves a draft's head itself in two places, and both are here:
 * the roles.yaml restore Apply makes, and an update from the target.
 *
 * The first test is the failure production showed four times on 2026-11-24:
 * a draft cut before the target's roles.yaml last changed was approved, and
 * Apply answered "need to re-approve" seconds later.
 */
const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
}, PG_TEST_TIMEOUT);
afterAll(dropScratchDatabases, PG_TEST_TIMEOUT);

const run = promisify(execFile);
const SHARED = 'KnowledgeBase/Shared.md';
const SHARED_TEXT = ['# Shared', '', 'first line', '', 'middle', '', 'last line', ''].join('\n');

async function startPlatform() {
  const root = await mkdtemp(join(tmpdir(), 'approval-head-move-'));
  stops.push(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const seed = join(root, 'seed');
  await cp(defaultKbTemplateDir(), seed, { recursive: true });
  await writeFile(join(seed, 'roles.yaml'), 'roles:\n  Admin:\n    - admin@example.com\n');
  await writeFile(join(seed, SHARED), SHARED_TEXT);
  const identity = ['-c', 'user.name=Test', '-c', 'user.email=admin@example.com'];
  await run('git', ['init', '-q', '-b', 'main'], { cwd: seed });
  await run('git', ['add', '.'], { cwd: seed });
  await run('git', [...identity, 'commit', '-qm', 'Seed test knowledge base'], { cwd: seed });
  // Bare, so a commit can be pushed to `main` from outside the server: the
  // target moving under a waiting draft.
  const repository = join(root, 'repository.git');
  await run('git', ['clone', '-q', '--bare', seed, repository]);

  /** Change one file on `main` behind the server's back, as another writer would. */
  let edits = 0;
  const changeOnMain = async (path: string, change: (file: string) => Promise<void>) => {
    const clone = join(root, `edit-${edits++}`);
    await run('git', ['clone', '-q', '--branch', 'main', repository, clone]);
    await change(join(clone, path));
    await run('git', [...identity, 'commit', '-qam', `Change ${path} on main`], { cwd: clone });
    await run('git', ['push', '-q', 'origin', 'main'], { cwd: clone });
  };
  const onBranch = async (branch: string, args: string[]) =>
    (await run('git', [...args.slice(0, 1), ...args.slice(1).map((a) => a.replace('<branch>', branch))], { cwd: repository })).stdout;

  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  stops.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const config: TenantConfig = {
    port, databaseUrl: await scratchDatabaseUrl('hexis_approval_move'), dbSchema: 'public', nodeEnv: 'test',
    tenantId: 'bevel', externalApiKeyPrefix: 'bevel_', internalTokenPrefix: 'bevel-internal_',
    uploadTokenPrefix: 'bevel-upload_', mcpOAuthTokenPrefix: 'bevel-mcp_',
    workspacesRoot: join(root, 'workspaces'), backupsRoot: join(root, 'backups'),
    spillRoot: join(root, 'spills'), agentUploadsRoot: join(root, 'uploads'), docExtractCacheRoot: join(root, 'extracts'),
    jwtSecret: 'approval-move-test-secret', adminEmail: 'admin@example.com', adminPassword: 'test-password',
    oidcIssuerUrl: '', oidcClientId: '', oidcClientSecret: '', oidcScopes: 'openid', oidcProviderLabel: 'SSO',
    kbRepoUrl: repository, kbDirName: 'knowledge-base', gitUsername: '', gitToken: '',
    kbTemplateDir: defaultKbTemplateDir(), starterPacksDir: defaultStarterPacksDir(),
    updateCheckEnabled: false, loginPasswordEnabled: true, allowedEmailDomains: [],
    secretsEncKey: randomBytes(32).toString('base64'), internalTokenSecret: 'approval-move-internal-secret',
    embedSharedSecret: '', trustProxy: '', gitTimeoutMs: 30_000,
    publicBackendUrl: baseUrl, publicFrontendUrl: baseUrl, configuredPublicFrontendUrl: baseUrl,
    settingsEnv: { KB_REPO_URL: repository, DEFAULT_BRANCH: 'main', PROTECTED_BRANCHES: 'main' },
  };
  const core = await createCoreServices(config, { mirrorSharedBindings: false });
  stops.push(() => stopCore(core));
  const app = await createCoreServer(core, {}, { boot: false });
  server.on('request', app);

  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: config.adminEmail, password: config.adminPassword }),
  });
  expect(login.status).toBe(200);
  const { token, user } = (await login.json()) as { token: string; user: { id: string } };
  const { plaintext: key } = await core.externalApiKeyService.mint(user.id, 'approval-move-test');

  const send = async <T>(bearer: string, method: string, url: string, body?: unknown): Promise<T> => {
    const res = await fetch(`${baseUrl}/api${url}`, {
      method,
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${url} answered ${res.status}: ${text.slice(0, 400)}`);
    return (text ? JSON.parse(text) : {}) as T;
  };
  /** A platform tool, called the way an agent calls it. */
  const tool = (name: string, body: unknown) => send<unknown>(key, 'POST', `/agent/tools/${name}`, body);

  /** A draft cut from `main` now, holding `files`, with a change request open on it. */
  const openRequest = async (draft: string, files: Record<string, string>) => {
    await tool('create_branch', { branch: 'main', name: draft });
    for (const [path, content] of Object.entries(files)) {
      await tool('write_file', { branch: draft, path, content, mode: path === SHARED ? 'overwrite' : 'create' });
    }
    // A write answers once the file is on disk; its commit is made and pushed
    // by the background worker. Wait for every file to be on the published
    // draft, or the request is opened, read and approved against a draft that
    // does not hold them yet.
    const published = async (path: string) =>
      run('git', ['show', `${draft}:${path}`], { cwd: repository }).then((r) => r.stdout, () => null);
    for (const [path, content] of Object.entries(files)) {
      const waitingSince = Date.now();
      while ((await published(path)) !== content) {
        if (Date.now() - waitingSince > 60_000) throw new Error(`${path} was not published on ${draft} in 60 seconds`);
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    const opened = await send<{ number: number }>(token, 'POST', '/workflow/change-requests', {
      sourceBranch: draft, targetBranch: 'main', title: `Request on ${draft}`,
    });
    return opened.number;
  };
  const detail = (number: number) =>
    send<ChangeRequestDetail>(token, 'GET', `/workflow/change-requests/${number}/detail?fresh=1`);
  /** Approve every file the gate binds, as the person pressing Approve on each. */
  const approveAll = async (number: number) => {
    for (const a of (await detail(number)).approvals) {
      if (a.inMergeGate && !a.isApproved) {
        await send(token, 'POST', `/workflow/change-requests/${number}/files/approve`, { path: a.path });
      }
    }
  };
  /** Press Apply and wait for its outcome: the request applied, or the refusal recorded on it. */
  const apply = async (number: number): Promise<ChangeRequestDetail> => {
    const pressed = Date.now();
    await send(token, 'POST', `/workflow/change-requests/${number}/merge`, {});
    for (;;) {
      const now = await detail(number);
      const refusedAt = now.lastApplyFailure ? Date.parse(now.lastApplyFailure.at) : 0;
      if (now.state !== 'open' || refusedAt >= pressed) return now;
      if (Date.now() - pressed > 60_000) throw new Error('Apply reported no outcome in 60 seconds');
      await new Promise((r) => setTimeout(r, 250));
    }
  };
  const approvalOf = (d: ChangeRequestDetail, path: string) => {
    const a = d.approvals.find((x) => x.path === path);
    if (!a) throw new Error(`${path} is not a file of the request: ${d.approvals.map((x) => x.path).join(', ')}`);
    return { approved: a.isApproved, entries: a.approvedBy.map((e) => (e.isStale ? 'out of date' : 'current')) };
  };
  return { core, token, send, openRequest, detail, approveAll, apply, approvalOf, changeOnMain, onBranch };
}

const addRole = (file: string) => appendFile(file, '  Sales:\n    - sam@example.com\n');

describe.skipIf(!PG_ADMIN_URL)('an approval survives a commit the server puts on the draft', () => {
  it('Apply goes through in one go on a draft cut before roles.yaml changed on the target', async () => {
    const p = await startPlatform();
    const number = await p.openRequest('ada/note', { 'KnowledgeBase/Note.md': '# Note\n\nA new page.\n' });
    await p.changeOnMain('roles.yaml', addRole);

    await p.approveAll(number);
    const approved = await p.detail(number);
    expect(p.approvalOf(approved, 'KnowledgeBase/Note.md')).toEqual({ approved: true, entries: ['current'] });

    const applied = await p.apply(number);
    expect(applied.lastApplyFailure ?? null).toBeNull();
    expect(applied.state).toBe('merged');

    // The case is the one meant: Apply did put its restore commit on the
    // draft, so the approval was given on a head that then moved. The draft
    // is retired once applied; its commits are on the target.
    const landed = await p.onBranch('main', ['log', '--format=%s', '-6', '<branch>']);
    expect(landed).toContain('Preserve official roles.yaml');
    // And the target has the page, with the roles.yaml it had: the restore
    // still does its job.
    const onMain = await p.onBranch('main', ['show', '<branch>:roles.yaml']);
    expect(onMain).toContain('sam@example.com');
    expect(await p.onBranch('main', ['show', '<branch>:KnowledgeBase/Note.md'])).toContain('A new page.');
  }, PG_TEST_TIMEOUT);

  it('an update from the target keeps the approval of the file it left alone and not of the file it changed', async () => {
    const p = await startPlatform();
    const number = await p.openRequest('ada/two-files', {
      [SHARED]: SHARED_TEXT.replace('first line', 'first line, as the draft has it'),
      'KnowledgeBase/Alone.md': '# Alone\n\nOnly the draft has this page.\n',
    });
    // The target changes the far end of the file the draft also changes: the
    // merge is clean and it rewrites that file on the draft.
    await p.changeOnMain(SHARED, async (file) =>
      writeFile(file, (await readFile(file, 'utf-8')).replace('last line', 'last line, as the target has it')),
    );
    await p.approveAll(number);
    const before = await p.detail(number);
    expect(p.approvalOf(before, SHARED).approved).toBe(true);
    expect(p.approvalOf(before, 'KnowledgeBase/Alone.md').approved).toBe(true);

    const updated = await p.send<ChangeRequestUpdateResult>(
      p.token, 'POST', `/workflow/change-requests/${number}/update-from-target`,
    );

    expect(updated.headSha).not.toBe(before.headSha);
    expect(updated.updatedPaths).toEqual([SHARED]);
    expect(updated).not.toHaveProperty('approvalCarryNotice');
    expect(p.approvalOf(updated, 'KnowledgeBase/Alone.md')).toEqual({ approved: true, entries: ['out of date', 'current'] });
    expect(p.approvalOf(updated, SHARED)).toEqual({ approved: false, entries: ['out of date'] });

    // So Apply still waits on the file that changed, in the gate's own words.
    const refused = await p.apply(number);
    expect(refused.state).toBe('open');
    expect(refused.lastApplyFailure?.reason).toMatch(/need to re-approve KnowledgeBase\/Shared\.md/);
    expect(refused.lastApplyFailure?.reason).not.toMatch(/Alone\.md/);
  }, PG_TEST_TIMEOUT);

  it('a carry that fails is said in words, and the next Apply carries and applies with no second approval', async () => {
    const p = await startPlatform();
    const number = await p.openRequest('ada/slow-day', { 'KnowledgeBase/Note.md': '# Note\n\nA new page.\n' });
    await p.changeOnMain('roles.yaml', addRole);
    await p.approveAll(number);

    // The copy of the approvals fails once, as it does when the approval lock
    // cannot be had in time on a slow server.
    const review = p.core.changeRequestReviewService;
    const carry = review.carryApprovalsForward.bind(review);
    let failures = 0;
    review.carryApprovalsForward = async (...args) => {
      if (failures++ === 0) throw new Error('could not take the approval lock in time');
      return carry(...args);
    };

    const refused = await p.apply(number);
    expect(refused.state).toBe('open');
    expect(refused.lastApplyFailure?.reason).toMatch(/could not yet carry the approvals/);
    expect(refused.lastApplyFailure?.reason).toMatch(/Applying again tries once more to carry over/);
    expect(refused.lastApplyFailure?.reason).not.toMatch(/no file needs approving/i);
    // The file the gate waits on is named, by path alone: no approver's name or address.
    expect(refused.lastApplyFailure?.reason).toMatch(/Approval is still awaited on KnowledgeBase\/Note\.md;/);
    expect(refused.lastApplyFailure?.reason).not.toMatch(/@|re-approve/);
    // The read above already tried the carry again, and it worked.
    expect(p.approvalOf(refused, 'KnowledgeBase/Note.md')).toEqual({ approved: true, entries: ['out of date', 'current'] });

    // Nobody approves anything. Apply again.
    const applied = await p.apply(number);
    expect(applied.state).toBe('merged');
  }, PG_TEST_TIMEOUT);
});
