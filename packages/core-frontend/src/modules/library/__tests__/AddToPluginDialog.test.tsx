import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DEFAULT_BRANCH } from '@bevel-software/platform-shared';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import {
  WorkspaceContext,
  type WorkspaceContextValue,
} from '../../workspace/state/workspace.context';
import { AdminContext, type AdminContextValue } from '../../admin/state/admin.context';
import { LibraryToastProvider } from '../state/toast';
import { withAuth } from './auth-harness';

/**
 * The writer's "add something" dialog. The prompt is the product in its second
 * half, so it is asserted character-for-character: it is pasted into an agent
 * verbatim, and a drifting word changes what the agent does with it. The first
 * half is now a real write rather than a link, so what is worth testing there
 * is the path it composes and the two ways the name can be wrong.
 */

const apiMock = vi.hoisted(() => ({ createEmptySkill: vi.fn() }));
vi.mock('../services/library.api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/library.api')>()),
  createEmptySkill: apiMock.createEmptySkill,
}));

import { AddToPluginDialog } from '../components/AddToPluginDialog';

const ADD_PROMPT =
  'Help me build a new skill or tool and add it to the GTM plugin at Bevel. ' +
  'I run it, so it goes in directly. No review step.';

function workspace(kbDirName: string | null) {
  return { workspaceId: 'target-company-state', kbDirName } as unknown as WorkspaceContextValue;
}

function admin(isAdmin: boolean): AdminContextValue {
  return {
    isAdmin,
    unreadCount: 0,
    lastSeen: null,
    markSeen: vi.fn(),
    refresh: vi.fn(),
    rolesConfigCorrupted: false,
    rolesConfigErrors: [],
    runRolesRecovery: vi.fn(),
  };
}

function LocationProbe() {
  const location = useLocation();
  return (
    <>
      <div aria-label="href">{location.pathname}</div>
      <div aria-label="router-state">{JSON.stringify(location.state)}</div>
    </>
  );
}

function renderDialog(
  kbDirName: string | null = 'knowledge-base',
  canWrite = true,
  existingSkills: string[] = [],
  isAdmin = true,
) {
  const onClose = vi.fn();
  render(
    <MemoryRouter initialEntries={['/skills-and-tools/plugins/GTM']}>
      <AdminContext.Provider value={admin(isAdmin)}>
        <WorkspaceContext.Provider value={workspace(kbDirName)}>
          <LibraryToastProvider>
            {withAuth(
              <>
                <Routes>
                  <Route
                    path="*"
                    element={
                      <AddToPluginDialog
                        name="GTM"
                        primaryPath="Plugins/GTM"
                        canWrite={canWrite}
                        existingSkills={existingSkills}
                        onClose={onClose}
                      />
                    }
                  />
                </Routes>
                <LocationProbe />
              </>,
            )}
          </LibraryToastProvider>
        </WorkspaceContext.Provider>
      </AdminContext.Provider>
    </MemoryRouter>,
  );
  return {
    onClose,
    field: () => screen.getByRole('textbox', { name: 'Skill name' }),
    create: () => screen.getByRole('button', { name: /^Create|Creating/ }),
    href: () => screen.getByLabelText('href').textContent,
  };
}

const writeText = vi.fn<(text: string) => Promise<void>>();

describe('AddToPluginDialog', () => {
  beforeEach(() => {
    writeText.mockReset();
    writeText.mockResolvedValue(undefined);
    apiMock.createEmptySkill.mockReset();
    apiMock.createEmptySkill.mockResolvedValue({
      repoRelativePath: 'Plugins/GTM/weekly-report/SKILL.md',
      workspacePath: 'knowledge-base/Plugins/GTM/weekly-report/SKILL.md',
      branch: 'target-company-state',
      direct: true,
    });
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(navigator, 'clipboard');
  });

  it('names the plugin in its title and its lede', () => {
    renderDialog();
    expect(screen.getByRole('heading', { name: 'Add a skill or tool to GTM' })).toBeInTheDocument();
    expect(
      screen.getByText(
        'Two ways in. Either way it joins GTM. Everyone in the plugin gets it the next time their agent connects.',
      ),
    ).toBeInTheDocument();
  });

  it('copies the agent prompt verbatim and says so', async () => {
    renderDialog();
    expect(screen.getByText(ADD_PROMPT)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Copy prompt' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(ADD_PROMPT));
    expect(await screen.findByText('Prompt copied.')).toBeInTheDocument();
  });

  it('tells the truth when the clipboard is unavailable', async () => {
    // What a non-secure context looks like: the API is simply not there.
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Copy prompt' }));
    expect(
      await screen.findByText("Couldn't copy: select the prompt text instead."),
    ).toBeInTheDocument();
    expect(screen.queryByText('Prompt copied.')).not.toBeInTheDocument();
  });

  it('closes from the footer', () => {
    const { onClose } = renderDialog();
    // Two controls are named "Close": the dialog chrome's X and the footer
    // button. The footer one is last in the DOM.
    const closes = screen.getAllByRole('button', { name: 'Close' });
    fireEvent.click(closes[closes.length - 1]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// ── the first door: a file, not a folder tour ──
// This half used to navigate to the plugin folder and leave the person there to
// work out that a skill is a folder with a SKILL.md in it. It now writes the
// file, so the assertions are about what gets written and where it opens.
describe('AddToPluginDialog: starting an empty SKILL.md', () => {
  beforeEach(() => {
    apiMock.createEmptySkill.mockReset();
    apiMock.createEmptySkill.mockResolvedValue({
      repoRelativePath: 'Plugins/GTM/weekly-report/SKILL.md',
      workspacePath: 'knowledge-base/Plugins/GTM/weekly-report/SKILL.md',
      branch: 'target-company-state',
      direct: true,
    });
  });

  it('will not create an unnamed skill', () => {
    const { create } = renderDialog();
    expect(create()).toBeDisabled();
  });

  it('creates it in the plugin folder, opens the file, and closes', async () => {
    const { field, create, onClose, href } = renderDialog();
    fireEvent.change(field(), { target: { value: '  weekly-report  ' } });
    fireEvent.click(create());

    // Trimmed, addressed at the plugin's own folder, and carrying the writer
    // verdict — the service decides direct-vs-change-request from it.
    await waitFor(() =>
      expect(apiMock.createEmptySkill).toHaveBeenCalledWith(
        expect.objectContaining({
          parentPath: 'Plugins/GTM',
          name: 'weekly-report',
          canWrite: true,
        }),
      ),
    );
    // Lands on the new skill's own LIBRARY page — never bounced to the
    // Knowledge app — with the editor handed the open signal IN ROUTER
    // STATE. Asserted by field, so a renamed or dropped flag fails here
    // rather than silently landing on a read-only page.
    await waitFor(() =>
      // The canonical address: the new SKILL.md's own workspace URL.
      expect(href()).toBe(`/workspace/${DEFAULT_BRANCH}/knowledge-base/Plugins/GTM/weekly-report/SKILL.md`),
    );
    expect(screen.getByLabelText('router-state')).toHaveTextContent(
      JSON.stringify({ startEditing: true }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('refuses a name that would create a nested folder', () => {
    const { field, create } = renderDialog();
    fireEvent.change(field(), { target: { value: 'GTM/weekly' } });
    expect(screen.getByRole('alert')).toHaveTextContent('/');
    expect(create()).toBeDisabled();
    expect(apiMock.createEmptySkill).not.toHaveBeenCalled();
  });

  it('refuses a name another skill already holds, in any plugin', () => {
    // A skill's id IS its name, and the backend's scan drops the second claimant
    // outright — so this file would exist and never appear anywhere.
    const { field, create } = renderDialog('knowledge-base', true, ['rfi', 'weekly-report']);
    fireEvent.change(field(), { target: { value: 'Weekly-Report' } });
    expect(screen.getByRole('alert')).toHaveTextContent('already exists');
    expect(create()).toBeDisabled();
  });

  it('surfaces the backend refusal and stays open', async () => {
    apiMock.createEmptySkill.mockRejectedValue(
      new Error("You don't have permission to write to Plugins/GTM"),
    );
    const { field, create, onClose } = renderDialog();
    fireEvent.change(field(), { target: { value: 'weekly-report' } });
    fireEvent.click(create());

    expect(await screen.findByText(/don't have permission to write to Plugins\/GTM/)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});

// ── one door, one varying clause ──
// The plugin page used to fork on `canWrite` into two different flows. It does
// not any more: everybody gets THIS dialog, and the only thing role changes is
// what the prompt says happens next — and, now, where the new file lands.
describe('AddToPluginDialog for an admin non-writer', () => {
  it('offers the same dialog, and tells the truth about review', () => {
    renderDialog('knowledge-base', false);
    // Both clauses also appear on the hidden Tools panel, so this is scoped to
    // the panel actually on screen.
    const skills = within(screen.getByRole('tabpanel'));
    expect(
      skills.getByText(/goes to GTM as a change request, and an owner reviews it/),
    ).toBeInTheDocument();
    expect(skills.getByText(/send it to the plugin as a change request/)).toBeInTheDocument();
    expect(screen.queryByText(/no review step/)).not.toBeInTheDocument();
  });

  it('still offers an admin both doors', () => {
    renderDialog('knowledge-base', false);
    expect(screen.getByRole('textbox', { name: 'Skill name' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy prompt' })).toBeInTheDocument();
  });

  it('passes the verdict down, so the file goes for review', async () => {
    apiMock.createEmptySkill.mockResolvedValue({
      repoRelativePath: 'Plugins/GTM/weekly-report/SKILL.md',
      workspacePath: 'knowledge-base/Plugins/GTM/weekly-report/SKILL.md',
      branch: 'suggestions/juan/weekly-report',
      direct: false,
    });
    const { field, create, href } = renderDialog('knowledge-base', false);
    fireEvent.change(field(), { target: { value: 'weekly-report' } });
    fireEvent.click(create());

    await waitFor(() =>
      expect(apiMock.createEmptySkill).toHaveBeenCalledWith(
        expect.objectContaining({ canWrite: false }),
      ),
    );
    // A proposal has no page yet, so the dialog does NOT navigate — the plugin
    // page stays put, and the new skill appears on it as an "In review" card.
    expect(await screen.findByText(/sent to the plugin's owners for review/)).toBeInTheDocument();
    expect(href()).toBe('/skills-and-tools/plugins/GTM');
  });
});

describe('AddToPluginDialog for a non-admin', () => {
  beforeEach(() => {
    apiMock.createEmptySkill.mockClear();
  });

  it('removes empty skill creation even when the person can write the plugin', () => {
    renderDialog('knowledge-base', true, [], false);

    expect(screen.queryByText('Start an empty SKILL.md')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Skill name' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy prompt' })).toBeInTheDocument();
    expect(screen.getByText(/add it to GTM for everyone in the plugin/)).toBeInTheDocument();
    expect(screen.queryByText(/Two ways in/)).not.toBeInTheDocument();
  });

  it('keeps only the reviewed agent path when the person cannot write the plugin', () => {
    renderDialog('knowledge-base', false, [], false);

    expect(screen.queryByText('Start an empty SKILL.md')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Skill name' })).not.toBeInTheDocument();
    const skills = within(screen.getByRole('tabpanel'));
    expect(skills.getByText(/change request for an owner to review/)).toBeInTheDocument();
    expect(skills.getByText(/send it to the plugin as a change request/)).toBeInTheDocument();
    expect(apiMock.createEmptySkill).not.toHaveBeenCalled();
  });
});


// ── the Tools tab ──
// The dialog is titled "Add a skill or tool", and people looking for the tool
// half found only skills. The Tools tab explains rather than creates, so what
// is worth asserting is its prompt (verbatim, per plugin and per role), the
// two declaration surfaces it names, and that it carries no form.
//
// Both panels are MOUNTED at all times and the inactive one is hidden, so the
// Skills half never loses a half-typed name to a tab click. That makes every
// text assertion below panel-scoped: `panel()` is the visible tabpanel, and
// the hidden one is deliberately still in the document.
describe('AddToPluginDialog: Skills and Tools tabs', () => {
  beforeEach(() => {
    writeText.mockReset();
    writeText.mockResolvedValue(undefined);
    apiMock.createEmptySkill.mockReset();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  });

  afterEach(() => {
    Reflect.deleteProperty(navigator, 'clipboard');
  });

  const TOOL_PROMPT_WRITER =
    'Help me build a new tool and add it to the GTM plugin at Bevel. ' +
    'I run it, so it goes in directly. No review step.';
  const TOOL_PROMPT_NON_OWNER =
    'Help me build a new tool and add it to the GTM plugin at Bevel. ' +
    'I am not an owner, so send it to the plugin as a change request for review.';
  const TOOL_MANUAL_SENTENCE =
    'To call an API without an MCP server, add a .tool manual describing it to the ' +
    "GTM plugin's software.bevel.hexis/tools/ folder.";

  /** The visible tabpanel. Role queries skip the hidden one. */
  const panel = () => screen.getByRole('tabpanel');

  it('opens on Skills, with the two tabs named Skills and Tools', () => {
    renderDialog();
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Skills', 'Tools']);
    expect(screen.getByRole('tab', { name: 'Skills' })).toHaveAttribute('aria-selected', 'true');
    expect(panel()).toHaveAccessibleName('Skills');
    expect(within(panel()).getByText(ADD_PROMPT)).toBeInTheDocument();
    // The Tools half is mounted but not shown.
    expect(screen.getByText(TOOL_PROMPT_WRITER)).not.toBeVisible();
  });

  it('shows the tool prompt, the MCP and .tool sentences, and no form', () => {
    renderDialog();
    fireEvent.click(screen.getByRole('tab', { name: 'Tools' }));

    expect(screen.getByRole('tab', { name: 'Tools' })).toHaveAttribute('aria-selected', 'true');
    expect(panel()).toHaveAccessibleName('Tools');
    expect(within(panel()).getByText(TOOL_PROMPT_WRITER)).toBeInTheDocument();
    expect(
      within(panel()).getByText(
        'To connect an MCP server, add it to the mcp.json in the GTM plugin folder.',
      ),
    ).toBeInTheDocument();
    expect(within(panel()).getByText(TOOL_MANUAL_SENTENCE)).toBeInTheDocument();
    expect(
      within(panel()).getByText(/it joins GTM\. Everyone in the plugin gets it/),
    ).toBeInTheDocument();
    expect(screen.getByText(ADD_PROMPT)).not.toBeVisible();
    // No form on this tab: the Skills panel's field is hidden, so no role query
    // reaches it.
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Add a skill or tool to GTM' })).toBeInTheDocument();
  });

  // The regression the panels exist for: a name typed into the Skills half must
  // survive a look at the Tools tab.
  it('keeps a typed skill name across a tab round trip', () => {
    const { field } = renderDialog();
    fireEvent.change(field(), { target: { value: 'weekly-report' } });

    fireEvent.click(screen.getByRole('tab', { name: 'Tools' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Skills' }));

    expect(field()).toHaveValue('weekly-report');
  });

  it('copies the prompt of the tab that is showing', async () => {
    renderDialog();
    fireEvent.click(screen.getByRole('tab', { name: 'Tools' }));
    fireEvent.click(screen.getByRole('button', { name: 'Copy prompt' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(TOOL_PROMPT_WRITER));

    fireEvent.click(screen.getByRole('tab', { name: 'Skills' }));
    fireEvent.click(screen.getByRole('button', { name: 'Copy prompt' }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(ADD_PROMPT));
  });

  it('carries the change-request note and clause for a non-owner', () => {
    renderDialog('knowledge-base', false, [], false);
    fireEvent.click(screen.getByRole('tab', { name: 'Tools' }));
    expect(within(panel()).getByText(TOOL_PROMPT_NON_OWNER)).toBeInTheDocument();
    expect(
      within(panel()).getByText(
        /goes to GTM as a change request, and an owner reviews it before it joins/,
      ),
    ).toBeInTheDocument();
    expect(within(panel()).queryByText(/No review step/)).not.toBeInTheDocument();
  });

  it('names whichever plugin it was opened on', () => {
    render(
      <MemoryRouter>
        <AdminContext.Provider value={admin(false)}>
          <WorkspaceContext.Provider value={workspace('knowledge-base')}>
            <LibraryToastProvider>
              {withAuth(
                <AddToPluginDialog
                  name="Finance"
                  primaryPath="Plugins/Finance"
                  canWrite
                  existingSkills={[]}
                  onClose={vi.fn()}
                />,
              )}
            </LibraryToastProvider>
          </WorkspaceContext.Provider>
        </AdminContext.Provider>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Tools' }));
    expect(
      within(panel()).getByText(
        'Help me build a new tool and add it to the Finance plugin at Bevel. I run it, so it goes in directly. No review step.',
      ),
    ).toBeInTheDocument();
    expect(within(panel()).getByText(/mcp\.json in the Finance plugin folder/)).toBeInTheDocument();
    expect(
      within(panel()).getByText(/Finance plugin's software\.bevel\.hexis\/tools\/ folder/),
    ).toBeInTheDocument();
  });

  it('moves between tabs with the arrow keys, focus following', () => {
    renderDialog();
    const skills = screen.getByRole('tab', { name: 'Skills' });
    fireEvent.keyDown(skills, { key: 'ArrowRight' });
    const tools = screen.getByRole('tab', { name: 'Tools' });
    expect(tools).toHaveAttribute('aria-selected', 'true');
    expect(tools).toHaveFocus();
    fireEvent.keyDown(tools, { key: 'Home' });
    expect(screen.getByRole('tab', { name: 'Skills' })).toHaveAttribute('aria-selected', 'true');
  });

  // Each tab owns its own panel, so a screen reader following `aria-controls`
  // lands on the half that tab describes rather than on one relabelled div.
  it('gives each tab its own panel to control', () => {
    renderDialog();
    const ids = screen.getAllByRole('tab').map((t) => t.getAttribute('aria-controls'));
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) {
      const owned = document.getElementById(id!);
      expect(owned).not.toBeNull();
      expect(owned).toHaveAttribute('role', 'tabpanel');
    }
  });
});
