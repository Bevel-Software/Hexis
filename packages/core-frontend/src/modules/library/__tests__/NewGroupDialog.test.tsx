import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import {
  WorkspaceContext,
  type WorkspaceContextValue,
} from '../../workspace/state/workspace.context';

/**
 * Making a group.
 *
 * A group IS a folder, so the whole feature is one `mkdir` under `Groups/` and
 * a navigation to the page that folder now has. What is worth testing is the
 * two ways it can go wrong before that call — a name that collides with a group
 * you cannot even see, and a name that would create a nested folder — plus the
 * fact that the caller lands somewhere real afterwards.
 */

const wsMock = vi.hoisted(() => ({ createDirectory: vi.fn() }));
vi.mock('../../workspace/services/workspace.api', () => ({
  createDirectory: wsMock.createDirectory,
}));

import { NewGroupDialog } from '../components/NewGroupDialog';
import { LibraryToastProvider } from '../state/toast';

const workspace = {
  workspaceId: 'target-company-state',
  kbDirName: 'knowledge-base',
} as unknown as WorkspaceContextValue;

function LocationProbe() {
  const location = useLocation();
  return <div aria-label="pathname">{location.pathname}</div>;
}

function renderDialog(existing: string[] = ['GTM', 'Finance']) {
  const onCreated = vi.fn();
  const onClose = vi.fn();
  render(
    <MemoryRouter initialEntries={['/skills-and-tools']}>
      <WorkspaceContext.Provider value={workspace}>
        <LibraryToastProvider>
          <Routes>
            <Route
              path="*"
              element={
                <NewGroupDialog existing={existing} onClose={onClose} onCreated={onCreated} />
              }
            />
          </Routes>
          <LocationProbe />
        </LibraryToastProvider>
      </WorkspaceContext.Provider>
    </MemoryRouter>,
  );
  return {
    onCreated,
    onClose,
    field: () => screen.getByRole('textbox', { name: 'Group name' }),
    submit: () => screen.getByRole('button', { name: /Create group|Creating/ }),
    pathname: () => screen.getByLabelText('pathname').textContent,
  };
}

describe('NewGroupDialog', () => {
  beforeEach(() => {
    wsMock.createDirectory.mockReset();
    wsMock.createDirectory.mockResolvedValue(undefined);
  });

  it('will not create an unnamed group', () => {
    const { submit } = renderDialog();
    expect(submit()).toBeDisabled();
  });

  it('creates the folder under Groups/ and opens the new group', async () => {
    const { field, submit, onCreated, pathname } = renderDialog();
    fireEvent.change(field(), { target: { value: '  Design  ' } });
    fireEvent.click(submit());

    // Trimmed, and addressed through the KB dir — the resolver reads paths
    // repo-relative, so the prefix is not optional.
    await waitFor(() =>
      expect(wsMock.createDirectory).toHaveBeenCalledWith(
        expect.any(String),
        'knowledge-base/Groups/Design',
      ),
    );
    await waitFor(() => expect(pathname()).toBe('/skills-and-tools/groups/Design'));
    expect(onCreated).toHaveBeenCalledTimes(1);
  });

  it('refuses a name that is already taken, whoever can see it', () => {
    // `existing` carries LOCKED groups too. Creating `Groups/Finance` when a
    // Finance you cannot read exists would not make a group — it would put
    // your items in somebody else's.
    const { field, submit } = renderDialog(['GTM', 'Finance']);
    fireEvent.change(field(), { target: { value: 'finance' } });
    expect(screen.getByRole('alert')).toHaveTextContent('already exists');
    expect(submit()).toBeDisabled();
  });

  it('refuses a name that would create a nested folder', () => {
    // `Groups/A/B` would be read back by `groupOfPath` as the group "A".
    const { field, submit } = renderDialog();
    fireEvent.change(field(), { target: { value: 'GTM/EMEA' } });
    expect(screen.getByRole('alert')).toHaveTextContent('/');
    expect(submit()).toBeDisabled();
  });

  it('says so when the folder could not be created, and stays open', async () => {
    wsMock.createDirectory.mockRejectedValue(new Error('nope'));
    const { field, submit, onClose } = renderDialog();
    fireEvent.change(field(), { target: { value: 'Design' } });
    fireEvent.click(submit());

    expect(await screen.findByText(/Couldn't create that group/)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});
