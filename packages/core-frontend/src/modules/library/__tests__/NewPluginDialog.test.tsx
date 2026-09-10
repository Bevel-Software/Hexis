import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

/**
 * Making a plugin.
 *
 * A plugin comes from the dedicated provisioning endpoint — the server owns
 * the folder, the seeded access.md and the commit. What is worth testing here
 * is the two refusals the dialog can reach before the call — a name that
 * collides with a plugin you cannot even see, and a name that would create a
 * nested folder — plus the fact that the caller lands somewhere real
 * afterwards, and that the server's own refusal is what the toast shows.
 */

const pluginsMock = vi.hoisted(() => ({ createPlugin: vi.fn() }));
vi.mock('../services/plugins.api', () => ({
  createPlugin: pluginsMock.createPlugin,
}));

import { NewPluginDialog } from '../components/NewPluginDialog';
import { LibraryToastProvider } from '../state/toast';

function LocationProbe() {
  const location = useLocation();
  return <div aria-label="pathname">{location.pathname}</div>;
}

function renderDialog(existing: string[] = ['GTM', 'Finance'], parent?: string) {
  const onCreated = vi.fn();
  const onClose = vi.fn();
  render(
    <MemoryRouter initialEntries={['/skills-and-tools']}>
      <LibraryToastProvider>
        <Routes>
          <Route
            path="*"
            element={
              <NewPluginDialog existing={existing} parent={parent} onClose={onClose} onCreated={onCreated} />
            }
          />
        </Routes>
        <LocationProbe />
      </LibraryToastProvider>
    </MemoryRouter>,
  );
  return {
    onCreated,
    onClose,
    field: () => screen.getByRole('textbox', { name: 'Plugin name' }),
    submit: () => screen.getByRole('button', { name: /Create plugin|Creating/ }),
    pathname: () => screen.getByLabelText('pathname').textContent,
  };
}

describe('NewPluginDialog', () => {
  beforeEach(() => {
    pluginsMock.createPlugin.mockReset();
    // A folder AND an identity that both DIFFER from the input, so a dialog
    // that navigates with the typed name — or with the folder — fails here.
    pluginsMock.createPlugin.mockImplementation(async (name: string) => ({
      folder: `${name}-canonical`,
      name: `${name.toLowerCase()}-id`,
    }));
  });

  it('will not create an unnamed plugin', () => {
    const { submit } = renderDialog();
    expect(submit()).toBeDisabled();
  });

  it('creates the folder under Plugins/ and opens the new plugin', async () => {
    const { field, submit, onCreated, pathname } = renderDialog();
    fireEvent.change(field(), { target: { value: '  Design  ' } });
    fireEvent.click(submit());

    // Trimmed — the endpoint owns everything after the name. No parent: the root.
    await waitFor(() => expect(pluginsMock.createPlugin).toHaveBeenCalledWith('Design', ''));
    // The route is built from the SERVER's identity — not the typed name, not the folder.
    await waitFor(() => expect(pathname()).toBe('/skills-and-tools/plugins/design-id'));
    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/This one goes in/)).toBeNull();
  });

  it('makes the plugin inside the folder it was opened from, and says so', async () => {
    const { field, submit } = renderDialog(['GTM'], 'Teams/EU');
    expect(screen.getByText(/This one goes in/)).toHaveTextContent('Teams/EU/');
    fireEvent.change(field(), { target: { value: 'Design' } });
    fireEvent.click(submit());
    await waitFor(() => expect(pluginsMock.createPlugin).toHaveBeenCalledWith('Design', 'Teams/EU'));
  });

  it('refuses a name that is already taken, whoever can see it', () => {
    // `existing` carries LOCKED plugins too. Creating `Plugins/Finance` when a
    // Finance you cannot read exists would not make a plugin — it would put
    // your items in somebody else's.
    const { field, submit } = renderDialog(['GTM', 'Finance']);
    fireEvent.change(field(), { target: { value: 'finance' } });
    expect(screen.getByRole('alert')).toHaveTextContent('already exists');
    expect(submit()).toBeDisabled();
  });

  it('refuses a name that would create a nested folder', () => {
    // `Plugins/A/B` would be read back by `pluginOfPath` as the plugin "A".
    const { field, submit } = renderDialog();
    fireEvent.change(field(), { target: { value: 'GTM/EMEA' } });
    expect(screen.getByRole('alert')).toHaveTextContent('/');
    expect(submit()).toBeDisabled();
  });

  it("shows the server's own refusal and stays open", async () => {
    // The server's check runs against the live tree (ours against a stale
    // catalog), so ITS words are the ones worth showing.
    pluginsMock.createPlugin.mockRejectedValue(
      new Error('Plugin names starting with "personal-" are reserved.'),
    );
    const { field, submit, onClose } = renderDialog();
    fireEvent.change(field(), { target: { value: 'personal-notes' } });
    fireEvent.click(submit());

    expect(await screen.findByText(/reserved/)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});
