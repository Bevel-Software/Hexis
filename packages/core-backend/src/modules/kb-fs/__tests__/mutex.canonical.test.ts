import { describe, it, expect } from 'vitest';
import { WorkspaceIdMutex, WorkspaceMutex } from '../mutex.js';

/**
 * `WorkspaceIdMutex`: a workspace id in either spelling — a route's decoded
 * `alice/feature`, a tool's `alice%2Ffeature` — takes the one key.
 */
describe('WorkspaceIdMutex', () => {
  /** A task that signals when it starts and ends only when released. */
  const held = () => {
    let release: () => void = () => {};
    let started: () => void = () => {};
    const begun = new Promise<void>((r) => { started = r; });
    const task = () =>
      new Promise<void>((resolve) => {
        release = resolve;
        started();
      });
    return { task, begun, release: () => release() };
  };
  const settled = () => new Promise<void>((r) => setImmediate(r));

  it('queues the decoded and the encoded spelling of one workspace on the same key', async () => {
    const mutex = new WorkspaceIdMutex();
    const first = held();
    const order: string[] = [];
    const a = mutex.run('alice/feature', first.task).then(() => { order.push('decoded'); });
    await first.begun;
    const b = mutex.run('alice%2Ffeature', async () => { order.push('encoded'); });
    await settled();
    // The encoded spelling waits on the decoded one's reservation: nothing
    // has run until the first is released; then both do.
    expect(order).toEqual([]);
    first.release();
    await Promise.all([a, b]);
    expect([...order].sort()).toEqual(['decoded', 'encoded']);
  });

  it('is what the plain mutex is not: two spellings, two keys, no wait', async () => {
    const mutex = new WorkspaceMutex();
    const first = held();
    const order: string[] = [];
    const a = mutex.run('alice/feature', first.task).then(() => { order.push('decoded'); });
    await first.begun;
    await mutex.run('alice%2Ffeature', async () => { order.push('encoded'); });
    expect(order).toEqual(['encoded']);
    first.release();
    await a;
  });

  it('leaves a protected branch (no slash, one spelling) and a malformed id as they are', async () => {
    const mutex = new WorkspaceIdMutex();
    const seen: string[] = [];
    await mutex.runAll(['main', 'bad%'], async () => { seen.push('ran'); });
    expect(seen).toEqual(['ran']);
  });
});
