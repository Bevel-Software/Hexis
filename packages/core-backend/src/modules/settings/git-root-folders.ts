import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { printable } from '../../shared/printable.js';

const execFileAsync = promisify(execFile);

/** How one `git` invocation is run. Injected by tests; `execFile` otherwise. */
export type GitRunner = (
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeout: number },
) => Promise<{ stdout: string }>;

const runGit: GitRunner = async (args, options) => {
  const { stdout } = await execFileAsync('git', args, { ...options, maxBuffer: 16 * 1024 * 1024 });
  return { stdout: String(stdout) };
};

/**
 * The `-c` pairs that authenticate a connection-check invocation. The helper
 * reads the token from the environment at call time, so it never appears in
 * argv (and so never in a process listing or a crash dump). The username is
 * interpolated into the snippet, which is why the route refuses anything but
 * a plain token before it gets here.
 */
export function connectionCredentialArgs(username: string, token: string): string[] {
  return [
    '-c',
    'credential.helper=',
    ...(token
      ? ['-c', `credential.helper=!f() { echo "username=${username}"; echo "password=$BEVEL_TEST_TOKEN"; }; f`]
      : []),
  ];
}

/** The environment a connection-check invocation runs with. */
export function connectionGitEnv(token: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    BEVEL_TEST_TOKEN: token,
    // Never let git stop for a prompt: without this a bad credential hangs the
    // request until the timeout instead of failing.
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: 'echo',
  };
}

/**
 * The `ls-remote` a connection check runs: the branches, plus `HEAD` with
 * `--symref` so the remote says which branch it calls its trunk. `--heads`
 * alone never reports `HEAD`, which would leave a repository whose trunk is
 * not `main`/`master` listed from the wrong branch.
 */
export function lsRemoteArgs(url: string): string[] {
  // `--end-of-options` on top of the route's validation: belt and braces, so
  // nothing that arrives here can ever be read as a flag.
  return ['ls-remote', '--symref', '--end-of-options', url, 'HEAD', 'refs/heads/*'];
}

/** The branches and the remote's default branch, read from {@link lsRemoteArgs}' output. */
export function parseLsRemote(stdout: string): { branches: string[]; defaultBranch: string | null } {
  const rows = stdout.split('\n').map((line) => line.trimEnd().split('\t'));
  // `<sha>\trefs/heads/<name>` — the `ref:` rows are symrefs and the bare
  // `<sha>\tHEAD` row is not a branch, so they are filtered rather than sliced blindly.
  const branches = rows
    .filter(([first, ref]) => !first?.startsWith('ref:') && ref?.startsWith('refs/heads/'))
    .map(([, ref]) => ref!.slice('refs/heads/'.length));
  // `ref: refs/heads/<name>\tHEAD` — what the remote calls its own trunk.
  const head = rows.find(([first, ref]) => ref === 'HEAD' && first?.startsWith('ref: refs/heads/'));
  const defaultBranch = head?.[0]?.slice('ref: refs/heads/'.length).trim() || null;
  return { branches, defaultBranch };
}

/**
 * Which branch's root to list: the one the remote calls its trunk, else the
 * configured one if the remote has it, else the conventional names, else the
 * first branch it listed — the same order the setup screen guesses in.
 */
export function pickListingBranch(
  remoteDefault: string | null,
  configured: string | null,
  branches: string[],
): string | null {
  if (remoteDefault) return remoteDefault;
  if (configured && branches.includes(configured)) return configured;
  return ['main', 'master', 'trunk'].find((name) => branches.includes(name)) ?? branches[0] ?? null;
}

/** Per git call. A blob-less clone of one commit is a second or two; this bounds the fallback. */
const LISTING_TIMEOUT_MS = 30_000;

/** A clone refused because the host cannot filter — worth one retry without the filter. */
const FILTER_UNSUPPORTED = /filter|partial|not support|unsupported/i;

export interface RootFolderListing {
  url: string;
  branch: string;
  username: string;
  token: string;
}

export interface RootFolderListingDeps {
  run?: GitRunner;
  makeTempDir?: () => Promise<string>;
  removeDir?: (dir: string) => Promise<void>;
}

/**
 * The top-level folder names of one branch of a remote, or null when they
 * could not be read.
 *
 * `ls-remote` answers with refs only; a folder listing needs the root TREE,
 * which no transport serves on its own over HTTPS (`git archive --remote` is
 * refused by GitHub and GitLab alike). So: a clone of exactly one commit with
 * no blobs and no checkout — trees only, which on a large repository is a
 * small fraction of it — then `ls-tree` on its root. A host that cannot filter
 * gets a plain shallow clone of the same commit instead.
 *
 * Nothing here can fail the connection check: the credentials were already
 * proven by `ls-remote`, and a listing that does not come back is reported as
 * "no listing" (null), not as a broken connection. The scratch clone belongs
 * to this call and is removed on every path out of it.
 */
export async function listRootFolders(
  { url, branch, username, token }: RootFolderListing,
  deps: RootFolderListingDeps = {},
): Promise<string[] | null> {
  const run = deps.run ?? runGit;
  const makeTempDir = deps.makeTempDir ?? (() => mkdtemp(path.join(tmpdir(), 'hexis-root-folders-')));
  const removeDir = deps.removeDir ?? ((dir: string) => rm(dir, { recursive: true, force: true }));

  let scratch: string;
  try {
    scratch = await makeTempDir();
  } catch {
    return null;
  }
  const target = path.join(scratch, 'repo');
  const credentials = connectionCredentialArgs(username, token);
  const env = connectionGitEnv(token);
  const clone = (filtered: boolean) =>
    run(
      [
        ...credentials,
        'clone',
        '--quiet',
        '--depth=1',
        ...(filtered ? ['--filter=blob:none'] : []),
        '--no-checkout',
        '--single-branch',
        // One argv entry: a branch name can never be read as a flag of its own.
        `--branch=${branch}`,
        '--end-of-options',
        url,
        target,
      ],
      { env, timeout: LISTING_TIMEOUT_MS },
    );

  try {
    try {
      await clone(true);
    } catch (err) {
      if (!FILTER_UNSUPPORTED.test(errorText(err))) throw err;
      // Whatever the refused attempt left behind would make the retry's target
      // a non-empty directory.
      await removeDir(target);
      await clone(false);
    }
    const { stdout } = await run(
      ['-C', target, 'ls-tree', '-d', '-z', '--name-only', 'HEAD'],
      { env, timeout: LISTING_TIMEOUT_MS },
    );
    return stdout.split('\0').filter(Boolean);
  } catch (err) {
    const text = errorText(err);
    // Git's error text echoes the remote host's response: token scrubbed, and
    // escaped so a hostile host cannot forge or colour the log line.
    console.warn(
      '[setup] could not list the repository root folders:',
      printable((token ? text.replaceAll(token, '***') : text).split('\n')[0]?.slice(0, 200) ?? ''),
    );
    return null;
  } finally {
    await removeDir(scratch).catch(() => {});
  }
}

function errorText(err: unknown): string {
  if (err instanceof Error) {
    const stderr = (err as { stderr?: unknown }).stderr;
    return `${err.message}${typeof stderr === 'string' ? `\n${stderr}` : ''}`;
  }
  return String(err);
}
