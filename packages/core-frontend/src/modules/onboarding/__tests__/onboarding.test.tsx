import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { AuthContext, type AuthContextValue } from '../../auth';
import { WelcomePage } from '../components/WelcomePage';
import { AppRegistryContext, EMPTY_REGISTRY } from '../../../core/registry';
import { ConnectAgentPill } from '../components/ConnectAgentPill';
import { RootLanding } from '../components/RootLanding';
import { WELCOME_PATH } from '../paths';
import { resetOnboardingForTests } from '../state/onboarding';
import { configureMcpUrl } from '../../../shared/mcp';
import { SidebarFrame } from '../../layout/components/SidebarFrame';
import { SIDEBAR_HEADER_TESTID } from '../../../shared/theme/header';
import { AGENT_RECHECK_MS } from '../state/agent-connection';
import type { AgentConnection } from '../services/agent-connection.api';
import { EventBusProvider } from '../../version-control';
import type { VersionControlEventPayload } from '@bevel-software/platform-shared';

/**
 * The onboarding contract, end to end on the client:
 *
 *  - `/` never redirects to the welcome page; it lands on Knowledge (or a
 *    carried deep link), even for an account that is not onboarded.
 *  - the pill is the reminder: it stays until × or Done, exactly two.
 *  - Done concludes (server write + navigation); the skip link and the copy
 *    button conclude NOTHING — leaving and copying are not promises.
 */

// No parameters: the mock never reads its arguments, and `vi.fn` records every
// call regardless of the implementation's signature — so the call assertions
// below keep working while lint stays clean.
const { authFetchMock } = vi.hoisted(() => ({
  authFetchMock: vi.fn(async () => ({ ok: true, status: 200 }) as Response),
}));
vi.mock('../../../lib/api', () => ({ authFetch: authFetchMock }));

/**
 * The agent-connection question has its own seam, so the page's one ask never
 * shows up in `authFetch` — every assertion above about what DID or did NOT
 * reach the server stays about the onboarding write alone. Default: nobody
 * has connected yet.
 */
const { fetchAgentConnectionMock } = vi.hoisted(() => ({
  fetchAgentConnectionMock: vi.fn<() => Promise<AgentConnection>>(),
}));
vi.mock('../services/agent-connection.api', () => ({ fetchAgentConnection: fetchAgentConnectionMock }));

/**
 * The `RequestInit` of a recorded `authFetch` call.
 *
 * The mock declares no parameters — deliberately, so lint stays clean — which
 * leaves `mock.calls` typed as an empty tuple even though the calls really do
 * carry two arguments. Naming that gap ONCE, here, is better than a cast at
 * every assertion that wants to read a request body.
 */
function fetchInit(call = 0): RequestInit | undefined {
  return (authFetchMock.mock.calls[call] as unknown as [string, RequestInit] | undefined)?.[1];
}

/**
 * Where `startSsoLogin` leaves a deep link for the far side of the SSO
 * round-trip. A name in the browser's session storage, so the cases below
 * stash a link the way a returning tab finds one: through the storage, not
 * through the auth module's files.
 */
const POST_LOGIN_REDIRECT_KEY = 'bevel_post_login_redirect';

/** The signed-in person, as the auth module's context hands them to a page. */
function authValue(over: Partial<AuthContextValue> = {}): AuthContextValue {
  return {
    user: { id: 'u1', email: 'juan@bevel.software', name: 'Juan Viera' },
    token: 'test-token',
    isLoading: false,
    login: vi.fn(),
    logout: vi.fn(),
    ...over,
  };
}

/** A user the server considers NOT onboarded (the explicit false matters). */
const newUser = () => authValue({ user: { id: 'u1', email: 'juan@bevel.software', name: 'Juan Viera', onboardingDone: false } });
/** The same account after the server has recorded the onboarding as done. */
const doneUser = () => authValue({ user: { id: 'u1', email: 'juan@bevel.software', name: 'Juan Viera', onboardingDone: true } });

/** Where we are. */
function LocationProbe() {
  return <div data-testid="pathname">{useLocation().pathname}</div>;
}

/**
 * Render `ui` inside the two contexts the onboarding actually reads — a
 * router at `route` and an auth context holding `auth` — plus the location
 * probe every redirect assertion below looks at. No toast provider: a toast
 * outside one is dropped, and no case here reads one.
 */
function mount(ui: React.ReactNode, auth = newUser(), route = '/') {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <AuthContext.Provider value={auth}>
        {ui}
        <LocationProbe />
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

const landingRoutes = (
  <Routes>
    <Route path="/" element={<RootLanding />} />
    <Route path={WELCOME_PATH} element={<div>welcome page</div>} />
    <Route path="/workspace" element={<div>knowledge</div>} />
  </Routes>
);

beforeEach(() => {
  resetOnboardingForTests();
  authFetchMock.mockClear();
  fetchAgentConnectionMock.mockReset().mockResolvedValue({ connected: false });
  sessionStorage.clear();
});

/**
 * jsdom ships no `navigator.clipboard`, so a copy test has to install one —
 * but only THAT property, never a replacement `navigator`: the rest of the
 * object (`userAgent`, `language`, whatever a library reaches for next) has no
 * business changing because one test wanted a spy.
 */
let restoreClipboard: (() => void) | null = null;

function stubClipboard() {
  const writeText = vi.fn().mockResolvedValue(undefined);
  const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  restoreClipboard = () => {
    if (original) Object.defineProperty(navigator, 'clipboard', original);
    else Reflect.deleteProperty(navigator, 'clipboard');
  };
  return writeText;
}

// In a hook, not at the end of a test body: a failing assertion would otherwise
// leave the stub installed for every test after it.
afterEach(() => {
  restoreClipboard?.();
  restoreClipboard = null;
  vi.unstubAllGlobals();
});

/**
 * `/` never sends anyone to the welcome page — not even a brand-new account.
 * Choosing where the knowledge lives is the only step before the app;
 * connecting an agent waits in the pill and the Get set up list.
 */
describe('RootLanding', () => {
  it('sends a brand-new account straight to Knowledge, not the welcome page', () => {
    mount(landingRoutes);
    expect(screen.getByTestId('pathname')).toHaveTextContent('/workspace');
  });

  it('sends everyone the server marked done straight to Knowledge', () => {
    mount(landingRoutes, doneUser());
    expect(screen.getByTestId('pathname')).toHaveTextContent('/workspace');
  });

  it('lands signed out (or providerless) on Knowledge too', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        {landingRoutes}
        <LocationProbe />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('pathname')).toHaveTextContent('/workspace');
  });

  /**
   * The SSO round-trip returns to a fixed callback URL, so a deep link
   * someone clicked dies in transit unless `startSsoLogin` stashed it. These
   * prove the far side: the stash is honoured, exactly once, and can never
   * point off-site.
   */
  it('sends an existing account straight to the stashed deep link, once', () => {
    const DEEP = '/workspace/main/knowledge-base/KnowledgeBase/Start here.md';
    sessionStorage.setItem(POST_LOGIN_REDIRECT_KEY, DEEP);
    mount(landingRoutes, doneUser());
    expect(screen.getByTestId('pathname')).toHaveTextContent(DEEP);
    // Taken, not peeked: the next front-door visit is an ordinary one.
    expect(sessionStorage.getItem(POST_LOGIN_REDIRECT_KEY)).toBeNull();
  });

  it('sends a brand-new account to the stashed deep link as well', () => {
    const DEEP = '/workspace/main/knowledge-base/KnowledgeBase/Start here.md';
    sessionStorage.setItem(POST_LOGIN_REDIRECT_KEY, DEEP);
    mount(landingRoutes);
    expect(screen.getByTestId('pathname')).toHaveTextContent(DEEP);
  });

  it('discards a stash that is not an in-app path — never an off-site redirect', () => {
    sessionStorage.setItem(POST_LOGIN_REDIRECT_KEY, '//evil.example/phish');
    mount(landingRoutes, doneUser());
    expect(screen.getByTestId('pathname')).toHaveTextContent('/workspace');
  });

  /**
   * The SSO callback scrubs its URL behind the router's back, so the router
   * still matches `/auth/<key>/callback` — which the shell routes here. The
   * carried link must survive that path just the same.
   */
  it('lands an /auth/* callback on the stashed deep link', () => {
    const DEEP = '/workspace/main/knowledge-base/KnowledgeBase/Start here.md';
    sessionStorage.setItem(POST_LOGIN_REDIRECT_KEY, DEEP);
    mount(
      <Routes>
        <Route path="/auth/*" element={<RootLanding />} />
        <Route path="*" element={<div>elsewhere</div>} />
      </Routes>,
      newUser(),
      '/auth/microsoft/callback',
    );
    expect(screen.getByTestId('pathname')).toHaveTextContent(DEEP);
  });
});

describe('WelcomePage', () => {
  // Every arrival is a visit — from the sidebar pill, the Get set up list or
  // a typed URL; nothing navigates here on its own.
  const mountPage = (auth = newUser()) =>
    mount(
      <Routes>
        <Route path={WELCOME_PATH} element={<WelcomePage />} />
        <Route path="/skills-and-tools" element={<div>library</div>} />
        <Route path="/skills-and-tools/yours" element={<div>your plugin</div>} />
      </Routes>,
      auth,
      WELCOME_PATH,
    );

  it('addresses the person by first name', () => {
    mountPage();
    expect(screen.getByRole('heading', { name: 'Welcome, Juan' })).toBeInTheDocument();
  });

  /**
   * Nobody is greeted any more, so the page simply exists: no hold, no fade,
   * and the nav it was opened from stays exactly where it is.
   */
  it('appears as it is, with no entrance to play', () => {
    mountPage();
    const title = screen.getByRole('heading', { name: 'Welcome, Juan' });
    expect(title.style.opacity).toBe('');
    expect(title.className).not.toContain('animate-onboarding');
  });

  // However the sign-in record spells it. The page addressed to one person is
  // the last place that should get their name wrong.
  it('capitalizes the name whatever the account holds', () => {
    mountPage(authValue({ user: { id: 'u1', email: 'j@bevel.software', name: 'juan viera', onboardingDone: false } }));
    expect(screen.getByRole('heading', { name: 'Welcome, Juan' })).toBeInTheDocument();
  });

  it('greets someone with no name at all', () => {
    mountPage(authValue({ user: { id: 'u1', email: 'j@bevel.software', name: '', onboardingDone: false } }));
    expect(screen.getByRole('heading', { name: 'Welcome, there' })).toBeInTheDocument();
  });

  /**
   * One thing in front of the reader at a time: a choice, then a single
   * action for it. Every other way in is a closed row underneath.
   */
  it('shows one thing to do at a time, following the picker', async () => {
    configureMcpUrl('https://kb.acme.com/api/mcp');
    mountPage();
    // Claude default: one button. The address to add by hand waits in a closed row.
    expect(screen.getByRole('link', { name: 'Add to Claude' })).toBeInTheDocument();
    expect(screen.getByText('Or add it by hand').closest('details')).not.toHaveAttribute('open');
    expect(screen.queryByRole('button', { name: 'Copy prompt' })).toBeNull();
    await userEvent.click(screen.getByRole('radio', { name: 'Coding agents' }));
    expect(screen.getByRole('button', { name: 'Copy prompt' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Add to Claude' })).toBeNull();
    await userEvent.click(screen.getByRole('radio', { name: 'Other' }));
    expect(screen.getByText('https://kb.acme.com/api/mcp')).toBeInTheDocument();
  });

  /**
   * ChatGPT renamed Apps & Connectors to Plugins, and a path with only the old
   * names stranded people. The one line names the current path; "Step by
   * step" names both builds and the connector's name, for whoever needs it.
   */
  it('walks ChatGPT in one line, with both builds named step by step', async () => {
    configureMcpUrl('https://kb.acme.com/api/mcp');
    mountPage();
    await userEvent.click(screen.getByRole('radio', { name: 'ChatGPT' }));
    expect(
      screen.getByText('In ChatGPT, open Settings → Plugins, turn on Developer Mode, choose Create and paste this address.'),
    ).toBeInTheDocument();
    const steps = screen.getByText('Step by step').closest('details') as HTMLDetailsElement;
    expect(steps.open).toBe(false);
    expect(steps).toHaveTextContent('Apps & Connectors in older versions');
    expect(steps).toHaveTextContent('name it “Skills, Tools and Knowledge”');
  });

  /**
   * "A JSON config" told a business user nothing, and plenty of tools take a
   * URL and nothing else. Other leads with the bare address; the
   * configuration and the Claude Code command are closed rows.
   */
  it('gives Other the bare address first, then the configuration and the Claude Code command', async () => {
    configureMcpUrl('https://kb.acme.com/api/mcp');
    const writeText = stubClipboard();
    mountPage();
    await userEvent.click(screen.getByRole('radio', { name: 'Other' }));
    expect(
      screen.getByText('In your tool’s settings, add an MCP server (also called a connector) and paste this address.'),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenLastCalledWith('https://kb.acme.com/api/mcp');

    const config = screen.getByText(/mcpServers/);
    expect(config.closest('details')).not.toHaveAttribute('open');
    expect(config.textContent).toContain('https://kb.acme.com/api/mcp');
    await userEvent.click(screen.getByRole('button', { name: 'Copy: As a JSON configuration' }));
    expect(writeText).toHaveBeenLastCalledWith(config.textContent);
    // Copying is not Done: no server write, no navigation.
    expect(authFetchMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('pathname')).toHaveTextContent(WELCOME_PATH);
  });

  /**
   * The default: Claude, which is what most people arriving here already use
   * and the one connection that is a single click.
   */
  it('defaults to Claude and its one button, without a click', () => {
    configureMcpUrl('https://kb.acme.com/api/mcp');
    mountPage();
    expect(screen.getByRole('radio', { name: 'Claude' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('link', { name: 'Add to Claude' })).toBeInTheDocument();
  });

  /**
   * An agent that can edit its own settings should not need its owner to:
   * coding agents get one prompt to paste. The configuration it carries is
   * the keyless local-server one, because the local server opens the browser
   * to sign in on first run.
   */
  it('gives coding agents a prompt that carries the keyless hexis-mcp setup', async () => {
    const writeText = stubClipboard();
    mountPage();
    await userEvent.click(screen.getByRole('radio', { name: 'Coding agents' }));
    await userEvent.click(screen.getByRole('button', { name: 'Copy prompt' }));
    const prompt = writeText.mock.calls[0]![0] as string;
    expect(prompt).toContain('@bevel-software/hexis-mcp');
    expect(prompt).toContain('claude mcp add --scope user skills-tools-knowledge');
    // Keyless = interactive sign-in: no key env at all, not a placeholder.
    expect(prompt).not.toContain('HEXIS_CONNECTION_KEY');
    expect(prompt).toMatch(/a browser window opens so I can sign in/);
    // Copying the prompt concludes nothing.
    expect(authFetchMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('pathname')).toHaveTextContent(WELCOME_PATH);
  });

  /**
   * The two ways the local server fails on a machine where it is otherwise
   * right: the wrong Node major, and an agent launched from the Dock, which
   * never read the shell profile that put `npx` on PATH. The fix for the
   * second is an absolute path, which is specific to one machine, so it
   * waits in a closed row and NOT in the snippet, which has to stay right
   * for every reader whose PATH was fine all along.
   */
  it('keeps Node and PATH trouble in closed rows, leaving the snippet on bare npx', async () => {
    mountPage();
    await userEvent.click(screen.getByRole('radio', { name: 'Coding agents' }));
    expect(screen.getByText(/Needs Node 22\.13\+ or 24/)).toBeInTheDocument();
    const trouble = screen.getByText('If the agent says npx was not found').closest('details') as HTMLDetailsElement;
    expect(trouble.open).toBe(false);
    expect(trouble).toHaveTextContent('cannot see your shell’s PATH');
    expect(trouble).toHaveTextContent('run `which npx` in a terminal');
    const snippet = screen.getByText(/"mcpServers"/).textContent!;
    expect(JSON.parse(snippet).mcpServers['skills-tools-knowledge'].command).toBe('npx');
  });

  /**
   * One click instead of a menu path. It is Claude-only because Claude is the
   * only client with a documented install link, and it appears only when
   * Anthropic could actually reach this deployment: see `canDeepLink`.
   *
   * Every case still selects the Claude option explicitly, although it is
   * the default: the link belongs to that option, and the cases say so.
   */
  describe('the Add to Claude link', () => {
    it('offers one-click connect on a reachable deployment', async () => {
      configureMcpUrl('https://kb.acme.com/api/mcp');
      mountPage();
      await userEvent.click(screen.getByRole('radio', { name: 'Claude' }));
      const link = screen.getByRole('link', { name: 'Add to Claude' });
      const href = new URL(link.getAttribute('href')!);
      expect(href.origin + href.pathname).toBe('https://claude.ai/customize/connectors');
      expect(href.searchParams.get('connectorUrl')).toBe('https://kb.acme.com/api/mcp');
      expect(href.searchParams.get('connectorName')).toBe('Skills, Tools and Knowledge — kb.acme.com');
    });

    /**
     * The default install: `PUBLIC_BACKEND_URL` unset means localhost, which
     * claude.ai cannot reach. A dead button, or an address Claude cannot use,
     * on the first screen a self-hoster sees reads as a broken product. The
     * page says so in one line and opens on what does work.
     */
    it('says Claude cannot reach a localhost deployment, and opens on coding agents', async () => {
      configureMcpUrl('http://localhost:3001/api/mcp');
      mountPage();
      expect(screen.getByRole('radio', { name: 'Coding agents' })).toHaveAttribute('aria-checked', 'true');
      await userEvent.click(screen.getByRole('radio', { name: 'Claude' }));
      expect(screen.queryByRole('link', { name: 'Add to Claude' })).toBeNull();
      expect(screen.getByText(/Claude connects over the internet, and this deployment has no public https address/)).toBeInTheDocument();
      expect(screen.queryByText('http://localhost:3001/api/mcp')).toBeNull();
    });

    /**
     * No `PUBLIC_BACKEND_URL` hint on THIS surface. The reader is a new
     * employee who cannot change deployment config; naming an env var at them
     * is noise.
     */
    it('does not lecture a new employee about deployment config', async () => {
      configureMcpUrl('http://localhost:3001/api/mcp');
      mountPage();
      await userEvent.click(screen.getByRole('radio', { name: 'Claude' }));
      expect(screen.queryByText(/PUBLIC_BACKEND_URL/)).toBeNull();
    });

    it('belongs to Claude alone', async () => {
      configureMcpUrl('https://kb.acme.com/api/mcp');
      mountPage();
      await userEvent.click(screen.getByRole('radio', { name: 'Claude' }));
      expect(screen.getByRole('link', { name: 'Add to Claude' })).toBeInTheDocument();
      for (const other of ['ChatGPT', 'Coding agents', 'Other']) {
        await userEvent.click(screen.getByRole('radio', { name: other }));
        expect(screen.queryByRole('link', { name: 'Add to Claude' })).toBeNull();
      }
    });

    /**
     * ChatGPT gets its own link, on its own option only. It cannot prefill
     * anything, so it says what it does (it opens ChatGPT) and sits after the
     * address the reader pastes there.
     */
    it('offers Open ChatGPT on the ChatGPT option alone, after the address', async () => {
      configureMcpUrl('https://kb.acme.com/api/mcp');
      mountPage();
      // The default (Claude) carries no ChatGPT link.
      expect(screen.queryByRole('link', { name: 'Open ChatGPT' })).toBeNull();
      await userEvent.click(screen.getByRole('radio', { name: 'ChatGPT' }));
      const link = screen.getByRole('link', { name: 'Open ChatGPT' });
      expect(link).toHaveAttribute('href', 'https://chatgpt.com/#settings');
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
      const address = screen.getByText('https://kb.acme.com/api/mcp');
      expect(address.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('offers no ChatGPT link on a localhost deployment either', async () => {
      configureMcpUrl('http://localhost:3001/api/mcp');
      mountPage();
      await userEvent.click(screen.getByRole('radio', { name: 'ChatGPT' }));
      expect(screen.queryByRole('link', { name: 'Open ChatGPT' })).toBeNull();
      expect(screen.getByText(/ChatGPT connects over the internet/)).toBeInTheDocument();
    });

    // Opening claude.ai must not hand it a handle on this window.
    it('opens in a new tab safely', async () => {
      configureMcpUrl('https://kb.acme.com/api/mcp');
      mountPage();
      await userEvent.click(screen.getByRole('radio', { name: 'Claude' }));
      const link = screen.getByRole('link', { name: 'Add to Claude' });
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    });

    /**
     * The whole point of the canonical URL: what the button hands Claude and
     * what "Or add it by hand" shows a human must be the same string, or one
     * of them is lying.
     */
    it('hands Claude exactly the URL the by-hand row shows', async () => {
      configureMcpUrl('https://kb.acme.com/api/mcp');
      mountPage();
      await userEvent.click(screen.getByRole('radio', { name: 'Claude' }));
      const href = new URL(
        screen.getByRole('link', { name: 'Add to Claude' }).getAttribute('href')!,
      );
      expect(href.searchParams.get('connectorUrl')).toBe(
        screen.getByText(/\/api\/mcp$/).textContent,
      );
    });
  });

  // Exact, not a substring: `/skills-and-tools` is a PREFIX of the personal
  // plugin's path, so a loose match would pass even if Done dropped someone in
  // the whole company's catalog instead of their own shelf.
  it('Done concludes: server write + landing in your own plugin', async () => {
    mountPage();
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(authFetchMock).toHaveBeenCalledWith(
      '/api/auth/onboarding-done',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(screen.getByTestId('pathname')).toHaveTextContent(/^\/skills-and-tools\/yours$/);
  });

  // Both exits, one destination: stated as its own fact so a future change to
  // either button has to face the question deliberately.
  it('sends you to the same place whether you finish or skip', async () => {
    mountPage();
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    const afterDone = screen.getByTestId('pathname').textContent;
    cleanup();
    mountPage();
    await userEvent.click(screen.getByRole('button', { name: /Go to your skills/ }));
    expect(screen.getByTestId('pathname')).toHaveTextContent(afterDone!);
  });

  // Exclusive-choice semantics: `radio` says one of these is always chosen
  // and the others are not. Three `aria-pressed` toggles said any combination,
  // including none, was possible.
  it('presents the client picker as an exclusive choice', async () => {
    configureMcpUrl('https://kb.acme.com/api/mcp');
    mountPage();
    const group = screen.getByRole('radiogroup', { name: 'Your agent' });
    const options = screen.getAllByRole('radio');
    expect(group).toContainElement(options[0]!);
    // Claude and ChatGPT lead; Claude is the default.
    expect(options.map((o) => o.textContent)).toEqual(['Claude', 'ChatGPT', 'Coding agents', 'Other']);
    expect(options.map((o) => o.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false', 'false']);
    await userEvent.click(screen.getByRole('radio', { name: 'Coding agents' }));
    expect(screen.getAllByRole('radio').map((o) => o.getAttribute('aria-checked'))).toEqual([
      'false',
      'false',
      'true',
      'false',
    ]);
  });

  /**
   * `role="radiogroup"` is a promise about the keyboard, not just a label for
   * a screen reader: arrows select, and selection follows focus. The picker
   * wraps, because four options in a row have no edge worth stopping at.
   */
  it('drives the picker with the arrow keys, wrapping at both ends', async () => {
    configureMcpUrl('https://kb.acme.com/api/mcp');
    mountPage();
    const checked = () =>
      screen.getAllByRole('radio').find((o) => o.getAttribute('aria-checked') === 'true');

    screen.getByRole('radio', { name: 'Claude' }).focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(checked()).toHaveAccessibleName('ChatGPT');
    expect(checked()).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    expect(checked()).toHaveAccessibleName('Coding agents');
    await userEvent.keyboard('{ArrowRight}');
    expect(checked()).toHaveAccessibleName('Other');

    // Off the end and round to the first.
    await userEvent.keyboard('{ArrowRight}');
    expect(checked()).toHaveAccessibleName('Claude');

    // And backwards past the start, to the last.
    await userEvent.keyboard('{ArrowLeft}');
    expect(checked()).toHaveAccessibleName('Other');
  });

  // Roving tabindex: the picker is ONE tab stop, not one per client.
  it('offers a single tab stop for the whole picker', () => {
    configureMcpUrl('https://kb.acme.com/api/mcp');
    mountPage();
    expect(screen.getAllByRole('radio').map((o) => o.getAttribute('tabindex'))).toEqual(['0', '-1', '-1', '-1']);
  });

  // Into the person's OWN plugin, not the whole catalog — the same place the
  // sidebar's personal row goes.
  it('the skip link leaves for your own plugin, without concluding', async () => {
    mountPage();
    await userEvent.click(screen.getByRole('button', { name: /Go to your skills/ }));
    expect(authFetchMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('pathname')).toHaveTextContent('/skills-and-tools/yours');
  });

  /**
   * `AppRegistry.welcomeExit` moves where a new person starts. WHERE that is,
   * is a property of the product: core sends them to their own skills shelf,
   * because on a core deployment that is the product and a fresh knowledge
   * base is empty. A distribution built around the knowledge graph wants the
   * opposite and would otherwise greet someone and then leave them in a
   * surface they did not come for.
   *
   * The tests above deliberately mount WITHOUT a registry, so they pin the
   * default: the seam must be invisible to a deployment that does not use it.
   */
  describe('welcomeExit', () => {
    const mountWithExit = (welcomeExit: { path: string; label: string } | undefined) =>
      mount(
        <AppRegistryContext.Provider value={{ ...EMPTY_REGISTRY, welcomeExit }}>
          <Routes>
            <Route path={WELCOME_PATH} element={<WelcomePage />} />
            <Route path="/skills-and-tools/yours" element={<div>your plugin</div>} />
            <Route path="/workspace" element={<div>knowledge</div>} />
          </Routes>
        </AppRegistryContext.Provider>,
        newUser(),
        WELCOME_PATH,
      );

    it('sends both exits to the configured destination', async () => {
      mountWithExit({ path: '/workspace', label: 'Go to your knowledge base' });
      await userEvent.click(screen.getByRole('button', { name: 'Done' }));
      expect(screen.getByTestId('pathname')).toHaveTextContent('/workspace');
    });

    /**
     * The label travels WITH the path. "Go to your skills →" pointing at a
     * knowledge base is a lie, and letting a caller set one without the other
     * is the likeliest way to produce it.
     */
    it('labels the skip link with the configured destination', () => {
      mountWithExit({ path: '/workspace', label: 'Go to your knowledge base' });
      expect(
        screen.getByRole('button', { name: /Go to your knowledge base/ }),
      ).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Go to your skills/ })).not.toBeInTheDocument();
    });

    it('falls back to the skills shelf when a registry sets nothing', async () => {
      mountWithExit(undefined);
      expect(screen.getByRole('button', { name: /Go to your skills/ })).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Done' }));
      expect(screen.getByTestId('pathname')).toHaveTextContent('/skills-and-tools/yours');
    });
  });
});

/**
 * The server's event stream, as the browser offers it. The test DOM ships no
 * EventSource; this one keeps the listeners the real `EventBusProvider`
 * registers and lets a test send an event down the stream, so the page is
 * driven the way the backend drives it: by a message on the wire, through the
 * provider the app mounts (as `GitSyncFailedBanner.test.tsx` does).
 */
class FakeEventSource {
  static latest: FakeEventSource | null = null;
  private readonly listeners = new Map<string, ((e: Event) => void)[]>();
  constructor() {
    FakeEventSource.latest = this;
  }
  addEventListener(type: string, fn: (e: Event) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  removeEventListener(type: string, fn: (e: Event) => void) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== fn));
  }
  close() {}
  send(event: unknown) {
    const message = new MessageEvent('message', { data: JSON.stringify(event) });
    for (const fn of [...(this.listeners.get('message') ?? [])]) fn(message);
  }
}

/** Sends one event down the stream the mounted provider opened. */
function emit(event: VersionControlEventPayload) {
  act(() => {
    FakeEventSource.latest?.send({ id: 1, ts: new Date().toISOString(), ...event });
  });
}

const ARRIVED: VersionControlEventPayload = {
  kind: 'agent-connected',
  forUserId: 'u1',
  client: 'Claude',
  agentKind: 'agent',
  at: '2026-10-07T12:00:00.000Z',
};

/**
 * "Did it work?" answered on the page: a quiet waiting line that turns into
 * a plain "Connected" the moment the server says the agent's first call
 * landed — and that conclusion does what Done does to the onboarding, once.
 * The page asks once on arrival and listens from then on; it never asks on
 * a timer.
 */
describe('WelcomePage: is your agent connected?', () => {
  beforeEach(() => {
    FakeEventSource.latest = null;
    vi.stubGlobal('EventSource', FakeEventSource);
    // The provider's focus POST, which this page has no stake in.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
  });

  /** The page under the provider the app mounts; `leave()` takes the page away and keeps the stream. */
  const mountPage = (auth = newUser()) => {
    const tree = (page: boolean) => (
      <EventBusProvider>
        <Routes>
          <Route path={WELCOME_PATH} element={page ? <WelcomePage /> : <div>elsewhere</div>} />
        </Routes>
      </EventBusProvider>
    );
    const rendered = mount(tree(true), auth, WELCOME_PATH);
    return { ...rendered, leave: () => rendered.rerender(
      <MemoryRouter initialEntries={[WELCOME_PATH]}>
        <AuthContext.Provider value={auth}>{tree(false)}</AuthContext.Provider>
      </MemoryRouter>,
    ) };
  };

  /** Calls to the onboarding write — the one `markDone` makes. */
  const doneWrites = () =>
    authFetchMock.mock.calls.filter((c) => (c as unknown[])[0] === '/api/auth/onboarding-done').length;

  /** Let the pending answer land. */
  const settle = () => act(async () => {});

  /** The page waits for the agent only once the reader has acted: copy the prompt. */
  const actOnThePage = () => {
    fireEvent.click(screen.getByRole('radio', { name: 'Coding agents' }));
    fireEvent.click(screen.getByRole('button', { name: 'Copy prompt' }));
  };

  afterEach(() => {
    vi.useRealTimers();
    Reflect.deleteProperty(document, 'hidden');
  });

  it('waits quietly, turns green when the server says the agent arrived, and concludes once', async () => {
    mountPage();
    await settle();
    // One live region, the same element in both states, so the change is announced.
    // Nothing is waited for until the reader has done something.
    expect(screen.queryByText('Waiting for your agent…')).not.toBeInTheDocument();
    actOnThePage();
    const status = screen.getByText('Waiting for your agent…').closest('[role="status"]') as HTMLElement;
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(fetchAgentConnectionMock).toHaveBeenCalledTimes(1);
    expect(doneWrites()).toBe(0);

    emit(ARRIVED);
    expect(status).toHaveTextContent('Connected. Your agent reached this knowledge base.');
    expect(status).not.toHaveTextContent('Waiting');
    expect(doneWrites()).toBe(1);
    expect(fetchInit(0)?.body).toBe(JSON.stringify({ userId: 'u1' }));

    // Connected is final: nothing more is asked, and no second conclusion.
    emit(ARRIVED);
    await settle();
    expect(fetchAgentConnectionMock).toHaveBeenCalledTimes(1);
    expect(doneWrites()).toBe(1);
  });

  it("stays waiting on another account's agent", async () => {
    mountPage();
    await settle();
    actOnThePage();
    emit({ ...ARRIVED, forUserId: 'u2' });
    expect(screen.getByText('Waiting for your agent…')).toBeInTheDocument();
    expect(doneWrites()).toBe(0);
  });

  it('shows the green state straight away for an agent connected before you arrived', async () => {
    fetchAgentConnectionMock.mockResolvedValue({ connected: true, client: 'Claude' });
    mountPage();
    // Before the first answer the line is empty, never a flash of "Waiting".
    expect(screen.queryByText('Waiting for your agent…')).not.toBeInTheDocument();
    await settle();
    expect(screen.getByText('Connected. Your agent reached this knowledge base.')).toBeInTheDocument();
    expect(doneWrites()).toBe(1);
    expect(fetchAgentConnectionMock).toHaveBeenCalledTimes(1);
  });

  /**
   * Someone who finished the onboarding and came back to copy a snippet is
   * waiting on nothing: no ask, no listening, no "Waiting" line, no second
   * conclusion.
   */
  it('asks nothing for an account that already finished the onboarding', async () => {
    fetchAgentConnectionMock.mockResolvedValue({ connected: true, client: 'Claude' });
    mountPage(doneUser());
    await settle();
    expect(fetchAgentConnectionMock).not.toHaveBeenCalled();
    expect(screen.queryByText('Waiting for your agent…')).not.toBeInTheDocument();
    // Not listening: an arrival on the stream changes nothing.
    emit(ARRIVED);
    expect(screen.queryByText(/^Connected\./)).not.toBeInTheDocument();
    expect(doneWrites()).toBe(0);
  });

  /**
   * A failed ask reads as "not yet", and nothing retries it on a timer: the
   * event says when it changes, and a return to the tab asks again — once
   * per {@link AGENT_RECHECK_MS} at most — for an agent that connected
   * while the stream was down.
   */
  it('reads a failed ask as "not yet", never retries on a timer, and asks again on a return to the tab', async () => {
    vi.useFakeTimers();
    fetchAgentConnectionMock.mockRejectedValueOnce(new Error('503')).mockResolvedValue({ connected: false });
    mountPage();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchAgentConnectionMock).toHaveBeenCalledTimes(1);
    actOnThePage();
    expect(screen.getByText('Waiting for your agent…')).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AGENT_RECHECK_MS * 10);
    });
    expect(fetchAgentConnectionMock).toHaveBeenCalledTimes(1);

    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchAgentConnectionMock).toHaveBeenCalledTimes(2);
    expect(doneWrites()).toBe(0);
  });

  it('stops listening when you leave the page', async () => {
    const { leave } = mountPage();
    await settle();
    actOnThePage();
    leave();
    // The stream stays open; the page that listened to it is gone.
    emit(ARRIVED);
    expect(doneWrites()).toBe(0);
  });
});

describe('ConnectAgentPill', () => {
  const mountPill = (auth = newUser(), route = '/skills-and-tools') =>
    mount(
      <Routes>
        <Route path="*" element={<ConnectAgentPill />} />
      </Routes>,
      auth,
      route,
    );

  it('shows for a not-onboarded account and leads to the welcome page', async () => {
    mountPill();
    await userEvent.click(screen.getByRole('button', { name: 'Connect your agent' }));
    expect(screen.getByTestId('pathname')).toHaveTextContent(WELCOME_PATH);
  });

  it('renders nothing once the server says done', () => {
    mountPill(doneUser());
    expect(screen.queryByRole('button', { name: 'Connect your agent' })).toBeNull();
  });

  // `page`, not `true` — the pill navigates, so the value that means "this is
  // the page you are on" is the one a screen reader announces as such.
  it('wears the selected state on the welcome page itself', () => {
    mountPill(newUser(), WELCOME_PATH);
    expect(screen.getByRole('button', { name: 'Connect your agent' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('claims no current page anywhere else', () => {
    mountPill();
    expect(screen.getByRole('button', { name: 'Connect your agent' })).not.toHaveAttribute(
      'aria-current',
    );
  });

  it('the × concludes: same field as Done. And the pill goes', async () => {
    mountPill();
    await userEvent.click(screen.getByRole('button', { name: /^Dismiss/ }));
    expect(authFetchMock).toHaveBeenCalledWith(
      '/api/auth/onboarding-done',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(screen.queryByRole('button', { name: 'Connect your agent' })).toBeNull();
  });

  // The stale-tab guard's client half: the request states which account it
  // means, so the server can refuse to conclude somebody else's onboarding.
  it('states which account it is concluding', async () => {
    mountPill();
    await userEvent.click(screen.getByRole('button', { name: /^Dismiss/ }));
    expect(JSON.parse(String(fetchInit()?.body))).toEqual({ userId: 'u1' });
  });

  /**
   * The pill fills `SidebarFrame`'s header band, which is spent on a header
   * that DRAWS and collapses (`empty:hidden`) for one that does not. "Does
   * not" is read off the DOM — an element that renders null is still an
   * element — so a pill with nothing to say has to leave the row literally
   * empty, and its dismissal receipt goes to the body rather than sitting in
   * the band invisibly holding 48px open above "Company Context".
   *
   * Both halves in one test on purpose: an empty row that had lost the
   * announcement with it would pass the first assertion and be a regression.
   */
  it('leaves the header band empty once onboarding is done, and still says so out loud', async () => {
    mount(
      <SidebarFrame label="Library navigation" header={<ConnectAgentPill />}>
        <nav>Company Context</nav>
      </SidebarFrame>,
      newUser(),
      '/skills-and-tools',
    );
    const band = screen.getByTestId(SIDEBAR_HEADER_TESTID);
    expect(band).not.toBeEmptyDOMElement();

    await userEvent.click(screen.getByRole('button', { name: /^Dismiss/ }));

    expect(band).toBeEmptyDOMElement();
    expect(
      screen.getAllByRole('status').some((r) => /Reminder dismissed/.test(r.textContent ?? '')),
    ).toBe(true);
  });

  it('leaves it empty for an account that was already done', () => {
    mount(
      <SidebarFrame label="Library navigation" header={<ConnectAgentPill />}>
        <nav>Company Context</nav>
      </SidebarFrame>,
      doneUser(),
      '/skills-and-tools',
    );
    expect(screen.getByTestId(SIDEBAR_HEADER_TESTID)).toBeEmptyDOMElement();
  });

  /**
   * A write that never landed must not leave the UI claiming it did. The pill
   * comes back immediately, rather than mysteriously reappearing at the next
   * sign-in with no account of why it left.
   */
  it('brings the pill back when the server refuses the write', async () => {
    authFetchMock.mockResolvedValueOnce({ ok: false, status: 409 } as Response);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    mountPill();
    await userEvent.click(screen.getByRole('button', { name: /^Dismiss/ }));
    expect(
      await screen.findByRole('button', { name: 'Connect your agent' }),
    ).toBeInTheDocument();
    errors.mockRestore();
  });
});
