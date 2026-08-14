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
    // Claude default: the bare URL.
    expect(screen.getByText(/\/api\/mcp$/)).toBeInTheDocument();
    expect(screen.queryByText(/mcpServers/)).toBeNull();
    await userEvent.click(screen.getByRole('radio', { name: 'Cursor & Others' }));
    expect(screen.getByText(/mcpServers/)).toBeInTheDocument();
  });

  /**
   * One click instead of a menu path. It is Claude-only because Claude is the
   * only client with a documented install link, and it appears only when
   * Anthropic could actually reach this deployment — see `canDeepLink`. The
   * copy block stays either way; it is the route that always works.
   */
  describe('the Add to Claude link', () => {
    it('offers one-click connect on a reachable deployment', () => {
      configureMcpUrl('https://kb.acme.com/api/mcp');
      mountPage();
      const link = screen.getByRole('link', { name: 'Add to Claude' });
      const href = new URL(link.getAttribute('href')!);
      expect(href.origin + href.pathname).toBe('https://claude.ai/customize/connectors');
      expect(href.searchParams.get('connectorUrl')).toBe('https://kb.acme.com/api/mcp');
      expect(href.searchParams.get('connectorName')).toBe('Hexis — kb.acme.com');
    });

    /**
     * The default install: `PUBLIC_BACKEND_URL` unset means localhost, which
     * claude.ai cannot reach. A dead button on the first screen a self-hoster
     * sees reads as a broken product.
     */
    it('offers nothing to click on a localhost deployment', () => {
      configureMcpUrl('http://localhost:3001/api/mcp');
      mountPage();
      expect(screen.queryByRole('link', { name: 'Add to Claude' })).toBeNull();
      // …and the route that always works is still there.
      expect(screen.getByText('http://localhost:3001/api/mcp')).toBeInTheDocument();
    });

    /**
     * No `PUBLIC_BACKEND_URL` hint on THIS surface. The reader is a new
     * employee who cannot change deployment config; naming an env var at them
     * is noise. The settings page, whose reader plausibly can, says it there.
     */
    it('does not lecture a new employee about deployment config', () => {
      configureMcpUrl('http://localhost:3001/api/mcp');
      mountPage();
      expect(screen.queryByText(/PUBLIC_BACKEND_URL/)).toBeNull();
    });

    it('belongs to Claude alone', async () => {
      configureMcpUrl('https://kb.acme.com/api/mcp');
      mountPage();
      expect(screen.getByRole('link', { name: 'Add to Claude' })).toBeInTheDocument();
      await userEvent.click(screen.getByRole('radio', { name: 'ChatGPT' }));
      expect(screen.queryByRole('link', { name: 'Add to Claude' })).toBeNull();
      await userEvent.click(screen.getByRole('radio', { name: 'Cursor & Others' }));
      expect(screen.queryByRole('link', { name: 'Add to Claude' })).toBeNull();
    });

    // Opening claude.ai must not hand it a handle on this window.
    it('opens in a new tab safely', () => {
      configureMcpUrl('https://kb.acme.com/api/mcp');
      mountPage();
      const link = screen.getByRole('link', { name: 'Add to Claude' });
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    });

    /**
     * The whole point of the canonical URL: what the button hands Claude and
     * what the copy block shows a human must be the same string, or one of
     * them is lying.
     */
    it('hands Claude exactly the URL the copy block shows', () => {
      configureMcpUrl('https://kb.acme.com/api/mcp');
      mountPage();
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
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('/api/mcp'));
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
    const plugin = screen.getByRole('radioplugin', { name: 'Your agent' });
    const options = screen.getAllByRole('radio');
    expect(plugin).toContainElement(options[0]!);
    expect(options.map((o) => o.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false']);
    await userEvent.click(screen.getByRole('radio', { name: 'ChatGPT' }));
    expect(screen.getAllByRole('radio').map((o) => o.getAttribute('aria-checked'))).toEqual([
      'false',
      'true',
      'false',
    ]);
  });

  /**
   * `role="radioplugin"` is a promise about the keyboard, not just a label for
   * a screen reader: arrows select, and selection follows focus. The plugin
   * wraps, because three options in a row have no edge worth stopping at.
   */
  it('drives the picker with the arrow keys, wrapping at both ends', async () => {
    mountPage();
    const checked = () =>
      screen.getAllByRole('radio').find((o) => o.getAttribute('aria-checked') === 'true');

    screen.getByRole('radio', { name: 'Claude' }).focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(checked()).toHaveAccessibleName('ChatGPT');
    expect(checked()).toHaveFocus();

    // Off the end and round to the first.
    await userEvent.keyboard('{ArrowRight}{ArrowRight}');
    expect(checked()).toHaveAccessibleName('Claude');

    // And backwards past the start, to the last.
    await userEvent.keyboard('{ArrowLeft}');
    expect(checked()).toHaveAccessibleName('Cursor & Others');
  });

  // Roving tabindex: the picker is ONE tab stop, not one per client.
  it('offers a single tab stop for the whole picker', () => {
    mountPage();
    expect(screen.getAllByRole('radio').map((o) => o.getAttribute('tabindex'))).toEqual([
      '0',
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
