import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import {
  WorkspaceContext,
  type WorkspaceContextValue,
} from '../../workspace/state/workspace.context';
import { LibraryToastProvider } from '../state/toast';
import { AddToGroupDialog } from '../components/AddToGroupDialog';

/**
 * The writer's "add something" dialog. The prompt is the product here, so it is
 * asserted character-for-character: it is pasted into an agent verbatim, and a
 * drifting word changes what the agent does with it.
 */

const ADD_PROMPT =
  'Help me build a new skill or tool and add it to the GTM group at Bevel. ' +
  'I run it, so it goes in directly — no review step.';

function workspace(kbDirName: string | null) {
  return { workspaceId: 'target-company-state', kbDirName } as unknown as WorkspaceContextValue;
}

function LocationProbe() {
  const location = useLocation();
  return <div aria-label="href">{location.pathname}</div>;
}

function renderDialog(kbDirName: string | null = 'knowledge-base') {
  const onClose = vi.fn();
  render(
    <MemoryRouter initialEntries={['/skills-and-tools/groups/GTM']}>
      <WorkspaceContext.Provider value={workspace(kbDirName)}>
        <LibraryToastProvider>
          <Routes>
            <Route
              path="*"
              element={
                <AddToGroupDialog name="GTM" primaryPath="Groups/GTM" onClose={onClose} />
              }
            />
          </Routes>
          <LocationProbe />
        </LibraryToastProvider>
      </WorkspaceContext.Provider>
    </MemoryRouter>,
  );
  return { onClose };
}

const writeText = vi.fn<(text: string) => Promise<void>>();

describe('AddToGroupDialog', () => {
  beforeEach(() => {
    writeText.mockReset();
    writeText.mockResolvedValue(undefined);
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
        'Two ways in. Either way it joins GTM — everyone in the group gets it the next time their agent connects.',
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
      await screen.findByText("Couldn't copy — select the prompt text instead."),
    ).toBeInTheDocument();
    expect(screen.queryByText('Prompt copied.')).not.toBeInTheDocument();
  });

  it('opens the group folder in the workspace and closes', async () => {
    const { onClose } = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: /^Open GTM in the workspace/ }));
    await waitFor(() =>
      expect(screen.getByLabelText('href').textContent).toBe(
        '/workspace/target-company-state/knowledge-base/Groups/GTM',
      ),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('hides the workspace route while the workspace is still bootstrapping', () => {
    renderDialog(null);
    expect(
      screen.queryByRole('button', { name: /^Open GTM in the workspace/ }),
    ).not.toBeInTheDocument();
    // The agent half still works without a workspace.
    expect(screen.getByRole('button', { name: 'Copy prompt' })).toBeInTheDocument();
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
