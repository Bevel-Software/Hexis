import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import {
  WorkspaceContext,
  type WorkspaceContextValue,
} from '../../workspace/state/workspace.context';
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

import { AddToGroupDialog } from '../components/AddToGroupDialog';

const ADD_PROMPT =
  'Help me build a new skill or tool and add it to the GTM group at Bevel. ' +
  'I run it, so it goes in directly. No review step.';

function workspace(kbDirName: string | null) {
  return { workspaceId: 'target-company-state', kbDirName } as unknown as WorkspaceContextValue;
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
) {
  const onClose = vi.fn();
  render(
    <MemoryRouter initialEntries={['/skills-and-tools/groups/GTM']}>
      <WorkspaceContext.Provider value={workspace(kbDirName)}>
        <LibraryToastProvider>
          {withAuth(
            <>
              <Routes>
                <Route
                  path="*"
                  element={
                    <AddToGroupDialog
                      name="GTM"
                      primaryPath="Groups/GTM"
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

describe('AddToGroupDialog', () => {
  beforeEach(() => {
    writeText.mockReset();
    writeText.mockResolvedValue(undefined);
    apiMock.createEmptySkill.mockReset();
    apiMock.createEmptySkill.mockResolvedValue({
      repoRelativePath: 'Groups/GTM/weekly-report/SKILL.md',
      workspacePath: 'knowledge-base/Groups/GTM/weekly-report/SKILL.md',
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

  it('names the group in its title and its lede', () => {
    renderDialog();
    expect(screen.getByRole('heading', { name: 'Add a skill or tool to GTM' })).toBeInTheDocument();
    expect(
      screen.getByText(
        'Two ways in. Either way it joins GTM. Everyone in the group gets it the next time their agent connects.',
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
// This half used to navigate to the group folder and leave the person there to
// work out that a skill is a folder with a SKILL.md in it. It now writes the
// file, so the assertions are about what gets written and where it opens.
describe('AddToGroupDialog: starting an empty SKILL.md', () => {
  beforeEach(() => {
    apiMock.createEmptySkill.mockReset();
    apiMock.createEmptySkill.mockResolvedValue({
      repoRelativePath: 'Groups/GTM/weekly-report/SKILL.md',
      workspacePath: 'knowledge-base/Groups/GTM/weekly-report/SKILL.md',
      branch: 'target-company-state',
      direct: true,
    });
  });

  it('will not create an unnamed skill', () => {
    const { create } = renderDialog();
    expect(create()).toBeDisabled();
  });

  it('creates it in the group folder, opens the file, and closes', async () => {
    const { field, create, onClose, href } = renderDialog();
    fireEvent.change(field(), { target: { value: '  weekly-report  ' } });
    fireEvent.click(create());

    // Trimmed, addressed at the group's own folder, and carrying the writer
    // verdict — the service decides direct-vs-change-request from it.
    await waitFor(() =>
      expect(apiMock.createEmptySkill).toHaveBeenCalledWith(
        expect.objectContaining({
          parentPath: 'Groups/GTM',
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
      expect(href()).toBe('/skills-and-tools/skills/weekly-report'),
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

  it('refuses a name another skill already holds, in any group', () => {
    // A skill's id IS its name, and the backend's scan drops the second claimant
    // outright — so this file would exist and never appear anywhere.
    const { field, create } = renderDialog('knowledge-base', true, ['rfi', 'weekly-report']);
    fireEvent.change(field(), { target: { value: 'Weekly-Report' } });
    expect(screen.getByRole('alert')).toHaveTextContent('already exists');
    expect(create()).toBeDisabled();
  });

  it('surfaces the backend refusal and stays open', async () => {
    apiMock.createEmptySkill.mockRejectedValue(
      new Error("You don't have permission to write to Groups/GTM"),
    );
    const { field, create, onClose } = renderDialog();
    fireEvent.change(field(), { target: { value: 'weekly-report' } });
    fireEvent.click(create());

    expect(await screen.findByText(/don't have permission to write to Groups\/GTM/)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});

// ── one door, one varying clause ──
// The group page used to fork on `canWrite` into two different flows. It does
// not any more: everybody gets THIS dialog, and the only thing role changes is
// what the prompt says happens next — and, now, where the new file lands.
describe('AddToGroupDialog for a non-writer', () => {
  it('offers the same dialog, and tells the truth about review', () => {
    renderDialog('knowledge-base', false);
    expect(
      screen.getByText(/goes to GTM as a change request, and an owner reviews it/),
    ).toBeInTheDocument();
    expect(screen.getByText(/send it to the group as a change request/)).toBeInTheDocument();
    expect(screen.queryByText(/no review step/)).not.toBeInTheDocument();
  });

  it('still offers both doors', () => {
    renderDialog('knowledge-base', false);
    expect(screen.getByRole('textbox', { name: 'Skill name' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy prompt' })).toBeInTheDocument();
  });

  it('passes the verdict down, so the file goes for review', async () => {
    apiMock.createEmptySkill.mockResolvedValue({
      repoRelativePath: 'Groups/GTM/weekly-report/SKILL.md',
      workspacePath: 'knowledge-base/Groups/GTM/weekly-report/SKILL.md',
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
    // A proposal has no page yet, so the dialog does NOT navigate — the group
    // page stays put, and the new skill appears on it as an "In review" card.
    expect(await screen.findByText(/sent to the group's owners for review/)).toBeInTheDocument();
    expect(href()).toBe('/skills-and-tools/groups/GTM');
  });
});
