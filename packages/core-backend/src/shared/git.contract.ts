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
 * Strip the configured git token out of text on its way into an error, a log
 * line or a response.
 *
 * git puts the remote URL into a great many of its messages, and on a
 * token-authenticated remote that URL carries the credential. Without this, a
 * push failure writes the deployment's token into the container log, the API
 * response, and any change request the recovery agent opens about it.
 *
 * Read from the environment at call time rather than captured: the setup screen
 * can supply a token after boot, and `DeploymentSettingsService.syncGitTokenEnv`
 * puts it here — a value captured at module load would be the empty string for
 * exactly the deployments that configure their token that way.
 */
export function redactGitToken(text: string): string {
  const token = process.env.GITHUB_TOKEN;
  return token ? text.replaceAll(token, '***') : text;
}

/** What a completed git invocation produced. Both streams are decoded text. */
export interface GitRunResult {
  stdout: string;
  stderr: string;
}

export interface GitRunOptions {
  /**
   * Bytes to feed the subprocess on stdin — used by the
   * `--pathspec-from-file=-` commit/add paths so that a several-hundred-file
   * batch never has to ride the argv (Windows caps a command line at ~32K
   * characters).
   */
  input?: string;
  /**
   * Override the runner's default deadline for this one call. For an operation
   * whose legitimate duration is unlike the rest — a first clone of a large
   * repository, say — rather than raising the deployment-wide default to
   * accommodate it.
   */
  timeoutMs?: number;
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

  constructor(
    message: string,
    opts: { exitCode?: number; stderr?: string; timedOut?: boolean; cause?: unknown } = {},
  ) {
    super(message, { cause: opts.cause });
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
  run(cwd: string, args: string[], opts?: GitRunOptions): Promise<GitRunResult>;
}
