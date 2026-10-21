import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SkillSummary } from '../../modules/skills/skills.contract.js';
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
