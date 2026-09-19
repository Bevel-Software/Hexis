import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SkillSummary } from '../../modules/skills/skills.contract.js';
import type { ToolManualSummary } from '../../modules/tool-manuals/tool-manuals.contract.js';
import { catalogRevision, createCatalogRevisionRoutes } from '../catalog-revision.js';

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

const manual = (over: Partial<ToolManualSummary> = {}): ToolManualSummary => ({
  slug: 'serper',
  name: 'serper',
  path: 'Plugins/Everyone/software.bevel.hexis/tools/serper.tool',
  type: 'http',
  description: 'Web search.',
  ...over,
});

const skill = (over: Partial<SkillSummary> = {}): SkillSummary => ({
  name: 'rfi',
  description: 'Answers RFIs.',
  path: 'Skills/Ops/rfi',
  ...over,
});

describe('catalogRevision', () => {
  it('is stable for the same catalog', () => {
    expect(catalogRevision([manual()], [skill()])).toBe(catalogRevision([manual()], [skill()]));
  });

  it('does not change when the same set arrives in another order', () => {
    const a = manual({ slug: 'a', name: 'a' });
    const b = manual({ slug: 'b', name: 'b' });
    const x = skill({ name: 'x' });
    const y = skill({ name: 'y' });
    expect(catalogRevision([a, b], [x, y])).toBe(catalogRevision([b, a], [y, x]));
  });

  describe('a manual added, changed or removed', () => {
    const base = catalogRevision([manual()], []);

    it('changes when one is added', () => {
      expect(catalogRevision([manual(), manual({ slug: 'other', name: 'other' })], [])).not.toBe(base);
    });

    it('changes when one is removed', () => {
      expect(catalogRevision([], [])).not.toBe(base);
    });

    it.each([
      ['its name', manual({ name: 'renamed' })],
      ['its declaring file', manual({ path: 'Plugins/Finance/software.bevel.hexis/tools/serper.tool' })],
      ['its type', manual({ type: 'mcp' })],
      ['its description', manual({ description: 'Something else.' })],
      // `remote: false` moves a tool from `list_tools` to `list_local_tools` —
      // the same visible change as an add and a remove at once.
      ['whether it is local-only', manual({ remote: false })],
    ])('changes when %s changes', (_what, changed) => {
      expect(catalogRevision([changed], [])).not.toBe(base);
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
      ['its lifecycle', skill({ lifecycle: 'deprecated' })],
    ])('changes when %s changes', (_what, changed) => {
      expect(catalogRevision([], [changed])).not.toBe(base);
    });
  });

  /**
   * `setup` and `variables` carry MCP OAuth auto-discovery results, which are
   * re-probed on every cold scan and can differ between two scans of a file
   * nobody touched. Hashing them would report a catalog change that no commit
   * made — and every connected client would re-register for it.
   */
  it('ignores the OAuth auto-discovery decoration, which no commit made', () => {
    const plain = manual({ type: 'mcp' });
    const probed = manual({
      type: 'mcp',
      setup: { kind: 'oauth-manual', reason: 'sign-in endpoint discovery failed: ECONNRESET' },
      variables: [{ name: 'MCP_OAUTH', scope: 'user' }],
    });
    expect(catalogRevision([probed], [])).toBe(catalogRevision([plain], []));
  });

  /** A manual and a skill are different things even when they read alike. */
  it('keeps the two catalogs apart', () => {
    const named = (n: string) => manual({ slug: n, name: n, path: n, type: 'http', description: '' });
    expect(catalogRevision([named('a'), named('b')], [])).not.toBe(catalogRevision([named('a')], []));
  });
});

describe('GET /agent/catalog-revision', () => {
  let http: Server | null = null;

  afterEach(async () => {
    if (http) await new Promise<void>((resolve) => http!.close(() => resolve()));
    http = null;
  });

  async function mount(deps: {
    manuals: ToolManualSummary[];
    skills: SkillSummary[];
    userId?: string | undefined;
    resolveUserEmail?: (userId: string) => Promise<string | undefined>;
  }): Promise<{ url: string; listAccessible: ReturnType<typeof vi.fn>; listSkills: ReturnType<typeof vi.fn> }> {
    const listAccessible = vi.fn(async () => deps.manuals);
    const listSkills = vi.fn(async () => deps.skills);
    const app = express();
    app.use(
      createCatalogRevisionRoutes({
        toolManuals: { listAccessible } as never,
        skills: { listSkills } as never,
        manualAuth: (req, _res, next) => {
          if (deps.userId !== undefined) req.toolAuth = { userId: deps.userId } as never;
          next();
        },
        resolveUserEmail: deps.resolveUserEmail ?? (async () => 'someone@example.com'),
      }),
    );
    http = app.listen(0);
    await new Promise<void>((resolve) => http!.once('listening', resolve));
    return { url: `http://127.0.0.1:${(http.address() as AddressInfo).port}`, listAccessible, listSkills };
  }

  it("answers the caller's own fingerprint, with the counts behind it", async () => {
    const { url, listAccessible, listSkills } = await mount({
      manuals: [manual()],
      skills: [skill()],
      userId: 'u1',
    });
    const body = await (await fetch(`${url}/agent/catalog-revision`)).json();

    expect(body).toEqual({ revision: catalogRevision([manual()], [skill()]), tools: 1, skills: 1 });
    // Per-caller and ACL-filtered by the services themselves: the route adds
    // no second read model that could show a tool the listing hides.
    expect(listAccessible).toHaveBeenCalledWith('someone@example.com');
    expect(listSkills).toHaveBeenCalledWith('someone@example.com');
  });

  it('answers an unresolvable caller the empty catalog, as both listings do', async () => {
    const { url, listAccessible } = await mount({ manuals: [manual()], skills: [skill()], userId: undefined });
    const body = await (await fetch(`${url}/agent/catalog-revision`)).json();

    expect(body).toEqual({ revision: catalogRevision([], []), tools: 0, skills: 0 });
    expect(listAccessible).not.toHaveBeenCalled();
  });

  it('does not fail the request when the email lookup throws', async () => {
    const { url } = await mount({
      manuals: [manual()],
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
