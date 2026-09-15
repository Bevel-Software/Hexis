import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import {
  GitRunError,
  redactGitToken,
  type GitRunOptions,
  type GitRunResult,
  type IGitRunner,
} from '../../../shared/git.contract.js';

const execFileAsync = promisify(execFile);

/**
 * The deadline every git call carries unless its caller says otherwise.
 *
 * Generous on purpose. The job of this number is not to make slow operations
 * fail fast — a first clone of a large knowledge base over a slow link is
 * legitimately minutes of work, and a deadline that cuts it off turns a working
 * deployment into a broken one. Its job is to put a ceiling on the case where
 * git will never return at all, so that the failure is a failure rather than a
 * workspace that has silently stopped committing. Two minutes is well past any
 * operation this codebase performs on a healthy remote, and far short of
 * forever.
 *
 * `GIT_TIMEOUT_MS` raises or lowers it for a deployment whose git host is
 * legitimately slower than that.
 */
export const DEFAULT_GIT_TIMEOUT_MS = 120_000;

/**
 * How long each stage of stopping a child is given before the next one.
 *
 * SIGTERM is a request, and git's network transports have been known to sit in
 * an uninterruptible read and ignore it.
 */
const KILL_GRACE_MS = 5_000;

/**
 * Bytes of stdout one invocation may produce before it is cut off. The
 * largest any converted site asked for: `ls-remote --heads` on a remote with
 * very many branches, and `ls-tree -r` over a large tree, both silently lose
 * lines at a smaller ceiling.
 */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/**
 * The environment every invocation runs under, laid OVER whatever the caller
 * supplied so that none of it can be unset per call. Only what is safe for
 * EVERY caller belongs here. `GIT_LITERAL_PATHSPECS` does not: it is the
 * workflow service's answer to raw user paths, and the startup runner spells
 * its literal paths with `:(literal)` magic, which that setting would disable
 * — so each of them sets its own, per call.
 *
 * `LC_ALL=C` / `LANG=C` force git's human-readable output (including stderr)
 * to stable, English, locale-independent text. Callers that classify errors by
 * message — `readFileAtRef` distinguishing a "path does not exist in <ref>"
 * absence from a hard failure — would otherwise misread a translated message
 * on a non-English host and, for the fail-closed roles.yaml preservation path,
 * fail OPEN.
 *
 * `GIT_TERMINAL_PROMPT=0` makes a credential prompt fail instead of wait. A
 * server process has no terminal for git to ask at; before the deadline
 * existed a prompt hung the call forever, and with it a prompt still burns the
 * whole deadline to learn what an immediate refusal says at once.
 */
const FIXED_ENV = {
  LC_ALL: 'C',
  LANG: 'C',
  GIT_TERMINAL_PROMPT: '0',
} as const;

/**
 * Stop a git command and everything it spawned.
 *
 * KILLING THE GIT PROCESS IS NOT ENOUGH, and this is the whole reason this
 * helper exists rather than a plain `child.kill()`. For anything touching a
 * remote, git is a launcher: it spawns `git-remote-http`, which spawns curl, or
 * a credential helper, and hands them the same stdio pipes. Node resolves an
 * `execFile` when those PIPES close, not when the process it started exits — so
 * signalling only the parent leaves the helper holding the pipes open and the
 * `await` waiting exactly as long as it would have anyway. Measured: a
 * one-second deadline on an `ls-remote` to an unroutable address returned after
 * twenty-one seconds, which is the helper's own connect timeout and not ours.
 *
 * So the signal goes to the whole tree. On POSIX that is the process group,
 * which `detached: true` below makes this child the leader of — hence the
 * negative pid. On Windows there are no process groups to signal and no
 * SIGTERM a transport helper would honour, so `taskkill /T` walks the tree and
 * `/F` ends it.
 */
function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return;

  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    // taskkill failing is not actionable here — the child is either already
    // gone (the common case, and taskkill says so with a non-zero exit) or
    // unkillable, and the abandonment backstop covers the second.
    killer.on('error', () => undefined);
    return;
  }

  try {
    process.kill(-pid, signal);
  } catch {
    // The group is already gone, or it vanished between the liveness check
    // above and the signal. Either way there is nothing left to stop.
  }
}

/**
 * The one place this application spawns a git command and waits for its result.
 *
 * See `shared/git.contract.ts` for what this port is and is not responsible
 * for. In short: it runs what it is told, where it is told, under a deadline —
 * and it does not decide whether running it there was safe, which is the
 * `WorkspaceMutex`'s job and stays the caller's to have done.
 */
export class NodeGitRunner implements IGitRunner {
  constructor(private readonly defaultTimeoutMs: number = DEFAULT_GIT_TIMEOUT_MS) {}

  run(cwd: string, args: string[], opts: GitRunOptions & { encoding: 'buffer' }): Promise<GitRunResult<Buffer>>;
  run(cwd: string, args: string[], opts?: GitRunOptions & { encoding?: 'utf8' }): Promise<GitRunResult>;
  async run(cwd: string, args: string[], opts: GitRunOptions = {}): Promise<GitRunResult<string | Buffer>> {
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
    const timers: NodeJS.Timeout[] = [];
    let timedOut = false;

    try {
      const spawnOptions = {
        cwd,
        env: { ...process.env, ...opts.env, ...FIXED_ENV },
        maxBuffer: MAX_OUTPUT_BYTES,
        // Makes the child a process-group leader so that `killTree` can signal
        // the transport helpers it spawns, not just git itself. Not on Windows,
        // where `detached` means "new console window" rather than "new process
        // group", and where `taskkill /T` walks the tree without it.
        detached: process.platform !== 'win32',
      };
      // Two calls rather than one with a computed encoding: `execFile`'s
      // overloads are keyed on the encoding literal, and a union satisfies
      // neither.
      const pending =
        opts.encoding === 'buffer'
          ? execFileAsync('git', args, { ...spawnOptions, encoding: 'buffer' })
          : execFileAsync('git', args, { ...spawnOptions, encoding: 'utf8' });

      // `promisify(execFile)` carries the child on the promise through
      // `execFile[promisify.custom]`. A double standing in for `execFile` (the
      // access resolver's cache suite injects failures that way) returns a
      // plain promise with no child on it; there is then nothing to feed, and
      // nothing to kill, and neither is an error.
      const child: ChildProcess | undefined = pending.child;

      // Abandonment, as a promise that loses every race it is not needed for.
      // It is the backstop for a tree that outlived even a forced kill: at that
      // point the child is not ours to wait for, and continuing to wait is the
      // hang this class exists to prevent.
      let abandon: (reason: Error) => void = () => undefined;
      const abandoned = new Promise<never>((_, reject) => {
        abandon = reject;
      });

      // The deadline is kept here rather than handed to `execFile`'s own
      // `timeout` option, which signals only the immediate child once and then
      // goes on waiting for pipes that a surviving helper still holds.
      timers.push(
        setTimeout(() => {
          timedOut = true;
          if (child) killTree(child, 'SIGTERM');
          timers.push(
            setTimeout(() => {
              if (child) killTree(child, 'SIGKILL');
              timers.push(setTimeout(() => abandon(new Error('child outlived SIGKILL')), KILL_GRACE_MS));
            }, KILL_GRACE_MS),
          );
        }, timeoutMs),
      );

      if (opts.input !== undefined && child?.stdin) {
        // A dying git can close stdin mid-write; the promise still rejects with
        // the exit code, which is the error worth surfacing.
        child.stdin.on('error', () => undefined);
        child.stdin.write(opts.input);
        child.stdin.end();
      }

      const { stdout, stderr } = await Promise.race([pending, abandoned]);
      return {
        stdout: opts.encoding === 'buffer' ? Buffer.from(stdout) : stdout.toString(),
        stderr: stderr.toString(),
      };
    } catch (err) {
      const subcommand = subcommandOf(args);

      if (timedOut) {
        throw new GitRunError(
          `git ${subcommand} timed out after ${timeoutMs}ms and was killed. ` +
            'The remote or the local repository stopped responding.',
          { timedOut: true, cause: err },
        );
      }

      const original = err as { code?: unknown; stderr?: unknown };
      const message = err instanceof Error ? err.message : String(err);
      const stderr =
        typeof original.stderr === 'string'
          ? original.stderr
          : Buffer.isBuffer(original.stderr)
            ? original.stderr.toString()
            : undefined;
      throw new GitRunError(`git ${subcommand} failed: ${redactGitToken(message)}`, {
        exitCode: typeof original.code === 'number' ? original.code : undefined,
        stderr: stderr === undefined ? undefined : redactGitToken(stderr),
        cause: err,
      });
    } finally {
      // Every timer is cleared on every path. The later ones in particular
      // would otherwise hold the event loop open for their full grace period
      // after a call that has already returned.
      for (const timer of timers) clearTimeout(timer);
    }
  }
}

/**
 * Name the git subcommand that failed, skipping any leading `-c key=value`
 * pairs so the message reads `git fetch failed` rather than `git -c failed`.
 */
function subcommandOf(args: string[]): string {
  let i = 0;
  while (i < args.length && args[i] === '-c') i += 2;
  return args[i] ?? args[0] ?? 'git';
}
