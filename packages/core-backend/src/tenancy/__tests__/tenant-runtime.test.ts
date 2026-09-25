import { describe, it, expect } from 'vitest';
import type { TenantConfig } from '../../core-config.js';
import { TenantRuntime, type TenantGraph } from '../tenant-runtime.js';
import type { TenantDescriptor } from '../tenant-source.contract.js';

const descriptor: TenantDescriptor = { slug: 'acme', hosts: ['acme.test'], config: {} as TenantConfig };

/** A graph builder whose completion the test controls. */
function harness(opts: { fail?: boolean | (() => boolean); now?: () => number; retry?: { initialMs: number; maxMs: number } } = {}) {
  const events: string[] = [];
  let release: (() => void) | null = null;
  let activations = 0;
  const runtime = new TenantRuntime(descriptor, {
    activate: async () => {
      activations += 1;
      events.push(`activate:${activations}`);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      if (typeof opts.fail === 'function' ? opts.fail() : opts.fail) throw new Error('the remote said no');
      return { core: { id: activations } } as unknown as TenantGraph;
    },
    stop: async (graph) => {
      events.push(`stop:${(graph.core as unknown as { id: number }).id}`);
    },
    busy: async () => false,
    now: opts.now,
    retry: opts.retry,
  });
  return { runtime, events, finish: () => release?.(), activations: () => activations };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('TenantRuntime', () => {
  it('builds the graph once for a burst of first requests, and hands every one the same graph', async () => {
    const h = harness();
    expect(h.runtime.state).toBe('idle');
    const first = h.runtime.handle();
    const second = h.runtime.handle();
    const third = h.runtime.handle();
    await settle();
    expect(h.runtime.state).toBe('activating');
    h.finish();
    const graphs = await Promise.all([first, second, third]);
    expect(h.activations()).toBe(1);
    expect(graphs[1]).toBe(graphs[0]);
    expect(graphs[2]).toBe(graphs[0]);
    expect(h.runtime.state).toBe('active');
    // Once active, a request is answered from the running graph.
    expect(await h.runtime.handle()).toBe(graphs[0]);
    expect(h.activations()).toBe(1);
  });

  it('remembers a failed activation for a growing window, and tries again once it has passed', async () => {
    let now = 0;
    const h = harness({ fail: true, now: () => now, retry: { initialMs: 100, maxMs: 300 } });
    const first = h.runtime.handle();
    await settle();
    h.finish();
    await expect(first).rejects.toThrow('the remote said no');
    expect(h.runtime.state).toBe('idle');

    // Inside the window: the same failure, from memory, without a build.
    now = 99;
    await expect(h.runtime.handle()).rejects.toThrow('the remote said no');
    expect(h.activations()).toBe(1);

    // Past it: tried again; a second failure doubles the window.
    now = 100;
    const second = h.runtime.handle();
    await settle();
    expect(h.activations()).toBe(2);
    h.finish();
    await expect(second).rejects.toThrow();
    now = 299;
    await expect(h.runtime.handle()).rejects.toThrow();
    expect(h.activations()).toBe(2);

    // The window is capped: 100, 200, then 300 and no more.
    now = 300;
    const third = h.runtime.handle();
    await settle();
    h.finish();
    await expect(third).rejects.toThrow();
    now = 599;
    await expect(h.runtime.handle()).rejects.toThrow();
    now = 600;
    const fourth = h.runtime.handle();
    await settle();
    expect(h.activations()).toBe(4);
    h.finish();
    await expect(fourth).rejects.toThrow();
    now = 899;
    await expect(h.runtime.handle()).rejects.toThrow();
    expect(h.activations()).toBe(4);
  });

  it('forgets the failures once an activation succeeds', async () => {
    let now = 0;
    let fail = true;
    const h = harness({ fail: () => fail, now: () => now, retry: { initialMs: 100, maxMs: 300 } });
    const first = h.runtime.handle();
    await settle();
    h.finish();
    await expect(first).rejects.toThrow();
    fail = false;
    now = 100;
    const ok = h.runtime.handle();
    await settle();
    h.finish();
    await ok;
    expect(h.runtime.state).toBe('active');
    // A later failure, after an eviction, starts the window from the beginning.
    await h.runtime.evict();
    fail = true;
    const again = h.runtime.handle();
    await settle();
    h.finish();
    await expect(again).rejects.toThrow();
    now = 199;
    await expect(h.runtime.handle()).rejects.toThrow();
    now = 200;
    const retried = h.runtime.handle();
    await settle();
    expect(h.activations()).toBe(4);
    h.finish();
    await expect(retried).rejects.toThrow();
  });

  it('evicts a running graph, and builds a fresh one on the next request', async () => {
    const h = harness();
    const pending = h.runtime.handle();
    await settle();
    h.finish();
    await pending;
    await h.runtime.evict();
    expect(h.events).toEqual(['activate:1', 'stop:1']);
    expect(h.runtime.state).toBe('idle');
    const next = h.runtime.handle();
    await settle();
    h.finish();
    await next;
    expect(h.events).toEqual(['activate:1', 'stop:1', 'activate:2']);
  });

  it('an eviction that lands during an activation waits for it and stops what it built', async () => {
    const h = harness();
    const pending = h.runtime.handle();
    await settle();
    const evicting = h.runtime.evict();
    expect(h.runtime.state).toBe('evicting');
    h.finish();
    await pending;
    await evicting;
    expect(h.events).toEqual(['activate:1', 'stop:1']);
    expect(h.runtime.state).toBe('idle');
  });

  it('a second eviction joins the one under way, and evicting an idle runtime stops nothing', async () => {
    const h = harness();
    await h.runtime.evict();
    expect(h.events).toEqual([]);
    const pending = h.runtime.handle();
    await settle();
    h.finish();
    await pending;
    const a = h.runtime.evict();
    const b = h.runtime.evict();
    await Promise.all([a, b]);
    expect(h.events).toEqual(['activate:1', 'stop:1']);
  });

  it('measures idleness from the last request, and reports busy only for a running graph', async () => {
    let now = 1_000;
    let busy = false;
    const runtime = new TenantRuntime(descriptor, {
      activate: async () => ({ core: {} } as unknown as TenantGraph),
      stop: async () => undefined,
      busy: async () => busy,
      now: () => now,
    });
    expect(await runtime.busy()).toBe(false);
    await runtime.handle();
    now += 5_000;
    expect(runtime.idleFor()).toBe(5_000);
    await runtime.handle();
    expect(runtime.idleFor()).toBe(0);
    busy = true;
    expect(await runtime.busy()).toBe(true);
  });

  it('is busy while any response is open, and counts idleness from the last one that closed', async () => {
    let now = 1_000;
    const runtime = new TenantRuntime(descriptor, {
      activate: async () => ({ core: {} } as unknown as TenantGraph),
      stop: async () => undefined,
      busy: async () => false,
      now: () => now,
    });
    await runtime.handle();
    // An event stream a browser holds: entered long ago, never left.
    runtime.enter();
    runtime.enter();
    now += 3_600_000;
    expect(runtime.idleFor()).toBe(3_600_000);
    expect(await runtime.busy()).toBe(true);
    expect(runtime.open).toBe(2);
    runtime.leave();
    expect(await runtime.busy()).toBe(true);
    // The last response closing is what idleness counts from.
    now += 10;
    runtime.leave();
    expect(runtime.open).toBe(0);
    expect(runtime.idleFor()).toBe(0);
    expect(await runtime.busy()).toBe(false);
    // A stray leave cannot make the count negative.
    runtime.leave();
    expect(runtime.open).toBe(0);
  });
});
