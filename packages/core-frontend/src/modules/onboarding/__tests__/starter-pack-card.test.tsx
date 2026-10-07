import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuthContext } from '../../auth/state/auth.context';
import { authValue } from '../../library/__tests__/auth-harness';
import { WorkspaceContext } from '../../workspace/state/workspace.context';
import { makeWorkspaceFixture } from '../../workspace/__tests__/testFixtures';
import { StarterPackCard } from '../components/StarterPackCard';
import { resetStarterPacksForTests } from '../state/starter-packs';
import {
  StarterPackApiError,
  type StarterPackApplied,
  type StarterPackSummary,
  type StarterPacksAnswer,
} from '../services/starter-packs.api';

/**
 * "What does your team do?": one chip per pack, a choice that posts and
 * fetches the tree again before handing over, a skip, and a refusal said on
 * the card in the server's words.
 */

const { fetchMock, chooseMock } = vi.hoisted(() => ({
  fetchMock: vi.fn<() => Promise<StarterPacksAnswer>>(),
  chooseMock: vi.fn<(id: string) => Promise<StarterPackApplied>>(),
}));
vi.mock('../services/starter-packs.api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/starter-packs.api')>()),
  fetchStarterPacks: fetchMock,
  chooseStarterPack: chooseMock,
}));

const PACKS: StarterPackSummary[] = [
  { id: 'engineering', name: 'Engineering', description: 'Pages about how you build.', order: 1 },
  { id: 'sales', name: 'Sales', description: 'Pages about what you sell.', order: 2 },
  { id: 'general', name: 'Something else', description: 'Pages about who you are.', order: 99 },
];

function mount(refreshFileTree = vi.fn(async () => null)) {
  const onDone = vi.fn();
  render(
    <AuthContext.Provider value={authValue()}>
      <WorkspaceContext.Provider value={makeWorkspaceFixture({ refreshFileTree })}>
        <StarterPackCard packs={PACKS} onDone={onDone} />
      </WorkspaceContext.Provider>
    </AuthContext.Provider>,
  );
  return { onDone, refreshFileTree };
}

beforeEach(() => {
  resetStarterPacksForTests();
  fetchMock.mockReset().mockResolvedValue({ offered: false, chosen: 'sales', packs: [], chosenPack: null });
  chooseMock.mockReset();
});

describe('StarterPackCard', () => {
  it('asks the question with a chip per pack, in order, and a quiet skip', () => {
    mount();
    expect(screen.getByRole('heading', { name: 'What does your team do?' })).toBeInTheDocument();
    expect(screen.getByText('We’ll add starter pages and skills that fit.')).toBeInTheDocument();
    const chips = screen.getAllByRole('button').map((b) => b.textContent);
    expect(chips).toEqual(['Engineering', 'Sales', 'Something else', 'Skip, I’ll start from scratch']);
    expect(screen.getByRole('button', { name: 'Sales' })).toHaveAttribute('title', 'Pages about what you sell.');
  });

  it('choosing posts the pack, says it is adding, refreshes the tree and hands over what was added', async () => {
    let finish!: (applied: StarterPackApplied) => void;
    chooseMock.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    const { onDone, refreshFileTree } = mount();

    await userEvent.click(screen.getByRole('button', { name: 'Sales' }));

    expect(chooseMock).toHaveBeenCalledWith('sales');
    expect(screen.getByRole('button', { name: 'Adding…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Engineering' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Skip/ })).toBeDisabled();

    const applied = { id: 'sales', name: 'Sales', pages: 6, skills: 37, summary: 'Added 6 pages and 37 skills for Sales.' };
    finish(applied);
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(applied));
    expect(refreshFileTree).toHaveBeenCalledTimes(1);
    // The answer is read again, so the prompt and the card follow the choice.
    expect(fetchMock).toHaveBeenCalled();
  });

  it('skipping posts "none" and has no tree to refresh', async () => {
    chooseMock.mockResolvedValue({ id: 'none', name: null, pages: 0, skills: 0, summary: '' });
    const { onDone, refreshFileTree } = mount();

    await userEvent.click(screen.getByRole('button', { name: 'Skip, I’ll start from scratch' }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(chooseMock).toHaveBeenCalledWith('none');
    expect(refreshFileTree).not.toHaveBeenCalled();
  });

  it('says a refusal on the card and lets the admin try again', async () => {
    chooseMock.mockRejectedValueOnce(
      new StarterPackApiError('Someone is editing the knowledge base right now. Try again in a moment.', 409),
    );
    const { onDone } = mount();

    await userEvent.click(screen.getByRole('button', { name: 'Engineering' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Someone is editing the knowledge base right now.');
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Engineering' })).toBeEnabled();
  });
});
