import type { ILogger } from './logger.contract.js';

/** A listener told of something after the fact: it may answer a promise, which nobody awaits. */
export type FireAndForgetListener<E> = (event: E) => void | Promise<void>;

/**
 * Call a fire-and-forget listener so that nothing it does reaches the caller:
 * a throw is caught, a returned promise's rejection is caught, and either is
 * logged as `failed`. The caller's own effect — the commit that landed, the
 * change that was announced — stands whatever the listener does. The one way
 * core dispatches such listeners (the commit-landed hooks, the file-change
 * notifier), so the rule is written once; the awaited, channel-answering kind
 * is `ListenerSeam`.
 */
export function callFireAndForget<E>(listener: FireAndForgetListener<E>, event: E, log: ILogger, failed: string): void {
  try {
    const answer: unknown = listener(event);
    if (isPromiseLike(answer)) answer.then(undefined, (err: unknown) => log.error(failed, { err }));
  } catch (err) {
    log.error(failed, { err });
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as PromiseLike<unknown>).then === 'function';
}
