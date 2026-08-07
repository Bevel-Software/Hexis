import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import {
  WorkspaceContext,
  type WorkspaceContextValue,
} from '../../workspace/state/workspace.context';
import { LibraryToastProvider } from '../state/toast';
import { withAuth, TEST_PERSONAL_GROUP } from './auth-harness';

/**
 * A person's own "add something" dialog.
 *
 * It carried one door until now — copy a prompt — because its first half used
 * to be a LINK into the destination folder and this page is defined as the
 * items in no folder. Writing needs no such destination: an ungrouped skill
 * lives in the caller's own `Groups/personal-<id>/` folder, so the door is back.
 *
 * The load-bearing assertion is that it creates DIRECTLY. A skill you make
 * here is yours — the new folder's `access.md` is seeded naming you as owner
 * as part of the same creation — so nothing about this door may quietly become
 * a change request.
 */

const apiMock = vi.hoisted(() => ({ createEmptySkill: vi.fn() }));
vi.mock('../services/library.api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/library.api')>()),
  createEmptySkill: apiMock.createEmptySkill,
}));

import { PersonalAddDialog } from '../components/PersonalAddDialog';

const workspace = {
  workspaceId: 'target-company-state',
  kbDirName: 'knowledge-base',
} as unknown as WorkspaceContextValue;

function LocationProbe() {
  const location = useLocation();
  return <div aria-label="href">{location.pathname}</div>;
}

function renderDialog(existingSkills: string[] = []) {
  const onClose = vi.fn();
  render(
    <MemoryRouter initialEntries={['/skills-and-tools/yours']}>
      <WorkspaceContext.Provider value={workspace}>
        <LibraryToastProvider>
          {withAuth(
            <>
              <Routes>
                <Route
                  path="*"
                  element={
                    <PersonalAddDialog
                      name={TEST_PERSONAL_GROUP}
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

describe('PersonalAddDialog', () => {
  beforeEach(() => {
    apiMock.createEmptySkill.mockReset();
    apiMock.createEmptySkill.mockResolvedValue({
      repoRelativePath: 'Groups/scratch/SKILL.md',
      workspacePath: 'knowledge-base/Groups/scratch/SKILL.md',
      branch: 'target-company-state',
      direct: true,
    });
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(navigator, 'clipboard');
  });

  it('offers both doors, not just the prompt', () => {
    const { field } = renderDialog();
    expect(field()).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy prompt' })).toBeInTheDocument();
    expect(screen.getByText(/yours alone until you add it to a group/)).toBeInTheDocument();
  });

  it('creates the skill as PERSONAL — destination resolution belongs to the api layer', async () => {
    // The dialog does not know (or guess) the personal folder's name: it
    // says `personal: true`, and `createEmptySkill` ensures the folder via
    // the provisioning endpoint before the write.
    const { field, create, onClose, href } = renderDialog();
    fireEvent.change(field(), { target: { value: 'scratch' } });
    fireEvent.click(create());

    await waitFor(() =>
      expect(apiMock.createEmptySkill).toHaveBeenCalledWith(
        expect.objectContaining({ personal: true, name: 'scratch' }),
      ),
    );
    // The skill's own library page, editor invited open — not the Knowledge app.
    await waitFor(() => expect(href()).toBe('/skills-and-tools/skills/scratch'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('creates it directly — a skill of your own is never sent for review', async () => {
    // The whole point of the personal list: the ensured personal folder's
    // access.md names the creator as owner, so there is nobody to review it
    // and nothing to wait for.
    const { field, create } = renderDialog();
    fireEvent.change(field(), { target: { value: 'scratch' } });
    fireEvent.click(create());

    await waitFor(() =>
      expect(apiMock.createEmptySkill).toHaveBeenCalledWith(
        expect.objectContaining({ personal: true }),
      ),
    );
    expect(await screen.findByText(/opening it/)).toBeInTheDocument();
    expect(screen.queryByText(/sent for review/)).not.toBeInTheDocument();
  });

  it('refuses a name a group’s skill already holds', async () => {
    const { field, create } = renderDialog(['rfi']);
    fireEvent.change(field(), { target: { value: 'RFI' } });
    expect(screen.getByRole('alert')).toHaveTextContent('already exists');
    expect(create()).toBeDisabled();
    await waitFor(() => expect(apiMock.createEmptySkill).not.toHaveBeenCalled());
  });
});
