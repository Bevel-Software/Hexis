import { useEffect } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { PluginSummary } from '../services/plugins.api';
import type { LibraryFilter } from '../utils/status';

/**
 * The Owner pill means OWNER — named in the item's `owner:` grant, directly or
 * by a role — and "Owned by me" means the same thing. Driven through the real
 * `LibraryProvider` and `useLibraryData` with the services stubbed at the
 * network edge, so what is under test is the whole path from verdicts to
 * pills: which batch asks which verb, and what each surface does with it.
 *
 * The caller here is an Admin: they WRITE every skill and tool (the write
 * batch and the tools' `canWrite` say yes to all), and are owner-listed on one
 * skill, one tool and one plugin. `ownerless` has no owner grant anywhere, so
 * the owner verdict on it is no for everybody.
 */

const svc = vi.hoisted(() => ({
  fetchFileAccessBatch: vi.fn(),
  listSkills: vi.fn(),
  getSkill: vi.fn(),
  listPendingSkills: vi.fn(),
  listToolSecrets: vi.fn(),
  listOpenChangeRequests: vi.fn(),
  listMyChangeRequests: vi.fn(),
  listPlugins: vi.fn(),
  listTeams: vi.fn(),
}));

vi.mock('../../access/api', async (orig) => ({
  ...(await orig<typeof import('../../access/api')>()),
  fetchFileAccessBatch: svc.fetchFileAccessBatch,
}));
vi.mock('../services/library.api', async (orig) => ({
  ...(await orig<typeof import('../services/library.api')>()),
  listSkills: svc.listSkills,
  getSkill: svc.getSkill,
  listPendingSkills: svc.listPendingSkills,
}));
vi.mock('../../secrets-vault/services/tool-secrets.api', async (orig) => ({
  ...(await orig<typeof import('../../secrets-vault/services/tool-secrets.api')>()),
  listToolSecrets: svc.listToolSecrets,
}));
vi.mock('../../change-requests/services/change-requests.api', async (orig) => ({
  ...(await orig<typeof import('../../change-requests/services/change-requests.api')>()),
  listOpenChangeRequests: svc.listOpenChangeRequests,
  listMyChangeRequests: svc.listMyChangeRequests,
}));
vi.mock('../services/plugins.api', async (orig) => ({
  ...(await orig<typeof import('../services/plugins.api')>()),
  listPlugins: svc.listPlugins,
}));
vi.mock('../services/teams.api', async (orig) => ({
  ...(await orig<typeof import('../services/teams.api')>()),
  listTeams: svc.listTeams,
}));
vi.mock('../../admin/state/admin.context', async (orig) => ({
  ...(await orig<typeof import('../../admin/state/admin.context')>()),
  useAdmin: () => ({ isAdmin: true }),
}));

import { LibraryProvider, useLibrary, type LibraryContextValue, type LibraryItem } from '../state/library-data';
import { filterLibraryItems } from '../utils/status';
import { ownedLensOf, pluginEntriesFor } from '../utils/plugin-entries';
import { LibraryCard, type LibraryCardProps } from '../components/LibraryCard';
import { PluginRows } from '../components/PluginRows';

const SKILLS = [
  { name: 'owned-skill', description: '', path: 'Skills/owned-skill', plugins: [] },
  { name: 'written-skill', description: '', path: 'Skills/written-skill', plugins: [] },
  { name: 'ownerless', description: '', path: 'Skills/ownerless', plugins: [] },
];
const TOOLS = [
  { slug: 'weather', name: 'Weather', path: 'Tools/weather.tool', type: 'http', setup: null, canWrite: true, variables: [] },
  { slug: 'slack', name: 'Slack', path: 'Tools/slack.tool', type: 'http', setup: null, canWrite: true, variables: [] },
];
const SKILL_PROBES = SKILLS.map((s) => `${s.path}/SKILL.md`);
const TOOL_PROBES = TOOLS.map((t) => t.path);

/** Admin by role: writes all of it. */
const WRITABLE = new Set([...SKILL_PROBES, ...TOOL_PROBES]);
/** Owner-listed on these alone. */
const OWNED = new Set(['Skills/owned-skill/SKILL.md', 'Tools/weather.tool']);

const plugin = (over: Partial<PluginSummary>): PluginSummary => ({
  name: 'gtm',
  displayName: 'GTM',
  folders: ['Plugins/GTM'],
  linksAreManaged: true,
  canRead: true,
  canWrite: true,
  isOwner: false,
  skillCount: 0,
  toolCount: 0,
  brokenLinks: 0,
  owners: { roles: [], users: [] },
  writers: { roles: [], users: [] },
  readers: { restricted: true, roles: [], users: [] },
  isPrivate: false,
  hasRequested: false,
  requestNumber: null,
  ...over,
});

let latest: LibraryContextValue | null = null;

/** A gallery in miniature: the plugin rows and the cards a filter shows. */
function Gallery({ filter, onLib }: { filter: LibraryFilter; onLib: (lib: LibraryContextValue) => void }) {
  const lib = useLibrary();
  useEffect(() => onLib(lib));
  if (lib.loading || lib.pluginsLoading) return <p>Loading…</p>;
  const cards = filterLibraryItems(lib.items, filter, '', lib.teams);
  const entries = pluginEntriesFor(lib.items, lib.pluginSummaries, filter, lib.teams, '', 'Yours');
  return (
    <>
      <PluginRows entries={entries} />
      <ul aria-label="cards">
        {cards.map((i) => (
          <li key={`${i.kind}:${i.id}`} aria-label={i.name}>
            <LibraryCard
              {...({
                kind: i.kind,
                flavor: 'utcp',
                id: i.id,
                name: i.name,
                description: i.description,
                owned: i.owned,
                status: i.status,
                onOpen: () => {},
              } as LibraryCardProps)}
            />
          </li>
        ))}
      </ul>
    </>
  );
}

async function renderGallery(filter: LibraryFilter) {
  render(
    <MemoryRouter>
      <LibraryProvider>
        <Gallery
          filter={filter}
          onLib={(lib) => {
            latest = lib;
          }}
        />
      </LibraryProvider>
    </MemoryRouter>,
  );
  await screen.findByRole('list', { name: 'cards' });
  // `latest` is set by an effect, which can trail the commit that put the
  // list on screen: on a slow runner the value read here was still the
  // loading render's (no items). Wait for the loaded value itself.
  await waitFor(() => expect(latest && !latest.loading && !latest.pluginsLoading).toBe(true));
  return latest!;
}

const cardNames = () =>
  within(screen.getByRole('list', { name: 'cards' }))
    .getAllByRole('listitem')
    .map((li) => li.getAttribute('aria-label'));

const pilled = () =>
  within(screen.getByRole('list', { name: 'cards' }))
    .getAllByRole('listitem')
    .filter((li) => within(li).queryByText('Owner') !== null)
    .map((li) => li.getAttribute('aria-label'));

beforeEach(() => {
  latest = null;
  vi.clearAllMocks();
  svc.fetchFileAccessBatch.mockImplementation(async (_ws: string, paths: string[], verb = 'write') => {
    const granted = verb === 'owner' ? OWNED : WRITABLE;
    return { results: Object.fromEntries(paths.map((p) => [p, granted.has(p)])) };
  });
  svc.listSkills.mockResolvedValue(SKILLS);
  svc.getSkill.mockResolvedValue({ allowedTools: [] });
  svc.listPendingSkills.mockResolvedValue([]);
  svc.listToolSecrets.mockResolvedValue(TOOLS);
  svc.listOpenChangeRequests.mockResolvedValue([]);
  svc.listMyChangeRequests.mockResolvedValue([]);
  svc.listPlugins.mockResolvedValue([
    plugin({ name: 'gtm', displayName: 'GTM', isOwner: true }),
    // Managed (an Admin writes it) but not owner-listed.
    plugin({ name: 'ops', displayName: 'Ops', isOwner: false }),
  ]);
  svc.listTeams.mockResolvedValue([]);
});

describe('the Owner pill', () => {
  it('shows on what the caller owns — not on what they only write, as an Admin by role, nor on an ownerless item', async () => {
    await renderGallery({ kind: 'all' });

    expect(cardNames()).toEqual(['owned-skill', 'written-skill', 'ownerless', 'Weather', 'Slack']);
    expect(pilled()).toEqual(['owned-skill', 'Weather']);
  });

  it('leaves write untouched: the writer who lost the pill keeps every item writable', async () => {
    const lib = await renderGallery({ kind: 'all' });

    const byName = new Map(lib.items.map((i: LibraryItem) => [i.name, i]));
    for (const name of ['owned-skill', 'written-skill', 'ownerless', 'Weather', 'Slack']) {
      expect(byName.get(name)?.canWrite).toBe(true);
    }
    expect(byName.get('written-skill')?.owned).toBe(false);
  });

  it('resolves ownership in ONE batched owner call over skills and tools — no per-item requests', async () => {
    await renderGallery({ kind: 'all' });

    const calls = svc.fetchFileAccessBatch.mock.calls as [string, string[], string?][];
    const owner = calls.filter(([, , verb]) => verb === 'owner');
    expect(owner).toHaveLength(1);
    expect(owner[0]?.[1]).toEqual([...SKILL_PROBES, ...TOOL_PROBES]);
    // The skills' write verdict keeps its own single batch, for the affordances.
    const write = calls.filter(([, , verb]) => verb !== 'owner');
    expect(write).toHaveLength(1);
    expect(write[0]?.[1]).toEqual(SKILL_PROBES);
  });

  it("splits a catalog past the endpoint's 500-path cap into batches and merges their verdicts", async () => {
    const filler = Array.from({ length: 500 }, (_, i) => ({
      name: `filler-${i}`,
      description: '',
      path: `Skills/filler-${i}`,
      plugins: [],
    }));
    // The owned skill and tool land in the SECOND slice of the owner batch.
    svc.listSkills.mockResolvedValue([...filler, ...SKILLS]);
    // Count requests in flight, per verb: slices are serialized, not burst.
    const inFlight = { write: 0, owner: 0 };
    const peak = { write: 0, owner: 0 };
    svc.fetchFileAccessBatch.mockImplementation(
      async (_ws: string, paths: string[], verb: 'write' | 'owner' = 'write') => {
        inFlight[verb] += 1;
        peak[verb] = Math.max(peak[verb], inFlight[verb]);
        await new Promise((r) => setTimeout(r, 0));
        inFlight[verb] -= 1;
        const granted = verb === 'owner' ? OWNED : WRITABLE;
        return { results: Object.fromEntries(paths.map((p) => [p, granted.has(p)])) };
      },
    );
    await renderGallery({ kind: 'owned' });

    const calls = svc.fetchFileAccessBatch.mock.calls as [string, string[], string?][];
    const sizes = (owner: boolean) =>
      calls.filter(([, , verb]) => (verb === 'owner') === owner).map(([, paths]) => paths.length);
    expect(sizes(true)).toEqual([500, SKILLS.length + TOOLS.length]);
    expect(sizes(false)).toEqual([500, SKILLS.length]);
    expect(peak).toEqual({ write: 1, owner: 1 });
    expect(cardNames()).toEqual(['owned-skill', 'Weather']);
  });

  it('stops sending slices once the load is superseded', async () => {
    const filler = Array.from({ length: 500 }, (_, i) => ({
      name: `filler-${i}`,
      description: '',
      path: `Skills/filler-${i}`,
      plugins: [],
    }));
    // Two slices per verb; each request hangs until released.
    svc.listSkills.mockResolvedValue([...filler, ...SKILLS]);
    const release: Array<() => void> = [];
    svc.fetchFileAccessBatch.mockImplementation(
      (_ws: string, paths: string[]) =>
        new Promise((resolve) => {
          release.push(() => resolve({ results: Object.fromEntries(paths.map((p) => [p, true])) }));
        }),
    );
    const { unmount } = render(
      <MemoryRouter>
        <LibraryProvider>
          <p>library</p>
        </LibraryProvider>
      </MemoryRouter>,
    );

    // The first slice of each verb is out…
    await vi.waitFor(() => expect(svc.fetchFileAccessBatch).toHaveBeenCalledTimes(2));
    // …when the page goes away. Answering them must not send the second ones.
    unmount();
    release.splice(0).forEach((r) => r());
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(svc.fetchFileAccessBatch).toHaveBeenCalledTimes(2);
  });

  it('fails closed: an owner lookup that errors pills nothing and takes no write away', async () => {
    svc.fetchFileAccessBatch.mockImplementation(async (_ws: string, paths: string[], verb = 'write') => {
      if (verb === 'owner') throw new Error('boom');
      return { results: Object.fromEntries(paths.map((p) => [p, true])) };
    });
    const lib = await renderGallery({ kind: 'all' });

    expect(pilled()).toEqual([]);
    expect(lib.items.every((i) => i.canWrite)).toBe(true);
  });
});

describe('the plugin Owner pill', () => {
  it("passes the listing's `isOwner` through — a plugin the caller only manages carries none", async () => {
    await renderGallery({ kind: 'all' });

    expect(within(screen.getByRole('button', { name: /^GTM/ })).getByText('Owner')).toBeInTheDocument();
    expect(within(screen.getByRole('button', { name: /^Ops/ })).queryByText('Owner')).not.toBeInTheDocument();
  });
});

describe('Owned by me', () => {
  it('lists exactly the pilled items, and its count is that list', async () => {
    const lib = await renderGallery({ kind: 'owned' });

    expect(cardNames()).toEqual(['owned-skill', 'Weather']);
    expect(pilled()).toEqual(cardNames());
    expect(screen.queryByRole('button', { name: /^Ops/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^GTM/ })).toBeInTheDocument();

    const plugins = pluginEntriesFor(lib.items, lib.pluginSummaries, { kind: 'owned' }, lib.teams, '', 'Yours');
    // Two owned cards, the own space and GTM.
    expect(ownedLensOf(lib.items, lib.pluginSummaries, lib.teams, 'Yours').count).toBe(2 + plugins.length);
    expect(plugins.map((p) => p.name)).toEqual([null, 'gtm']);
  });
});

describe('ownedLensOf', () => {
  const item = (over: Partial<LibraryItem>): LibraryItem => ({
    kind: 'skill',
    id: 'x',
    name: 'x',
    description: '',
    owned: false,
    canWrite: false,
    plugin: null,
    path: 'Skills/x',
    status: { state: 'ok', text: 'Ready' },
    ...over,
  });

  it("counts attention on owned items only — a writer's broken item is not theirs to count", () => {
    const items = [
      item({ id: 'a', name: 'a', owned: true, canWrite: true }),
      item({ id: 'b', name: 'b', owned: true, canWrite: true, status: { state: 'warn', text: 'Needs setup' } }),
      item({ id: 'c', name: 'c', owned: false, canWrite: true, status: { state: 'warn', text: 'Needs setup' } }),
      item({ kind: 'integration', id: 't', name: 't', owned: false, canWrite: true, status: { state: 'warn', text: 'Needs setup' } }),
    ];
    const lens = ownedLensOf(items, [plugin({ isOwner: false })], [], 'Yours');
    expect(filterLibraryItems(items, { kind: 'owned' }, '').map((i) => i.id)).toEqual(['a', 'b']);
    // a + b, plus the own space row; the managed-not-owned plugin is out.
    expect(lens).toEqual({ count: 3, attention: 1 });
  });
});
