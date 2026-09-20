import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { buttonClasses, type ButtonSize } from '../../../shared/components';
import { AuthContext, type AuthContextValue } from '../../auth/state/auth.context';
import {
  WorkspaceContext,
  type WorkspaceContextValue,
} from '../../workspace/state/workspace.context';
import {
  checkToolConnection,
  deleteAdminVar,
  setAdminVar,
  type ProbeVerdict,
  type ToolSecrets,
  type ToolSetup,
} from '../../secrets-vault/services/tool-secrets.api';

/**
 * The section frame: the Secrets deep link, the setup banner's three audiences,
 * and that the rows keep server order (the `.tool` file's declaration order is
 * the only order that means anything to the person who wrote it).
 */

vi.mock('../../secrets-vault/services/tool-secrets.api', () => ({
  setAdminVar: vi.fn(),
  setUserVar: vi.fn(),
  deleteAdminVar: vi.fn(),
  setOAuthClientSecret: vi.fn(),
  checkToolConnection: vi.fn(),
}));
vi.mock('../../secrets-vault/services/connect.api', () => ({ startToolOAuth: vi.fn() }));
vi.mock('../utils/navigate-external', () => ({ navigateExternal: vi.fn() }));

import { ToolConnectionSection } from '../components/tool-page/ToolConnectionSection';
import { TOOL_CREDENTIALS_STALE_EVENT } from '../../../core/events';

// `checkToolConnection` is one module-level mock shared by every test here.
// `resetAllMocks`, not `clearAllMocks`: clearing kept whatever implementation
// the previous test installed with `mockResolvedValue`, which is exactly the
// ordering hazard this line claims to prevent — a test that forgot its own
// implementation inherited its neighbour's and passed by accident. Reset
// drops implementations too, so every test states what its probe answers.
beforeEach(() => vi.resetAllMocks());
function workspace(kbDirName: string | null): WorkspaceContextValue {
  return { workspaceId: 'target-company-state', kbDirName } as unknown as WorkspaceContextValue;
}

/** Exposes the router's pathname so the Edit link's destination is assertable. */
function LocationProbe() {
  const location = useLocation();
  return <div aria-label="pathname">{location.pathname}</div>;
}

// The rendered tree reaches for the signed-in identity, so the provider has to
// be present even though this section no longer reads it itself.
const AUTH = {
  user: { email: 'user@x.com', name: 'User' },
  token: 't',
  isLoading: false,
  login: vi.fn(),
  logout: vi.fn(),
} as unknown as AuthContextValue;

function wrap(children: ReactNode, kbDirName: string | null = 'knowledge-base') {
  return (
    <MemoryRouter>
      <AuthContext.Provider value={AUTH}>
        <WorkspaceContext.Provider value={workspace(kbDirName)}>
          {children}
          <LocationProbe />
        </WorkspaceContext.Provider>
      </AuthContext.Provider>
    </MemoryRouter>
  );
}

function tool(over: Partial<ToolSecrets> = {}): ToolSecrets {
  return {
    slug: 'github',
    name: 'github',
    path: 'Plugins/Engineering/github.tool',
    type: 'mcp',
    setup: null,
    canWrite: false,
    variables: [],
    ...over,
  };
}

const OAUTH_MANUAL: ToolSetup = {
  kind: 'oauth-manual',
  reason: 'The server does not support dynamic client registration.',
};

function renderSection(t: ToolSecrets, kbDirName: string | null = 'knowledge-base') {
  return render(
    wrap(
      <ToolConnectionSection tool={t} configRevision={0} onChanged={vi.fn()} onError={vi.fn()} />,
      kbDirName,
    ),
  );
}

describe('ToolConnectionSection', () => {
  it('heads the section and links to the Secrets page', () => {
    renderSection(tool());
    expect(screen.getByRole('heading', { name: 'Your connection' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Secrets' })).toHaveAttribute('href', '/secrets');
  });

  it('says there is nothing to set up when the tool declares no variables', () => {
    renderSection(tool());
    expect(screen.getByText('Nothing to set up')).toBeInTheDocument();
  });

  it('renders one row per variable, in server order', () => {
    renderSection(
      tool({
        variables: [
          { name: 'B_KEY', scope: 'admin', label: 'Second', key: 'k1', adminConfigured: true, userConfigured: false },
          { name: 'A_KEY', scope: 'admin', label: 'First', key: 'k2', adminConfigured: true, userConfigured: false },
        ],
      }),
    );
    const labels = screen.getAllByText(/^(First|Second)$/).map((n) => n.textContent);
    expect(labels).toEqual(['Second', 'First']);
  });

  it('tells a writer how to finish an oauth-manual setup, with a link into the tool file', async () => {
    renderSection(tool({ setup: OAUTH_MANUAL, canWrite: true }));

    expect(screen.getByRole('status')).toHaveTextContent(
      /Sign-in setup needed: this server needs users to sign in/,
    );
    expect(screen.getByText(OAUTH_MANUAL.reason!)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Edit the tool file' }));
    await waitFor(() =>
      expect(screen.getByLabelText('pathname').textContent).toContain(
        'knowledge-base/Plugins/Engineering/github.tool',
      ),
    );
  });

  it('tells everyone else to ask the owner, with no edit link', () => {
    renderSection(tool({ setup: OAUTH_MANUAL }));
    expect(screen.getByRole('status')).toHaveTextContent(
      "Sign-in setup needed: ask the tool's owner to finish setting this up.",
    );
    expect(screen.queryByRole('button', { name: 'Edit the tool file' })).toBeNull();
  });

  it('sends the owner of an mcp.json server to "Edit server" on this page, not to a file', () => {
    renderSection(tool({ path: 'Plugins/GTM/mcp.json', setup: OAUTH_MANUAL, canWrite: true }));
    expect(screen.getByRole('status')).toHaveTextContent(/under "Edit server" below/);
    expect(screen.queryByRole('button', { name: 'Edit the tool file' })).toBeNull();
  });

  it('once the sign-in is declared, asks the owner only for the client secret', () => {
    renderSection(
      tool({
        setup: { kind: 'oauth-manual' },
        canWrite: true,
        variables: [
          {
            name: 'SIGNIN',
            scope: 'user',
            label: null,
            key: 'github_SIGNIN',
            adminConfigured: false,
            userConfigured: false,
            oauth: true,
            authorized: false,
          },
        ],
      }),
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      'the sign-in is declared — set its client secret below to finish',
    );
    expect(screen.queryByRole('button', { name: 'Edit the tool file' })).toBeNull();
  });

  it('omits the edit link while the workspace has no kb directory yet', () => {
    renderSection(tool({ setup: OAUTH_MANUAL, canWrite: true }), null);
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit the tool file' })).toBeNull();
  });

  it('drops every banner once the owner-side provider is configured', () => {
    renderSection(
      tool({
        setup: OAUTH_MANUAL,
        canWrite: true,
        variables: [
          {
            name: 'SIGNIN',
            scope: 'user',
            label: null,
            key: 'github_SIGNIN',
            adminConfigured: true,
            userConfigured: false,
            oauth: true,
            authorized: false,
          },
        ],
      }),
    );
    // The SETUP banner is gone because the provider is configured — and the
    // connection banner does NOT take its place: configuration is done, and a
    // pending sign-in is the row's business. The row below carries the state
    // and the button, so a banner would be the same sentence twice.
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByText(/Sign-in setup needed/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('keeps the banner about configuration: a missing key is named, a pending sign-in is not', () => {
    renderSection(
      tool({
        variables: [
          {
            name: 'API_KEY',
            scope: 'user',
            label: 'HeyReach API key',
            key: 'heyreach_API_KEY',
            adminConfigured: false,
            userConfigured: false,
          },
          {
            name: 'SIGNIN',
            scope: 'user',
            label: null,
            key: 'heyreach_SIGNIN',
            adminConfigured: true,
            userConfigured: false,
            oauth: true,
            authorized: false,
          },
        ],
      }),
    );
    const banner = screen.getByRole('status');
    // One configuration gap → the singular headline, not "needs 2 things".
    expect(banner).toHaveTextContent('This tool is not connected yet.');
    expect(banner).toHaveTextContent('HeyReach API key: Needs a key from you');
    expect(banner).not.toHaveTextContent('Needs your sign-in');
  });

  it('says what a tool is missing, in amber, above the rows', () => {
    renderSection(
      tool({
        variables: [
          {
            name: 'API_KEY',
            scope: 'user',
            label: 'HeyReach API key',
            key: 'heyreach_API_KEY',
            adminConfigured: false,
            userConfigured: false,
          },
        ],
      }),
    );
    // Named by its label, not its env var — and it says whose move it is.
    expect(screen.getByRole('status')).toHaveTextContent(
      'HeyReach API key: Needs a key from you',
    );
  });

  it("the banner's Add key opens the missing variable's editor, from a distance", () => {
    renderSection(
      tool({
        variables: [
          {
            name: 'API_KEY',
            scope: 'user',
            label: 'HeyReach API key',
            key: 'heyreach_API_KEY',
            adminConfigured: false,
            userConfigured: false,
          },
        ],
      }),
    );
    expect(screen.queryByRole('textbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add key: HeyReach API key' }));
    // The same editor the row's own button opens — one path, two doors.
    expect(screen.getByLabelText('Value for API_KEY')).toBeInTheDocument();
  });

  it('says nothing when every variable is set', () => {
    renderSection(
      tool({
        variables: [
          {
            name: 'API_KEY',
            scope: 'user',
            label: null,
            key: 'heyreach_API_KEY',
            adminConfigured: true,
            userConfigured: true,
          },
        ],
      }),
    );
    expect(screen.queryByRole('status')).toBeNull();
  });

  it.each<ToolSetup | null>([{ kind: 'open' }, { kind: 'oauth-auto' }, null])(
    'shows no setup banner for %s',
    (setup) => {
      // No variables at all, so neither banner has anything to report.
      renderSection(tool({ setup, canWrite: true }));
      expect(screen.queryByRole('status')).toBeNull();
    },
  );

  /**
   * The word "Connected" and the evidence for it.
   *
   * Nothing stores a verdict, so this component's own state is the only place
   * one exists — which is exactly why the claim can be trusted: it cannot
   * outlive the page that watched the call succeed.
   */
  describe('the verdict', () => {
    const settled = () =>
      tool({
        variables: [
          {
            name: 'API_KEY',
            scope: 'user',
            label: null,
            key: 'github_API_KEY',
            adminConfigured: true,
            userConfigured: true,
          },
        ],
      });

    it('says Key saved — never Connected — before anything has been tested', () => {
      renderSection(settled());
      expect(screen.getByTestId('tool-health')).toHaveTextContent('Key saved');
    });

    it('earns Connected from a passing probe, and only then', async () => {
      vi.mocked(checkToolConnection).mockResolvedValue({
        status: 'ok',
        detail: null,
        checkedAt: new Date().toISOString(),
      });
      renderSection(settled());

      fireEvent.click(screen.getByRole('button', { name: 'Test connection: github' }));

      await waitFor(() => expect(screen.getByTestId('tool-health')).toHaveTextContent('Connected'));
      expect(checkToolConnection).toHaveBeenCalledWith('github');
    });

    it("goes red with the provider's own words when the credential is rejected", async () => {
      vi.mocked(checkToolConnection).mockResolvedValue({
        status: 'failed',
        detail: 'Invalid API key.',
        checkedAt: new Date().toISOString(),
      });
      renderSection(settled());

      fireEvent.click(screen.getByRole('button', { name: 'Test connection: github' }));

      // A rejected credential needs a person, so it escalates from the quiet
      // line to a banner.
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Invalid API key.'));
    });

    it('keeps the button disabled while the probe is in flight', async () => {
      let release: (v: ProbeVerdict) => void = () => {};
      vi.mocked(checkToolConnection).mockReturnValue(
        new Promise<ProbeVerdict>((r) => {
          release = r;
        }),
      );
      renderSection(settled());
      const button = screen.getByRole('button', { name: 'Test connection: github' });

      fireEvent.click(button);

      // The in-flight state lives beside the button precisely so it survives
      // the refetch a save triggers — a remount would re-enable it mid-probe.
      await waitFor(() => expect(screen.getByRole('button', { name: /Test connection/ })).toBeDisabled());
      expect(screen.getByRole('button', { name: /Test connection/ })).toHaveTextContent('Testing…');
      release({ status: 'ok', detail: null, checkedAt: new Date().toISOString() });
      await waitFor(() => expect(screen.getByRole('button', { name: /Test connection/ })).toBeEnabled());
    });

    it('does not claim a verdict when the CHECK itself failed', async () => {
      // Our own network trouble is not evidence about someone else's credential.
      vi.mocked(checkToolConnection).mockRejectedValue(new Error('Network down'));
      const onError = vi.fn();
      render(wrap(<ToolConnectionSection tool={settled()} configRevision={0} onChanged={vi.fn()} onError={onError} />));

      fireEvent.click(screen.getByRole('button', { name: 'Test connection: github' }));

      // The section's OWN banner, not the page's shared one: page state
      // outlived its subject (another action's error cleared by a probe, a
      // previous tool's probe touching the current tool's banner).
      await waitFor(() => expect(screen.getByTestId('tool-probe-error')).toHaveTextContent('Network down'));
      expect(onError).not.toHaveBeenCalled();
      expect(screen.getByTestId('tool-health')).toHaveTextContent('Key saved');

      // The next clean probe clears it.
      vi.mocked(checkToolConnection).mockResolvedValue({ status: 'ok', detail: null, checkedAt: new Date().toISOString() });
      fireEvent.click(screen.getByRole('button', { name: 'Test connection: github' }));
      await waitFor(() => expect(screen.queryByTestId('tool-probe-error')).toBeNull());
    });

    it('stops claiming Connected once the server definition changes', async () => {
      // A verdict describes the endpoint and headers it was probed against.
      // Editing the mcp.json server replaces those, so the old answer is about
      // a server that is no longer configured — and the page not remounting on
      // a same-slug reload is exactly why it would otherwise survive.
      vi.mocked(checkToolConnection).mockResolvedValue({
        status: 'ok',
        detail: null,
        checkedAt: new Date().toISOString(),
      });
      const view = render(
        wrap(<ToolConnectionSection tool={settled()} configRevision={0} onChanged={vi.fn()} onError={vi.fn()} />),
      );
      fireEvent.click(screen.getByRole('button', { name: 'Test connection: github' }));
      await waitFor(() => expect(screen.getByTestId('tool-health')).toHaveTextContent('Connected'));

      view.rerender(
        wrap(<ToolConnectionSection tool={settled()} configRevision={1} onChanged={vi.fn()} onError={vi.fn()} />),
      );

      expect(screen.getByTestId('tool-health')).toHaveTextContent('Key saved');
    });

    it('lets the NEWER of two overlapping probes win, however they finish', async () => {
      // Two saves in quick succession start two probes. If the first answers
      // last, its verdict is about the credential the second one replaced —
      // the same stale-answer bug this feature exists to remove, one layer up.
      //
      // Driven through SAVES, not the button: the button disables itself while
      // a probe runs, so it cannot start the second one. A save can, because
      // nothing stops a user typing the next key while the last check is still
      // in flight — which is what makes this reachable at all.
      let releaseFirst: (v: ProbeVerdict) => void = () => {};
      vi.mocked(checkToolConnection)
        .mockReturnValueOnce(
          new Promise<ProbeVerdict>((r) => {
            releaseFirst = r;
          }),
        )
        .mockResolvedValueOnce({ status: 'failed', detail: 'Invalid API key.', checkedAt: new Date().toISOString() });
      vi.mocked(setAdminVar).mockResolvedValue(undefined);

      // An ADMIN variable a writer can replace: a user-scope row offers no way
      // back into the editor once its key is stored, so it cannot produce the
      // second save this race needs.
      renderSection(
        tool({
          canWrite: true,
          variables: [
            {
              name: 'API_KEY',
              scope: 'admin',
              label: null,
              key: 'github_API_KEY',
              adminConfigured: true,
              userConfigured: false,
            },
          ],
        }),
      );
      const save = async (value: string) => {
        fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
        fireEvent.change(screen.getByLabelText('Value for API_KEY'), { target: { value } });
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));
        await waitFor(() => expect(screen.queryByLabelText('Value for API_KEY')).toBeNull());
      };

      await save('first-key');
      await save('second-key');
      await waitFor(() => expect(checkToolConnection).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Invalid API key.'));

      // The first probe now answers "ok" — about `first-key`, which no longer
      // exists — and must not be believed. `act` flushes the re-render that a
      // BROKEN guard would schedule here; a bare microtask await did not, so
      // the assertions below used to pass with the guard removed.
      await act(async () => {
        releaseFirst({ status: 'ok', detail: null, checkedAt: new Date().toISOString() });
      });
      expect(screen.getByRole('alert')).toHaveTextContent('Invalid API key.');
      expect(screen.queryByTestId('tool-health')).toBeNull();
    });
  });

  /**
   * What this section owes the REST of the app.
   *
   * The stale-status bug never showed here: a save re-probes, so the page the
   * key was typed on was always right. It showed one click later, on the
   * plugin page and the cards, which read a catalog loaded before the write.
   * So the thing worth pinning is the announcement, not the local repaint.
   */
  describe('announcing a landed credential', () => {
    const heard = vi.fn();
    beforeEach(() => {
      heard.mockReset();
      window.addEventListener(TOOL_CREDENTIALS_STALE_EVENT, heard);
    });
    afterEach(() => window.removeEventListener(TOOL_CREDENTIALS_STALE_EVENT, heard));

    /** One admin key a writer can set, replace and remove. */
    const withKey = (adminConfigured: boolean) =>
      tool({
        canWrite: true,
        variables: [
          {
            name: 'API_KEY',
            scope: 'admin',
            label: null,
            key: 'github_API_KEY',
            adminConfigured,
            userConfigured: false,
          },
        ],
      });

    it('announces a save without waiting for the probe to answer', async () => {
      // The catalog's answer does not depend on whether the provider likes the
      // key, so making the reload wait on a round-trip nobody is watching only
      // keeps the plugin page stale for longer.
      vi.mocked(setAdminVar).mockResolvedValue(undefined);
      vi.mocked(checkToolConnection).mockReturnValue(new Promise<ProbeVerdict>(() => {}));
      renderSection(withKey(false));

      fireEvent.click(screen.getByRole('button', { name: 'Set key' }));
      fireEvent.change(screen.getByLabelText('Value for API_KEY'), { target: { value: 'k' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));

      // The probe is started and will never answer, so an announcement that
      // arrives at all is one that did not wait for a verdict.
      await waitFor(() => expect(heard).toHaveBeenCalledTimes(1));
      expect(checkToolConnection).toHaveBeenCalledTimes(1);
    });

    it('announces a removal, which starts no probe of its own', async () => {
      vi.mocked(deleteAdminVar).mockResolvedValue(undefined);
      renderSection(withKey(true));

      fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

      await waitFor(() => expect(heard).toHaveBeenCalledTimes(1));
      expect(checkToolConnection).not.toHaveBeenCalled();
    });

    it('announces nothing when the save fails', async () => {
      // A failed save changed nothing. Reloading on it would blink every card
      // in the Library for no reason — and teach the reader that the blink
      // means something landed.
      vi.mocked(setAdminVar).mockRejectedValue(new Error('Nope.'));
      const onError = vi.fn();
      render(
        wrap(
          <ToolConnectionSection
            tool={withKey(false)}
            configRevision={0}
            onChanged={vi.fn()}
            onError={onError}
          />,
        ),
      );

      fireEvent.click(screen.getByRole('button', { name: 'Set key' }));
      fireEvent.change(screen.getByLabelText('Value for API_KEY'), { target: { value: 'k' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(onError).toHaveBeenCalledWith('Nope.'));
      expect(heard).not.toHaveBeenCalled();
    });
  });

  /**
   * One size for every action in the section.
   *
   * The heights used to disagree: Set key was `sm` while Test connection,
   * Remove and Sign in beside it were `tiny`, so a single row read as three
   * unrelated controls. Edit server and Save set the size and everything here
   * follows them.
   *
   * Asserted through the size TOKENS `buttonClasses` emits rather than a
   * literal class string, so moving the padding scale moves this test with it
   * instead of leaving it asserting a size nothing renders any more. The
   * `px-*` token differs between quiet and solid buttons; what every button of
   * a size shares is its vertical padding and its type scale — which is
   * precisely what a row's height is made of.
   */
  describe('one size', () => {
    function sizeTokens(size: ButtonSize): string[] {
      const solid = buttonClasses({ variant: 'outline', size }).split(' ');
      const quiet = new Set(buttonClasses({ variant: 'quiet', size }).split(' '));
      // `md` carries everything that is NOT size-specific — the frame, the
      // focus ring, the variant's colours — so subtracting it leaves the size.
      const sizeless = new Set(buttonClasses({ variant: 'outline', size: 'md' }).split(' '));
      return solid.filter((c) => quiet.has(c) && !sizeless.has(c));
    }

    const SMALL = sizeTokens('sm');
    const TINY = sizeTokens('tiny');

    /**
     * What the section offers as an action: every <button>, plus the links
     * that are DRESSED as buttons. A link only counts when it carries the
     * frame every button shares — `buttonClasses` is what turns Open Secrets
     * into a button to the eye — so a plain link written into the banner's
     * prose one day stays prose, and this test keeps its opinion to the
     * controls it is about.
     */
    const FRAME = (() => {
      const md = new Set(buttonClasses({ variant: 'outline', size: 'md' }).split(' '));
      // Different variant AND different size, so what survives is neither.
      return buttonClasses({ variant: 'quiet', size: 'tiny' })
        .split(' ')
        .filter((c) => md.has(c));
    })();

    /** Every action the section is currently offering. */
    function actions(): HTMLElement[] {
      return [
        ...screen.queryAllByRole('button'),
        ...screen
          .queryAllByRole('link')
          .filter((el) => FRAME.every((c) => el.className.split(' ').includes(c))),
      ];
    }

    /**
     * What those actions call themselves. Size alone cannot hold a case
     * honest: `notSmall()` reads nothing into a control that is absent, and
     * every fixture below carries Open Secrets — a link that is always small —
     * so a branch that stopped rendering its action entirely would leave
     * `notSmall()` just as empty as one that sized it correctly. Each case
     * names the actions it expects first, and the size assertion then speaks
     * about a cast already known to be complete.
     */
    function actionNames(): string[] {
      return actions()
        .map(
          (el) =>
            el.getAttribute('aria-label') ?? (el.textContent ?? '').replace(/\s+/g, ' ').trim(),
        )
        .sort();
    }

    /**
     * Every action on screen that is NOT small, named by what it reads as —
     * so a failure says which control drifted rather than only how many did.
     */
    function notSmall(): string[] {
      return actions()
        .filter((el) => {
          const classes = el.className.split(' ');
          return !SMALL.every((c) => classes.includes(c)) || TINY.some((c) => classes.includes(c));
        })
        .map((el) => `${el.textContent} — ${el.className}`);
    }

    it('distinguishes the two sizes it is asserting on', () => {
      // Guards the derivation itself: were `sizeTokens` to come back empty, or
      // the two sizes to share every token, `notSmall` would be vacuous and
      // every case below would pass against tiny buttons.
      expect(SMALL.length).toBeGreaterThan(0);
      expect(SMALL.filter((c) => TINY.includes(c))).toEqual([]);
      // And that the frame is a real filter: an empty one would wave every
      // link through as an action, which is the opposite of what it is for.
      expect(FRAME.length).toBeGreaterThan(0);
    });

    it('holds the one action that is a link to the same size', () => {
      // Named on its own because it is the case the frame test above protects:
      // Open Secrets is a <Link>, not a <Button>, and it is the control most
      // easily left behind when the buttons beside it move.
      renderSection(tool());
      const link = screen.getByRole('link', { name: 'Open Secrets' });
      expect(SMALL.every((c) => link.className.split(' ').includes(c))).toBe(true);
      expect(actionNames()).toEqual(['Open Secrets', 'Test connection: github'].sort());
      expect(notSmall()).toEqual([]);
    });

    type Var = ToolSecrets['variables'][number];

    const signIn = (over: Partial<Var> = {}): Var => ({
      name: 'SIGNIN',
      scope: 'user',
      label: null,
      key: 'github_SIGNIN',
      adminConfigured: true,
      userConfigured: false,
      oauth: true,
      authorized: false,
      ...over,
    });

    const sharedKey = (over: Partial<Var> = {}): Var => ({
      name: 'API_KEY',
      scope: 'admin',
      label: null,
      key: 'github_API_KEY',
      adminConfigured: true,
      userConfigured: false,
      ...over,
    });

    // Between them these cover every button the section can render: the header
    // pair, the banner's action, and each branch of the row matrix.
    it.each<[string, ToolSecrets, string[]]>([
      [
        'a settled tool an owner is looking at',
        tool({
          setup: { kind: 'oauth-manual' },
          canWrite: true,
          variables: [signIn({ authorized: true }), sharedKey()],
        }),
        [
          'Test connection: github',
          'Open Secrets',
          'Reconnect',
          'Replace client secret',
          'Replace',
          'Remove',
        ],
      ],
      [
        'a tool still waiting on its keys',
        tool({
          canWrite: true,
          variables: [
            sharedKey({ adminConfigured: false }),
            {
              name: 'MY_KEY',
              scope: 'user',
              label: null,
              key: 'github_MY_KEY',
              adminConfigured: false,
              userConfigured: false,
            },
          ],
        }),
        // The banner's Set key, plus the rows' own Set key and Add key.
        ['Open Secrets', 'Set key', 'Set key: API_KEY', 'Add key'],
      ],
      ['a sign-in nobody has done yet', tool({ variables: [signIn()] }), ['Open Secrets', 'Sign in']],
      [
        'a sign-in that has to be done again',
        tool({ variables: [signIn({ authorized: true, needsReauth: true })] }),
        ['Open Secrets', 'Sign in again'],
      ],
      [
        'an oauth-manual setup the owner has not started',
        tool({ setup: OAUTH_MANUAL, canWrite: true }),
        ['Open Secrets', 'Edit the tool file'],
      ],
      [
        'a declared sign-in still missing its client secret',
        tool({ setup: OAUTH_MANUAL, canWrite: true, variables: [signIn({ adminConfigured: false })] }),
        ['Open Secrets', 'Set client secret'],
      ],
    ])('sizes every action small on %s', (_name, t, expected) => {
      renderSection(t);
      expect(actionNames()).toEqual([...expected].sort());
      expect(notSmall()).toEqual([]);
    });

    it("sizes the row editor's Save and Cancel like the row that opened it", () => {
      renderSection(tool({ canWrite: true, variables: [sharedKey()] }));
      fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
      expect(screen.getByLabelText('Value for API_KEY')).toBeInTheDocument();
      // The row keeps its own actions while the editor is open, so Save and
      // Cancel are joining a row rather than replacing it — which is exactly
      // why they have to match the height of what they stand next to.
      expect(actionNames()).toEqual(
        ['Test connection: github', 'Open Secrets', 'Replace', 'Remove', 'Save', 'Cancel'].sort(),
      );
      expect(notSmall()).toEqual([]);
    });
  });
});
