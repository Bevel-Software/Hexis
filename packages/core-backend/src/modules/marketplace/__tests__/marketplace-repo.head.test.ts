import { describe, it, expect } from 'vitest';
import { MarketplaceRepoService, type MarketplaceCompiler } from '../marketplace-repo.service.js';
import { GitRunError, NO_GIT_CREDENTIALS, type IGitRunner } from '../../../shared/git.contract.js';

const SHA = 'a'.repeat(40);

/** A runner whose `rev-parse` fails the way `failure` says; everything else succeeds empty. */
function runnerFailingRevParse(failure: GitRunError): IGitRunner {
  return {
    defaultTimeoutMs: 1_000,
    credentials: NO_GIT_CREDENTIALS,
    run: (async (_cwd: string, args: string[]) => {
      if (args.includes('rev-parse')) throw failure;
      return { stdout: '', stderr: '' };
    }) as IGitRunner['run'],
  };
}

const compiler: MarketplaceCompiler = {
  sourceCommit: async () => 'aaa111',
  compileFor: async () => ({ files: new Map(), warnings: [], plugins: [], sourceCommit: 'aaa111' }),
};

/**
 * "No such ref" is the one git answer a missing namespace head stands for,
 * and `rev-parse --verify --quiet` gives it as exit code 1 and nothing else.
 * Every other failure — a deadline, a repository git cannot open — is not an
 * answer about the ref, and read as "no head" it would have the service start
 * a namespace's history over on top of the one it has.
 */
describe('MarketplaceRepoService — a namespace head that cannot be read', () => {
  it('reads exit code 1 as "no head": a commit is then simply not contained', async () => {
    const svc = new MarketplaceRepoService('/nowhere/marketplace.git', compiler, runnerFailingRevParse(
      new GitRunError('fatal: Needed a single revision', { exitCode: 1 }),
    ));
    expect(await svc.contains('user-alice', SHA)).toBe(false);
  });

  it('lets any other failure through — a deadline is not an answer about the ref', async () => {
    for (const failure of [
      new GitRunError('git timed out', { timedOut: true }),
      new GitRunError('fatal: not a git repository', { exitCode: 128 }),
    ]) {
      const svc = new MarketplaceRepoService('/nowhere/marketplace.git', compiler, runnerFailingRevParse(failure));
      await expect(svc.contains('user-alice', SHA)).rejects.toBe(failure);
    }
  });
});
