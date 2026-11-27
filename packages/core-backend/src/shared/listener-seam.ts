import type { ILogger } from './logger.contract.js';
import { redactSecret } from './redact-secret.js';

/**
 * A listener answers how it reached the people an event concerns — a
 * non-empty channel name, `'email'` say — or null when it did not (nothing
 * configured, nobody to tell, the send failed). It is awaited: the caller's
 * answer says who was notified, truthfully, so a listener bounds its own
 * wait. A throw is logged and counts as null; it never fails the caller. An
 * empty name is no channel and counts as null too.
 */
export type NotifyingListener<E> = (event: E) => Promise<string | null>;

/**
 * The one way core runs the notification listeners a deployment registers
 * on a seam (an account invited, a change request opened): every listener
 * in registration order, each awaited, the channels that reached somebody
 * collected in that order, a failure logged and counted as "did not" so the
 * event's own effect — the account made, the request opened — stands
 * whatever the listeners do. A seam wraps one of these per event and keeps
 * its own typed registration method, so the rule above is written once.
 *
 * A channel name is the listener's own text, and it reaches the caller's
 * answer and its log lines. One that carries a secret — the event's own
 * (`secretsOf`), or the token in effect, as {@link redactSecret} finds them —
 * is not a channel: it is counted as null and logged without its text, so
 * whatever the caller derives from the channels (an answer, an audit line)
 * cannot carry the secret either.
 */
export class ListenerSeam<E> {
  private readonly listeners: NotifyingListener<E>[] = [];

  /**
   * @param log Where a failed listener is reported.
   * @param failed The line logged for one, said in the seam's own terms
   *   ("an account-invited listener failed; the person was not notified by it:").
   * @param secretsOf The values in an event that must never reach the log
   *   (a generated starting password). A listener's error often quotes what
   *   it was sending (a mailer echoes its payload), in any encoding, so when
   *   the event has any, the failure is logged as {@link describeFailure} —
   *   its shape only (names, codes, stack frames), no text the error carries
   *   — never as the raw error.
   */
  constructor(
    private readonly log: ILogger,
    private readonly failed: string,
    private readonly secretsOf: (event: E) => readonly (string | undefined)[] = () => [],
  ) {}

  add(listener: NotifyingListener<E>): void {
    this.listeners.push(listener);
  }

  /** Run every listener in registration order; the channels that reached somebody, in that order. */
  async run(event: E): Promise<string[]> {
    const notified: string[] = [];
    for (const listener of this.listeners) {
      try {
        const channel = await listener(event);
        if (channel === null || channel === '') continue;
        if (redactSecret(channel, this.secrets(event)) !== channel) {
          this.log.warn(
            'a listener answered a channel name that carries a secret; it counts as not having reached anyone, and its answer is withheld:',
            { seam: this.failed },
          );
          continue;
        }
        notified.push(channel);
      } catch (err) {
        const secrets = this.secrets(event);
        if (secrets.length === 0) this.log.error(this.failed, { err });
        else this.log.error(this.failed, { failure: redactSecret(describeFailure(err), secrets) });
      }
    }
    return notified;
  }

  private secrets(event: E): string[] {
    return this.secretsOf(event).filter((v): v is string => !!v);
  }
}

/** How deep a chain of `cause`s is followed when a failure is described. */
const MAX_CAUSE_DEPTH = 4;

/** An error's name or code as it is logged: identifier-shaped, or not at all. */
const IDENTIFIER = /^[\w.$-]{1,64}$/;

/**
 * A thrown value as text for a log line next to a secret: for the error and
 * each `cause` under it, its name, an identifier-shaped `code` and its stack
 * FRAMES (the `at …` lines) — and no text the error carries. Not its
 * message, which a stack's first line repeats, and not its fields: a mailer
 * quotes its payload there, and as base64, hex or a Buffer the secret is no
 * longer the literal text a scrub could find. Where it failed and what kind
 * of failure it was is what stays to diagnose it by; a thrown non-Error is
 * named by its type only.
 */
function describeFailure(err: unknown): string {
  const lines: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current !== undefined && current !== null; depth++) {
    const prefix = depth === 0 ? '' : 'caused by: ';
    if (!(current instanceof Error)) {
      lines.push(`${prefix}a thrown ${typeof current}`);
      break;
    }
    const name = typeof current.name === 'string' && IDENTIFIER.test(current.name) ? current.name : 'Error';
    const code = (current as { code?: unknown }).code;
    const codeText =
      typeof code === 'number' || (typeof code === 'string' && IDENTIFIER.test(code)) ? ` [code: ${code}]` : '';
    const frames = stackFrames(current);
    lines.push(`${prefix}${name} (message withheld)${codeText}`, ...frames);
    current = current.cause;
  }
  return lines.join('\n');
}

/**
 * The `at …` lines of an error's stack, read only from after its message
 * (which the stack's head repeats, and which may itself hold lines that look
 * like frames). A stack that does not start with its message, or none at
 * all, gives no frames.
 */
function stackFrames(error: Error): string[] {
  const stack = typeof error.stack === 'string' ? error.stack : '';
  const head = error.message ? `${error.name}: ${error.message}` : error.name;
  if (!stack.startsWith(head)) return [];
  return stack
    .slice(head.length)
    .split('\n')
    .filter((line) => /^\s+at \S/.test(line));
}
