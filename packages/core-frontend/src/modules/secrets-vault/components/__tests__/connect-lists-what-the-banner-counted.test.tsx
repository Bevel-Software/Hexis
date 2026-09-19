import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ConnectPending, ConnectTool, ConnectToolOAuth } from '../../services/connect.api';
import type { ToolSecrets, ToolVarStatus } from '../../services/tool-secrets.api';
import { outstandingCount } from '../../utils/connect-status';
import { ConnectToolsPage } from '../ConnectToolsPage';
import { attentionOf, type LibraryItem } from '../../../library/state/library-data';
import { toolStatus } from '../../../library/utils/status';

/**
 * The plugin banner and this page, counting the same thing.
 *
 * A plugin page said four integrations needed setup and the Connect page it
 * linked to showed two: the banner counts every integration that is not ok —
 * workspace keys only an owner can set, tools the reader took out — and the page
 * listed only what the reader could act on, then dropped the skipped ones from
 * its total as well.
 *
 * So the scenario is built ONCE, as the tool catalog both surfaces are really
 * derived from, and projected two ways: into the Library items the banner counts
 * and into the `/connect/pending` payload the page renders. A test that built
 * two hand-written fixtures could be made to agree while the product did not.
 */

const connectMock = vi.hoisted(() => ({
  getConnectPending: vi.fn(),
  startToolOAuth: vi.fn(),
  getMcpOAuthRequest: vi.fn(),
  completeMcpOAuth: vi.fn(),
}));
vi.mock('../../services/connect.api', () => connectMock);

const varsMock = vi.hoisted(() => ({
  setUserVar: vi.fn(),
  setAdminVar: vi.fn(),
  deleteUserVar: vi.fn(),
  setOAuthClientSecret: vi.fn(),
}));
vi.mock('../../services/tool-secrets.api', () => varsMock);
vi.mock('../../services/secrets.api', () => ({ startOAuth: vi.fn() }));

/* ── the scenario, as one catalog ───────────────────────────────────────── */

function v(over: Partial<ToolVarStatus> & { name: string }): ToolVarStatus {
  return {
    scope: 'user',
    label: null,
    key: `k_${over.name}`,
    adminConfigured: false,
    userConfigured: false,
    ...over,
  };
}

function tool(over: Partial<ToolSecrets> & { slug: string }): ToolSecrets {
  return {
    name: over.slug,
    path: `Plugins/GTM/${over.slug}.tool`,
    type: 'inline',
    setup: null,
    canWrite: false,
    variables: [],
    ...over,
  };
}

/**
 * The spec's scenario: two of the reader's own keys unset, one workspace key
 * only an owner can set, one tool they skipped (skipping WIPED its key, which is
 * what makes it unconfigured), and one that is fully set up and must not be
 * counted by either surface.
 */
const CATALOG: ToolSecrets[] = [
  tool({ slug: 'heyreach', variables: [v({ name: 'API_KEY', key: 'heyreach_API_KEY' })] }),
  tool({ slug: 'apollo', variables: [v({ name: 'API_KEY', key: 'apollo_API_KEY' })] }),
  tool({
    slug: 'salesforce',
    variables: [v({ name: 'ORG_TOKEN', key: 'salesforce_ORG_TOKEN', scope: 'admin' })],
  }),
  tool({ slug: 'clay', variables: [v({ name: 'API_KEY', key: 'clay_API_KEY' })] }),
  tool({
    slug: 'notion',
    variables: [v({ name: 'API_KEY', key: 'notion_API_KEY', userConfigured: true })],
  }),
];

/** A tool the caller may not read is not in the catalog at all — see below. */
const SECRET_TOOL = 'blackbox';

/** What the Library holds, and what the plugin banner counts off it. */
function libraryItems(catalog: ToolSecrets[]): LibraryItem[] {
  return catalog.map((t) => ({
    kind: 'integration' as const,
    id: t.slug,
    name: t.name,
    description: '',
    owned: false,
    canWrite: t.canWrite,
    status: toolStatus(t),
    plugin: 'GTM',
    path: t.path,
  }));
}

/**
 * What `GET /api/connect/pending` returns for the same catalog — the server's
 * rules, restated: workspace values that are already set are dropped (nobody's
 * outstanding work), one the caller cannot write is `ownerOnly`, and oauth vars
 * move to the sign-in list.
 */
function pendingFor(catalog: ToolSecrets[]): ConnectPending {
  const tools: ConnectTool[] = catalog
    .map((t) => ({
      slug: t.slug,
      name: t.name,
      path: t.path,
      type: t.type,
      canWrite: t.canWrite,
      variables: t.variables
        .filter((x) => !x.oauth)
        .map((x) => ({
          name: x.name,
          label: x.label,
          key: x.key,
          scope: x.scope,
          configured: x.scope === 'admin' ? x.adminConfigured : x.userConfigured,
          ownerOnly: x.scope === 'admin' && !t.canWrite,
        }))
        .filter((x) => x.scope !== 'admin' || !x.configured),
    }))
    .filter((t) => t.variables.length > 0);
  const toolOAuth: ConnectToolOAuth[] = catalog.flatMap((t) =>
    t.variables
      .filter((x) => x.oauth)
      .map((x) => ({
        slug: t.slug,
        varName: x.name,
        toolName: t.name,
        key: x.key,
        label: x.label,
        authorized: x.authorized ?? false,
        needsReauth: x.needsReauth ?? false,
        ownerConfigured: x.adminConfigured,
        ownerOnly: !x.adminConfigured && !t.canWrite,
      })),
  );
  return { tools, oauth: [], toolOAuth };
}

function renderPage() {
  return render(
    <MemoryRouter>
      <ConnectToolsPage />
    </MemoryRouter>,
  );
}

/**
 * The card for one tool: the Surface holding the row head its name links from.
 * Awaited, because every one of these tests starts with the page's first load.
 */
async function rowFor(name: string): Promise<HTMLElement> {
  const link = await screen.findByRole('link', { name: `Open ${name}` });
  return link.closest('div')!.parentElement as HTMLElement;
}

beforeEach(() => {
  window.history.replaceState(null, '', '/connect');
  sessionStorage.clear();
  connectMock.getConnectPending.mockReset().mockResolvedValue(pendingFor(CATALOG));
  connectMock.getMcpOAuthRequest.mockReset();
  varsMock.setUserVar.mockReset().mockResolvedValue(undefined);
  varsMock.setAdminVar.mockReset().mockResolvedValue(undefined);
  varsMock.deleteUserVar.mockReset().mockResolvedValue(undefined);
});

describe('the Connect page counts what the plugin banner counted', () => {
  it('agrees with the banner on the spec’s 2 + 1 + 1 scenario', () => {
    const { total, brokenLinks, warnings } = attentionOf(libraryItems(CATALOG), 'GTM');
    const banner = total - brokenLinks - warnings;

    // Four integrations need setup; `notion` is done and counted by neither.
    expect(banner).toBe(4);
    expect(outstandingCount(pendingFor(CATALOG))).toBe(banner);
  });

  it('still agrees once a tool is skipped — skipping is not setting up', async () => {
    // Skipping wipes the reader's keys, so the catalog the banner reads is
    // unchanged by it: `clay` was already unconfigured. The page must not quietly
    // drop it from its own total the way it used to.
    renderPage();

    const clay = await rowFor('clay');
    fireEvent.click(
      within(clay).getByRole('checkbox', {
        name: 'Skip this tool (removes your saved keys and sign-ins for it)',
      }),
    );

    expect(await screen.findByText('Skipped by you')).toBeInTheDocument();
    // The banner's four, still on the page.
    expect(outstandingCount(pendingFor(CATALOG))).toBe(4);
  });

  it('counts a tool once even when it owes both a sign-in and a key', () => {
    // One integration, two rows — the banner counts the integration.
    const both = tool({
      slug: 'linear',
      variables: [
        v({ name: 'API_KEY', key: 'linear_API_KEY' }),
        v({ name: 'TOKEN', key: 'linear_TOKEN', oauth: true, adminConfigured: true }),
      ],
    });
    const catalog = [both];
    const { total, brokenLinks, warnings } = attentionOf(libraryItems(catalog), 'GTM');

    expect(total - brokenLinks - warnings).toBe(1);
    expect(outstandingCount(pendingFor(catalog))).toBe(1);
  });
});

describe('the Connect page says why, when the reader cannot act', () => {
  it('lists a configured tool as set, with no demand on the reader', async () => {
    renderPage();
    const notion = await rowFor('notion');

    expect(within(notion).getByText('Key saved')).toBeInTheDocument();
    // The field is still there — this page is also where a key is replaced.
    expect(within(notion).getByPlaceholderText('Replace…')).toBeInTheDocument();
  });

  it('lists an unconfigured tool as the reader’s to fix, fields open', async () => {
    renderPage();
    const apollo = await rowFor('apollo');

    expect(within(apollo).getByText('Needs a key from you')).toBeInTheDocument();
    expect(within(apollo).getByLabelText('API_KEY value')).toBeInTheDocument();
  });

  it('greys a workspace key the reader cannot set, and names the variable', async () => {
    renderPage();
    const sf = await rowFor('salesforce');

    expect(within(sf).getAllByText('Needs an owner to set ORG_TOKEN').length).toBeGreaterThan(0);
    // Nothing to save and nothing to opt out of: it was never the reader's.
    expect(within(sf).queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(within(sf).queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('gives the OWNER the ordinary row, with the key field', async () => {
    const owned = CATALOG.map((t) => (t.slug === 'salesforce' ? { ...t, canWrite: true } : t));
    connectMock.getConnectPending.mockResolvedValue(pendingFor(owned));
    renderPage();
    const sf = await rowFor('salesforce');

    expect(within(sf).queryByText('Needs an owner to set ORG_TOKEN')).not.toBeInTheDocument();
    expect(within(sf).getByText('Needs a key from you')).toBeInTheDocument();

    fireEvent.change(within(sf).getByLabelText('ORG_TOKEN value'), { target: { value: 's3cret' } });
    fireEvent.click(within(sf).getByRole('button', { name: 'Save' }));

    // The WORKSPACE value, not a personal one — the owner is setting it for
    // everybody, which is the whole reason the other reader could not.
    await waitFor(() =>
      expect(varsMock.setAdminVar).toHaveBeenCalledWith('salesforce', 'ORG_TOKEN', 's3cret'),
    );
    expect(varsMock.setUserVar).not.toHaveBeenCalled();
  });

  it('keeps a skipped tool on the page, greyed, with a way back in', async () => {
    renderPage();
    const clay = await rowFor('clay');

    fireEvent.click(
      within(clay).getByRole('checkbox', {
        name: 'Skip this tool (removes your saved keys and sign-ins for it)',
      }),
    );

    const skipped = await rowFor('clay');
    expect(within(skipped).getByText('Skipped by you')).toBeInTheDocument();
    expect(skipped.className).toContain('opacity-60');
    fireEvent.click(within(skipped).getByRole('button', { name: 'Include' }));

    expect(within(await rowFor('clay')).getByText('Needs a key from you')).toBeInTheDocument();
  });

  it('says an unregistered sign-in is the owner’s, and offers no Authorize', async () => {
    // Nobody can sign in until the provider registration exists, so offering the
    // button would send the reader at a consent screen that cannot open.
    const catalog = [
      tool({
        slug: 'google',
        variables: [v({ name: 'GOOGLE_TOKEN', key: 'google_GOOGLE_TOKEN', oauth: true })],
      }),
    ];
    connectMock.getConnectPending.mockResolvedValue(pendingFor(catalog));
    renderPage();
    const google = await rowFor('google');

    expect(within(google).getByText('Needs an owner to set GOOGLE_TOKEN')).toBeInTheDocument();
    expect(within(google).queryByRole('button', { name: 'Authorize' })).not.toBeInTheDocument();
    // Counted all the same — the banner counts the integration.
    expect(outstandingCount(pendingFor(catalog))).toBe(1);
  });

  it('never names a tool the reader cannot read', async () => {
    // The server builds the listing from the tools the caller may read, so the
    // unreadable one is absent — not greyed, not counted, not named.
    renderPage();
    await rowFor('apollo');

    expect(screen.queryByText(SECRET_TOOL)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: `Open ${SECRET_TOOL}` })).not.toBeInTheDocument();
    expect(outstandingCount(pendingFor(CATALOG))).toBe(4);
  });
});
