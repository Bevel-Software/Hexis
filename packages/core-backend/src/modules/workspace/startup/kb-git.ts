import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cloneCredentialArgs, credentialHelperValue } from '../../kb-fs/clone-config.js';
import { ClassifiedFailure, classifyGitFailure } from '../../settings/git-connection-check.js';

const execFileAsync = promisify(execFile);

/**
 * The startup phase's own git plumbing — the runner owns every remote and
 * repository operation of the phase (steps only declare buffered ops), so
 * this is deliberately small and self-contained rather than borrowed from
 * the runtime workspace service.
 */

/** Fallback committer identity; workflow commits override with `--author`. */
export const BOT_NAME = 'Bevel Workflow';
export const BOT_EMAIL = 'bevel-workflow@bevel.software';

/**
 * Scrub credentials from anything that reaches a log or an error message:
 * the token in effect wherever it appears, URL userinfo — a remote spelled
 * `https://user:pass@host` would otherwise leak `pass` verbatim through every
 * git failure that quotes the URL back — and URL query strings, where a
 * presigned remote keeps its credential.
 *
 * "The token in effect" is every place one can come from: each environment
 * spelling `CoreConfig` accepts (it normalises them onto `GITHUB_TOKEN` at
 * boot, but a later write to one of them is not normalised), plus whatever the
 * caller knows about — the settings-stored token, or a token a request brought
 * along. Longest first, so a token that contains another is not half-scrubbed.
 */
export function redactSecret(text: string, secrets: readonly (string | null | undefined)[] = []): string {
  const tokens = [
    process.env.GITHUB_TOKEN,
    process.env.GIT_TOKEN,
    process.env.GH_TOKEN,
    ...secrets,
  ]
    .map((t) => t?.trim())
    .filter((t): t is string => !!t);
  let scrubbed = text;
  for (const token of [...new Set(tokens)].sort((a, b) => b.length - a.length)) {
    scrubbed = scrubbed.replaceAll(token, '***');
  }
  return (
    scrubbed
      .replace(/:\/\/[^/@\s]+@/g, '://***@')
      // A presigned remote carries its credential in the query instead
      // (`?X-Amz-Signature=…`, `?access_token=…`). A git remote has no query
      // worth keeping in a log, so the whole of it goes.
      .replace(/(\bhttps?:\/\/[^\s?#'"]+)\?[^\s#'"]*/gi, '$1?***')
  );
}

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

export async function git(cwd: string, gitUsername: string, args: string[]): Promise<string> {
  try {
    const argv = [...credArgs(gitUsername), ...withPersistedCloneConfig(gitUsername, args)];
    const { stdout } = await execFileAsync('git', argv, {
      cwd,
      // A stalled remote must FAIL the phase, not hang the boot forever —
      // fail-closed (and KB_SAFE_BOOT's demotion) can only engage on an error
      // that actually arrives. 10 minutes is generous for the largest clone.
      timeout: 600_000,
      // The 1MiB default truncates `ls-remote --heads` on remotes with very
      // many branches, which would silently drop heads from the phase's view.
      maxBuffer: 64 * 1024 * 1024,
      // A credential prompt must fail the phase, not hang the boot forever
      // waiting on a terminal nobody is watching.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return stdout.toString();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Classified here, from what git actually said, before the scrub can
    // rewrite it — the message that leaves is the scrubbed one.
    const raw = `git ${args[0]} failed: ${msg}`;
    throw new ClassifiedFailure(redactSecret(raw), classifyGitFailure(raw));
  }
}

export async function stampIdentity(repo: string, gitUsername: string): Promise<void> {
  await git(repo, gitUsername, ['config', 'user.name', BOT_NAME]);
  await git(repo, gitUsername, ['config', 'user.email', BOT_EMAIL]);
}

/** Branch names present on the remote, from `ls-remote --heads`. */
export async function lsRemoteHeads(repoUrl: string, gitUsername: string): Promise<Set<string>> {
  const out = await git(os.tmpdir(), gitUsername, ['ls-remote', '--heads', repoUrl]);
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
