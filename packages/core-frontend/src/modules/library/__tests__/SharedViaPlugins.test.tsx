import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LibraryContext } from '../state/library-context';
import type { LibraryContextValue, LibraryItem } from '../state/library-data';
import type { PluginMembership } from '../services/library.api';
import { SharedViaPlugins } from '../components/skill-page/SharedViaPlugins';

/**
 * The skill page's "In plugins" section, on the one question this ticket
 * settles: who may be shared onward.
 *
 * The section used to read `metadata.lifecycle` off the catalog item and offer
 * a retired skill nothing — the chooser went empty because the link API would
 * have refused every choice. The API no longer refuses, so neither does this:
 * a skill is offered every plugin the caller manages, whatever its frontmatter
 * still declares.
 */

const OK = { state: 'ok' as const, text: 'Ready' };

function pluginSummary(name: string) {
  return {
    name,
    folders: [`Plugins/${name}`],
    canRead: true,
    canWrite: true,
  } as LibraryContextValue['pluginSummaries'][number];
}

function lib(items: LibraryItem[]): LibraryContextValue {
  return {
    loading: false,
    error: null,
    skills: [],
    pendingSkills: [],
    tools: [],
    ownedSkills: new Set(),
    writableSkills: new Set(),
    ownedTools: new Set(),
    allowedToolsBySkill: new Map(),
    crs: [],
    myCrNumbers: new Set(),
    reload: vi.fn(),
    items,
    pluginSummaries: [pluginSummary('GTM')],
    pluginsLoading: false,
    pluginsError: null,
    teams: [],
    teamsLoading: false,
    teamsError: null,
    reloadPlugins: vi.fn(),
  };
}

function renderSection(items: LibraryItem[], memberships: PluginMembership[] = []) {
  render(
    <MemoryRouter>
      <LibraryContext.Provider value={lib(items)}>
        <SharedViaPlugins
          skillName="legacy"
          skillPath="Skills/Eng/legacy"
          memberships={memberships}
          canWrite
          onChanged={vi.fn()}
        />
      </LibraryContext.Provider>
    </MemoryRouter>,
  );
}

// The cast is the point: `lifecycle` is no longer part of `LibraryItem`, so a
// server still sending the key — from a SKILL.md that still declares it — is
// exactly the case that must change nothing here.
const legacy = {
  kind: 'skill',
  id: 'legacy',
  name: 'legacy',
  description: 'Old but readable.',
  owned: true,
  canWrite: true,
  plugin: null,
  shared: true,
  plugins: [],
  path: 'Skills/Eng/legacy',
  status: OK,
  lifecycle: 'retired',
} as LibraryItem;

describe('SharedViaPlugins', () => {
  it('offers the plugins the caller manages to a skill whose frontmatter still says retired', async () => {
    renderSection([legacy]);
    fireEvent.click(screen.getByRole('button', { name: 'Add to plugin…' }));
    expect(await screen.findByRole('option', { name: 'GTM' })).toBeInTheDocument();
  });

  it('leaves out only the plugins the skill is already in', () => {
    renderSection([legacy], [{ name: 'GTM', linked: true, granted: true }]);
    // The one managed plugin already holds it, so there is nothing to add —
    // an absent chooser, not an empty one, and for a reason that is about
    // membership rather than about the skill's declared lifecycle.
    expect(screen.queryByRole('button', { name: 'Add to plugin…' })).not.toBeInTheDocument();
    expect(screen.getByText('GTM')).toBeInTheDocument();
  });
});
