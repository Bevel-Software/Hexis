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
      'git branch --unset-upstream',
      'git branch -t mine origin/bob/b',
      'git branch --track mine origin/bob/b',
      'git branch --track=inherit mine bob/b',
      'git checkout -t origin/bob/b',
      'git checkout -b mine --track origin/bob/b',
      'git switch --track origin/bob/b',
      'git switch -c mine -t origin/bob/b',
      'git push -u origin HEAD',
      'git push --set-upstream origin mine',
      'git push -fu origin mine',
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
      'git push --force-with-lease origin HEAD',
      'git checkout -- notes.md',
      'git checkout --theirs notes.md',
      'git switch -c new-idea',
      'git branch --no-track new-idea',
      'ls -la',
      'echo "not git"',
    ]) {
      expect(sharedRepositoryGitRefusal(command), command).toBeNull();
    }
  });

  it('reads the command as sh does: quotes and escapes inside a word do not hide the subcommand', () => {
    for (const command of [
      'git up"date"-ref refs/heads/bob/b HEAD',
      "git up'date'-ref refs/heads/bob/b HEAD",
      'git up\\date-ref refs/heads/bob/b HEAD',
      '"git" "update-ref" refs/heads/bob/b HEAD',
      'g""it update-ref refs/heads/bob/b HEAD',
      'git "g"c',
      'git branch "-"D bob/b',
      'git push -"u" origin HEAD',
      'git \\\nupdate-ref refs/heads/bob/b HEAD',
      'echo "$(git update-ref refs/heads/x HEAD)"',
      'echo `git gc`',
      "sh -c 'git update-ref refs/heads/bob/b HEAD'",
      'bash -lc "git up\\"\\"date-ref refs/heads/bob/b HEAD"',
      "eval 'git gc'",
      'nice -n 5 git gc',
      'timeout 9 git prune',
      'find . -maxdepth 0 -exec git gc \\;',
      'git -c alias.u=update-ref u refs/heads/bob/b HEAD',
      'git --config-env=alias.u=X u',
    ]) {
      expect(sharedRepositoryGitRefusal(command, 'posix'), command).not.toBeNull();
    }
  });

  it('refuses what only the running shell can resolve where it could decide the outcome', () => {
    for (const command of [
      'git $SUB refs/heads/bob/b HEAD',
      'git ${SUB} refs/heads/bob/b HEAD',
      "git $'update-ref' refs/heads/bob/b HEAD",
      'git "$(echo update-ref)" refs/heads/bob/b HEAD',
      'git update-re? refs/heads/bob/b HEAD',
      '$G update-ref refs/heads/bob/b HEAD',
      'git branch $FLAGS bob/b',
      'git push $OPTS origin HEAD',
      'echo update-ref | xargs git',
      'sh -c "$CMD"',
    ]) {
      expect(sharedRepositoryGitRefusal(command, 'posix'), command).not.toBeNull();
    }
  });

  it('leaves expansions alone where they cannot change what git does to the shared repository', () => {
    for (const command of [
      'git add *.md',
      'git commit -m "$MSG"',
      'git log --format=%s "$(git merge-base HEAD origin/main)"..HEAD',
      'git checkout -- *.md',
      'git diff HEAD -- "$FILE"',
      "sh -c 'git status'",
      'cat notes.md > out.txt 2>&1',
      'echo "git gc is the platform\'s job" > /dev/null',
    ]) {
      expect(sharedRepositoryGitRefusal(command, 'posix'), command).toBeNull();
    }
  });

  it('refuses a program a wrapper runs from an operand only the shell can resolve', () => {
    for (const command of [
      'G=git; env "$G" gc',
      'nice -n 5 $G gc',
      'command "$G" update-ref refs/heads/bob/b HEAD',
      'timeout 9 ${G} prune',
      'find . -maxdepth 0 -exec "$G" gc \\;',
    ]) {
      expect(sharedRepositoryGitRefusal(command, 'posix'), command).not.toBeNull();
    }
    for (const command of ['env FOO=1 git status', 'nice -n 5 git log', 'find . -name "$PAT"', 'cp "$SRC" "$DST"']) {
      expect(sharedRepositoryGitRefusal(command, 'posix'), command).toBeNull();
    }
  });

  it('finds the end of a command substitution as sh does: a quoted or nested ")" does not close it', () => {
    for (const command of [
      'echo "$(printf ")" ; git update-ref refs/heads/x HEAD)"',
      "echo $(printf ')' ; git gc)",
      'echo "$(echo "$(printf ")")"; git gc)"',
      'echo $(echo \\) ; git gc)',
      `echo $(printf ")" ; git gc ; echo "'")`,
      'echo $(# )\ngit gc)',
    ]) {
      expect(sharedRepositoryGitRefusal(command, 'posix'), JSON.stringify(command)).not.toBeNull();
    }
  });

  it('reads a here-document body as data, and what follows its delimiter as commands', () => {
    for (const command of [
      "cat <<'EOF'\n'\nEOF\ngit gc",
      'cat <<EOF\n"\nEOF\ngit gc',
      'cat <<-EOF > notes.md\n\t\'\n\tEOF\ngit update-ref refs/heads/x HEAD',
      'cat <<EOF\n$(git gc)\nEOF',
      'cat <<EOF\n`git gc`\nEOF',
      'echo "$(cat <<EOF\n)\nEOF\n)"; git gc',
      'cat <<$D\nx\n$D',
    ]) {
      expect(sharedRepositoryGitRefusal(command, 'posix'), JSON.stringify(command)).not.toBeNull();
    }
    for (const command of [
      "cat <<'EOF' > notes.md\nit's $(git gc) here, `git gc` there\nEOF",
      "git commit -m \"$(cat <<'EOF'\nfix: the thing (finally)\n\nIt's done.\nEOF\n)\"",
      'cat <<EOF\nupdate-ref gc prune\nEOF\ngit status',
      'git log --format=%s <<<"x"',
    ]) {
      expect(sharedRepositoryGitRefusal(command, 'posix'), JSON.stringify(command)).toBeNull();
    }
  });

  it('reads a comment as sh does: a quote in it does not hide the next line', () => {
    for (const command of ["# '\ngit gc", 'echo hi # "\ngit gc', "true; # it's\ngit update-ref refs/heads/x HEAD"]) {
      expect(sharedRepositoryGitRefusal(command, 'posix'), JSON.stringify(command)).not.toBeNull();
    }
    for (const command of ['# git gc', 'git status # then git gc', 'echo a#b', 'git log -1 # it\'s fine']) {
      expect(sharedRepositoryGitRefusal(command, 'posix'), JSON.stringify(command)).toBeNull();
    }
  });

  it('reads the command as cmd.exe does on Windows', () => {
    for (const command of [
      'git update-ref refs/heads/bob/b HEAD',
      'git up^date-ref refs/heads/bob/b HEAD',
      'git up"date"-ref refs/heads/bob/b HEAD',
      'C:\\Program Files\\Git\\cmd\\git.exe gc',
      '"C:\\Program Files\\Git\\cmd\\git.exe" gc',
      'cd kb & git gc',
      'git %SUB% refs/heads/bob/b HEAD',
      'cmd /c "git gc"',
    ]) {
      expect(sharedRepositoryGitRefusal(command, 'cmd'), command).not.toBeNull();
    }
    for (const command of ['git status', 'git log -1 --format=%s', "git commit -m 'fix'", 'dir & git diff']) {
      expect(sharedRepositoryGitRefusal(command, 'cmd'), command).toBeNull();
    }
  });
});
