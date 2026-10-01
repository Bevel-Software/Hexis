import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { testKbContext } from '../../../../__tests__/kb-context.js';
import { GitService } from '../git.service.js';
import {
  VersionNotOnBranchError,
  VERSION_NOT_ON_BRANCH_MESSAGE,
  WorkflowValidationError,
} from '../../../../shared/domain-errors.js';
import { runGit, gitOut, stubWorkflowHooks, stubWorkspaceService } from './git-test-helpers.js';

/**
 * A past version has to come back BYTE FOR BYTE, and only for saves on the
 * branch being viewed.
 *
 * `readFileAtRef` decodes git's stdout as UTF-8, which is why a binary could
 * not be served through it at all: every byte sequence that is not valid UTF-8
 * comes back as U+FFFD, so a PNG downloaded from history would not open. The
 * suite pins the round trip on bytes that would not survive that (everything
 * from 0x00 to 0xff, NUL included), the two sides of a save, and the branch
 * rule that decides who may ask at all.
 */

/** Every byte value, so any decode-and-re-encode step is visible as a failure. */
const ALL_BYTES = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const V1 = Buffer.concat([PNG_HEADER, ALL_BYTES, Buffer.from('v1')]);
const V2 = Buffer.concat([PNG_HEADER, ALL_BYTES.subarray(0, 128), Buffer.from('v2\0tail')]);

describe('GitService.fileBytesAtCommit', () => {
  let root: string;
  let repo: string;
  let svc: GitService;
  const workspaceId = 'target-company-state';
  /** The save that ADDED logo.png (V1), the save that REPLACED it (V2). */
  let addSha: string;
  let replaceSha: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-bytes-at-ref-'));
    const workspaceDir = path.join(root, workspaceId);
    repo = path.join(workspaceDir, 'knowledge-base');
    await fs.mkdir(repo, { recursive: true });
    await runGit(root, ['init', '-b', 'target-company-state', repo]);
    await runGit(repo, ['config', 'user.email', 'workspace@bevel.test']);
    await runGit(repo, ['config', 'user.name', 'bevel Workspace']);

    await fs.writeFile(path.join(repo, 'logo.png'), V1);
    await fs.mkdir(path.join(repo, 'docs'));
    await fs.writeFile(path.join(repo, 'docs', 'child.md'), 'child\n');
    await runGit(repo, ['add', '.']);
    await runGit(repo, ['commit', '-m', 'add logo']);
    addSha = await gitOut(repo, ['rev-parse', 'HEAD']);

    await fs.writeFile(path.join(repo, 'logo.png'), V2);
    await runGit(repo, ['add', '.']);
    await runGit(repo, ['commit', '-m', 'replace logo']);
    replaceSha = await gitOut(repo, ['rev-parse', 'HEAD']);

    svc = new GitService(
      stubWorkspaceService({ [workspaceId]: workspaceDir }),
      stubWorkflowHooks(),
      testKbContext(),
    );
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('returns the exact bytes of each save, on both sides of it', async () => {
    const atAdd = await svc.fileBytesAtCommit(workspaceId, 'knowledge-base/logo.png', addSha, 'after');
    expect(atAdd).not.toBeNull();
    expect(atAdd!.bytes.equals(V1)).toBe(true);
    expect(atAdd!.blobId).toMatch(/^[0-9a-f]{40}$/);

    const atReplace = await svc.fileBytesAtCommit(
      workspaceId,
      'knowledge-base/logo.png',
      replaceSha,
      'after',
    );
    expect(atReplace!.bytes.equals(V2)).toBe(true);

    // The `before` side of the replacing save IS the original upload — which
    // is what makes "download the version this save replaced" possible.
    const before = await svc.fileBytesAtCommit(
      workspaceId,
      'knowledge-base/logo.png',
      replaceSha,
      'before',
    );
    expect(before!.bytes.equals(V1)).toBe(true);
    // Different content, therefore a different ETag: the blob id IS the hash.
    expect(atReplace!.blobId).not.toBe(before!.blobId);
  });

  it('accepts the repo-relative spelling of the path too', async () => {
    const at = await svc.fileBytesAtCommit(workspaceId, 'logo.png', addSha, 'after');
    expect(at!.bytes.equals(V1)).toBe(true);
  });

  it('serves the version just before the save that DELETED the file', async () => {
    await fs.rm(path.join(repo, 'logo.png'));
    await runGit(repo, ['add', '-A']);
    await runGit(repo, ['commit', '-m', 'remove logo']);
    const delSha = await gitOut(repo, ['rev-parse', 'HEAD']);

    // Nothing at the path after the save…
    expect(
      await svc.fileBytesAtCommit(workspaceId, 'knowledge-base/logo.png', delSha, 'after'),
    ).toBeNull();
    // …and the bytes as they were just before it.
    const before = await svc.fileBytesAtCommit(
      workspaceId,
      'knowledge-base/logo.png',
      delSha,
      'before',
    );
    expect(before!.bytes.equals(V2)).toBe(true);
  });

  it('returns null for a path the save did not have', async () => {
    expect(
      await svc.fileBytesAtCommit(workspaceId, 'knowledge-base/never.png', addSha, 'after'),
    ).toBeNull();
    // The root commit has no parent, so it has no `before` side either.
    expect(
      await svc.fileBytesAtCommit(workspaceId, 'knowledge-base/logo.png', addSha, 'before'),
    ).toBeNull();
  });

  it('refuses a directory at the ref — history is served per file', async () => {
    await expect(
      svc.fileBytesAtCommit(workspaceId, 'knowledge-base/docs', addSha, 'after'),
    ).rejects.toThrow(/history is served per file/);
  });

  it('refuses a sha that is not a sha', async () => {
    await expect(
      svc.fileBytesAtCommit(workspaceId, 'knowledge-base/logo.png', 'HEAD', 'after'),
    ).rejects.toThrow(WorkflowValidationError);
  });

  it('refuses a save that is not in this branch\'s history, and a made-up one, alike', async () => {
    // A save that exists — on another branch this workspace is not viewing.
    await runGit(repo, ['checkout', '-b', 'someone-else']);
    await fs.writeFile(path.join(repo, 'logo.png'), Buffer.from('elsewhere'));
    await runGit(repo, ['add', '-A']);
    await runGit(repo, ['commit', '-m', 'elsewhere']);
    const otherSha = await gitOut(repo, ['rev-parse', 'HEAD']);
    await runGit(repo, ['checkout', 'target-company-state']);

    for (const sha of [otherSha, 'a'.repeat(40)]) {
      const read = svc.fileBytesAtCommit(workspaceId, 'knowledge-base/logo.png', sha, 'after');
      await expect(read).rejects.toThrow(VersionNotOnBranchError);
      await expect(read).rejects.toThrow(VERSION_NOT_ON_BRANCH_MESSAGE);
    }

    // …and every save the panel LISTS is accepted, which is the other half of
    // the rule: `logForFile` walks HEAD, so anything it returns is an ancestor.
    // Asserted through the read itself rather than a boolean helper, so what is
    // pinned is the thing the route calls.
    for (const listed of await svc.logForFile(workspaceId, 'knowledge-base/logo.png')) {
      await expect(
        svc.fileBytesAtCommit(workspaceId, 'knowledge-base/logo.png', listed.sha, 'after'),
      ).resolves.not.toBeNull();
    }
  });

  it('propagates a repository failure rather than calling it a version off the branch', async () => {
    // An UNBORN HEAD: the sha resolves perfectly well and git's complaint is
    // about the other argument ('ambiguous argument HEAD'). Folded into
    // `VersionNotOnBranchError` it would tell a reader the save they can see
    // listed is not in their history — a broken workspace dressed up as an
    // answer about access, and one 'Try again' can never get past.
    await runGit(repo, ['checkout', '--orphan', 'nothing-committed-yet']);
    const err: unknown = await svc
      .fileBytesAtCommit(workspaceId, 'knowledge-base/logo.png', addSha, 'after')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(VersionNotOnBranchError);
  });

  it('applies the same branch rule to the existing text-history reads', async () => {
    await runGit(repo, ['checkout', '-b', 'someone-else']);
    await fs.writeFile(path.join(repo, 'logo.png'), Buffer.from('elsewhere'));
    await runGit(repo, ['add', '-A']);
    await runGit(repo, ['commit', '-m', 'elsewhere']);
    const otherSha = await gitOut(repo, ['rev-parse', 'HEAD']);
    await runGit(repo, ['checkout', 'target-company-state']);

    // Otherwise the bytes route's rule could simply be read around: the patch
    // and the full before/after text are past versions too.
    await expect(
      svc.diffFileAtCommit(workspaceId, 'knowledge-base/logo.png', otherSha),
    ).rejects.toThrow(VERSION_NOT_ON_BRANCH_MESSAGE);
    await expect(
      svc.fileContentsAtCommit(workspaceId, 'knowledge-base/logo.png', otherSha),
    ).rejects.toThrow(VERSION_NOT_ON_BRANCH_MESSAGE);
    // The on-branch saves still work.
    expect(await svc.diffFileAtCommit(workspaceId, 'knowledge-base/logo.png', replaceSha)).toContain(
      'logo.png',
    );
  });
});
