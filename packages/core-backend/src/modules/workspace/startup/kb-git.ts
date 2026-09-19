import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cloneCredentialArgs, credentialHelperValue } from '../../kb-fs/clone-config.js';
import { GitRunError, type IGitRunner } from '../../../shared/git.contract.js';
import { ClassifiedFailure, classifyGitFailure } from '../../../shared/git-failure.js';
import { redactSecret, urlQuerySecrets } from '../../../shared/redact-secret.js';

/**
 * The startup phase's own git plumbing — the runner owns every remote and
 * repository operation of the phase (steps only declare buffered ops), so
 * this is deliberately small: the credential and clone-config arguments the
 * phase needs on every call, over the one git port the rest of the backend
 * runs through (`shared/git.contract.ts`).
 */

/** Fallback committer identity; workflow commits override with `--author`. */
export const BOT_NAME = 'Bevel Workflow';
export const BOT_EMAIL = 'bevel-workflow@bevel.software';

/**
 * A stalled remote must FAIL the phase, not hang the boot forever —
 * fail-closed (and KB_SAFE_BOOT's demotion) can only engage on an error that
 * actually arrives. Ten minutes is generous for the largest clone, and far
 * past the port's default, which is sized for a running deployment's
 * operations rather than a first clone.
 */
const STARTUP_GIT_TIMEOUT_MS = 600_000;

/**
 * Per-invocation `-c` config. Long paths always (Windows checkouts of deep
 * KB trees); when a token is present, an inline credential helper that reads
 * it from the environment at call time — the secret never appears in argv.
 */
function credArgs(gitUsername: string): string[] {
  const args = ['-c', 'core.longpaths=true'];
  const helper = credentialHelperValue(gitUsername);
  if (helper) args.push('-c', `credential.helper=${helper}`);
  return args;
}

/**
 * `credArgs` authenticates the invocation and nothing more — the `-c` pairs sit
 * BEFORE the subcommand, so git applies them to this process and forgets them.
 * That is right for every command here except `clone`, whose product is a
 * repository other code pushes from later: the phase clones the default branch
 * into `<workspacesRoot>/<id>/<kbDirName>`, exactly where `WorkspaceService`
 * adopts it, and `GitService.push` then runs a bare `git push` expecting the
 * clone to carry its own credentials. Persist them with `clone --config` (which
 * only means "write into the new repo" after the subcommand) so it does.
 */
function withPersistedCloneConfig(gitUsername: string, args: string[]): string[] {
  if (args[0] !== 'clone') return args;
  return [args[0], ...cloneCredentialArgs(gitUsername), ...args.slice(1)];
}

export async function git(
  runner: IGitRunner,
  cwd: string,
  gitUsername: string,
  args: string[],
): Promise<string> {
  const argv = [...credArgs(gitUsername), ...withPersistedCloneConfig(gitUsername, args)];
  try {
    // A floor under the configured ceiling, not a replacement for it: an
    // operator who raised GIT_TIMEOUT_MS past ten minutes gets that here too.
    const { stdout } = await runner.run(cwd, argv, {
      timeoutMs: Math.max(runner.defaultTimeoutMs, STARTUP_GIT_TIMEOUT_MS),
    });
    return stdout;
  } catch (err) {
    // Classified here, from what git said — the port's error already names the
    // subcommand and carries git's stderr in its message — before the scrub
    // can rewrite it; the message that leaves is the scrubbed one. A remote in
    // the argv has its query values scrubbed as secrets of their own. The
    // port's error rides along as the cause: its fields say whether git ran
    // at all, which the runner reads to tell a missing git from a remote
    // that would not answer.
    const msg = err instanceof Error ? err.message : String(err);
    const raw = err instanceof GitRunError ? msg : `git ${args[0]} failed: ${msg}`;
    const querySecrets = args.flatMap((arg) => urlQuerySecrets(arg));
    throw new ClassifiedFailure(redactSecret(raw, querySecrets), classifyGitFailure(raw), { cause: err });
  }
}

export async function stampIdentity(runner: IGitRunner, repo: string, gitUsername: string): Promise<void> {
  await git(runner, repo, gitUsername, ['config', 'user.name', BOT_NAME]);
  await git(runner, repo, gitUsername, ['config', 'user.email', BOT_EMAIL]);
}

/** Branch names present on the remote, from `ls-remote --heads`. */
export async function lsRemoteHeads(
  runner: IGitRunner,
  repoUrl: string,
  gitUsername: string,
): Promise<Set<string>> {
  const out = await git(runner, os.tmpdir(), gitUsername, ['ls-remote', '--heads', repoUrl]);
  const heads = new Set<string>();
  for (const line of out.split('\n')) {
    const m = /\srefs\/heads\/(.+)$/.exec(line.trim());
    if (m) heads.add(m[1]!);
  }
  return heads;
}

/** A temp dir that is always removed, success or failure. */
export async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-startup-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
