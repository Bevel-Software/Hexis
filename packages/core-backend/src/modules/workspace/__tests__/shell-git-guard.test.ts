import { describe, it, expect } from 'vitest';
import { sharedRepositoryGitRefusal } from '../shell-git-guard.js';

/**
 * The shell tool runs in a worktree of the one repository: a git command that
 * rewrites what every branch's worktree shares is refused, and one that acts
 * on this branch's own HEAD, index and working tree runs.
 */
describe('sharedRepositoryGitRefusal', () => {
  it("refuses what rewrites another branch's refs, the shared store, the worktree list or the shared config", () => {
    for (const command of [
      'git update-ref refs/heads/bob/b HEAD',
      'git -c core.x=y update-ref -d refs/heads/bob/b',
      'cd knowledge-base && git update-ref refs/heads/bob/b HEAD',
      'echo hi; git gc --prune=now',
      'GIT_TRACE=1 git prune',
      'git repack -ad',
      'git pack-refs --all',
      'git branch -m bob/b stolen',
      'git branch -D bob/b',
      'git branch --delete bob/b',
      'git branch -f bob/b HEAD',
      'git branch --set-upstream-to=origin/main',
      'git worktree remove ../other',
      'git worktree prune',
      'git reflog expire --all',
      'git remote set-url origin https://elsewhere.example/x.git',
      'git config remote.origin.url https://elsewhere.example/x.git',
      'git config --unset user.name',
      'git config set user.name x',
      '/usr/bin/git update-ref refs/heads/x HEAD',
      '$(git update-ref refs/heads/x HEAD)',
    ]) {
      expect(sharedRepositoryGitRefusal(command), command).not.toBeNull();
    }
  });

  it("runs what acts on this branch's own worktree, and reads", () => {
    for (const command of [
      'git status --porcelain',
      'git log -1 --format=%s',
      'git diff HEAD~1',
      'git add -A && git commit -m "fix: x"',
      'git branch',
      'git branch -a',
      'git branch --list',
      'git branch new-idea',
      'git worktree list',
      'git remote -v',
      'git remote get-url origin',
      'git config user.name',
      'git config --get remote.origin.url',
      'git config --list',
      'git reflog',
      'git fetch origin',
      'git push origin HEAD',
      'ls -la',
      'echo "not git"',
    ]) {
      expect(sharedRepositoryGitRefusal(command), command).toBeNull();
    }
  });
});
