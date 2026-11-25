import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SkillSummary } from '../../modules/skills/index.js';
import { catalogRevision, createCatalogRevisionReader, createCatalogRevisionRoutes } from '../catalog-revision.js';
import { ConnectionScope, type IAgentScopeResolver } from '../../modules/agent-scope/index.js';

/**
 * One agent configuration as a distribution would resolve it: what it loads,
 * and anything else its file says. Core does not own what a configuration is,
 * so the tests below stand one in through the agent-scope module's contract.
 */
interface AgentConfiguration {
  name?: string;
  connectors?: string[];
  skills?: string[];
  description?: string;
}

/**
 * A resolver over `agents`, by path. A path with no configuration is gone. The
 * fingerprint is the whole configuration, as a distribution's is a digest of
 * the whole file: any edit moves it. Change `agents` and the next resolve sees it.
 */
function agentScopeOver(agents: Map<string, AgentConfiguration>): Pick<IAgentScopeResolver, 'resolve'> {
  return {
    async resolve(_userEmail, agentPath) {
      if (!agentPath) return ConnectionScope.everything();
      const agent = agents.get(agentPath);
      if (!agent) return ConnectionScope.gone(agentPath);
      const fileName = agentPath.slice(agentPath.lastIndexOf('/') + 1).replace(/\.agent$/, '');
      return ConnectionScope.narrowed(
        { path: agentPath, name: agent.name ?? fileName },
        { skills: agent.skills ?? [], connectors: agent.connectors ?? [], platformTools: null },
        `agent\u0000${agentPath}\u0000${JSON.stringify(agent)}`,
      );
    },
  };
}

/**
 * The fingerprint a long-lived client polls to learn that the released catalog
 * moved under it.
 *
 * What it must get right is narrow but exact: change when the catalog changed,
 * and NOT otherwise. A digest that flaps re-registers an MCP session on every
 * connected laptop for nothing; a digest that misses a change leaves a tool
 * the author just wrote invisible until someone restarts the process — the bug
 * this exists to close.
 */

/**
 * A manual's line as `IToolManualService.catalogFingerprints` renders it:
 * identity plus a digest of the file it was parsed from. Opaque here on
 * purpose — what goes into one is the tool catalog's business, and
 * `tool-manuals.service.test.ts` is where the fields that move it are pinned.
 */
const manualLine = (name: string, source = 'src-1'): string =>
  [name, name, `Plugins/Everyone/${name}.tool`, 'http', 'remote', 'Web search.', source].join('\u0000');

const skill = (over: Partial<SkillSummary> = {}): SkillSummary => ({
  name: 'rfi',
  description: 'Answers RFIs.',
  path: 'Skills/Ops/rfi',
  ...over,
});

describe('catalogRevision', () => {
  it('is stable for the same catalog', () => {
    expect(catalogRevision([manualLine('serper')], [skill()])).toBe(
      catalogRevision([manualLine('serper')], [skill()]),
    );
  });

  it('does not change when the same set arrives in another order', () => {
    const x = skill({ name: 'x' });
    const y = skill({ name: 'y' });
    expect(catalogRevision([manualLine('a'), manualLine('b')], [x, y])).toBe(
      catalogRevision([manualLine('b'), manualLine('a')], [y, x]),
    );
  });

  it('moves when an MCP App view changes by a byte, and not when the same view is read again', () => {
    const view = { uri: 'ui://hexis/page.html', text: '<html>v1</html>' };
    const base = catalogRevision([manualLine('serper')], [skill()], [view]);
    expect(catalogRevision([manualLine('serper')], [skill()], [{ ...view }])).toBe(base);
    expect(catalogRevision([manualLine('serper')], [skill()], [{ ...view, text: '<html>v2</html>' }])).not.toBe(base);
    expect(catalogRevision([manualLine('serper')], [skill()], [])).not.toBe(base);
  });

  describe('a manual added, changed or removed', () => {
    const base = catalogRevision([manualLine('serper')], []);

    it('changes when one is added', () => {
      expect(catalogRevision([manualLine('serper'), manualLine('other')], [])).not.toBe(base);
    });

    it('changes when one is removed', () => {
      expect(catalogRevision([], [])).not.toBe(base);
    });

    /**
     * The line moved without the set changing size: a manual whose file was
     * edited in place — a new `url`, a new header, another inline tool — is a
     * different callable thing under the same name, and a client holding the
     * old one has to be told.
     */
    it('changes when a manual line moves but the set does not', () => {
      expect(catalogRevision([manualLine('serper', 'src-2')], [])).not.toBe(base);
    });
  });

  describe('a skill added, changed or removed', () => {
    const base = catalogRevision([], [skill()]);

    it('changes when one is added', () => {
      expect(catalogRevision([], [skill(), skill({ name: 'triage' })])).not.toBe(base);
    });

    it('changes when one is removed', () => {
      expect(catalogRevision([], [])).not.toBe(base);
    });

    it.each([
      ['its name', skill({ name: 'renamed' })],
      ['its folder', skill({ path: 'Plugins/Ops/rfi' })],
      ['its description', skill({ description: 'Something else.' })],
      ['its version', skill({ version: '2.0.0' })],
    ])('changes when %s changes', (_what, changed) => {
      expect(catalogRevision([], [changed])).not.toBe(base);
    });
  });

  /**
   * A manual and a skill are different things even when they read alike: one
   * of each, rendering to the same text, must not hash to the same catalog —
   * otherwise renaming a skill to a departing tool's name would look like no
   * change at all.
   */
  it('keeps the two catalogs apart', () => {
    const line = 'rfi\u0000Skills/Ops/rfi\u0000\u0000\u0000Answers RFIs.';
    expect(catalogRevision([line], [])).not.toBe(catalogRevision([], [skill()]));
  });
});

describe('GET /agent/catalog-revision', () => {
  let http: Server | null = null;

  afterEach(async () => {
    if (http) await new Promise<void>((resolve) => http!.close(() => resolve()));
    http = null;
  });

  async function mount(deps: {
    manuals: string[];
    skills: SkillSummary[];
    userId?: string | undefined;
    resolveUserEmail?: (userId: string) => Promise<string | undefined>;
    /** The served views, or a manifest read that fails. */
    mcpApps?: { manifest(): Promise<{ resources: { uri: string; text: string }[] }> };
  }): Promise<{
    url: string;
    catalogFingerprints: ReturnType<typeof vi.fn>;
    listSkills: ReturnType<typeof vi.fn>;
  }> {
    const catalogFingerprints = vi.fn(async () => deps.manuals);
    const listSkills = vi.fn(async () => deps.skills);
    const app = express();
    app.use(
      createCatalogRevisionRoutes({
        toolManuals: { catalogFingerprints } as never,
        skills: { listSkills } as never,
        manualAuth: (req, _res, next) => {
          if (deps.userId !== undefined) req.toolAuth = { userId: deps.userId } as never;
          next();
        },
        resolveUserEmail: deps.resolveUserEmail ?? (async () => 'someone@example.com'),
        ...(deps.mcpApps ? { mcpApps: deps.mcpApps } : {}),
      }),
    );
    http = app.listen(0);
    await new Promise<void>((resolve) => http!.once('listening', resolve));
    return {
      url: `http://127.0.0.1:${(http.address() as AddressInfo).port}`,
      catalogFingerprints,
      listSkills,
    };
  }

  it('the reader, called as a function, answers the fingerprint of what the two services list that caller', async () => {
    // The hosted MCP endpoint calls the reader directly, on every request. The
    // expectation is computed here from the lists, not read back off the route.
    const manuals = [manualLine('serper'), manualLine('granola')];
    const skills = [skill(), skill({ name: 'brief', path: 'Skills/Ops/brief' })];
    const view = { uri: 'ui://hexis/page.html', text: '<html>v1</html>' };
    const catalogFingerprints = vi.fn(async () => manuals);
    const listSkills = vi.fn(async () => skills);
    const resolveUserEmail = vi.fn(async () => 'someone@example.com');

    const read = createCatalogRevisionReader({
      toolManuals: { catalogFingerprints } as never,
      skills: { listSkills } as never,
      resolveUserEmail,
      mcpApps: { manifest: async () => ({ resources: [view] }) },
    });

    expect(await read({ userId: 'u1' })).toEqual({
      revision: catalogRevision(manuals, skills, [view]),
      tools: 2,
      skills: 2,
    });
    // Asked as that caller, by their email: the access filtering is the services' own.
    expect(resolveUserEmail).toHaveBeenCalledWith('u1');
    expect(catalogFingerprints).toHaveBeenCalledWith('someone@example.com');
    expect(listSkills).toHaveBeenCalledWith('someone@example.com');
    // A caller nobody can resolve is an empty catalog, never a failure, and the lists are not asked.
    catalogFingerprints.mockClear();
    expect(await read({})).toEqual({ revision: catalogRevision([], [], [view]), tools: 0, skills: 0 });
    expect(catalogFingerprints).not.toHaveBeenCalled();
  });

  it('serves the reader it is handed, asked for the caller its auth resolved', async () => {
    const read = vi.fn(async () => ({ revision: 'from-the-reader', tools: 3, skills: 4 }));
    const app = express();
    app.use(
      createCatalogRevisionRoutes({
        manualAuth: (req, _res, next) => {
          req.toolAuth = { userId: 'u1', agentPath: 'Agents/support.agent' } as never;
          next();
        },
        read,
      }),
    );
    http = app.listen(0);
    await new Promise<void>((resolve) => http!.once('listening', resolve));
    const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;

    expect(await (await fetch(`${url}/agent/catalog-revision`)).json()).toEqual({
      revision: 'from-the-reader',
      tools: 3,
      skills: 4,
    });
    expect(read).toHaveBeenCalledWith({ userId: 'u1', agentPath: 'Agents/support.agent' });
  });

  it("answers the caller's own fingerprint, with the counts behind it", async () => {
    const { url, catalogFingerprints, listSkills } = await mount({
      manuals: [manualLine('serper')],
      skills: [skill()],
      userId: 'u1',
    });
    const body = await (await fetch(`${url}/agent/catalog-revision`)).json();

    expect(body).toEqual({
      revision: catalogRevision([manualLine('serper')], [skill()]),
      tools: 1,
      skills: 1,
    });
    // Per-caller and ACL-filtered by the services themselves: the route adds
    // no second read model that could show a tool the listing hides.
    expect(catalogFingerprints).toHaveBeenCalledWith('someone@example.com');
    expect(listSkills).toHaveBeenCalledWith('someone@example.com');
  });

  it('answers an unresolvable caller the empty catalog, as both listings do', async () => {
    const { url, catalogFingerprints } = await mount({
      manuals: [manualLine('serper')],
      skills: [skill()],
      userId: undefined,
    });
    const body = await (await fetch(`${url}/agent/catalog-revision`)).json();

    expect(body).toEqual({ revision: catalogRevision([], []), tools: 0, skills: 0 });
    expect(catalogFingerprints).not.toHaveBeenCalled();
  });

  it('folds the served MCP App views into the revision, so a changed view moves it', async () => {
    const view = { uri: 'ui://hexis/page.html', text: '<html>v1</html>' };
    const { url } = await mount({
      manuals: [manualLine('serper')],
      skills: [skill()],
      userId: 'u1',
      mcpApps: { manifest: async () => ({ resources: [view] }) },
    });
    const body = (await (await fetch(`${url}/agent/catalog-revision`)).json()) as { revision: string };
    expect(body.revision).toBe(catalogRevision([manualLine('serper')], [skill()], [view]));
    expect(body.revision).not.toBe(catalogRevision([manualLine('serper')], [skill()]));
  });

  it('answers the no-views revision when the manifest cannot be read, rather than failing', async () => {
    const { url } = await mount({
      manuals: [manualLine('serper')],
      skills: [skill()],
      userId: 'u1',
      mcpApps: {
        manifest: async () => {
          throw new Error('the view file is gone');
        },
      },
    });
    const res = await fetch(`${url}/agent/catalog-revision`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { revision: string }).revision).toBe(catalogRevision([manualLine('serper')], [skill()]));
  });

  it('does not fail the request when the email lookup throws', async () => {
    const { url } = await mount({
      manuals: [manualLine('serper')],
      skills: [],
      userId: 'u1',
      resolveUserEmail: async () => {
        throw new Error('database is asleep');
      },
    });
    const res = await fetch(`${url}/agent/catalog-revision`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revision: catalogRevision([], []), tools: 0, skills: 0 });
  });
});

describe('GET /agent/catalog-revision, for a connection made as an .agent file', () => {
  let http: Server | null = null;

  afterEach(async () => {
    if (http) await new Promise<void>((resolve) => http!.close(() => resolve()));
    http = null;
  });

  const lines = [
    ['ops', 'ops', 'Plugins/Ops/ops.tool', 'http', 'remote', '', 's'].join('\u0000'),
    ['crm', 'crm', 'Plugins/Sales/crm.tool', 'http', 'remote', '', 's'].join('\u0000'),
  ];
  const paths = ['Plugins/Ops/ops.tool', 'Plugins/Sales/crm.tool'];
  const skills = [skill({ name: 'notes', path: 'Skills/Release/notes' }), skill({ name: 'pitch', path: 'Skills/Sales/pitch' })];

  async function mount(agents: Map<string, AgentConfiguration>, agentPath: string | undefined) {
    // The two services narrow by the predicate they are handed, AFTER their
    // own read gate — stood in for here by the lists above, all readable.
    const catalogFingerprints = vi.fn(async (_email: string, within?: (p: string) => boolean) =>
      lines.filter((_, i) => !within || within(paths[i]!)),
    );
    const listSkills = vi.fn(async (_email: string, opts?: { within?: (p: string) => boolean }) =>
      skills.filter((s) => !opts?.within || opts.within(s.path)),
    );
    const agentScope = agentScopeOver(agents);
    const resolve = vi.spyOn(agentScope, 'resolve');
    const app = express();
    app.use(
      createCatalogRevisionRoutes({
        toolManuals: { catalogFingerprints } as never,
        skills: { listSkills } as never,
        manualAuth: (req, _res, next) => {
          req.toolAuth = { userId: 'u1', ...(agentPath ? { agentPath } : {}) } as never;
          next();
        },
        resolveUserEmail: async () => 'ada@example.com',
        agentScope,
      }),
    );
    http = app.listen(0);
    await new Promise<void>((r) => http!.once('listening', r));
    const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/agent/catalog-revision`;
    const read = async () =>
      (await (await fetch(url)).json()) as { revision: string; tools: number; skills: number; connection?: unknown };
    return { read, catalogFingerprints, listSkills, resolve };
  }

  it('Everything is the revision it always was: nothing resolved, nothing narrowed, no `connection`', async () => {
    const { read, catalogFingerprints, listSkills, resolve } = await mount(new Map(), undefined);
    expect(await read()).toEqual({ revision: catalogRevision(lines, skills), tools: 2, skills: 2 });
    expect(catalogFingerprints).toHaveBeenCalledWith('ada@example.com');
    expect(listSkills).toHaveBeenCalledWith('ada@example.com');
    expect(resolve).not.toHaveBeenCalled();
  });

  it("is the fingerprint of what the agent loads, and names the agent", async () => {
    const agents = new Map([['Agents/ops.agent', { name: 'ops', connectors: ['Plugins/Ops'], skills: ['Skills/Release'] }]]);
    const { read } = await mount(agents, 'Agents/ops.agent');
    const body = await read();
    expect(body.tools).toBe(1);
    expect(body.skills).toBe(1);
    expect(body.connection).toEqual({ agent: { path: 'Agents/ops.agent', name: 'ops' } });
    expect(body.revision).not.toBe(catalogRevision(lines, skills));
  });

  it('moves at the next read after the .agent file is edited — no reconnect', async () => {
    const agents = new Map<string, AgentConfiguration>([['Agents/ops.agent', { connectors: ['Plugins/Ops'] }]]);
    const { read } = await mount(agents, 'Agents/ops.agent');
    const before = await read();
    expect(await read()).toEqual(before);
    agents.set('Agents/ops.agent', { connectors: ['Plugins/Ops'], skills: ['Skills/Sales'] });
    const after = await read();
    expect(after.revision).not.toBe(before.revision);
    expect(after.skills).toBe(1);
    // Even an edit that changes nothing listed moves it: the file is the configuration.
    agents.set('Agents/ops.agent', { connectors: ['Plugins/Ops'], skills: ['Skills/Sales'], description: 'now described' });
    expect((await read()).revision).not.toBe(after.revision);
  });

  it('a deleted file is an empty catalog with the reason, never Everything', async () => {
    const { read } = await mount(new Map(), 'Agents/gone.agent');
    const body = await read();
    expect(body.tools).toBe(0);
    expect(body.skills).toBe(0);
    expect((body.connection as { unavailable?: string }).unavailable).toMatch(/no longer exists or which you can no longer read/);
  });
});
