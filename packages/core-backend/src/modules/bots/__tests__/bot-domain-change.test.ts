import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AuthUser } from '@bevel-software/platform-shared';
import { realDisk } from '../../../__tests__/real-disk.js';
import { WalkError, type ITreeWalker } from '../../../shared/fs.contract.js';
import { hasAccessFrontmatterExtension, isAccessFile } from '../../access-model/index.js';
import { GrantRewriteChangeRequests } from '../bot-domain-change.js';

/**
 * The change request a bots' domain change opens. Run against core's OWN
 * template `.bevelignore`, which hides every `access.md` and `roles.yaml` from
 * the explorer: the rewrite must still find every grant the access model
 * reads, or the old domain counts forever.
 */

const KB = 'knowledge-base';
const TEMPLATE_IGNORE = fileURLToPath(new URL('../../../../kb-template/.bevelignore', import.meta.url));
const ADMIN = { id: 'u-admin', email: 'admin@acme.com', name: 'Admin' } as unknown as AuthUser;

let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function seed(files: Record<string, string>): Promise<string> {
  root = await mkdtemp(path.join(tmpdir(), 'bot-domain-change-'));
  const repo = path.join(root, KB);
  await mkdir(repo, { recursive: true });
  await writeFile(path.join(repo, '.bevelignore'), await readFile(TEMPLATE_IGNORE, 'utf-8'));
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(repo, rel)), { recursive: true });
    await writeFile(path.join(repo, rel), text);
  }
  return root;
}

function rewriter(dir: string, walker: Pick<ITreeWalker, 'walkKb'> = realDisk()) {
  const written: Record<string, string> = {};
  const calls: string[] = [];
  const r = new GrantRewriteChangeRequests({
    versionControl: {
      createBranch: async (_ws: string, branch: string, from: string) => {
        calls.push(`branch ${branch} from ${from}`);
      },
      commitChanges: async (_ws: string, by: AuthUser, message: string) => {
        calls.push(`commit by ${by.email}: ${message}`);
      },
      openChangeRequest: async (_ws: string, by: AuthUser, req: { targetBranch: string }) => {
        calls.push(`request by ${by.email} into ${req.targetBranch}`);
        return { number: 7 };
      },
    } as never,
    workspace: {
      getOrCreateForBranch: async () => ({ id: 'ws-branch' }),
      getWorkspacePath: async () => dir,
      readFile: (_ws, wsPath) => readFile(path.join(dir, wsPath), 'utf-8'),
      writeFile: async (ws, wsPath, content) => {
        expect(ws).toBe('ws-branch');
        written[wsPath.slice(KB.length + 1)] = content;
      },
    },
    walker,
    kb: { defaultBranch: 'main', kbDirName: KB, defaultWorkspaceId: () => 'ws-main' },
    isAccessFile,
    hasOwnAccessLines: hasAccessFrontmatterExtension,
  });
  return { r, written, calls };
}

describe('the grant-rewriting change request of a bots\' domain change', () => {
  it('rewrites every grant naming a bot at the old domain, in files the template .bevelignore hides from the explorer', async () => {
    const dir = await seed({
      'access.md': '---\nread:\n  - ops@agent.hexis\n  - dana@acme.com\n---\n',
      'Finance/access.md': '---\nwrite:\n  - ops@agent.hexis\n---\n',
      'roles.yaml': 'roles:\n  reviewers:\n    - ops@agent.hexis\n    - dana@acme.com\n',
      'groups.yaml': 'groups:\n  release:\n    members:\n      - ops@agent.hexis\n',
      'Finance/Budget.md': '---\nread:\n  - ops@agent.hexis\n---\nWrite to ops@agent.hexis for the numbers.\n',
      'Tools/deploy.tool': '---\nname: deploy\nread:\n  - ops@agent.hexis\n---\n',
      'Notes/plain.md': 'ops@agent.hexis is mentioned in prose only.\n',
      'Notes/other.txt': 'ops@agent.hexis\n',
    });
    const { r, written, calls } = rewriter(dir);

    expect(await r.open(ADMIN, 'agent.hexis', 'bots.acme.com', ['ops'])).toBe(7);

    expect(Object.keys(written).sort()).toEqual(
      ['Finance/Budget.md', 'Finance/access.md', 'Tools/deploy.tool', 'access.md', 'groups.yaml', 'roles.yaml'],
    );
    expect(written['access.md']).toBe('---\nread:\n  - ops@bots.acme.com\n  - dana@acme.com\n---\n');
    expect(written['Finance/access.md']).toBe('---\nwrite:\n  - ops@bots.acme.com\n---\n');
    expect(written['roles.yaml']).toBe('roles:\n  reviewers:\n    - ops@bots.acme.com\n    - dana@acme.com\n');
    expect(written['groups.yaml']).toContain('- ops@bots.acme.com');
    expect(written['Tools/deploy.tool']).toContain('- ops@bots.acme.com');
    // A file's own definition is its frontmatter; its body is left as written.
    expect(written['Finance/Budget.md']).toBe('---\nread:\n  - ops@bots.acme.com\n---\nWrite to ops@agent.hexis for the numbers.\n');
    expect(calls).toEqual([
      expect.stringMatching(/^branch bots\/domain-bots\.acme\.com-[a-z0-9]+ from main$/),
      'commit by admin@acme.com: Address bots at bots.acme.com instead of agent.hexis',
      'request by admin@acme.com into main',
    ]);
  });

  it('opens nothing when no grant names a bot at the old domain', async () => {
    const dir = await seed({ 'access.md': '---\nread:\n  - dana@acme.com\n  - other@agent.hexis\n---\n' });
    const { r, written, calls } = rewriter(dir);
    expect(await r.open(ADMIN, 'agent.hexis', 'bots.acme.com', ['ops'])).toBeNull();
    expect(written).toEqual({});
    expect(calls).toEqual([]);
  });

  it('refuses the whole rewrite, opening nothing, when a folder cannot be listed', async () => {
    const dir = await seed({ 'access.md': '---\nread:\n  - ops@agent.hexis\n---\n' });
    const real = realDisk();
    // A walker that finds a hole: reported and walked around unless the
    // caller asks for the walk to throw — which the rewrite must.
    const holed: Pick<ITreeWalker, 'walkKb'> = {
      async walkKb(r, listeners, options) {
        if (options?.unreadable === 'throw') throw new WalkError('Finance', new Error('EACCES'));
        const result = await real.walkKb(r, listeners, options);
        for (const l of listeners) await l.onHole?.('Finance', new Error('EACCES'));
        return { holes: [...result.holes, 'Finance'] };
      },
    };
    const { r, written, calls } = rewriter(dir, holed);
    await expect(r.open(ADMIN, 'agent.hexis', 'bots.acme.com', ['ops'])).rejects.toBeInstanceOf(WalkError);
    expect(written).toEqual({});
    expect(calls).toEqual([]);
  });
});
