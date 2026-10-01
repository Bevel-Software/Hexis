import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { testKbContext } from '../../../__tests__/kb-context.js';
import { createSetupRoutes } from '../setup.routes.js';
import { DeploymentSettingsService } from '../deployment-settings.service.js';
import { KbStartupRunner } from '../../workspace/startup/kb-startup-runner.js';
import { NodeGitRunner } from '../../workflow/git/node-git-runner.js';
import { TemplateFilesStep } from '../../workspace/startup/steps/template-files.step.js';
import { NodeFs } from '../../kb-fs/node-fs.js';
import { defaultKbTemplateDir } from '../../../assets.js';
import type { Database } from '../../database/connection.js';
import type { IAdminAccessService } from '../../admin/admin.interface.js';

/**
 * The completing save and the REAL initialization phase, wired the way the
 * composition root wires them: the template step is built first, under the
 * defaults, and the admin's folder names arrive with the save afterwards.
 *
 * A fake phase that merely reads the layout proves the names were applied; it
 * cannot see a step that took its own copy of them at boot. This one looks at
 * what the phase actually pushed.
 */

const execFileAsync = promisify(execFile);
const ENC_KEY = 'kToAi8FXWDpDn3A6yQ/60O39bv05N7XzVOIu/0CJrFc=';
const BRANCH = 'target-company-state';
const KB_ENV = [
  'KB_REPO_URL',
  'GIT_TOKEN',
  'GIT_USERNAME',
  'KB_DIR_NAME',
  'GITHUB_TOKEN',
  'KB_KNOWLEDGE_BASE_DIR',
  'KB_SKILLS_DIR',
  'KB_PLUGINS_DIR',
] as const;

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 't@x.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 't@x.com',
};
const git = async (cwd: string, args: string[]) =>
  (await execFileAsync('git', args, { cwd, env: gitEnv })).stdout.toString();

let root: string;
let upstream: string;
let server: HttpServer | null = null;
let savedEnv: Partial<Record<(typeof KB_ENV)[number], string | undefined>> = {};

beforeEach(async () => {
  savedEnv = {};
  for (const k of KB_ENV) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'setup-layout-phase-'));
  upstream = path.join(root, 'upstream.git');
  await git(root, ['init', '--bare', '-b', BRANCH, upstream]);
});

afterEach(async () => {
  server?.close();
  server = null;
  for (const k of KB_ENV) {
    const original = savedEnv[k];
    if (original === undefined) delete process.env[k];
    else process.env[k] = original;
  }
  await fs.rm(root, { recursive: true, force: true });
});

/** An upstream laid out by someone else: skills in lowercase `skills/`. */
async function seedUpstream(files: Record<string, string>) {
  const seed = path.join(root, '.seed');
  await fs.mkdir(seed, { recursive: true });
  await git(seed, ['init', '-b', BRANCH]);
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(seed, rel)), { recursive: true });
    await fs.writeFile(path.join(seed, rel), content, 'utf8');
  }
  await git(seed, ['add', '-A']);
  await git(seed, ['commit', '-m', 'init']);
  await git(seed, ['push', upstream, BRANCH]);
}

/** Boot: the phase and its template step built under the defaults, then the setup routes. */
function boot() {
  const db = {
    select: () => ({ from: () => Promise.resolve([]) }),
    insert: () => ({ values: () => ({ onConflictDoUpdate: () => Promise.resolve() }) }),
    delete: () => ({ where: () => Promise.resolve() }),
  } as unknown as Database;
  const settings = new DeploymentSettingsService(db, ENC_KEY);
  // ONE context for the step and the routes, as the composition root builds
  // it: the completing save applies the admin's names to it, and the step
  // reads them from it when the phase runs.
  const kb = testKbContext();
  const runner = new KbStartupRunner({
    gitRunner: new NodeGitRunner(),
    kbRepoUrl: () => upstream,
    workspacesRoot: path.join(root, 'workspaces'),
    kbDirName: 'knowledge-base',
    templateDir: defaultKbTemplateDir(),
    defaultBranch: () => BRANCH,
    protectedBranches: () => [BRANCH],
    seedAdminEmails: ['admin@example.com'],
    steps: [new TemplateFilesStep(new NodeFs(), kb)],
    buildSeedTree: async () => [],
  });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.userEmail = 'root@example.com';
    req.userId = 'user-1';
    next();
  });
  app.use(
    '/api',
    createSetupRoutes(
      settings,
      { isAdmin: async () => true } as IAdminAccessService,
      runner,
      kb,
      undefined,
      // The save now proves the connection first; the remote here is local, so
      // the stand-in answers for the host the stored address names.
      async () => ({ outcome: 'connected', branches: [BRANCH], defaultBranch: BRANCH, empty: false }),
    ),
  );
  server = app.listen(0);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('the completing save runs the real phase under the admin\'s folder names', () => {
  it('scaffolds Docs/ and keeps skills/, with no KnowledgeBase/ or Skills/ beside them', async () => {
    await seedUpstream({ 'skills/demo/SKILL.md': '# demo\n' });
    const base = boot();

    const res = await fetch(`${base}/api/setup/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        settings: {
          kbRepoUrl: 'https://example.com/acme/kb.git',
          gitToken: 'ghp_x',
          knowledgeBaseDir: 'Docs',
          skillsDir: 'skills',
        },
      }),
    });
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.complete).toBe(true);
    expect(body.restartRequired).toBe(false);

    const tree = await git(root, ['--git-dir', upstream, 'ls-tree', '-d', '--name-only', BRANCH]);
    expect(tree.split('\n').filter(Boolean).sort()).toEqual(['Docs', 'Plugins', 'skills']);
    const pushed = await git(root, ['--git-dir', upstream, 'ls-tree', '-r', '--name-only', BRANCH]);
    expect(pushed).toContain('Docs/.gitkeep');
    expect(pushed).toContain('skills/demo/SKILL.md');
    expect(pushed).not.toContain('skills/.gitkeep');
  });
});
