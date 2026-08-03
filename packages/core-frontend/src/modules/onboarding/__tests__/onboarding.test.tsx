import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { AuthContext } from '../../auth/state/auth.context';
import { authValue } from '../../library/__tests__/auth-harness';
import { LibraryToastProvider } from '../../library/state/toast';
import { WelcomePage } from '../components/WelcomePage';
import { ConnectAgentPill } from '../components/ConnectAgentPill';
import { RootLanding } from '../components/RootLanding';
import { WELCOME_PATH } from '../paths';
import { resetOnboardingForTests } from '../state/onboarding';

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

/** A user the server considers NOT onboarded (the explicit false matters). */
const newUser = () => authValue({ user: { id: 'u1', email: 'juan@bevel.software', name: 'Juan Viera', onboardingDone: false } });
/** The same account after the server has recorded the onboarding as done. */
const doneUser = () => authValue({ user: { id: 'u1', email: 'juan@bevel.software', name: 'Juan Viera', onboardingDone: true } });

/** Renders the current path, so a redirect can be asserted as a destination. */
function LocationProbe() {
  return <div data-testid="pathname">{useLocation().pathname}</div>;
}

/**
 * Render `ui` inside the three contexts the onboarding actually reads — a
 * router at `route`, an auth context holding `auth`, and the toast provider —
 * plus the location probe every redirect assertion below looks at.
 */
function mount(ui: React.ReactNode, auth = newUser(), route = '/') {
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

describe('RootLanding — the one-time greeting', () => {
  it('sends a brand-new account to the welcome page', () => {
    mount(landingRoutes);
    expect(screen.getByTestId('pathname')).toHaveTextContent(WELCOME_PATH);
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
  const mountPage = (auth = newUser()) =>
    mount(
      <Routes>
        <Route path={WELCOME_PATH} element={<WelcomePage />} />
        <Route path="/skills-and-tools" element={<div>library</div>} />
      </Routes>,
      auth,
      WELCOME_PATH,
    );

  it('addresses the person by first name', () => {
    mountPage();
    expect(screen.getByRole('heading', { name: 'Welcome, Juan' })).toBeInTheDocument();
  });

  it('shows one snippet at a time, following the picker', async () => {
    mountPage();
    // Claude default: the bare URL.
    expect(screen.getByText(/\/api\/mcp$/)).toBeInTheDocument();
    expect(screen.queryByText(/mcpServers/)).toBeNull();
    await userEvent.click(screen.getByRole('radio', { name: 'Cursor & Others' }));
    expect(screen.getByText(/mcpServers/)).toBeInTheDocument();
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

  it('Done concludes: server write + landing in the library', async () => {
    mountPage();
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(authFetchMock).toHaveBeenCalledWith(
      '/api/auth/onboarding-done',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(screen.getByTestId('pathname')).toHaveTextContent('/skills-and-tools');
  });

  // Exclusive-choice semantics: `radio` says one of these is always chosen
  // and the others are not. Three `aria-pressed` toggles said any combination,
  // including none, was possible.
  it('presents the client picker as an exclusive choice', async () => {
    mountPage();
    const group = screen.getByRole('radiogroup', { name: 'Your agent' });
    const options = screen.getAllByRole('radio');
    expect(group).toContainElement(options[0]!);
    expect(options.map((o) => o.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false']);
    await userEvent.click(screen.getByRole('radio', { name: 'ChatGPT' }));
    expect(screen.getAllByRole('radio').map((o) => o.getAttribute('aria-checked'))).toEqual([
      'false',
      'true',
      'false',
    ]);
  });

  it('the skip link leaves without concluding', async () => {
    mountPage();
    await userEvent.click(screen.getByRole('button', { name: /Go to your library/ }));
    expect(authFetchMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('pathname')).toHaveTextContent('/skills-and-tools');
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

  it('the × concludes — same field as Done — and the pill goes', async () => {
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
    const init = authFetchMock.mock.calls[0]?.[1];
    expect(JSON.parse(init?.body as string)).toEqual({ userId: 'u1' });
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
