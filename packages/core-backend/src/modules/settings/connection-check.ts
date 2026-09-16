import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { validateHttpsRemote } from './deployment-settings.service.js';
import { classifyGitFailure } from '../../shared/git-failure.js';
import { redactSecret, urlQuerySecrets } from '../../shared/redact-secret.js';
import { GitRunError, type IGitRunner } from '../../shared/git.contract.js';
import { NodeGitRunner } from '../workflow/git/node-git-runner.js';

/** The repository connection a deployment reads and writes its knowledge base with. */
export interface RepositoryConnection {
  url: string;
  token: string;
  username: string;
}

/** Which form field a failed check is about — the save reports it against that input. */
export type ConnectionField = 'kbRepoUrl' | 'gitToken';

/** What the remote listed, when it answered a read. */
interface Listing {
  branches: string[];
  /** What the remote calls its own trunk, when it says. */
  defaultBranch: string | null;
  /** No branches yet — a supported starting point, not a failure. */
  empty: boolean;
}

/**
 * The three answers a connection can give, and the only three the screen
 * distinguishes:
 *
 *  - `connected`: the token reads AND writes the repository;
 *  - `read-only`: it reads, but the host refused the push side — the listing
 *    rides along, and `error` names the permission to grant;
 *  - `rejected`: it never got as far as reading — bad credentials, no such
 *    repository, or a host that could not be reached.
 */
export type ConnectionCheck =
  | ({ outcome: 'connected' } & Listing)
  | ({ outcome: 'read-only'; field: 'gitToken'; error: string } & Listing)
  | {
      outcome: 'rejected';
      reason: FailureReason;
      field: ConnectionField;
      error: string;
    };

export type FailureReason = 'credentials' | 'not-found' | 'unreachable' | 'invalid-address' | 'unknown';

/** Runs one git command; rejects with an error whose message carries git's stderr. */
export type GitRunner = (args: string[], env: NodeJS.ProcessEnv) => Promise<{ stdout: string }>;

const TOKEN_ENV = 'BEVEL_PROBE_TOKEN';

/**
 * A short deadline of its own: this is an interactive check behind a form,
 * and an admin waiting on a wrong URL should hear so in seconds, not after
 * the port's default.
 */
const PROBE_TIMEOUT_MS = 20_000;

/**
 * The probe's git, run through the deployment's git port (see
 * `shared/git.contract.ts`) so it carries the same environment, deadline
 * handling and token redaction as every other git the backend runs — and so
 * a host that never answers is killed with its helpers rather than left
 * holding a request open.
 */
export function gitRunnerFor(runner: IGitRunner): GitRunner {
  return async (args, env) => {
    const { stdout } = await runner.run(process.cwd(), args, { env, timeoutMs: PROBE_TIMEOUT_MS });
    return { stdout };
  };
}

/** The check bound to one runner: what the composition root hands the setup routes. */
export function repositoryConnectionCheck(
  runner: IGitRunner,
): (connection: RepositoryConnection) => Promise<ConnectionCheck> {
  const run = gitRunnerFor(runner);
  return (connection) => checkRepositoryConnection(connection, run);
}

let defaultRun: GitRunner | null = null;
/** The check's own runner when none is injected — a port with default settings, made once. */
function runGit(): GitRunner {
  defaultRun ??= gitRunnerFor(new NodeGitRunner());
  return defaultRun;
}

/**
 * Ask the remote whether this connection can do what a deployment needs of it:
 * READ the repository and WRITE to it, with exactly the token and username the
 * deployment will use.
 *
 * Reading alone is not enough. A read-only token lists branches, clones, and
 * finishes setup — and then every save anyone makes fails at push, which is
 * the first moment anyone would learn the token was wrong.
 *
 *  - Read: `ls-remote` of HEAD and the branches, the cheapest call that proves
 *    the address resolves and the credential authenticates.
 *  - Write: a DRY-RUN push deleting a ref that does not exist, from an empty
 *    scratch repository. Nothing is sent and nothing can be written, but git
 *    still opens `receive-pack`, which is where a host checks push permission.
 *    A host that lets us that far answers "remote ref does not exist" (or,
 *    locally, reports the no-op delete) — either is a yes.
 *
 * The ONE function both Test connection and the settings save call, so the
 * button can never say "connected" about a connection the save would refuse.
 */
export async function checkRepositoryConnection(
  connection: RepositoryConnection,
  run: GitRunner = runGit(),
): Promise<ConnectionCheck> {
  const { url, token, username } = connection;
  // The callers validate what they are sent; this is the floor under them,
  // because both values reach git (the URL as an argument, the username inside
  // a shell snippet) and either unvalidated is injection. The URL is ANSWERED,
  // not thrown: one stored before the rule tightened (userinfo) still arrives
  // here through a save that only changes the token, and the admin needs the
  // rule's own words against the address — not a 500.
  const urlProblem = validateHttpsRemote(url);
  if (urlProblem) {
    return { outcome: 'rejected', reason: 'invalid-address', field: 'kbRepoUrl', error: urlProblem };
  }
  if (!/^[A-Za-z0-9._-]+$/.test(username)) throw new Error('Refusing an unsupported git username.');

  // The helper reads the token from the environment at call time, so it never
  // appears in argv (and so never in a process listing or a crash dump). The
  // empty helper first clears any the host has configured, so the answer is
  // about THIS token, not one sitting in a system credential store.
  const credArgs = [
    '-c',
    'credential.helper=',
    ...(token
      ? ['-c', `credential.helper=!f() { printf '%s\\n' "username=${username}" "password=$${TOKEN_ENV}"; }; f`]
      : []),
  ];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    [TOKEN_ENV]: token,
    // Never let git stop for a prompt: without this a bad credential hangs the
    // request until the timeout instead of failing.
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: 'echo',
  };
  /** What git said, as git said it — the classifier's input. */
  const gitSaid = (err: unknown) => {
    let raw = err instanceof Error ? err.message : String(err);
    // The port carries git's stderr beside the message, and that is where the
    // host's own words are — the classifier reads them.
    if (err instanceof GitRunError && err.stderr) raw += `\n${err.stderr}`;
    // A deadline expiry says so in `timedOut` (the port) or in `killed` /
    // `signal` (a bare execFile) — never in the message. Without the marker a
    // host that never answers classifies as `unknown`, not unreachable.
    const exit = err as { killed?: boolean; signal?: string | null } | null;
    if ((err instanceof GitRunError && err.timedOut) || (exit?.killed && exit.signal === 'SIGTERM')) {
      raw += '\ntimed out';
    }
    return raw;
  };
  // Classification reads the raw text; only a scrubbed copy is ever echoed —
  // git failures have been known to quote the credential back.
  const scrub = (text: string) => redactSecret(text, [token, ...urlQuerySecrets(url)]);

  let listing: Listing;
  try {
    // `--end-of-options` on top of the validation above: belt and braces, so
    // nothing that arrives here can ever be read as a flag. Patterns, not
    // `--heads`: `--heads` drops the HEAD symref, and with it the default branch.
    const { stdout } = await run(
      [...credArgs, 'ls-remote', '--symref', '--end-of-options', url, 'HEAD', 'refs/heads/*'],
      env,
    );
    listing = parseListing(stdout);
  } catch (err) {
    const raw = gitSaid(err);
    return rejection(classifyReadFailure(raw), scrub(raw));
  }

  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'hexis-write-check-'));
  try {
    await run(['init', '--bare', '--quiet', scratch], env);
    const probeRef = `refs/heads/hexis-write-check-${randomBytes(6).toString('hex')}`;
    await run(
      [...credArgs, `--git-dir=${scratch}`, 'push', '--dry-run', '--end-of-options', url, `:${probeRef}`],
      env,
    );
    return { outcome: 'connected', ...listing };
  } catch (err) {
    const raw = gitSaid(err);
    const verdict = classifyWriteFailure(raw);
    if (verdict === 'writable') return { outcome: 'connected', ...listing };
    if (verdict === 'read-only') {
      return { outcome: 'read-only', field: 'gitToken', error: readOnlyMessage(url), ...listing };
    }
    return rejection(verdict, scrub(raw));
  } finally {
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Why a READ failed — the shared classifier's reading (`shared/git-failure.ts`,
 * the ONE table of git's wordings), in the three reasons the connection check
 * reports. This module keeps no patterns of its own: a host that changes its
 * phrasing is learned once, for this check and the KB startup phase alike.
 */
export function classifyReadFailure(text: string): FailureReason {
  switch (classifyGitFailure(text, { operation: 'read' }).kind) {
    case 'credentials-rejected':
      return 'credentials';
    case 'not-found':
      return 'not-found';
    case 'unreachable':
      return 'unreachable';
    default:
      return 'unknown';
  }
}

/**
 * What a dry-run push's failure means, given the same credentials have just
 * READ the repository.
 *
 * "remote ref does not exist" is git's answer AFTER the host has let it into
 * `receive-pack` and advertised its refs — the probe ref is absent by design,
 * so that answer is proof of write access, not a failure. It is this probe's
 * own success signal, which is why it is read here rather than in the shared
 * table of failures.
 *
 * Everything else is the shared classifier's reading of a WRITE: a refusal in
 * a host's own words, or a bare 403/404 (the credentials just listed the
 * repository, so it exists and the host is hiding the write side), is
 * read-only; an authentication failure stays credentials — on a PUBLIC
 * repository the read succeeds anonymously, so the push is the first time the
 * token is presented, and a made-up one must not send the admin off to grant a
 * permission to a token that does not exist.
 */
export function classifyWriteFailure(text: string): 'writable' | 'read-only' | FailureReason {
  if (/remote ref does not exist/i.test(text)) return 'writable';
  switch (classifyGitFailure(text, { operation: 'write' }).kind) {
    case 'write-refused':
    case 'push-refused-by-policy':
      return 'read-only';
    case 'credentials-rejected':
      return 'credentials';
    case 'not-found':
      return 'not-found';
    case 'unreachable':
      return 'unreachable';
    default:
      return 'unknown';
  }
}

/** The permission a token needs to write, in the host's own words where it is recognised. */
export function writePermissionFor(url: string): string {
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    // Unreachable in practice — the URL was validated before it was probed.
  }
  if (host === 'github.com' || host.endsWith('.github.com')) {
    return 'on GitHub, “Contents: Read and write” for this repository (a classic token needs the “repo” scope)';
  }
  if (host === 'gitlab.com') return 'on GitLab, the “write_repository” scope and at least the Developer role';
  if (host === 'bitbucket.org') return 'on Bitbucket, “Repositories: Write”';
  if (host === 'dev.azure.com' || host.endsWith('.visualstudio.com')) {
    return 'on Azure DevOps, “Code: Read & write”';
  }
  return 'push (write) access to this repository';
}

function readOnlyMessage(url: string): string {
  return `This token can read the repository but cannot write to it. Grant it write access: ${writePermissionFor(url)}.`;
}

function rejection(reason: FailureReason, text: string): ConnectionCheck {
  switch (reason) {
    case 'credentials':
      return {
        outcome: 'rejected',
        reason,
        field: 'gitToken',
        error:
          'The host rejected those credentials. Check the token, and that the username matches the host (GitHub x-access-token, GitLab oauth2, Bitbucket x-token-auth).',
      };
    case 'not-found':
      return {
        outcome: 'rejected',
        reason,
        field: 'kbRepoUrl',
        error: 'No repository at that URL — or the token cannot see it.',
      };
    case 'unreachable':
      return {
        outcome: 'rejected',
        reason,
        field: 'kbRepoUrl',
        error:
          'Could not reach that host from this server. Check the URL and any network egress rules, then try again.',
      };
    default:
      // Echoed only when it matches nothing known, already scrubbed of the
      // token — `ls-remote` failures have been known to quote the credential.
      return {
        outcome: 'rejected',
        reason: 'unknown',
        field: 'kbRepoUrl',
        error: text.split('\n').slice(0, 3).join(' ').slice(0, 400),
      };
  }
}

/** `<sha>\trefs/heads/<name>` rows, plus the `ref: … HEAD` symref row when a host sends one. */
function parseListing(stdout: string): Listing {
  const lines = stdout.split('\n');
  // Tag refs and the bare HEAD row are not branches, so they are filtered
  // rather than sliced blindly.
  const branches = lines
    .filter((line) => !line.startsWith('ref:'))
    .map((line) => line.split('\t')[1]?.trim())
    .filter((ref): ref is string => !!ref && ref.startsWith('refs/heads/'))
    .map((ref) => ref.slice('refs/heads/'.length));
  const defaultBranch =
    lines
      .find((line) => line.startsWith('ref:') && line.trimEnd().endsWith('\tHEAD'))
      ?.slice('ref: refs/heads/'.length)
      .split('\t')[0]
      ?.trim() || null;
  return { branches, defaultBranch, empty: branches.length === 0 };
}
