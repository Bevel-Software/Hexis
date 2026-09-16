import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { IGitRunner } from '../../shared/git.contract.js';
import { printable } from '../../shared/printable.js';
import { logger } from '../../shared/logging.js';
import { NodeGitRunner } from '../workflow/git/node-git-runner.js';
import { probeCredentialArgs, probeGitEnv } from './connection-check.js';

const log = logger('setup');

/** How one `git` invocation is run. Injected by tests; the deployment's git port otherwise. */
export type GitRunner = (
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeout: number },
) => Promise<{ stdout: string }>;

/**
 * The listing's git, run through the deployment's git port (see
 * `shared/git.contract.ts`) — the same port the connection check runs
 * through — so it carries the same environment, deadline handling and token
 * redaction as every other git the backend runs, and a clone whose host
 * stalls mid-transfer is killed with its transport helpers at the deadline
 * rather than left holding the request open.
 */
export function listingRunnerFor(runner: IGitRunner): GitRunner {
  return async (args, { env, timeout }) => {
    const { stdout } = await runner.run(process.cwd(), args, { env, timeoutMs: timeout });
    return { stdout };
  };
}

/** The listing bound to one runner: what the composition root hands the setup routes. */
export function rootFolderListerFor(runner: IGitRunner): typeof listRootFolders {
  const run = listingRunnerFor(runner);
  return (listing, deps = {}) => listRootFolders(listing, { run, ...deps });
}

let defaultRun: GitRunner | undefined;
/** A runner on default settings, for callers that did not bind one; built once. */
function runGit(): GitRunner {
  defaultRun ??= listingRunnerFor(new NodeGitRunner());
  return defaultRun;
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
  const run = deps.run ?? runGit();
  const makeTempDir = deps.makeTempDir ?? (() => mkdtemp(path.join(tmpdir(), 'hexis-root-folders-')));
  const removeDir = deps.removeDir ?? ((dir: string) => rm(dir, { recursive: true, force: true }));

  let scratch: string;
  try {
    scratch = await makeTempDir();
  } catch {
    return null;
  }
  const target = path.join(scratch, 'repo');
  // The one credential helper every probe uses (see connection-check.ts).
  const credentials = probeCredentialArgs(username, token);
  const env = probeGitEnv(token);
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
    log.warn(
      `could not list the repository root folders: ${printable(
        (token ? text.replaceAll(token, '***') : text).split('\n')[0]?.slice(0, 200) ?? '',
      )}`,
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
