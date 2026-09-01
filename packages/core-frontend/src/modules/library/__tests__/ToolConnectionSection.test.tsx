import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { AuthContext, type AuthContextValue } from '../../auth/state/auth.context';
import {
  WorkspaceContext,
  type WorkspaceContextValue,
} from '../../workspace/state/workspace.context';
import {
  checkToolConnection,
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

// `checkToolConnection` is one module-level mock shared by every test here, so
// without this a test that does not set its own implementation inherits the
// previous one's — and the suite passes only because of the order it happens to
// run in. Clears call history and keeps each test's own `mockResolvedValue`.
beforeEach(() => vi.clearAllMocks());
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

      await waitFor(() => expect(onError).toHaveBeenCalledWith('Network down'));
      expect(screen.getByTestId('tool-health')).toHaveTextContent('Key saved');
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
});
