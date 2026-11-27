import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/**
 * Hands a manual this process has already read to a tool client, through the
 * `direct-call` protocol. That protocol discovers a manual by calling a
 * function registered with it under the manual's `callable_name`; the ONE
 * function this registers answers the manual carried by the registration that
 * called it ({@link carry}).
 *
 * Carried in the async context of that one registration, so concurrent
 * registrations (every manual of a surface registers at once, and so do the
 * surfaces of different people) each discover their own.
 *
 * The protocol keeps one function per name for the whole process, so each of
 * these registers under a name of its own: two graphs in one process (two
 * knowledge bases, or a test's successive ones) never answer from each
 * other's registrations. The composition root makes one per graph, and its
 * function stays registered for the life of the process.
 */
export class ManualInHand {
  /** The name the function is registered under: the `callable_name` a manual's template names. */
  readonly callableName = `hexis.manual-in-hand.${randomUUID()}`;
  private readonly carried = new AsyncLocalStorage<{ manual: unknown }>();

  constructor(
    /** Registers a function with the `direct-call` protocol (`registerCallable` of `@utcp/direct-call`). */
    register: (name: string, callable: () => unknown) => void,
  ) {
    register(this.callableName, () => {
      const carried = this.carried.getStore();
      if (!carried) throw new Error('no manual was read for this registration');
      return carried.manual;
    });
  }

  /** Runs `registration` with `manual` as what the function answers within it. */
  carry<T>(manual: unknown, registration: () => T): T {
    return this.carried.run({ manual }, registration);
  }
}
