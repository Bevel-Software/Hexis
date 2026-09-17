import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

/**
 * The menu a skill card and a plugin row carry.
 *
 * A business-user tester could see plugins and skills on a group's page and had
 * nowhere to share any of them: Share lived on the item's own page, in the file
 * tree's right-click and on a nav row, never on the thing they were looking at.
 * So every card and row that HAS a second verb now offers one — and what is
 * under test here is which verb each of them gets, because that is the part
 * that differs: a readable skill shares its own folder, a readable plugin
 * shares its primary folder, and a plugin the caller cannot read is offered
 * the locked page's Subscribe instead.
 *
 * Dismissal — outside click, Escape, the focus handback that comes with it —
 * is `useDismissableMenu`'s and is covered where that is
 * (`PluginsSidebarMenu`); what the keyboard cases here prove is the part this
 * menu added, which is the INSIDE of it: opening lands focus on the first
 * verb, the arrows walk the items, and the two other ways out that leave the
 * focused node unmounted — Tab, and picking a verb — hand focus back too.
 */

const svc = vi.hoisted(() => ({ requestPluginAccess: vi.fn() }));
const libStub = vi.hoisted(() => ({ current: null as unknown }));

vi.mock('../services/plugins.api', async (orig) => ({
  ...(await orig<typeof import('../services/plugins.api')>()),
  requestPluginAccess: svc.requestPluginAccess,
}));
vi.mock('../../admin/state/admin.context', async (orig) => ({
  ...(await orig<typeof import('../../admin/state/admin.context')>()),
  useAdmin: () => ({ isAdmin: false }),
}));
// The band reads the catalog from its context; what decides a row's verbs is
// the entries and the summaries, so the context is stubbed rather than driven
// through the provider and its four endpoints.
vi.mock('../state/library-data', async (orig) => ({
  ...(await orig<typeof import('../state/library-data')>()),
  useLibrary: () => libStub.current,
}));

import { LibraryCard, type LibraryCardProps } from '../components/LibraryCard';
import { PluginRows } from '../components/PluginRows';
import type { LibraryContextValue } from '../state/library-data';
import type { PluginEntry } from '../utils/plugin-entries';
import type { PluginSummary } from '../services/plugins.api';

/* ---------------------------------------------------------------- helpers */

const items = () =>
  within(screen.getByRole('menu'))
    .getAllByRole('menuitem')
    .map((i) => i.textContent);

const trigger = (label: string) => screen.getByRole('button', { name: `Actions for ${label}` });

function card(over: Partial<LibraryCardProps> = {}) {
  const props = {
    kind: 'skill',
    id: 'rfi',
    name: 'rfi',
    description: 'Answers an RFI.',
    owned: false,
    status: { state: 'ok', text: 'Ready' },
    onOpen: vi.fn(),
    ...over,
  } as LibraryCardProps;
  render(<LibraryCard {...props} />);
  return props;
}

const summary = (over: Partial<PluginSummary>): PluginSummary => ({
  name: 'gtm',
  displayName: 'GTM',
  folders: ['Plugins/GTM'],
  linksAreManaged: true,
  canRead: true,
  canWrite: false,
  isOwner: false,
  skillCount: 2,
  toolCount: 1,
  brokenLinks: 0,
  owners: { roles: [], users: [{ name: 'Olga Ivanova', email: 'olga@example.com' }] },
  writers: { roles: [], users: [] },
  readers: { restricted: true, roles: [], users: [] },
  isPrivate: false,
  hasRequested: false,
  requestNumber: null,
  ...over,
});

const entry = (over: Partial<PluginEntry>): PluginEntry => ({
  name: 'gtm',
  label: 'GTM',
  summary: summary({}),
  skillCount: 2,
  toolCount: 1,
  attention: 0,
  urgent: false,
  member: true,
  ...over,
});

/**
 * The band with the catalog stubbed at the context, not at the network: what
 * is under test is which verbs a row offers, and that is decided from the
 * entries and the summaries alone.
 */
function rows(entries: PluginEntry[], onShare?: (folder: string) => void) {
  const lib = {
    loading: false,
    error: null,
    items: [],
    pluginSummaries: entries.map((e) => e.summary).filter((s): s is PluginSummary => s !== null),
    pluginsLoading: false,
    pluginsError: null,
    teams: [],
    teamsLoading: false,
    teamsError: null,
    reload: vi.fn(),
    reloadPlugins: vi.fn(),
  } as unknown as LibraryContextValue;
  libStub.current = lib;
  render(
    <MemoryRouter>
      <PluginRows entries={entries} onShare={onShare} />
    </MemoryRouter>,
  );
  return lib;
}

beforeEach(() => {
  vi.clearAllMocks();
  svc.requestPluginAccess.mockResolvedValue(undefined);
});

/* ------------------------------------------------------------------ cards */

describe('a skill card', () => {
  it('offers Open and Share, and Share opens the skill’s own access rules', () => {
    const onShare = vi.fn();
    card({ onShare });

    fireEvent.click(trigger('rfi'));
    expect(items()).toEqual(['Open', 'Share']);

    fireEvent.click(screen.getByRole('menuitem', { name: 'Share' }));
    expect(onShare).toHaveBeenCalledTimes(1);
    // Picking closes the menu — the dialog it opened is the surface now.
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('opens the same menu on right-click, at the pointer', () => {
    card({ onShare: vi.fn() });

    fireEvent.contextMenu(screen.getByRole('group', { name: 'rfi' }), { clientX: 120, clientY: 240 });
    expect(items()).toEqual(['Open', 'Share']);
    // AT THE POINTER, which is the half of this that a menu opening at the
    // trigger — or at the origin — would still pass without. The panel is
    // placed by the fixed wrapper around it; nothing is measurable in this
    // DOM, so the pointer is where it stays.
    const panel = screen.getByRole('menu').parentElement as HTMLElement;
    expect(panel.style.left).toBe('120px');
    expect(panel.style.top).toBe('240px');
  });

  it('still opens the skill when the card body is clicked', () => {
    const props = card({ onShare: vi.fn() });

    fireEvent.click(screen.getByTestId('library-card-skill-rfi'));
    expect(props.onOpen).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('carries no menu without a Share to offer, and none at all on a tool', () => {
    card({});
    expect(screen.queryByRole('button', { name: /^Actions for/ })).not.toBeInTheDocument();

    cleanup();
    // Access to a tool is decided at its plugin, so a tool card has nothing of
    // its own to share — the props union refuses `onShare` outright.
    card({ kind: 'integration', flavor: 'utcp', id: 'slack', name: 'Slack', status: { state: 'ok', text: 'Connected' } });
    expect(screen.queryByRole('button', { name: /^Actions for/ })).not.toBeInTheDocument();
  });

  /**
   * The keyboard path the ticket names: the "…" is a tab stop after the card,
   * Enter opens, the arrows move, Escape closes and hands focus back.
   */
  it('is driveable from the keyboard alone', async () => {
    const onShare = vi.fn();
    card({ onShare });
    const dots = trigger('rfi');

    // A real Enter on a focused button fires its click; the tab order is DOM
    // order, and the button follows the card inside the frame.
    const frame = screen.getByRole('group', { name: 'rfi' });
    expect(frame.firstElementChild).toBe(screen.getByTestId('library-card-skill-rfi'));
    expect(frame.children[1]).toBe(dots);

    dots.focus();
    // ENTER, not a synthesised click: the tab stop has to be operable by the
    // key the ticket names, and a click would pass even if it were not.
    await userEvent.keyboard('{Enter}');
    // Focus enters the menu with it, on the first verb.
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Open' }));

    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Share' }));
    // The list wraps, so the arrows never strand anybody at an end.
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Open' }));

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(dots);
    expect(onShare).not.toHaveBeenCalled();
  });

  /**
   * Every other way OUT of the menu, which all end with the focused node
   * unmounted: Tab (the menu closes and carries on) and picking a verb whose
   * action opens nothing that takes focus for itself. Focus left on a removed
   * node restarts the next Tab at the top of the document.
   */
  it('hands focus back to the "…" when the menu is tabbed out of, or picked from', () => {
    card({ onShare: vi.fn() });
    const dots = trigger('rfi');

    fireEvent.click(dots);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Tab' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(dots);

    fireEvent.click(dots);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Share' }));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(dots);
  });
});

/* ------------------------------------------------------------------- rows */

describe('a plugin row', () => {
  it("offers Open and Share, and Share names the plugin's primary folder", () => {
    const onShare = vi.fn();
    rows([entry({})], onShare);

    fireEvent.click(trigger('GTM'));
    expect(items()).toEqual(['Open', 'Share']);

    fireEvent.click(screen.getByRole('menuitem', { name: 'Share' }));
    expect(onShare).toHaveBeenCalledWith('Plugins/GTM');
  });

  it('offers Subscribe in place of Share on a plugin the caller cannot read, and asks its owners', async () => {
    rows([entry({ member: false, summary: summary({ canRead: false }) })], vi.fn());

    fireEvent.click(trigger('GTM'));
    expect(items()).toEqual(['Open', 'Subscribe']);

    fireEvent.click(screen.getByRole('menuitem', { name: 'Subscribe' }));
    expect(svc.requestPluginAccess).toHaveBeenCalledWith('gtm');
    // Having asked, the row says so — chip and menu both — rather than
    // offering the ask again. The same swap the locked page makes.
    await vi.waitFor(() => expect(screen.getByText('Requested')).toBeInTheDocument());

    fireEvent.click(trigger('GTM'));
    expect(items()).toEqual(['Open', 'Requested']);
    expect(screen.getByRole('menuitem', { name: 'Requested' })).toBeDisabled();
  });

  it('states Requested from the start for a plugin already asked about', () => {
    rows([entry({ member: false, summary: summary({ canRead: false, hasRequested: true }) })], vi.fn());

    fireEvent.click(trigger('GTM'));
    expect(items()).toEqual(['Open', 'Requested']);
  });

  it("gives the caller's own space no menu — it is not a plugin, and has neither verb", () => {
    rows([entry({ name: null, label: 'Yours', summary: null })], vi.fn());

    expect(screen.queryByRole('button', { name: /^Actions for/ })).not.toBeInTheDocument();
  });

  it('gives a readable plugin no menu when there is no folder to point Share at', () => {
    // Two ways to have none: the PAGE cannot address folders yet (no `onShare`
    // — its KB directory has not resolved), and the PLUGIN has no folder the
    // index named. Either way Share would open on a path we do not mean.
    rows([entry({})]);
    expect(screen.queryByRole('button', { name: /^Actions for/ })).not.toBeInTheDocument();

    cleanup();
    rows([entry({ summary: summary({ folders: [] }) })], vi.fn());
    expect(screen.queryByRole('button', { name: /^Actions for/ })).not.toBeInTheDocument();
  });
});
