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
 * lives at `Groups/<name>/SKILL.md`, so the door is back, and the interesting
 * part is that the `Groups/` root is admin-only by default. For most people
 * their own skill therefore goes for review, and the dialog has to say that
 * BEFORE they press the button.
 */

const apiMock = vi.hoisted(() => ({ createEmptySkill: vi.fn() }));
vi.mock('../services/library.api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/library.api')>()),
  createEmptySkill: apiMock.createEmptySkill,
}));

const accessMock = vi.hoisted(() => ({ fetchFileAccess: vi.fn() }));
vi.mock('../../access/api', () => ({ fetchFileAccess: accessMock.fetchFileAccess }));

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
    accessMock.fetchFileAccess.mockReset();
    accessMock.fetchFileAccess.mockResolvedValue({ canWrite: true });
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(navigator, 'clipboard');
  });

  it('offers both doors, not just the prompt', async () => {
    const { field } = renderDialog();
    expect(field()).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy prompt' })).toBeInTheDocument();
    expect(screen.getByText(/yours alone until you add it to a group/)).toBeInTheDocument();
    await waitFor(() => expect(accessMock.fetchFileAccess).toHaveBeenCalled());
  });

  it('writes an ungrouped skill straight under Groups/, one level above a group’s', async () => {
    const { field, create, onClose, href } = renderDialog();
    // Wait for the access verdict, else the panel would still read "not a writer".
    await waitFor(() => expect(accessMock.fetchFileAccess).toHaveBeenCalled());

    fireEvent.change(field(), { target: { value: 'scratch' } });
    fireEvent.click(create());

    await waitFor(() =>
      expect(apiMock.createEmptySkill).toHaveBeenCalledWith(
        expect.objectContaining({ parentPath: 'Groups', name: 'scratch', canWrite: true }),
      ),
    );
    await waitFor(() =>
      expect(href()).toBe('/workspace/target-company-state/knowledge-base/Groups/scratch/SKILL.md'),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('warns before the press when the Groups root is not theirs to write', async () => {
    accessMock.fetchFileAccess.mockResolvedValue({ canWrite: false });
    renderDialog();
    expect(
      await screen.findByText(/can't write outside a group directly, so it goes for review/),
    ).toBeInTheDocument();
  });

  it('treats an unanswered access lookup as "not a writer"', async () => {
    accessMock.fetchFileAccess.mockRejectedValue(new Error('offline'));
    const { field, create } = renderDialog();
    fireEvent.change(field(), { target: { value: 'scratch' } });
    fireEvent.click(create());

    // Fail-closed: a failed lookup must not promote anyone to writer, because
    // the direct write would then 403 instead of becoming a change request.
    await waitFor(() =>
      expect(apiMock.createEmptySkill).toHaveBeenCalledWith(
        expect.objectContaining({ canWrite: false }),
      ),
    );
  });

  it('refuses a name a group’s skill already holds', async () => {
    const { field, create } = renderDialog(['rfi']);
    fireEvent.change(field(), { target: { value: 'RFI' } });
    expect(screen.getByRole('alert')).toHaveTextContent('already exists');
    expect(create()).toBeDisabled();
    await waitFor(() => expect(apiMock.createEmptySkill).not.toHaveBeenCalled());
  });
});
