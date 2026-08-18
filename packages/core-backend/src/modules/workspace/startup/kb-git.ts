import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

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

/** Scrub the token from anything that reaches a log or an error message. */
export function redactSecret(text: string): string {
  const token = process.env.GITHUB_TOKEN;
  return token ? text.replaceAll(token, '***') : text;
}

/**
 * Per-invocation `-c` config. Long paths always (Windows checkouts of deep
 * KB trees); when a token is present, an inline credential helper that reads
 * it from the environment at call time — the secret never appears in argv.
 */
function credArgs(gitUsername: string): string[] {
  const args = ['-c', 'core.longpaths=true'];
  if (process.env.GITHUB_TOKEN) {
    args.push(
      '-c',
      `credential.helper=!f() { echo "username=${gitUsername}"; echo "password=$GITHUB_TOKEN"; }; f`,
    );
  }
  return args;
}

export async function git(cwd: string, gitUsername: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', [...credArgs(gitUsername), ...args], { cwd });
    return stdout.toString();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(redactSecret(`git ${args[0]} failed: ${msg}`));
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
