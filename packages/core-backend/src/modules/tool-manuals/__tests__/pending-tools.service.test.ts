import { describe, test, expect } from 'vitest';
import { DEFAULT_BRANCH, type ChangeRequest, type IWorkflowService } from '@bevel-software/platform-shared';
import { PendingToolsService } from '../pending-tools.service.js';
import { hashEmail } from '../../../shared/email-identity.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import type { IAccessControl } from '../../access/access-control.interface.js';
import type { IToolManualService, ToolManualSummary } from '../tool-manuals.contract.js';

/**
 * The half of the tool catalog that is NOT on the default branch.
 *
 * The bug this exists for, told by the tester: they asked the agent for a tool,
 * a change request opened, and the tools UI showed nothing at all until
 * somebody approved it. So the tests below are mostly about WHO GETS TO SEE
 * ONE, because "show it" and "show it to the wrong people" are the two ways to
 * get this wrong — and about WHEN IT GOES AWAY, because a card that outlives
 * its request is a card pointing at a decision already taken.
 */

const AUTHOR = 'ali@bevel.software';
const ADMIN = 'olga@bevel.software';
const BYSTANDER = 'sam@bevel.software';

const TOOL_PATH = 'Plugins/Ops/weather.tool';
const MCP_PATH = 'Plugins/Ops/mcp.json';

const WEATHER_TOOL = `---
id: weather
type: http
description: Forecasts for a place.
url: https://weather.example/utcp
---

# Weather
`;

const MCP_JSON = JSON.stringify({
  mcpServers: {
    tickets: { type: 'streamable-http', url: 'https://tickets.example/mcp' },
  },
});

function cr(over: Partial<ChangeRequest> = {}): ChangeRequest {
  return {
    number: 7,
    title: 'Add the weather tool',
    authorId: hashEmail(AUTHOR),
    author: { login: 'user-abc', name: 'service' },
    appAuthor: { name: 'Ali Raza' },
    branch: 'agent/weather',
    base: DEFAULT_BRANCH,
    state: 'open',
    createdAt: '2026-09-06T09:00:00.000Z',
    touchedNodePaths: [TOOL_PATH],
    review: { approvals: 0, changesRequested: 0, pendingLogins: [] },
    url: '/change-requests/7',
    ...over,
  };
}

function harness(opts: {
  crs: ChangeRequest[];
  released?: Partial<ToolManualSummary>[];
  /** Files present on a change request's branch, keyed `<branch>:<path>`. */
  branchFiles?: Record<string, string>;
  /** Emails allowed to write each path. Absent path ⇒ nobody. */
  writers?: Record<string, string[]>;
  /** The access tree cannot be read at all — `canWriteBatch` REJECTS. */
  accessThrows?: boolean;
}) {
  const branchFiles = opts.branchFiles ?? { [`agent/weather:${TOOL_PATH}`]: WEATHER_TOOL };
  const workspaceService = {
    ensureRemotesFetched: async () => undefined,
    readFileAtRef: async (_ws: string, ref: string, rel: string) =>
      branchFiles[`${ref.replace(/^origin\//, '')}:${rel}`] ?? null,
  } as unknown as WorkspaceService;

  const accessControl = {
    canWriteBatch: async (_ws: string, email: string, paths: string[]) => {
      // A tree that cannot be read REJECTS — it does not answer `false` for
      // every path. The two are different code paths in the caller and only
      // this one reaches its `.catch`.
      if (opts.accessThrows) throw new Error('access.md is unreadable');
      return new Map(paths.map((p) => [p, (opts.writers?.[p] ?? []).includes(email)]));
    },
  } as unknown as IAccessControl;

  const toolManuals = {
    listAllSummaries: async () => (opts.released ?? []) as ToolManualSummary[],
  } as unknown as IToolManualService;

  const workflow = {
    listChangeRequests: async () => opts.crs,
  } as unknown as IWorkflowService;

  return new PendingToolsService(workspaceService, accessControl, toolManuals, workflow);
}

const ADMIN_WRITES = { [TOOL_PATH]: [ADMIN] };

describe('PendingToolsService', () => {
  test('surfaces a `.tool` that exists only on a change request, to its author', async () => {
    const pending = await harness({ crs: [cr()], writers: ADMIN_WRITES }).listPendingTools(AUTHOR);

    expect(pending).toEqual([
      {
        slug: 'weather',
        name: 'weather',
        path: TOOL_PATH,
        type: 'http',
        description: 'Forecasts for a place.',
        plugin: 'Ops',
        changeRequestNumber: 7,
        branch: 'agent/weather',
        authorName: 'Ali Raza',
        createdAt: '2026-09-06T09:00:00.000Z',
        isAuthor: true,
      },
    ]);
  });

  test('surfaces it to whoever could approve it, marked as not theirs', async () => {
    const pending = await harness({ crs: [cr()], writers: ADMIN_WRITES }).listPendingTools(ADMIN);
    expect(pending.map((p) => [p.name, p.isAuthor])).toEqual([['weather', false]]);
  });

  /**
   * The decision that shapes this surface: a proposal is between its author and
   * the people who can approve it, and nobody else. Somebody who cannot see the
   * change request sees no card — not a card without a link, no card.
   */
  test('hides it from everyone else', async () => {
    expect(await harness({ crs: [cr()], writers: ADMIN_WRITES }).listPendingTools(BYSTANDER))
      .toEqual([]);
  });

  /**
   * Fail closed like the catalog: an access lookup that cannot answer is a
   * denial, never a disclosure. Without this a broken access tree would show
   * every open proposal to everyone.
   */
  test('shows nothing to a non-author when the access tree cannot be read', async () => {
    const broken = harness({ crs: [cr()], accessThrows: true });
    expect(await broken.listPendingTools(ADMIN)).toEqual([]);
    // …and the author still sees their own, because that verdict needs no tree.
    expect(await broken.listPendingTools(AUTHOR)).toHaveLength(1);
  });

  /** The ordinary denial, which is a verdict rather than a failure. */
  test('shows nothing to a non-author the tree names as no writer', async () => {
    const svc = harness({ crs: [cr()], writers: {} });
    expect(await svc.listPendingTools(ADMIN)).toEqual([]);
  });

  /**
   * After the request MERGES the tool is in the catalog, and the card must be
   * replaced by the real one rather than doubled beside it. The catalog is the
   * witness for that: a declaration whose UTCP name the default branch already
   * serves is not a pending tool, whatever the request's own state says.
   */
  test('drops a proposal once its tool is in the released catalog', async () => {
    const svc = harness({
      crs: [cr()],
      released: [{ slug: 'weather', name: 'weather', path: TOOL_PATH, type: 'http' }],
      writers: ADMIN_WRITES,
    });
    expect(await svc.listPendingTools(AUTHOR)).toEqual([]);
  });

  /**
   * The catalog is the DEFAULT BRANCH, and everything this surface says is said
   * in terms of it — what counts as already released, and whose access tree
   * decides the review. A request aimed somewhere else could merge in full and
   * still put no tool in the catalog, so its card would never resolve.
   */
  test('ignores a change request aimed at a branch other than the default', async () => {
    const svc = harness({ crs: [cr({ base: 'some-other-branch' })], writers: ADMIN_WRITES });
    expect(await svc.listPendingTools(AUTHOR)).toEqual([]);
  });

  /**
   * The catalog dedups by the UTCP NAMESPACE, not by the raw name: an mcp.json
   * server key may carry a `-`, and `a-b` namespaces to the same `a__b_` a
   * `.tool` id `a_b` does. Compared by name, a request re-declaring a
   * released tool under the other spelling would get a ghost card beside the
   * live one — for a namespace the catalog would refuse to serve twice.
   */
  test('drops a proposal whose UTCP namespace the catalog already serves', async () => {
    const svc = harness({
      crs: [cr({ number: 11, branch: 'agent/tickets', touchedNodePaths: [MCP_PATH] })],
      branchFiles: {
        [`agent/tickets:${MCP_PATH}`]: JSON.stringify({
          mcpServers: { 'on-call': { type: 'streamable-http', url: 'https://oc.example/mcp' } },
        }),
      },
      released: [{ slug: 'on_call', name: 'on_call', path: 'Plugins/Ops/oncall.tool', type: 'http' }],
      writers: { [MCP_PATH]: [ADMIN] },
    });
    expect(await svc.listPendingTools(ADMIN)).toEqual([]);
  });

  /**
   * The slug is the ROUTE the tool will be served at once released, and the
   * catalog serves the resolved manual name — not the filename, which is only
   * the parser's fallback. A card keyed to the filename would not line up with
   * the tool that replaces it, and a filename like `My Weather.tool` is not
   * route-safe to begin with.
   */
  test('slugs a proposal by its resolved manual name, not its file name', async () => {
    const ODD = 'Plugins/Ops/My Weather.tool';
    const svc = harness({
      crs: [cr({ touchedNodePaths: [ODD] })],
      branchFiles: {
        [`agent/weather:${ODD}`]: '---\nid: get_weather\ntype: http\nurl: https://w.example/utcp\n---\n',
      },
      writers: { [ODD]: [ADMIN] },
    });
    const [pending] = await svc.listPendingTools(ADMIN);
    expect(pending?.name).toBe('get_weather');
    expect(pending?.slug).toBe('get_weather');
  });

  test('ignores change requests that are merged, closed or cancelled', async () => {
    for (const state of ['merged', 'closed', 'cancelled'] as const) {
      const svc = harness({ crs: [cr({ state })], writers: ADMIN_WRITES });
      expect(await svc.listPendingTools(AUTHOR)).toEqual([]);
    }
  });

  test('ignores touched paths that declare no tool', async () => {
    const svc = harness({
      crs: [
        cr({
          touchedNodePaths: [
            'Plugins/Ops/access.md',
            'Plugins/Ops/weather/SKILL.md',
            'Plugins/Ops/plugin.json',
            'Plugins/mcp.json', // no plugin for its servers to belong to
          ],
        }),
      ],
      writers: {
        'Plugins/Ops/access.md': [ADMIN],
        'Plugins/Ops/plugin.json': [ADMIN],
        'Plugins/mcp.json': [ADMIN],
      },
    });
    expect(await svc.listPendingTools(AUTHOR)).toEqual([]);
  });

  /**
   * The proposal is read at the request's own branch. Reading the default
   * branch would find nothing and drop the card — which is the original bug.
   */
  test('drops a proposal whose file cannot be read on its branch', async () => {
    const svc = harness({ crs: [cr()], branchFiles: {}, writers: ADMIN_WRITES });
    expect(await svc.listPendingTools(AUTHOR)).toEqual([]);
  });

  test('drops a `.tool` that does not parse — the catalog would skip it too', async () => {
    const svc = harness({
      crs: [cr()],
      branchFiles: { [`agent/weather:${TOOL_PATH}`]: 'not: [a, valid, manual\n' },
      writers: ADMIN_WRITES,
    });
    expect(await svc.listPendingTools(AUTHOR)).toEqual([]);
  });

  test('names a `.tool` after its file when the frontmatter declares no id', async () => {
    const svc = harness({
      crs: [cr()],
      branchFiles: {
        [`agent/weather:${TOOL_PATH}`]: '---\ntype: http\nurl: https://w.example/utcp\n---\n',
      },
      writers: ADMIN_WRITES,
    });
    const [pending] = await svc.listPendingTools(AUTHOR);
    expect(pending?.name).toBe('weather');
    expect(pending?.description).toBeUndefined();
  });

  describe('MCP servers', () => {
    const MCP_CR = cr({ number: 11, branch: 'agent/tickets', touchedNodePaths: [MCP_PATH] });

    test('surfaces a server added to a plugin mcp.json', async () => {
      const svc = harness({
        crs: [MCP_CR],
        branchFiles: { [`agent/tickets:${MCP_PATH}`]: MCP_JSON },
        writers: { [MCP_PATH]: [ADMIN] },
      });
      expect(await svc.listPendingTools(ADMIN)).toEqual([
        {
          slug: 'tickets',
          name: 'tickets',
          path: MCP_PATH,
          type: 'mcp',
          plugin: 'Ops',
          changeRequestNumber: 11,
          branch: 'agent/tickets',
          authorName: 'Ali Raza',
          createdAt: '2026-09-06T09:00:00.000Z',
          isAuthor: false,
        },
      ]);
    });

    /**
     * An `mcp.json` the request edits usually already holds servers. Only the
     * ADDED one is a proposal; the siblings are live tools with pages of their
     * own, and listing them here would put a ghost card beside each.
     */
    test('lists only the servers the default branch does not already serve', async () => {
      const svc = harness({
        crs: [MCP_CR],
        branchFiles: {
          [`agent/tickets:${MCP_PATH}`]: JSON.stringify({
            mcpServers: {
              rota: { type: 'streamable-http', url: 'https://rota.example/mcp' },
              tickets: { type: 'streamable-http', url: 'https://tickets.example/mcp' },
            },
          }),
        },
        released: [{ slug: 'rota', name: 'rota', path: MCP_PATH, type: 'mcp' }],
        writers: { [MCP_PATH]: [ADMIN] },
      });
      expect((await svc.listPendingTools(ADMIN)).map((p) => p.name)).toEqual(['tickets']);
    });

    /**
     * The plugin's manifest carries what the portable `mcp.json` may not — the
     * description, and the `local: true` that exempts a localhost server from
     * the reachability gate. Read at the same branch: without it a proposed
     * local server would be dropped as unreachable and never get a card.
     */
    test("reads the plugin's manifest on the branch for the extension block", async () => {
      const svc = harness({
        crs: [MCP_CR],
        branchFiles: {
          [`agent/tickets:${MCP_PATH}`]: JSON.stringify({
            mcpServers: { tickets: { type: 'streamable-http', url: 'http://127.0.0.1:9911/mcp' } },
          }),
          'agent/tickets:Plugins/Ops/plugin.json': JSON.stringify({
            extensions: {
              'software.bevel.hexis': {
                mcpServers: { tickets: { local: true, description: 'The on-call rota board.' } },
              },
            },
          }),
        },
        writers: { [MCP_PATH]: [ADMIN] },
      });
      const [pending] = await svc.listPendingTools(ADMIN);
      expect(pending?.name).toBe('tickets');
      expect(pending?.description).toBe('The on-call rota board.');
    });
  });

  /**
   * This hangs off the library's list load. A workflow service that cannot
   * answer must cost the reader an empty review shelf, not their whole library.
   */
  test('degrades to nothing pending when the change requests cannot be listed', async () => {
    const workflow = {
      listChangeRequests: async () => {
        throw new Error('offline');
      },
    } as unknown as IWorkflowService;
    const svc = new PendingToolsService(
      {} as unknown as WorkspaceService,
      {} as unknown as IAccessControl,
      { listAllSummaries: async () => [] } as unknown as IToolManualService,
      workflow,
    );
    await expect(svc.listPendingTools(AUTHOR)).resolves.toEqual([]);
  });

  test('degrades to nothing pending when the catalog cannot be scanned', async () => {
    const svc = new PendingToolsService(
      {} as unknown as WorkspaceService,
      {} as unknown as IAccessControl,
      {
        listAllSummaries: async () => {
          throw new Error('workspace gone');
        },
      } as unknown as IToolManualService,
      { listChangeRequests: async () => [cr()] } as unknown as IWorkflowService,
    );
    await expect(svc.listPendingTools(AUTHOR)).resolves.toEqual([]);
  });

  test('oldest first — the request that has waited longest is the one to answer', async () => {
    const OLDER = 'Plugins/Ops/rota.tool';
    const svc = harness({
      crs: [
        cr({ number: 9, createdAt: '2026-09-06T12:00:00.000Z' }),
        cr({
          number: 3,
          createdAt: '2026-09-01T12:00:00.000Z',
          branch: 'agent/older',
          touchedNodePaths: [OLDER],
        }),
      ],
      branchFiles: {
        [`agent/weather:${TOOL_PATH}`]: WEATHER_TOOL,
        [`agent/older:${OLDER}`]: '---\nid: rota\ntype: http\nurl: https://r.example/utcp\n---\n',
      },
      writers: { ...ADMIN_WRITES, [OLDER]: [ADMIN] },
    });
    expect((await svc.listPendingTools(ADMIN)).map((p) => p.changeRequestNumber)).toEqual([3, 9]);
  });
});
