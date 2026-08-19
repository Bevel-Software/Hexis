import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ExternalAgentAccessPage } from '../ExternalAgentAccessPage';
import { configureMcpUrl } from '../../../../shared/mcp';

/**
 * The Connect page's contract, and the reason this file exists at all: every
 * address it hands out is the DEPLOYMENT's, never the browser's.
 *
 * Six sites on this page used to rebuild the endpoint from
 * `window.location.origin` — three keyless, three carrying a freshly minted
 * external API key. They agreed with the server's own idea of its address
 * only by luck, and a proxy or a second domain was enough to break it. The
 * regression cases below name all six.
 */

const { listMock, createMock } = vi.hoisted(() => ({
  listMock: vi.fn(),
  createMock: vi.fn(),
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

beforeEach(() => {
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

describe('the interactive tab quotes the deployment, not the browser', () => {
  it('builds all three keyless snippets from the configured URL', () => {
    mount(PUBLIC_URL);
    const values = snippets();

    // 1. the Claude Code one-liner
    expect(values).toContain(
      `claude mcp add --transport http knowledge-base ${PUBLIC_URL}`,
    );
    // 2. the bare URL for claude.ai / Claude Desktop
    expect(values).toContain(PUBLIC_URL);
    // 3. the JSON config for everything else
    const json = values.find((v) => v.includes('mcpServers'));
    expect(JSON.parse(json!).mcpServers['knowledge-base'].url).toBe(PUBLIC_URL);
  });

  /**
   * The regression stated as a negative: the page's own origin must appear
   * nowhere, or one of the six sites quietly went back to deriving it.
   */
  it('never falls back to the page origin', () => {
    mount(PUBLIC_URL);
    for (const value of snippets()) {
      expect(value).not.toContain(window.location.origin);
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
      `claude mcp add --transport http knowledge-base ${PUBLIC_URL} --header "Authorization: Bearer ${KEY}"`,
    );
    // 5. the Langdock field list
    expect(values).toContain(
      `URL: ${PUBLIC_URL}\nHeader name: Authorization\nHeader value: Bearer ${KEY}`,
    );
    // 6. the JSON config, with the key
    const json = values.find((v) => v.includes('mcpServers') && v.includes('headers'));
    const parsed = JSON.parse(json!).mcpServers['knowledge-base'];
    expect(parsed.url).toBe(PUBLIC_URL);
    expect(parsed.headers.Authorization).toBe(`Bearer ${KEY}`);
  });

  /**
   * The local-tools block is the ONE place the page's own origin is right:
   * hexis-mcp takes the workspace's address — the one the browser provably
   * loaded this app from — and resolves the MCP endpoint from it itself,
   * so the configured `mcpUrl` (possibly a proxy serving only the MCP path)
   * must appear in neither snippet.
   */
  it('hands the local server the workspace origin, with the minted key in both snippets', async () => {
    const user = userEvent.setup();
    mount(PUBLIC_URL);
    await revealAKey(user);
    expect(screen.getByText('Local tools on this machine (hexis-mcp)')).toBeInTheDocument();
    const values = snippets();

    // 7. the Claude Code stdio one-liner
    expect(values).toContain(
      `claude mcp add hexis-local --env HEXIS_URL="${window.location.origin}" --env HEXIS_CONNECTION_KEY="${KEY}" -- npx -y @bevel-software/hexis-mcp`,
    );
    // 8. the JSON config that spawns the package
    const json = values.find((v) => v.includes('mcpServers') && v.includes('hexis-local'));
    const parsed = JSON.parse(json!).mcpServers['hexis-local'];
    expect(parsed.args).toEqual(['-y', '@bevel-software/hexis-mcp']);
    expect(parsed.env.HEXIS_URL).toBe(window.location.origin);
    expect(parsed.env.HEXIS_CONNECTION_KEY).toBe(KEY);
    expect(json).not.toContain(PUBLIC_URL);
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
      // the reveal textarea itself, the three keyed hosted snippets, and the
      // two local-server (hexis-mcp) snippets
      6,
    );
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
    expect(href.searchParams.get('connectorName')).toBe('Hexis — kb.acme.com');
  });

  it('opens in a new tab without handing Claude a window reference', () => {
    mount(PUBLIC_URL);
    const link = screen.getByRole('link', { name: 'Add to Claude' });
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
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
    expect(tabs.map((t) => t.textContent)).toEqual(['Your agent', 'Autonomous agents']);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    expect(tabs[1]).toHaveAttribute('aria-selected', 'false');
  });

  /**
   * The interactive tab's configs all point at the HOSTED endpoint, which
   * skips local-only tools by construction. The footnote is what tells
   * someone why a tool `list_local_tools` names is not in their agent — and
   * its inline button walks them to the tab where the key (and with it the
   * hexis-mcp setup) is minted.
   */
  it('points local-tools users at the autonomous tab, and the button goes there', async () => {
    const user = userEvent.setup();
    mount(PUBLIC_URL);
    expect(screen.getByText(/local-only tools/)).toBeInTheDocument();
    expect(screen.getByText('list_local_tools')).toBeInTheDocument();
    // Two footnotes point at the same tab; the local-tools one comes first.
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
