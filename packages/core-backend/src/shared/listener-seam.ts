import { inspect } from 'node:util';
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
 */
export class ListenerSeam<E> {
  private readonly listeners: NotifyingListener<E>[] = [];

  /**
   * @param log Where a failed listener is reported.
   * @param failed The line logged for one, said in the seam's own terms
   *   ("an account-invited listener failed; the person was not notified by it:").
   * @param secretsOf The values in an event that must never reach the log
   *   (a generated starting password). A listener's error often quotes what
   *   it was sending (a mailer echoes its payload), so when the event has
   *   any, the failure is logged as its inspected text with each of them
   *   scrubbed, never as the raw error.
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
        if (channel !== null && channel !== '') notified.push(channel);
      } catch (err) {
        const secrets = this.secretsOf(event).filter((v): v is string => !!v);
        if (secrets.length === 0) this.log.error(this.failed, { err });
        else this.log.error(this.failed, { failure: redactSecret(inspect(err, { depth: 4 }), secrets) });
      }
    }
    return notified;
  }
}
