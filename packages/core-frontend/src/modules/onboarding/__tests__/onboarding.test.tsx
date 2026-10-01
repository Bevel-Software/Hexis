import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, renderHook, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { AuthContext } from '../../auth/state/auth.context';
import { authValue } from '../../library/__tests__/auth-harness';
import { LibraryToastProvider } from '../../library/state/toast';
import { WelcomePage } from '../components/WelcomePage';
import { AppRegistryContext, EMPTY_REGISTRY } from '../../../core/registry';
import { ConnectAgentPill } from '../components/ConnectAgentPill';
import { RootLanding } from '../components/RootLanding';
import { POST_LOGIN_REDIRECT_KEY } from '../../auth/services/sso';
import { WELCOME_PATH } from '../paths';
import { resetOnboardingForTests } from '../state/onboarding';
import { configureMcpUrl } from '../../../shared/mcp';
import { setSidebarCollapsed, useSidebar } from '../../layout/state/sidebar';
import { SidebarFrame } from '../../layout/components/SidebarFrame';
import { SIDEBAR_HEADER_TESTID } from '../../../shared/theme/header';

/**
 * The onboarding contract, end to end on the client:
 *
 *  - `/` redirects to the welcome page ONCE, on an account the server says is
 *    not onboarded — and never hijacks anything after that first greeting.
 *  - the pill outlives the redirect: it stays until × or Done, exactly two.
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

/** A user the server considers NOT onboarded (the explicit false matters). */
const newUser = () => authValue({ user: { id: 'u1', email: 'juan@bevel.software', name: 'Juan Viera', onboardingDone: false } });
/** The same account after the server has recorded the onboarding as done. */
const doneUser = () => authValue({ user: { id: 'u1', email: 'juan@bevel.software', name: 'Juan Viera', onboardingDone: true } });

/** Reads the sidebar store the way a component would. */
function sidebarState() {
  return renderHook(() => useSidebar()).result.current;
}

/** Where we are, whether we got here by being greeted, and any carried link. */
function LocationProbe() {
  const { pathname, state } = useLocation();
  const s = state as { greeting?: boolean; returnTo?: string | null } | null;
  return (
    <>
      <div data-testid="pathname">{pathname}</div>
      <div data-testid="greeting">{String(s?.greeting === true)}</div>
      <div data-testid="returnTo">{s?.returnTo ?? ''}</div>
    </>
  );
}

/** The welcome page as the first-sign-in redirect leaves it: greeted. */
const greeted = { pathname: WELCOME_PATH, state: { greeting: true } };

/**
 * Render `ui` inside the three contexts the onboarding actually reads — a
 * router at `route`, an auth context holding `auth`, and the toast provider —
 * plus the location probe every redirect assertion below looks at. `route`
 * takes a location object when a test needs to arrive as the greeting does.
 */
function mount(
  ui: React.ReactNode,
  auth = newUser(),
  route: string | { pathname: string; state?: unknown } = '/',
) {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <AuthContext.Provider value={auth}>
        <LibraryToastProvider>
          {ui}
          <LocationProbe />
        </LibraryToastProvider>
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

describe('RootLanding: the one-time greeting', () => {
  it('sends a brand-new account to the welcome page', () => {
    mount(landingRoutes);
    expect(screen.getByTestId('pathname')).toHaveTextContent(WELCOME_PATH);
  });

  // The flag the page reads to know this arrival is a ceremony rather than a
  // visit — the sidebar collapse hangs off it, and only this navigation sets it.
  it('marks the automatic redirect as a greeting', () => {
    mount(landingRoutes);
    expect(screen.getByTestId('greeting')).toHaveTextContent('true');
  });

  it('sends everyone the server marked done straight to Knowledge', () => {
    mount(landingRoutes, doneUser());
    expect(screen.getByTestId('pathname')).toHaveTextContent('/workspace');
  });

  // Optional-field semantics: an ABSENT flag (old fixture, cached session)
  // must never resurrect the welcome flow. Only an explicit false onboards.
  it('treats a missing flag as done, not as new', () => {
    mount(landingRoutes, authValue());
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

  it('greets a brand-new account first, handing the link to the welcome page', () => {
    const DEEP = '/workspace/main/knowledge-base/KnowledgeBase/Start here.md';
    sessionStorage.setItem(POST_LOGIN_REDIRECT_KEY, DEEP);
    mount(landingRoutes);
    expect(screen.getByTestId('pathname')).toHaveTextContent(WELCOME_PATH);
    expect(screen.getByTestId('greeting')).toHaveTextContent('true');
    expect(screen.getByTestId('returnTo')).toHaveTextContent(DEEP);
  });

  it('discards a stash that is not an in-app path — never an off-site redirect', () => {
    sessionStorage.setItem(POST_LOGIN_REDIRECT_KEY, '//evil.example/phish');
    mount(landingRoutes, doneUser());
    expect(screen.getByTestId('pathname')).toHaveTextContent('/workspace');
  });

  it('greets ONCE: after the welcome page has been seen, / goes to Knowledge', async () => {
    mount(
      <Routes>
        <Route path="/" element={<RootLanding />} />
        <Route path={WELCOME_PATH} element={<WelcomePage />} />
        <Route path="/workspace" element={<div>knowledge</div>} />
      </Routes>,
    );
    // Landed on the real page, which marks `welcomed` on mount.
    await screen.findByRole('heading', { name: /Welcome, Juan/ });
    cleanup();
    // A fresh visit to `/` — same account, same browser.
    mount(landingRoutes);
    expect(screen.getByTestId('pathname')).toHaveTextContent('/workspace');
  });
});

describe('WelcomePage', () => {
  // Default: the ordinary visit, from the sidebar pill. The greeting — the
  // one-time redirect — is the special case, and says so at each call site.
  const mountPage = (auth = newUser(), route: string | typeof greeted = WELCOME_PATH) =>
    mount(
      <Routes>
        <Route path={WELCOME_PATH} element={<WelcomePage />} />
        <Route path="/skills-and-tools" element={<div>library</div>} />
        <Route path="/skills-and-tools/yours" element={<div>your plugin</div>} />
      </Routes>,
      auth,
      route,
    );

  it('addresses the person by first name', () => {
    mountPage();
    expect(screen.getByRole('heading', { name: 'Welcome, Juan' })).toBeInTheDocument();
  });

  /**
   * The entrance must BEGIN on a painted frame. A CSS animation runs on the
   * document timeline whether or not the browser is producing frames, so an
   * animation attached at mount can elapse entirely during a cold boot and
   * never be seen — the bug that made this page "just appear" at every
   * duration we tried. Held invisible first, animating second.
   */
  it('starts its entrance on a painted frame, not at mount', async () => {
    mountPage(newUser(), greeted);
    const title = screen.getByRole('heading', { name: 'Welcome, Juan' });
    const body = screen.getByText(/company’s shared library/).parentElement!;
    // An inline style, deliberately — a utility class would depend on Tailwind
    // having compiled it, and that is exactly what failed silently before.
    expect(title.style.opacity).toBe('0');
    expect(body.style.opacity).toBe('0');
    await waitFor(() => {
      expect(title.className).toContain('animate-onboarding-greeting');
      expect(body.className).toContain('animate-onboarding-body');
    });
    // …and never both at once: held invisible and animating would fight.
    expect(title.style.opacity).toBe('');
    expect(body.style.opacity).toBe('');
  });

  /**
   * Being welcomed happens once. Opening the same page from the pill later is
   * a visit, and a 2.6s arrival every time you come back to copy your MCP
   * snippet is a page you learn to dread — so there is no hold and no fade,
   * only the page.
   */
  it('does not replay the entrance when you open it from the pill', () => {
    mountPage();
    const title = screen.getByRole('heading', { name: 'Welcome, Juan' });
    expect(title.style.opacity).toBe('');
    expect(title.className).not.toContain('animate-onboarding-greeting');
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
   * The nav gets out of the way for the greeting and STAYS out — there is no
   * restore. Putting it back meant leaving a screen with no nav and arriving
   * at one where the nav had opened itself, which is the app rearranging a
   * page you asked for. Whether the sidebar shows is the toolbar toggle's to
   * say, and after the greeting it says whatever it said last.
   */
  it('collapses the sidebar for the greeting, without animating it', () => {
    setSidebarCollapsed(false);
    mountPage(newUser(), greeted);
    expect(sidebarState()).toMatchObject({ collapsed: true, instant: true });
  });

  it('leaves it collapsed when you go to your own plugin', async () => {
    setSidebarCollapsed(false);
    mountPage(newUser(), greeted);
    await userEvent.click(screen.getByRole('button', { name: /Go to your skills/ }));
    expect(screen.getByTestId('pathname')).toHaveTextContent('/skills-and-tools/yours');
    expect(sidebarState().collapsed).toBe(true);
  });

  it('leaves it collapsed after Done too', async () => {
    setSidebarCollapsed(false);
    mountPage(newUser(), greeted);
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(sidebarState().collapsed).toBe(true);
  });

  /**
   * The one case where the nav is showing on the way out: you opened it
   * yourself while you were here. The page collapses once, on arrival, and
   * never touches the store again — so your gesture is the last word.
   */
  it('respects a sidebar you opened yourself while reading the page', async () => {
    setSidebarCollapsed(false);
    mountPage(newUser(), greeted);
    expect(sidebarState().collapsed).toBe(true);
    setSidebarCollapsed(false); // …the toolbar toggle, from the user's hand
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(sidebarState().collapsed).toBe(false);
  });

  it('leaves it collapsed for someone who arrived that way', () => {
    setSidebarCollapsed(true);
    const { unmount } = mountPage(newUser(), greeted);
    expect(sidebarState().collapsed).toBe(true);
    unmount();
    expect(sidebarState().collapsed).toBe(true);
  });

  // Reached from the pill it is a page, not a ceremony: the nav it was just
  // clicked in stays exactly where it is.
  it('leaves the sidebar alone when you open it from the pill', () => {
    setSidebarCollapsed(false);
    const { unmount } = mountPage();
    expect(sidebarState().collapsed).toBe(false);
    unmount();
    expect(sidebarState().collapsed).toBe(false);
  });

  it('shows one snippet at a time, following the picker', async () => {
    mountPage();
    // Claude default: the bare hosted URL, not a config.
    expect(screen.getByText(/\/api\/mcp$/)).toBeInTheDocument();
    expect(screen.queryByText(/mcpServers/)).toBeNull();
    await userEvent.click(screen.getByRole('radio', { name: 'Desktop agents' }));
    expect(screen.getByText(/@bevel-software\/hexis-mcp/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('radio', { name: 'Other tools' }));
    expect(screen.getByText(/skills-tools-knowledge/)).toBeInTheDocument();
  });

  /**
   * ChatGPT renamed Apps & Connectors to Plugins, and a one-line path with the
   * old names stranded people. The steps are numbered, in the order the
   * settings are actually walked, and each renamed thing is named both ways
   * so either build of ChatGPT reads right.
   */
  it('walks ChatGPT as numbered steps naming both the current and the previous page', async () => {
    mountPage();
    await userEvent.click(screen.getByRole('radio', { name: 'ChatGPT' }));
    const steps = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(steps).toEqual([
      'Open Settings in ChatGPT.',
      'Open Plugins (called Apps & Connectors in older versions).',
      'Turn on Developer Mode (under Advanced in older versions).',
      'Go back and choose Create (or Add).',
      'Name it “Skills, Tools and Knowledge”.',
      'Paste the address below, then save.',
    ]);
    // An ordered list, so the numbers are real rather than typed into the text.
    expect(screen.getByRole('list').tagName).toBe('OL');
    // The other options keep their one-paragraph hint.
    await userEvent.click(screen.getByRole('radio', { name: 'Claude' }));
    expect(screen.queryByRole('list')).toBeNull();
  });

  /**
   * "A JSON config" told a business user nothing. The Other tools option
   * says where it goes, and gives the bare address too — many tools take a
   * URL and nothing else — each with its own copy button.
   */
  it('tells Other tools where the configuration goes, and offers the bare address too', async () => {
    configureMcpUrl('https://kb.acme.com/api/mcp');
    const writeText = stubClipboard();
    mountPage();
    await userEvent.click(screen.getByRole('radio', { name: 'Other tools' }));
    expect(
      screen.getByText(
        'For any other AI tool that supports MCP servers. Open the tool’s settings, find MCP servers (also called connectors or integrations), choose add, and paste this configuration. If the tool asks for an address only, paste this instead:',
      ),
    ).toBeInTheDocument();

    const address = screen.getByText('https://kb.acme.com/api/mcp');
    const config = screen.getByText(/mcpServers/);
    // The address first — the hint ends on "paste this instead:" — then the JSON.
    expect(address.compareDocumentPosition(config) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(config.textContent).toContain('https://kb.acme.com/api/mcp');

    await userEvent.click(screen.getByRole('button', { name: 'Copy address' }));
    expect(writeText).toHaveBeenLastCalledWith('https://kb.acme.com/api/mcp');
    await userEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenLastCalledWith(config.textContent);
  });

  it('shows the separate address block on Other tools alone', async () => {
    mountPage();
    expect(screen.queryByRole('button', { name: 'Copy address' })).toBeNull();
    await userEvent.click(screen.getByRole('radio', { name: 'ChatGPT' }));
    expect(screen.queryByRole('button', { name: 'Copy address' })).toBeNull();
    await userEvent.click(screen.getByRole('radio', { name: 'Desktop agents' }));
    expect(screen.queryByRole('button', { name: 'Copy address' })).toBeNull();
  });

  /**
   * The default: Claude, which is what most people arriving here already use
   * and the one connection that is a single click. The button and the hosted
   * address are both on screen before anything is clicked.
   */
  it('defaults to Claude: its install button and the hosted address, without a click', () => {
    configureMcpUrl('https://kb.acme.com/api/mcp');
    mountPage();
    expect(screen.getByRole('radio', { name: 'Claude' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('link', { name: 'Add to Claude' })).toBeInTheDocument();
    expect(screen.getByText('https://kb.acme.com/api/mcp')).toBeInTheDocument();
  });

  /**
   * Desktop agents is no longer the default, but its snippet is still the
   * keyless local-server config: the local server opens the browser to sign
   * in on first run, so the config carries no key at all.
   */
  it('offers Desktop agents the keyless hexis-mcp config', async () => {
    mountPage();
    await userEvent.click(screen.getByRole('radio', { name: 'Desktop agents' }));
    const snippet = screen.getByText(/mcpServers/).textContent!;
    expect(snippet).toContain('@bevel-software/hexis-mcp');
    // Keyless = interactive sign-in: no key env at all, not a placeholder —
    // the server opens the browser on first run.
    expect(snippet).not.toContain('HEXIS_CONNECTION_KEY');
    // The hint says how identity arrives instead: browser sign-in on first run.
    expect(screen.getByText(/your browser opens so you can sign in/)).toBeInTheDocument();
  });

  /**
   * The two ways this snippet fails on a machine where it is otherwise
   * right: the wrong Node major, and a client launched from the Dock, which
   * was started by the window server and so never read the shell profile
   * that put `npx` on PATH (Cursor and Claude Desktop on macOS). The fix for
   * the second is an absolute path, which is specific to one machine — so it
   * belongs in the hint and NOT in the snippet, which has to stay right for
   * every reader whose PATH was fine all along.
   */
  it('warns Desktop agents about Node and PATH, leaving the snippet on bare npx', async () => {
    mountPage();
    await userEvent.click(screen.getByRole('radio', { name: 'Desktop agents' }));
    expect(screen.getByText(/Needs Node 22\.13\+ or 24/)).toBeInTheDocument();
    expect(screen.getByText(/cannot see your shell’s PATH/)).toBeInTheDocument();
    expect(screen.getByText(/run `which npx` in a terminal/)).toBeInTheDocument();
    const snippet = screen.getByText(/mcpServers/).textContent!;
    expect(JSON.parse(snippet).mcpServers['skills-tools-knowledge'].command).toBe('npx');
  });

  /**
   * One click instead of a menu path. It is Claude-only because Claude is the
   * only client with a documented install link, and it appears only when
   * Anthropic could actually reach this deployment — see `canDeepLink`. The
   * copy block stays either way; it is the route that always works.
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
     * claude.ai cannot reach. A dead button on the first screen a self-hoster
     * sees reads as a broken product.
     */
    it('offers nothing to click on a localhost deployment', async () => {
      configureMcpUrl('http://localhost:3001/api/mcp');
      mountPage();
      await userEvent.click(screen.getByRole('radio', { name: 'Claude' }));
      expect(screen.queryByRole('link', { name: 'Add to Claude' })).toBeNull();
      // …and the route that always works is still there.
      expect(screen.getByText('http://localhost:3001/api/mcp')).toBeInTheDocument();
    });

    /**
     * No `PUBLIC_BACKEND_URL` hint on THIS surface. The reader is a new
     * employee who cannot change deployment config; naming an env var at them
     * is noise. The settings page, whose reader plausibly can, says it there.
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
      await userEvent.click(screen.getByRole('radio', { name: 'ChatGPT' }));
      expect(screen.queryByRole('link', { name: 'Add to Claude' })).toBeNull();
      await userEvent.click(screen.getByRole('radio', { name: 'Desktop agents' }));
      expect(screen.queryByRole('link', { name: 'Add to Claude' })).toBeNull();
      await userEvent.click(screen.getByRole('radio', { name: 'Other tools' }));
      expect(screen.queryByRole('link', { name: 'Add to Claude' })).toBeNull();
    });

    /**
     * ChatGPT gets its own button, on its own option only. It cannot prefill
     * anything — ChatGPT has no such link — so it opens the settings pane and
     * the hint beside it spells out the name to type, which is what stops a
     * dozen employees each inventing their own.
     */
    it('offers Add to ChatGPT on the ChatGPT option alone, with the name to type', async () => {
      configureMcpUrl('https://kb.acme.com/api/mcp');
      mountPage();
      // The default — Claude — carries no ChatGPT button.
      expect(screen.queryByRole('link', { name: 'Add to ChatGPT' })).toBeNull();
      await userEvent.click(screen.getByRole('radio', { name: 'Desktop agents' }));
      expect(screen.queryByRole('link', { name: 'Add to ChatGPT' })).toBeNull();
      await userEvent.click(screen.getByRole('radio', { name: 'ChatGPT' }));
      const link = screen.getByRole('link', { name: 'Add to ChatGPT' });
      expect(link).toHaveAttribute('href', 'https://chatgpt.com/#settings');
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
      expect(screen.getByText(/Skills, Tools and Knowledge/)).toBeInTheDocument();
      // …and the URL to paste is still the copy block.
      expect(screen.getByText('https://kb.acme.com/api/mcp')).toBeInTheDocument();
    });

    it('offers no ChatGPT button on a localhost deployment either', async () => {
      configureMcpUrl('http://localhost:3001/api/mcp');
      mountPage();
      await userEvent.click(screen.getByRole('radio', { name: 'ChatGPT' }));
      expect(screen.queryByRole('link', { name: 'Add to ChatGPT' })).toBeNull();
      expect(screen.getByText('http://localhost:3001/api/mcp')).toBeInTheDocument();
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
     * what the copy block shows a human must be the same string, or one of
     * them is lying.
     */
    it('hands Claude exactly the URL the copy block shows', async () => {
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

  it('copies the visible snippet without concluding anything', async () => {
    const writeText = stubClipboard();
    mountPage();
    await userEvent.click(screen.getByRole('button', { name: 'Copy' }));
    // The default snippet is Claude's: the hosted URL itself.
    expect(writeText).toHaveBeenCalledWith(expect.stringMatching(/\/api\/mcp$/));
    // Copying is not Done: no server write, no navigation.
    expect(authFetchMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('pathname')).toHaveTextContent(WELCOME_PATH);
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

  // Both exits, one destination — stated as its own fact so a future change to
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
    mountPage();
    const group = screen.getByRole('radiogroup', { name: 'Your agent' });
    const options = screen.getAllByRole('radio');
    expect(group).toContainElement(options[0]!);
    // Claude and ChatGPT lead; Claude is the default.
    expect(options.map((o) => o.textContent)).toEqual(['Claude', 'ChatGPT', 'Desktop agents', 'Other tools']);
    expect(options.map((o) => o.getAttribute('aria-checked'))).toEqual([
      'true',
      'false',
      'false',
      'false',
    ]);
    await userEvent.click(screen.getByRole('radio', { name: 'Desktop agents' }));
    expect(screen.getAllByRole('radio').map((o) => o.getAttribute('aria-checked'))).toEqual([
      'false',
      'false',
      'true',
      'false',
    ]);
  });

  /**
   * `role="radiogroup"` is a promise about the keyboard, not just a label for
   * a screen reader: arrows select, and selection follows focus. The plugin
   * wraps, because four options in a row have no edge worth stopping at.
   */
  it('drives the picker with the arrow keys, wrapping at both ends', async () => {
    mountPage();
    const checked = () =>
      screen.getAllByRole('radio').find((o) => o.getAttribute('aria-checked') === 'true');

    screen.getByRole('radio', { name: 'Claude' }).focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(checked()).toHaveAccessibleName('ChatGPT');
    expect(checked()).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    expect(checked()).toHaveAccessibleName('Desktop agents');
    await userEvent.keyboard('{ArrowRight}');
    expect(checked()).toHaveAccessibleName('Other tools');

    // Off the end and round to the first.
    await userEvent.keyboard('{ArrowRight}');
    expect(checked()).toHaveAccessibleName('Claude');

    // And backwards past the start, to the last.
    await userEvent.keyboard('{ArrowLeft}');
    expect(checked()).toHaveAccessibleName('Other tools');
  });

  // Roving tabindex: the picker is ONE tab stop, not one per client.
  it('offers a single tab stop for the whole picker', () => {
    mountPage();
    expect(screen.getAllByRole('radio').map((o) => o.getAttribute('tabindex'))).toEqual([
      '0',
      '-1',
      '-1',
      '-1',
    ]);
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
   * A deep link that survived the SSO round-trip retargets BOTH exits: the
   * greeting concluded by discarding the page someone was sent would cost
   * them the reason they came. The skip label says where it now goes.
   */
  it('keeps a carried deep link: Done lands on it, and the skip link says so', async () => {
    const DEEP = '/workspace/main/knowledge-base/KnowledgeBase/Start here.md';
    const arrivedWithLink = { pathname: WELCOME_PATH, state: { greeting: true, returnTo: DEEP } };
    mountPage(newUser(), arrivedWithLink);
    expect(screen.getByRole('button', { name: /Continue to your link/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(authFetchMock).toHaveBeenCalledWith(
      '/api/auth/onboarding-done',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(screen.getByTestId('pathname')).toHaveTextContent(DEEP);
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
    const mountWithExit = (
      welcomeExit: { path: string; label: string } | undefined,
      // Same shape `mount` accepts — `typeof greeted` would pin `state` to
      // `{ greeting: boolean }` and reject the deep-link case below.
      route: string | { pathname: string; state?: unknown } = greeted,
    ) =>
      mount(
        <AppRegistryContext.Provider value={{ ...EMPTY_REGISTRY, welcomeExit }}>
          <Routes>
            <Route path={WELCOME_PATH} element={<WelcomePage />} />
            <Route path="/skills-and-tools/yours" element={<div>your plugin</div>} />
            <Route path="/workspace" element={<div>knowledge</div>} />
          </Routes>
        </AppRegistryContext.Provider>,
        newUser(),
        route,
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

    /**
     * A deep link still outranks it. Someone who followed a link is owed that
     * link, and no amount of deployment configuration may eat an intention.
     */
    it('does not override a carried deep link', async () => {
      const DEEP = '/workspace/main/knowledge-base/KnowledgeBase/Start here.md';
      mountWithExit(
        { path: '/skills-and-tools/yours', label: 'Go to your skills' },
        { pathname: WELCOME_PATH, state: { greeting: true, returnTo: DEEP } },
      );
      expect(screen.getByRole('button', { name: /Continue to your link/ })).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Done' }));
      expect(screen.getByTestId('pathname')).toHaveTextContent(DEEP);
    });
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
    // …as a plain visit. The pill opens the page; it does not re-run the
    // first-sign-in ceremony that folds the nav it lives in away.
    expect(screen.getByTestId('greeting')).toHaveTextContent('false');
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
