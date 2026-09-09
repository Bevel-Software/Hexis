import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ExternalAgentAccessPage } from '../ExternalAgentAccessPage';
import { configureMcpUrl } from '../../../../shared/mcp';
import { GITHUB_LINK_KIND, configureMarketplaceGitUrl } from '../../../../shared/marketplace-url';

/**
 * The Connect page's contract, and the reason this file exists at all: every
 * HOSTED snippet quotes the DEPLOYMENT's address, never the browser's — and
 * every LOCAL-server (hexis-mcp) snippet quotes the browser's origin, never
 * the deployment's MCP endpoint. Two families, two addresses, on purpose:
 * hexis-mcp takes the workspace base and resolves the endpoint from
 * `GET /api/config` itself, and the one base the browser has proven serves
 * the whole app is its own origin.
 *
 * Six hosted sites on this page used to rebuild the endpoint from
 * `window.location.origin` — three keyless, three carrying a freshly minted
 * external API key. They agreed with the server's own idea of its address
 * only by luck, and a proxy or a second domain was enough to break it. The
 * regression cases below name all six.
 */

const { listMock, createMock, facadeMock, adminState } = vi.hoisted(() => ({
  listMock: vi.fn(),
  createMock: vi.fn(),
  facadeMock: vi.fn(),
  // Mutable so one file can mount the page as both roles: the Cowork drawer
  // shows two different sets of steps depending on this.
  adminState: { isAdmin: false },
}));

vi.mock('../../../admin/state/admin.context', () => ({
  useAdmin: () => ({ isAdmin: adminState.isAdmin }),
}));

// The registration credentials the admin branch shows inline. Mocked, or the
// component reaches for the real admin endpoint over the network.
vi.mock('../../../settings/services/github-facade.api', () => ({
  fetchGitHubFacade: facadeMock,
}));

vi.mock('../../services/external-api-keys.api', () => ({
  listExternalApiKeys: listMock,
  createExternalApiKey: createMock,
  disconnectExternalApiKey: vi.fn(async () => {}),
  deleteExternalApiKey: vi.fn(async () => {}),
}));

/** A deployment configured the way a real one is: public, https, its own domain. */
const PUBLIC_URL = 'https://kb.acme.com/api/mcp';
/** What an unconfigured deployment actually runs with — see `.env.example`. */
const LOCALHOST_URL = 'http://localhost:3001/api/mcp';

const KEY = 'bvl_live_s3cret';

const FACADE = {
  host: 'kb.acme.com',
  appId: '12345',
  clientId: 'Iv1.abcdef',
  clientSecret: 'ghs_secret',
  webhookSecret: 'whsec_0123456789012345678',
  privateKeyPem: '-----BEGIN RSA PRIVATE KEY-----\nx\n-----END RSA PRIVATE KEY-----',
  marketplaceUrl: 'https://kb.acme.com/git/marketplace.git',
  createdAt: Date.now(),
  rotatedAt: null,
};

beforeEach(() => {
  adminState.isAdmin = false;
  // Cleared, not just re-stubbed: the count is an assertion of its own below.
  facadeMock.mockClear();
  facadeMock.mockResolvedValue(FACADE);
  listMock.mockResolvedValue([]);
  createMock.mockResolvedValue({
    plaintext: KEY,
    summary: {
      id: 'k1',
      label: 'CI',
      createdAt: Date.now(),
      lastUsedAt: null,
      revokedAt: null,
    },
  });
});

function mount(mcpUrl: string) {
  configureMcpUrl(mcpUrl);
  // The marketplace remote is served from the same deployment address.
  configureMarketplaceGitUrl(`${new URL(mcpUrl).origin}/git/marketplace.git`);
  return render(
    <MemoryRouter>
      <ExternalAgentAccessPage />
    </MemoryRouter>,
  );
}

/** Every read-only snippet on screen, as plain strings. */
function snippets(): string[] {
  return screen
    .getAllByRole('textbox')
    .map((el) => (el as HTMLTextAreaElement).value);
}

/** Mint a key so the reveal modal — and its three keyed snippets — is on screen. */
async function revealAKey(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('tab', { name: 'Autonomous agents' }));
  await user.type(screen.getByRole('textbox', { name: /Create an external API key/ }), 'CI');
  await user.click(screen.getByRole('button', { name: 'Create key' }));
  await screen.findByRole('heading', { name: /Save this external API key now/ });
}

describe('the interactive tab: local first, hosted second, each with its own address', () => {
  it('builds all three hosted keyless snippets from the configured URL', () => {
    mount(PUBLIC_URL);
    const values = snippets();

    // 1. the Claude Code one-liner
    expect(values).toContain(
      `claude mcp add --transport http skills-tools-knowledge ${PUBLIC_URL}`,
    );
    // 2. the bare URL for claude.ai / Claude Desktop
    expect(values).toContain(PUBLIC_URL);
    // 3. the JSON config for everything else — the LOCAL section renders a
    // `mcpServers` block too, so pick the hosted one by its server name.
    const json = values.find((v) => v.includes('"type": "http"') && v.includes('mcpServers'));
    expect(JSON.parse(json!).mcpServers['skills-tools-knowledge'].url).toBe(PUBLIC_URL);
  });

  /**
   * The RECOMMENDED path leads: the local-server drawer renders above the
   * hosted one, and its two snippets are KEYLESS — interactive mode signs in
   * through the browser on first run, so no key belongs in the config. Both
   * quote the workspace ORIGIN, because hexis-mcp resolves the endpoint from
   * `GET <base>/api/config` itself.
   */
  it('leads with the local server: keyless snippets built from the origin', () => {
    mount(PUBLIC_URL);
    // Two CLOSED drawers, desktop first. The summaries are the whole pitch;
    // the configs sit inside and neither drawer arrives open.
    const local = screen.getByText(
      'Desktop agents: Claude Code, Claude Desktop, Cursor, Windsurf, Cline and similar',
    );
    const hosted = screen.getByText('Any other agent');
    // DOCUMENT_POSITION_FOLLOWING: the hosted drawer comes after the local one.
    expect(local.compareDocumentPosition(hosted) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    for (const drawer of [local, hosted]) {
      expect((drawer.closest('details') as HTMLDetailsElement).open).toBe(false);
    }

    const values = snippets();
    expect(values).toContain(
      `claude mcp add skills-tools-knowledge --env HEXIS_URL="${window.location.origin}" -- npx -y @bevel-software/hexis-mcp`,
    );
    const json = values.find((v) => v.includes('mcpServers') && v.includes('"command"'));
    const parsed = JSON.parse(json!).mcpServers['skills-tools-knowledge'];
    expect(parsed.args).toEqual(['-y', '@bevel-software/hexis-mcp']);
    expect(parsed.env.HEXIS_URL).toBe(window.location.origin);
    // Keyless = interactive: the browser-sign-in mode carries no key env.
    expect(parsed.env.HEXIS_CONNECTION_KEY).toBeUndefined();
  });

  /**
   * The regression stated as a negative, per family: a hosted snippet
   * quoting the origin means one of the six sites quietly went back to
   * deriving it, and a local snippet quoting the configured endpoint would
   * hand hexis-mcp a base that may serve only the MCP path.
   */
  it('keeps each family on its own address', () => {
    mount(PUBLIC_URL);
    for (const value of snippets()) {
      if (value.includes('marketplace.git')) {
        // The marketplace remote is the deployment's own address (with the
        // key in the userinfo, so the HOST is what survives), never the browser's.
        expect(value).toContain(new URL(PUBLIC_URL).host);
        expect(value).not.toContain(window.location.host);
      } else if (value.includes('hexis')) {
        expect(value).toContain(window.location.origin);
        expect(value).not.toContain(PUBLIC_URL);
      } else {
        expect(value).not.toContain(window.location.origin);
      }
    }
  });

  it('still offers the tool-configuration link', () => {
    mount(PUBLIC_URL);
    expect(screen.getByRole('link', { name: /Configure your tools/ })).toBeInTheDocument();
  });

  /**
   * A bare `<button>` defaults to `type="submit"`. These render inside a
   * shared component that does not get to assume which tree it lands in, and
   * a copy button that submits an enclosing form is a nasty surprise.
   */
  it('gives every copy button an explicit type so it cannot submit a form', () => {
    mount(PUBLIC_URL);
    const copyButtons = screen.getAllByRole('button', { name: /^Copy/ });
    expect(copyButtons.length).toBeGreaterThan(0);
    for (const button of copyButtons) {
      expect(button).toHaveAttribute('type', 'button');
    }
  });
});

describe('the key-bearing snippets quote the deployment too', () => {
  it('builds all three keyed snippets from the configured URL', async () => {
    const user = userEvent.setup();
    mount(PUBLIC_URL);
    await revealAKey(user);
    const values = snippets();

    // 4. the Claude Code one-liner, with the key
    expect(values).toContain(
      `claude mcp add --transport http skills-tools-knowledge ${PUBLIC_URL} --header "Authorization: Bearer ${KEY}"`,
    );
    // 5. the Langdock field list
    expect(values).toContain(
      `URL: ${PUBLIC_URL}\nHeader name: Authorization\nHeader value: Bearer ${KEY}`,
    );
    // 6. the JSON config, with the key
    const json = values.find((v) => v.includes('mcpServers') && v.includes('headers'));
    const parsed = JSON.parse(json!).mcpServers['skills-tools-knowledge'];
    expect(parsed.url).toBe(PUBLIC_URL);
    expect(parsed.headers.Authorization).toBe(`Bearer ${KEY}`);
  });

  /**
   * The modal leads with the local server too — the recommended block comes
   * first, with the REAL key in both snippets (unlike the interactive tab's
   * placeholder). And it is the one place the page's own origin is right:
   * hexis-mcp takes the workspace's address — the one the browser provably
   * loaded this app from — and resolves the MCP endpoint from it itself,
   * so the configured `mcpUrl` (possibly a proxy serving only the MCP path)
   * must appear in neither snippet.
   */
  it('leads with the local server, handing it the origin and the minted key', async () => {
    const user = userEvent.setup();
    mount(PUBLIC_URL);
    await revealAKey(user);
    const local = screen.getByText('Desktop agents — the local server (recommended)');
    const hosted = screen.getByText('Web agents and pipelines — the hosted endpoint');
    // DOCUMENT_POSITION_FOLLOWING: the hosted block comes after the local one.
    expect(local.compareDocumentPosition(hosted) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const values = snippets();

    // 7. the Claude Code stdio one-liner
    expect(values).toContain(
      `claude mcp add skills-tools-knowledge --env HEXIS_URL="${window.location.origin}" --env HEXIS_CONNECTION_KEY="${KEY}" -- npx -y @bevel-software/hexis-mcp`,
    );
    // 8. the JSON config that spawns the package
    const json = values.find((v) => v.includes('mcpServers') && v.includes('"command"'));
    const parsed = JSON.parse(json!).mcpServers['skills-tools-knowledge'];
    expect(parsed.args).toEqual(['-y', '@bevel-software/hexis-mcp']);
    expect(parsed.env.HEXIS_URL).toBe(window.location.origin);
    expect(parsed.env.HEXIS_CONNECTION_KEY).toBe(KEY);
    expect(json).not.toContain(PUBLIC_URL);
  });

  /**
   * The modal holds the SAME three drawers as the interactive tab, in the
   * same order, and every one of them arrives closed: the key is what the
   * dialog hands over, and the configs wait until the reader picks a side.
   */
  it('folds the configs into the tab\'s three drawers, all closed', async () => {
    const user = userEvent.setup();
    mount(PUBLIC_URL);
    await revealAKey(user);
    const dialog = screen.getByRole('alertdialog');
    const summaries = [
      'Desktop agents — the local server (recommended)',
      'Web agents and pipelines — the hosted endpoint',
      'Skills as native plugins — the marketplace',
    ].map((text) => within(dialog).getByText(text));
    for (const summary of summaries) {
      expect(summary.tagName).toBe('SUMMARY');
      expect((summary.closest('details') as HTMLDetailsElement).open).toBe(false);
    }
    expect(summaries[0].compareDocumentPosition(summaries[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(summaries[1].compareDocumentPosition(summaries[2]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The key itself is not behind a drawer.
    expect(within(dialog).getByRole('button', { name: 'Copy external API key' }).closest('details')).toBeNull();
  });

  /**
   * The placeholder in the keyless marketplace commands is a placeholder, not
   * a percent-encoded one: `%3Cexternal-api-key%3E` looked like a secret to
   * paste. The commands live on the Marketplaces tab now.
   */
  it('shows the marketplace placeholder verbatim in the keyless commands', async () => {
    const user = userEvent.setup();
    mount(PUBLIC_URL);
    await user.click(screen.getByRole('tab', { name: 'Marketplaces' }));
    const marketplace = snippets().filter((v) => v.includes('marketplace.git'));
    expect(marketplace.length).toBeGreaterThan(0);
    for (const v of marketplace) expect(v).not.toContain('%3C');
    expect(marketplace.some((v) => v.includes('key:<external-api-key>@'))).toBe(true);
  });

  /**
   * The consolidation's real risk: snippets that must carry a secret
   * and snippets that must not. Losing the token during the move would look
   * like working code and fail at connect time.
   */
  it('keeps the key in the keyed snippets and out of the keyless ones', async () => {
    const user = userEvent.setup();
    mount(PUBLIC_URL);
    expect(snippets().some((v) => v.includes(KEY))).toBe(false);
    await revealAKey(user);
    expect(snippets().filter((v) => v.includes(KEY))).toHaveLength(
      // the reveal textarea itself, the three keyed hosted snippets, the two
      // local-server (hexis-mcp) snippets, and the three marketplace commands
      9,
    );
  });
});

describe('the Marketplaces tab', () => {
  it('is the third tab, and the interactive tab points at it instead of carrying the remote', async () => {
    const user = userEvent.setup();
    mount(PUBLIC_URL);
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'Your agent',
      'Marketplaces',
      'Autonomous agents',
    ]);
    // The remote no longer lives on the interactive tab.
    expect(snippets().some((v) => v.includes('marketplace.git'))).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Marketplaces' }));
    expect(screen.getByRole('tab', { name: 'Marketplaces' })).toHaveAttribute('aria-selected', 'true');
  });

  it('leads with the Cowork route and follows with the git remote, both closed, one URL for both', async () => {
    const user = userEvent.setup();
    mount(PUBLIC_URL);
    await user.click(screen.getByRole('tab', { name: 'Marketplaces' }));
    const cowork = screen.getByText('Cowork and claude.ai');
    const git = screen.getByText('Claude Code, Codex and the skills CLI');
    expect(cowork.compareDocumentPosition(git) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    for (const drawer of [cowork, git]) {
      expect((drawer.closest('details') as HTMLDetailsElement).open).toBe(false);
    }
    const remote = `${new URL(PUBLIC_URL).origin}/git/marketplace.git`;
    // The same address in both drawers: what Cowork adds is what Claude Code clones.
    expect(snippets().filter((v) => v === remote)).toHaveLength(2);
    // The keyed commands point at the deployment's host.
    const commands = snippets().filter((v) => v.includes('key:'));
    expect(commands.length).toBeGreaterThan(0);
    for (const v of commands) expect(v).toContain(new URL(PUBLIC_URL).host);
  });

  /**
   * The registration steps live on pages inside Claude's ADMIN settings. A
   * non-admin cannot open those, so showing them four screenshots of a door
   * they have no key to is worse than showing them nothing: the two admin
   * steps and their four shots are gated, and the three steps they can act
   * on are not.
   */
  it('gives a non-admin only the steps they can act on, and none of the admin screenshots', async () => {
    const user = userEvent.setup();
    mount(PUBLIC_URL);
    await user.click(screen.getByRole('tab', { name: 'Marketplaces' }));
    const cowork = screen.getByText('Cowork and claude.ai').closest('details') as HTMLElement;

    expect(within(cowork).queryByText('Register this deployment with your Claude organization')).toBeNull();
    expect(within(cowork).getByText('Connect your Claude account to this deployment')).toBeTruthy();
    expect(within(cowork).getByText('Add the marketplace')).toBeTruthy();
    expect(within(cowork).getByText('Install the plugins you want')).toBeTruthy();

    // The four Cowork shots, and not one of the four from Claude's admin settings.
    const alts = within(cowork).getAllByRole('img').map((el) => el.getAttribute('alt') ?? '');
    expect(alts).toHaveLength(4);
    expect(alts.some((a) => a.includes('admin settings'))).toBe(false);
  });

  it('gives an admin the registration steps as well, screenshots and all', async () => {
    adminState.isAdmin = true;
    const user = userEvent.setup();
    mount(PUBLIC_URL);
    await user.click(screen.getByRole('tab', { name: 'Marketplaces' }));
    const cowork = screen.getByText('Cowork and claude.ai').closest('details') as HTMLElement;

    expect(within(cowork).getByText('Register this deployment with your Claude organization')).toBeTruthy();
    expect(within(cowork).getByText('Connect your own Claude account to it')).toBeTruthy();
    expect(within(cowork).getAllByRole('img')).toHaveLength(8);
  });

  /**
   * Step 1 asks the reader to paste six values into Claude's form, so the six
   * values are IN step 1. Sending them to the Deployment page to fetch them
   * and back again was friction with nothing on the other end of it.
   */
  it('puts the registration credentials in the step that asks for them', async () => {
    adminState.isAdmin = true;
    const user = userEvent.setup();
    mount(PUBLIC_URL);
    await user.click(screen.getByRole('tab', { name: 'Marketplaces' }));
    const cowork = screen.getByText('Cowork and claude.ai').closest('details') as HTMLDetailsElement;
    // Closed, the drawer holds no credentials at all: a client secret is not
    // put in the DOM of something nobody opened.
    expect(within(cowork).queryByDisplayValue(FACADE.clientSecret)).toBeNull();
    expect(facadeMock).not.toHaveBeenCalled();

    await user.click(within(cowork).getByText('Cowork and claude.ai'));

    await within(cowork).findByDisplayValue(FACADE.clientSecret);
    for (const value of [FACADE.host, FACADE.appId, FACADE.clientId, FACADE.webhookSecret]) {
      expect(within(cowork).getByDisplayValue(value)).toBeTruthy();
    }
    // The key is multi-line, which the display-value matcher normalises away.
    expect(snippets().some((v) => v === FACADE.privateKeyPem)).toBe(true);
  });

  it('never asks the admin endpoint for credentials a non-admin cannot have', async () => {
    const user = userEvent.setup();
    mount(PUBLIC_URL);
    await user.click(screen.getByRole('tab', { name: 'Marketplaces' }));
    const cowork = screen.getByText('Cowork and claude.ai').closest('details') as HTMLDetailsElement;
    await user.click(within(cowork).getByText('Cowork and claude.ai'));
    expect(facadeMock).not.toHaveBeenCalled();
  });

  /**
   * Every box is decoration: `aria-hidden`, and the control it frames is
   * named in the image's own alt text. A screen reader that never sees a red
   * rectangle still gets the instruction.
   */
  it('names the highlighted control in alt text rather than only boxing it', async () => {
    adminState.isAdmin = true;
    const user = userEvent.setup();
    mount(PUBLIC_URL);
    await user.click(screen.getByRole('tab', { name: 'Marketplaces' }));
    const cowork = screen.getByText('Cowork and claude.ai').closest('details') as HTMLElement;

    for (const img of within(cowork).getAllByRole('img')) {
      expect((img.getAttribute('alt') ?? '').length).toBeGreaterThan(40);
    }
    // The deployment's own host, never a hard-coded example.
    expect(cowork).toHaveTextContent(new URL(PUBLIC_URL).host);
  });

  it('tells Claude connections from keys by their stored kind — never by the label', async () => {
    listMock.mockResolvedValue([
      { id: 'c1', kind: GITHUB_LINK_KIND, label: 'My Cowork link', createdAt: Date.now(), lastUsedAt: null, revokedAt: null },
      // A hand-made key wearing the link's usual label is still a key.
      { id: 'k1', kind: 'key', label: 'Claude (claude.ai and Cowork)', createdAt: Date.now(), lastUsedAt: null, revokedAt: null },
    ]);
    const user = userEvent.setup();
    mount(PUBLIC_URL);
    await user.click(screen.getByRole('tab', { name: 'Marketplaces' }));
    const cowork = screen.getByText('Cowork and claude.ai').closest('details') as HTMLElement;
    await screen.findByText('My Cowork link');
    expect(cowork).toHaveTextContent('My Cowork link');
    expect(cowork).not.toHaveTextContent('Claude (claude.ai and Cowork)');

    await user.click(screen.getByRole('tab', { name: 'Autonomous agents' }));
    await screen.findByText('Claude (claude.ai and Cowork)');
    expect(screen.queryByText('My Cowork link')).toBeNull();
  });

  it('says where the keys went when only Claude connections exist, and shows a load error on both tabs', async () => {
    listMock.mockResolvedValue([
      { id: 'c1', kind: GITHUB_LINK_KIND, label: 'Claude', createdAt: Date.now(), lastUsedAt: null, revokedAt: null },
    ]);
    const user = userEvent.setup();
    const first = mount(PUBLIC_URL);
    await user.click(screen.getByRole('tab', { name: 'Autonomous agents' }));
    await screen.findByText(/Your Claude connections are on the Marketplaces tab/);
    first.unmount();

    listMock.mockRejectedValue(new Error('keys are down'));
    mount(PUBLIC_URL);
    await user.click(screen.getByRole('tab', { name: 'Marketplaces' }));
    await screen.findByText('keys are down');
    expect(screen.queryByText(/None yet/)).toBeNull();
  });
});

describe('the one-click install link', () => {
  it('offers Add to Claude on a reachable deployment', () => {
    mount(PUBLIC_URL);
    const link = screen.getByRole('link', { name: 'Add to Claude' });
    const href = new URL(link.getAttribute('href')!);
    expect(href.origin + href.pathname).toBe('https://claude.ai/customize/connectors');
    expect(href.searchParams.get('modal')).toBe('add-custom-connector');
    expect(href.searchParams.get('connectorUrl')).toBe(PUBLIC_URL);
    expect(href.searchParams.get('connectorName')).toBe('Skills, Tools and Knowledge — kb.acme.com');
  });

  it('opens in a new tab without handing Claude a window reference', () => {
    mount(PUBLIC_URL);
    const link = screen.getByRole('link', { name: 'Add to Claude' });
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  /**
   * ChatGPT sits beside Claude, with the honest difference: no prefill
   * exists, so the button opens the settings pane and the copy under it
   * names the connector to type. Same gate — an endpoint Anthropic cannot
   * reach is one OpenAI cannot reach.
   */
  it('offers Add to ChatGPT beside it, naming what to call the connector', () => {
    mount(PUBLIC_URL);
    const link = screen.getByRole('link', { name: 'Add to ChatGPT' });
    // The whole href, not just the origin: the settings-pane anchor is the
    // only part that makes the link worth clicking.
    expect(link).toHaveAttribute('href', 'https://chatgpt.com/#settings/Connectors');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByText('Skills, Tools and Knowledge')).toBeInTheDocument();
  });

  it('offers no ChatGPT button on a localhost deployment', () => {
    mount(LOCALHOST_URL);
    expect(screen.queryByRole('link', { name: 'Add to ChatGPT' })).toBeNull();
  });

  /**
   * The default install. claude.ai fetches the server from Anthropic's
   * infrastructure and cannot reach a laptop, so the button would be dead —
   * and a dead button is worse than none.
   */
  it('offers nothing to click on a localhost deployment', () => {
    mount(LOCALHOST_URL);
    expect(screen.queryByRole('link', { name: 'Add to Claude' })).toBeNull();
  });

  /**
   * ...but this surface's reader is plausibly the person holding the env
   * file, so the dead state names the variable that fixes it. Without this,
   * one-click is a feature nobody can discover they are missing.
   */
  it('names PUBLIC_BACKEND_URL so an admin can turn it on', () => {
    mount(LOCALHOST_URL);
    expect(screen.getByText(/PUBLIC_BACKEND_URL/)).toBeInTheDocument();
  });

  // Whatever the button does, the manual route stays — it is the only one
  // that works on every deployment.
  it('keeps the copy-paste URL in both states', () => {
    const { unmount } = mount(PUBLIC_URL);
    expect(snippets()).toContain(PUBLIC_URL);
    unmount();
    mount(LOCALHOST_URL);
    expect(snippets()).toContain(LOCALHOST_URL);
  });
});

describe('tabs', () => {
  it('starts on the interactive tab', () => {
    mount(PUBLIC_URL);
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Your agent', 'Marketplaces', 'Autonomous agents']);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    expect(tabs[1]).toHaveAttribute('aria-selected', 'false');
  });

  /**
   * The local server authenticates by key alone, and the key is minted on
   * the other tab — so the recommended section names why a tool
   * `list_local_tools` lists is worth the trip, and its inline button walks
   * someone straight there.
   */
  it('points local-server users at the autonomous tab, and the button goes there', async () => {
    const user = userEvent.setup();
    mount(PUBLIC_URL);
    expect(screen.getByText(/local-only tools/)).toBeInTheDocument();
    expect(screen.getByText('list_local_tools')).toBeInTheDocument();
    // The local section's button and the CI footnote's point at the same
    // tab; the local section comes first.
    await user.click(screen.getAllByRole('button', { name: 'Autonomous agents' })[0]!);
    expect(screen.getByRole('tab', { name: 'Autonomous agents' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  // The install link belongs to the interactive tab only — the autonomous
  // tab is for agents that cannot open a browser at all.
  it('does not offer one-click connect on the autonomous tab', async () => {
    const user = userEvent.setup();
    mount(PUBLIC_URL);
    await user.click(screen.getByRole('tab', { name: 'Autonomous agents' }));
    expect(screen.queryByRole('link', { name: 'Add to Claude' })).toBeNull();
  });
});
