import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AdminContext, type AdminContextValue } from '../../admin';

/**
 * Who a plugin row says runs the plugin.
 *
 * `GET /api/plugins` names a person in `owners` and `writers` by email, with
 * an empty `name`: the access resolver has no display names to give. A
 * plugin whose access.md owns it to one person therefore arrives as
 * `owners.users: [{ name: '', email }]`, and its writers as that person plus
 * the Admin role the platform's floor adds. The row read "Run by Admin",
 * dropping the owner the agent had just reported.
 */

const libStub = vi.hoisted(() => ({ current: null as unknown }));

// The band reads the catalog from its context; the line under test is built
// from the summaries alone, so the context is stubbed rather than driven
// through the provider and its endpoints.
vi.mock('../state/library-data', async (orig) => ({
  ...(await orig<typeof import('../state/library-data')>()),
  useLibrary: () => libStub.current,
}));

import { PluginRows } from '../components/PluginRows';
import type { LibraryContextValue } from '../state/library-data';
import type { PluginEntry } from '../utils/plugin-entries';
import type { PluginSummary, PluginPrincipals } from '../services/plugins.api';

/** A person as the plugin listing sends one: by email, no display name. */
const person = (email: string) => ({ name: '', email });

function row(owners: PluginPrincipals, writers: PluginPrincipals) {
  const summary: PluginSummary = {
    name: 'qa-spaced',
    displayName: 'QA Spaced',
    folders: ['Plugins/QA Spaced'],
    linksAreManaged: true,
    canRead: true,
    canWrite: false,
    isOwner: false,
    skillCount: 0,
    toolCount: 0,
    brokenLinks: 0,
    owners,
    writers,
    readers: { restricted: true, roles: [], users: [] },
    isPrivate: false,
    hasRequested: false,
    requestNumber: null,
  };
  const entry: PluginEntry = {
    name: 'qa-spaced',
    label: 'QA Spaced',
    summary,
    skillCount: 0,
    toolCount: 0,
    attention: 0,
    urgent: false,
    member: true,
  };
  libStub.current = {
    loading: false,
    error: null,
    items: [],
    pluginSummaries: [summary],
    pluginsLoading: false,
    pluginsError: null,
    teams: [],
    teamsLoading: false,
    teamsError: null,
    reload: vi.fn(),
    reloadPlugins: vi.fn(),
  } as unknown as LibraryContextValue;
  render(
    <MemoryRouter>
      <AdminContext.Provider value={{ isAdmin: false } as AdminContextValue}>
        <PluginRows entries={[entry]} />
      </AdminContext.Provider>
    </MemoryRouter>,
  );
}

describe("a plugin row's run-by line", () => {
  it('names the owner the listing sends, not the Admin role inherited as a writer', () => {
    row(
      { roles: [], users: [person('qa-user@example.com')] },
      { roles: ['Admin'], users: [person('qa-user@example.com')] },
    );

    expect(screen.getByText('Run by qa-user@example.com')).toBeInTheDocument();
    expect(screen.queryByText('Run by Admin')).not.toBeInTheDocument();
  });

  it('names an owning person beside an owning group', () => {
    row(
      { roles: ['GTM Team'], users: [person('qa-user@example.com')] },
      { roles: ['Admin', 'GTM Team'], users: [person('qa-user@example.com')] },
    );

    expect(screen.getByText('Run by qa-user@example.com, GTM Team')).toBeInTheDocument();
  });

  it('falls back to the inherited Admin role only for a plugin with no owner', () => {
    row({ roles: [], users: [] }, { roles: ['Admin'], users: [] });

    expect(screen.getByText('Run by Admin')).toBeInTheDocument();
  });
});
