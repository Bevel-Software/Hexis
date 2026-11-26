import { vi } from 'vitest';
import type { AuthUser } from '@bevel-software/platform-shared';
import type { GitService } from '../git/git.service.js';

type MergeOpts = NonNullable<Parameters<GitService['mergeFromOrigin']>[4]>;
type Merged = { kind: 'clean'; alreadyUpToDate: boolean } | { kind: 'conflicts'; paths: string[] };

/** The moves a refresh's publish is made of, read off the suite's git double when they are called. */
interface CloneMoves {
  push(workspaceId: string, user: AuthUser): Promise<unknown>;
  pull(workspaceId: string, opts: { preserveMerges: boolean }): Promise<{ treeChanged: boolean }>;
  hasUnpushedCommits?(workspaceId: string): Promise<boolean>;
}

/**
 * `git.mergeFromOrigin` by the git layer's rule: merge (or, asked with
 * `merge: false`, only fetch) and, on anything but a conflict, run the
 * caller's publish over the clone's own push, pull and unpushed probe before
 * answering, as the one reservation does. Those moves are the suite's own
 * `push`, `pull` and `hasUnpushedCommits` doubles, looked up when called, so
 * a suite asserts on them as it would on direct calls.
 */
export function mergeFromOriginDouble(git: CloneMoves, merged: Merged = { kind: 'clean', alreadyUpToDate: false }) {
  return vi.fn(async (workspaceId: string, _source: string, _target: string, user: AuthUser, opts: MergeOpts = {}) => {
    const outcome = opts.merge === false ? { kind: 'not-merged' as const } : merged;
    if (outcome.kind === 'conflicts') return outcome;
    await opts.publish?.(outcome, {
      push: async () => {
        await git.push(workspaceId, user);
      },
      pullRebase: () => git.pull(workspaceId, { preserveMerges: true }),
      hasUnpushedCommits: () => (git.hasUnpushedCommits ? git.hasUnpushedCommits(workspaceId) : Promise.resolve(true)),
    });
    return outcome;
  });
}
