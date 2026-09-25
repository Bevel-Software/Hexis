/**
 * The contract for RUNNING git. Nothing here spawns anything — the one
 * implementation is `NodeGitRunner` in `modules/workflow/git`, wired once by
 * the composition root and injected into every module that shells out to git,
 * so no module carries an `execFile('git', …)` of its own.
 *
 * WHY THERE IS A PORT AT ALL. Git was spawned from six places, each with its
 * own environment, its own buffer ceiling and its own error shape. Four of the
 * six had no deadline at all, and the two that did (the KB startup runner, the
 * setup screen's `ls-remote`) set `execFile`'s own `timeout`, which signals git
 * and then goes on waiting for output pipes a surviving transport helper still
 * holds — see `killTree` in the implementation for what that measured out at.
 * A git process that never returns is not
 * a hypothetical: an unreachable host, a hung credential helper, or a remote
 * that accepts the connection and then stops talking all produce one. And a
 * hung git is not one stalled request. It holds the workspace mutex, which is
 * what serializes every other operation on that clone, so one dead remote takes
 * the workspace with it — and, while the commit worker is single-flight, every
 * other workspace too. The file is on disk and shows as saved; git history
 * silently stops moving.
 *
 * So the point of this contract is the DEADLINE, and the deadline is not
 * optional: {@link https://github.com/Bevel-Software/Hexis Hexis}'s
 * "Opened Connections Have a Closing Owner" invariant requires that a spawned
 * child be closed on every path including timeout and abandonment, and a wait
 * that can never be abandoned cannot satisfy it. Every call made through this
 * port carries one, and the implementation kills the child when it expires.
 *
 * WHAT THIS PORT DOES NOT DO. It does not lock. Serializing git against a
 * clone is the `WorkspaceMutex`'s job, under the canonical workspace id, and
 * moving that responsibility here would give the codebase two answers to
 * "which operations exclude each other". A runner is told what to run and
 * where; whether it was safe to run it there was decided before the call.
 *
 * It also does not stream. A long-lived child whose output is piped somewhere
 * as it arrives — `git http-backend` serving a clone, `git archive` piped into
 * a download — is a different lifetime with a different owner, and stays with
 * the code that owns it.
 */

/**
 * The credential git authenticates a knowledge base's remote with: the
 * Basic-auth username the host expects and the token that is its password.
 *
 * A PROVIDER, read at every call, not a value captured at boot: the setup
 * screen can supply a token after the graph is built, and a token rotated in
 * the settings has to be the one the next push carries. The runner puts the
 * token into the child's environment under {@link GIT_TOKEN_ENV}, which is
 * the only place git reads it from (the inline credential helper spells
 * `password=$GITHUB_TOKEN`), so the value never enters argv, a clone's
 * config, or a message that quotes either. Nothing writes it into THIS
 * process's environment: a server hosting several knowledge bases has one
 * environment and several tokens.
 */
export interface GitCredentials {
  /**
   * The username sent in the Basic credential: GitHub `x-access-token`,
   * GitLab `oauth2`, Bitbucket `x-token-auth`. Interpolated into the helper
   * snippet, so callers validate it against `[A-Za-z0-9._-]+` before it
   * gets here.
   */
  username(): string;
  /** The token in effect, or null when the deployment has none configured. */
  token(): string | null;
}

/** The username git is given when a deployment names none. */
export const DEFAULT_GIT_USERNAME = 'x-access-token';

/**
 * The environment variable the child git process reads the token from. The
 * name is historical (the first supported host), and it is the literal every
 * app-stamped credential helper carries, which is what lets a re-stamp find
 * its own helpers in a clone's config and leave an operator's alone.
 */
export const GIT_TOKEN_ENV = 'GITHUB_TOKEN';

/** No token, the default username: an unauthenticated runner. */
export const NO_GIT_CREDENTIALS: GitCredentials = Object.freeze({
  username: () => DEFAULT_GIT_USERNAME,
  token: () => null,
});

/** A provider from values or thunks, for a composition root or a test. */
export function gitCredentials(
  username: string | (() => string) = DEFAULT_GIT_USERNAME,
  token: string | null | (() => string | null) = null,
): GitCredentials {
  const user = typeof username === 'function' ? username : () => username;
  const secret = typeof token === 'function' ? token : () => token;
  return {
    username: () => user() || DEFAULT_GIT_USERNAME,
    token: () => secret() || null,
  };
}

/**
 * Strip a git token out of text on its way into an error, a log line or a
 * response.
 *
 * git puts the remote URL into a great many of its messages, and on a
 * token-authenticated remote that URL carries the credential. Without this, a
 * push failure writes the deployment's token into the container log, the API
 * response, and any change request the recovery agent opens about it.
 *
 * The token is the caller's to name (the runner names its own), never read
 * from this process's environment: the environment holds no per-knowledge-
 * base token any more, and a scrub that silently found none there would look
 * like one that worked.
 */
export function redactGitToken(text: string, token: string | null | undefined): string {
  const scrubbed = token ? text.replaceAll(token, '***') : text;
  // URL userinfo as well: a remote spelled `https://user:pass@host` would
  // otherwise leak `pass` verbatim through every git failure that quotes the
  // URL back, whatever the token setting.
  return scrubbed.replace(/:\/\/[^/@\s]+@/g, '://***@');
}

/**
 * What a completed git invocation produced. `stdout` is decoded text unless
 * the call asked for bytes (see {@link GitRunOptions.encoding}); `stderr` is
 * always text, since its only use is a message.
 */
export interface GitRunResult<TOut = string> {
  stdout: TOut;
  stderr: string;
}

export interface GitRunOptions {
  /**
   * Bytes to feed the subprocess on stdin — used by the
   * `--pathspec-from-file=-` commit/add paths so that a several-hundred-file
   * batch never has to ride the argv (Windows caps a command line at ~32K
   * characters), and by `cat-file --batch` to name the objects it wants.
   */
  input?: string;
  /**
   * Override the runner's default deadline for this one call. For an operation
   * whose legitimate duration is unlike the rest — a first clone of a large
   * repository, say — rather than raising the deployment-wide default to
   * accommodate it.
   */
  timeoutMs?: number;
  /**
   * Environment entries laid over the runner's own for this one call. For the
   * variables git reads as INPUT to a specific command — `GIT_DIR`,
   * `GIT_INDEX_FILE` and `GIT_WORK_TREE` pointing a plumbing command at a
   * scratch index, `GIT_AUTHOR_*` naming a committer, a helper-read credential
   * — never for the settings that make every invocation safe, which the
   * runner sets and a caller cannot unset.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * `'buffer'` returns stdout as raw bytes. For output whose framing is in
   * BYTES rather than characters: `cat-file --batch` announces each object as
   * `<oid> <type> <size>` and follows it with exactly `size` bytes, and a
   * decoded string cannot be walked by that count once the content is not
   * ASCII. Default `'utf8'`.
   */
  encoding?: 'utf8' | 'buffer';
}

/**
 * A git invocation that did not succeed: a non-zero exit, a failure to spawn,
 * or a deadline that expired.
 *
 * `exitCode` and `stderr` are carried so that callers can tell an EXPECTED
 * non-zero exit (`merge-base` exiting 1 for "no common ancestor", `diff
 * --quiet` exiting 1 for "there are differences") from an infrastructure
 * failure, without parsing message text. Several callers already read
 * `exitCode` this way.
 *
 * `timedOut` is the distinction the deadline adds, and it matters: a timeout is
 * a statement about the host or the network, never about the repository. Code
 * that treats a non-zero exit as a permanent answer — "there is no such ref",
 * "there is nothing to commit" — would draw exactly the wrong conclusion from
 * one, so a caller that interprets exit codes must exclude it first.
 */
export class GitRunError extends Error {
  /** Process exit code, when the process ran and exited. */
  readonly exitCode?: number;
  /** Captured stderr, with any configured git token redacted. */
  readonly stderr?: string;
  /** True when the deadline expired and the child was killed. */
  readonly timedOut: boolean;

  /**
   * No `cause`, on purpose: the child-process error it would carry holds the
   * unredacted command line and stderr, and a logger that serializes errors
   * walks the cause chain. Everything a caller can act on is on the fields
   * above, redacted.
   */
  constructor(message: string, opts: { exitCode?: number; stderr?: string; timedOut?: boolean } = {}) {
    super(message);
    this.name = 'GitRunError';
    this.exitCode = opts.exitCode;
    this.stderr = opts.stderr;
    this.timedOut = opts.timedOut ?? false;
  }
}

/** Whether a failure came from the deadline rather than from git's own answer. */
export function isGitTimeout(err: unknown): boolean {
  return err instanceof GitRunError && err.timedOut;
}

/**
 * Runs one git command to completion and returns what it wrote.
 *
 * `cwd` is the directory git runs in; `args` are passed to the executable
 * verbatim, never through a shell. Throws {@link GitRunError} for every
 * failure, the deadline included.
 */
export interface IGitRunner {
  /**
   * The deadline a call gets when it names none — the deployment's configured
   * ceiling. A caller whose command is legitimately long (a first clone) asks
   * for `Math.max(defaultTimeoutMs, itsOwnFloor)`, so an operator who raised
   * the ceiling raises it there too rather than being overridden by a
   * constant.
   */
  readonly defaultTimeoutMs: number;
  /**
   * The credential every call through this runner authenticates with — see
   * {@link GitCredentials}. Exposed so the code that stamps a clone's helper
   * or scrubs a message can ask the same runner it runs git through whether
   * a token is in effect, rather than a second source that could disagree.
   */
  readonly credentials: GitCredentials;
  run(cwd: string, args: string[], opts: GitRunOptions & { encoding: 'buffer' }): Promise<GitRunResult<Buffer>>;
  run(cwd: string, args: string[], opts?: GitRunOptions & { encoding?: 'utf8' }): Promise<GitRunResult>;
}
