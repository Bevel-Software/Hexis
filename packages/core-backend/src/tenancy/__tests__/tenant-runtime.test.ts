import { describe, it, expect } from 'vitest';
import type { TenantConfig } from '../../core-config.js';
import { TenantRuntime, type TenantGraph } from '../tenant-runtime.js';
import type { TenantDescriptor } from '../tenant-source.contract.js';

const descriptor: TenantDescriptor = { slug: 'acme', hosts: ['acme.test'], config: {} as TenantConfig };

/** A graph builder whose completion the test controls. */
function harness(opts: { fail?: boolean } = {}) {
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
      if (opts.fail) throw new Error('the remote said no');
      return { core: { id: activations } } as unknown as TenantGraph;
    },
    stop: async (graph) => {
      events.push(`stop:${(graph.core as unknown as { id: number }).id}`);
    },
    busy: async () => false,
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

  it('forgets a failed activation so the next request tries again', async () => {
    const h = harness({ fail: true });
    const first = h.runtime.handle();
    await settle();
    h.finish();
    await expect(first).rejects.toThrow('the remote said no');
    expect(h.runtime.state).toBe('idle');
    const second = h.runtime.handle();
    await settle();
    expect(h.activations()).toBe(2);
    h.finish();
    await expect(second).rejects.toThrow();
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
});
