import { describe, expect, it, vi, afterEach } from 'vitest';
import { CommunicationProtocol } from '@utcp/sdk';
import '@utcp/cli';
import {
  HexisLocalVariableLoader,
  bindLocalVariableResolver,
  resetLocalVariableResolver,
} from '../local-variables.js';
import { fetchLocalOnlyManuals, fetchLocalToolVariables, type LocalManualInfo } from '../deployment.js';
import type { HexisMcpConfig } from '../config.js';

const config = { baseUrl: 'https://x.example', connectionKey: 'bevel_k' } as HexisMcpConfig;

const local = (entries: Record<string, LocalManualInfo>): Map<string, LocalManualInfo> =>
  new Map(Object.entries(entries));

/** A fetch stub that answers the variable route and counts the calls it saw. */
function stubVariables(bySlug: Record<string, { variables?: unknown; missing?: string[] }>) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(url);
      const slug = decodeURIComponent(url.split('/local-tools/')[1]?.split('/')[0] ?? '');
      const body = bySlug[slug];
      if (!body) return new Response('{}', { status: 404 });
      return new Response(JSON.stringify({ name: slug, missing: [], ...body }), { status: 200 });
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetLocalVariableResolver();
});

describe('the local runtime can run shell tools', () => {
  it('registers the cli communication protocol, unlike the platform', () => {
    // The mirror image of the platform's parse-only registration: here the
    // executor is the whole point, because this is where a shell `.tool` runs.
    expect(CommunicationProtocol.communicationProtocols.cli).toBeDefined();
  });
});

describe('fetchLocalOnlyManuals', () => {
  it('carries the slug the variable route is keyed by', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ tools: [{ slug: 'git', name: 'git', path: 'Plugins/E/git.tool' }] }), {
            status: 200,
          }),
      ),
    );
    expect(await fetchLocalOnlyManuals(config)).toEqual(local({ git: { slug: 'git', path: 'Plugins/E/git.tool' } }));
  });

  it('falls back to the name against a deployment that predates `slug`', async () => {
    // Old build, same `.tool` semantics — name and slug coincide there, so
    // falling back keeps this server working instead of resolving nothing.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ tools: [{ name: 'git', path: 'p' }] }), { status: 200 })),
    );
    expect((await fetchLocalOnlyManuals(config)).get('git')).toEqual({ slug: 'git', path: 'p' });
  });
});

describe('fetchLocalToolVariables', () => {
  it('names only the manual — never a variable', async () => {
    const calls = stubVariables({ git: { variables: { GITHUB_TOKEN: 'ghp_x' } } });
    expect(await fetchLocalToolVariables(config, 'git')).toEqual({ ok: true, values: { GITHUB_TOKEN: 'ghp_x' } });
    expect(calls).toEqual(['https://x.example/api/agent/local-tools/git/variables']);
  });

  it('degrades to no variables rather than taking the tool out of the catalog', async () => {
    // An unset variable, an older deployment without the route, a network
    // blip: the tool should still be offered and fail with its own message.
    stubVariables({});
    expect(await fetchLocalToolVariables(config, 'git')).toEqual({ ok: false, values: {} });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    expect(await fetchLocalToolVariables(config, 'git')).toEqual({ ok: false, values: {} });
  });

  it('reports a malformed response as a failure rather than as an unset secret', async () => {
    // Protocol drift and an unset secret look identical to a caller otherwise,
    // and only one of them is fixed by visiting the Secrets page.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ unexpected: true }), { status: 200 })));
    expect(await fetchLocalToolVariables(config, 'git')).toEqual({ ok: false, values: {} });
  });

  it('ignores non-string values', async () => {
    stubVariables({ git: { variables: { A: 'ok', B: 42, C: null } } });
    expect(await fetchLocalToolVariables(config, 'git')).toEqual({ ok: true, values: { A: 'ok' } });
  });
});

describe('HexisLocalVariableLoader', () => {
  /** Bind, then build a loader that reads THAT binding. */
  const bind = (
    local: Map<string, LocalManualInfo>,
    now: () => number = Date.now,
  ): HexisLocalVariableLoader => new HexisLocalVariableLoader(bindLocalVariableResolver(config, local, now));

  it('resolves a local manual variable from its namespaced key', async () => {
    stubVariables({ git: { variables: { GITHUB_TOKEN: 'ghp_x' } } });
    const loader = bind(local({ git: { slug: 'git', path: 'p' } }));
    expect(await loader.get('git_GITHUB_TOKEN')).toBe('ghp_x');
  });

  it('answers null for anything that is not a local manual', async () => {
    // A remote manual's tools execute on the deployment and resolve their
    // credentials there — this loader must never be a route to those.
    const calls = stubVariables({ git: { variables: { GITHUB_TOKEN: 'ghp_x' } } });
    const loader = bind(local({ git: { slug: 'git', path: 'p' } }));
    expect(await loader.get('hexis_SOMETHING')).toBeNull();
    expect(await loader.get('GITHUB_TOKEN')).toBeNull();
    expect(calls).toEqual([]);
  });

  it('answers null for an undeclared variable of a local manual', async () => {
    stubVariables({ git: { variables: { GITHUB_TOKEN: 'ghp_x' } } });
    const loader = bind(local({ git: { slug: 'git', path: 'p' } }));
    // Falls through to `process.env`, which is UTCP's last tier.
    expect(await loader.get('git_OTHER')).toBeNull();
  });

  it('binds a variable to exactly one manual', async () => {
    // Two manuals declaring the same bare name form different keys, so one
    // cannot harvest the other's secret — the isolation the namespace buys.
    stubVariables({
      git: { variables: { TOKEN: 'git-token' } },
      deploy: { variables: { TOKEN: 'deploy-token' } },
    });
    const loader = bind(local({ git: { slug: 'git', path: 'p' }, deploy: { slug: 'deploy', path: 'q' } }));
    expect(await loader.get('git_TOKEN')).toBe('git-token');
    expect(await loader.get('deploy_TOKEN')).toBe('deploy-token');
  });

  it('matches the longest namespace so one manual cannot shadow another', async () => {
    // UTCP doubles underscores in a namespace, so `a_b` prefixes as `a__b_`
    // while `a` prefixes as `a_`. A first-underscore split would mis-attribute.
    stubVariables({ a: { variables: { _b_KEY: 'wrong' } }, ab: { variables: { KEY: 'right' } } });
    const loader = bind(local({ a: { slug: 'a', path: 'p' }, a_b: { slug: 'ab', path: 'q' } }));
    expect(await loader.get('a__b_KEY')).toBe('right');
  });

  it('asks the deployment once per manual, not once per variable', async () => {
    let now = 0;
    const calls = stubVariables({ git: { variables: { A: '1', B: '2' } } });
    const loader = bind(local({ git: { slug: 'git', path: 'p' } }), () => now);
    // Concurrent asks during one tool call share a single request…
    expect(await Promise.all([loader.get('git_A'), loader.get('git_B')])).toEqual(['1', '2']);
    expect(calls).toHaveLength(1);
    // …and later calls are served from the cache until it ages out.
    expect(await loader.get('git_A')).toBe('1');
    expect(calls).toHaveLength(1);
    now += 6 * 60_000;
    expect(await loader.get('git_A')).toBe('1');
    expect(calls).toHaveLength(2);
  });

  it('resolves nothing at all for an unknown binding', async () => {
    const calls = stubVariables({ git: { variables: { A: '1' } } });
    expect(await new HexisLocalVariableLoader('never-bound').get('git_A')).toBeNull();
    expect(calls).toEqual([]);
  });

  it('keeps two bindings apart, so one server cannot retarget another', async () => {
    // Two servers in one process — embedded callers, and the tests that build
    // several. One process-wide binding meant the second to bind silently
    // pointed the first server's tools at the wrong deployment.
    stubVariables({ one: { variables: { TOKEN: 'from-one' } }, two: { variables: { TOKEN: 'from-two' } } });
    const first = bind(local({ git: { slug: 'one', path: 'p' } }));
    const second = bind(local({ git: { slug: 'two', path: 'p' } }));
    expect(await first.get('git_TOKEN')).toBe('from-one');
    expect(await second.get('git_TOKEN')).toBe('from-two');
  });

  it('resolves NEITHER of two manuals sharing a namespace', async () => {
    // Namespacing maps non-word characters to `_` then doubles them, so `a-b`
    // and `a_b` both give `a__b_`. Picking one would hand its vault value to
    // the other — exactly the isolation this loader exists to provide — and
    // which one would depend on map order.
    stubVariables({ dash: { variables: { KEY: 'from-dash' } }, under: { variables: { KEY: 'from-under' } } });
    const loader = bind(local({ 'a-b': { slug: 'dash', path: 'p' }, a_b: { slug: 'under', path: 'q' } }));
    expect(await loader.get('a__b_KEY')).toBeNull();
  });

  it('retries after a failed resolution instead of caching the failure', async () => {
    // A blip used to disable a tool's credentials for the whole TTL, with the
    // tool silently running without them.
    let attempt = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        attempt += 1;
        if (attempt === 1) throw new Error('offline');
        return new Response(JSON.stringify({ variables: { A: 'recovered' }, missing: [] }), { status: 200 });
      }),
    );
    const loader = bind(local({ git: { slug: 'git', path: 'p' } }), () => 0);
    expect(await loader.get('git_A')).toBeNull();
    expect(await loader.get('git_A')).toBe('recovered');
  });
});
