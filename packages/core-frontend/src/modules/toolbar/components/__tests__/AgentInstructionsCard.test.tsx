import { StrictMode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { configureBranchModel } from '@bevel-software/platform-shared';
import { AgentInstructionsCard } from '../AgentInstructionsCard';
import { AdminContext, type AdminContextValue } from '../../../admin/state/admin.context';
import { WorkspaceContext, type WorkspaceContextValue } from '../../../workspace/state/workspace.context';
import type { AgentInstructions } from '../../services/agent-instructions.api';

/**
 * The card shows what the server SENDS, organised around what the admin can
 * change: their description with its count, the fixed platform message
 * folded away, and no repository/file-format implementation copy. The Edit
 * action belongs to admins, and only once the KB dir name is known.
 */

const { fetchMock, fetchEditableMock, saveMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  fetchEditableMock: vi.fn(),
  saveMock: vi.fn(),
}));

vi.mock('../../services/agent-instructions.api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/agent-instructions.api')>()),
  fetchAgentInstructions: fetchMock,
  fetchEditableAgentDescription: fetchEditableMock,
  saveAgentDescription: saveMock,
}));

const nonAdmin: AdminContextValue = {
  isAdmin: false,
  unreadCount: 0,
  lastSeen: null,
  markSeen: vi.fn(),
  refresh: vi.fn(),
  rolesConfigCorrupted: false,
  rolesConfigErrors: [],
  runRolesRecovery: vi.fn(),
};
const asAdmin: AdminContextValue = { ...nonAdmin, isAdmin: true };

const HEADER = "Hexis is this organisation's knowledge base.";
const LINE = "This organisation's knowledge base. Search it before answering from memory.";

const composed = (over: Partial<AgentInstructions> = {}): AgentInstructions => ({
  instructions: `${HEADER}\n\nAcme builds solar farms.\n\n## What is where\n\n- Projects/`,
  header: HEADER,
  preamble: 'Acme builds solar farms.\n\n## What is where\n\n- Projects/',
  toolPrefix: `${LINE} Acme builds solar farms.`,
  toolPrefixLine: LINE,
  truncated: false,
  preambleChars: 1240,
  toolPrefixTruncated: false,
  toolPrefixChars: 212,
  unterminatedComment: false,
  ...over,
});

function mount(
  opts: { admin?: AdminContextValue | null; kbDirName?: string | null | 'no-provider'; strict?: boolean } = {},
) {
  const admin = opts.admin === undefined ? nonAdmin : opts.admin;
  const kb = opts.kbDirName === undefined ? 'knowledge-base' : opts.kbDirName;
  let tree = <AgentInstructionsCard />;
  if (kb !== 'no-provider') {
    tree = (
      <WorkspaceContext.Provider value={{ kbDirName: kb } as unknown as WorkspaceContextValue}>{tree}</WorkspaceContext.Provider>
    );
  }
  if (admin !== null) tree = <AdminContext.Provider value={admin}>{tree}</AdminContext.Provider>;
  tree = <MemoryRouter>{tree}</MemoryRouter>;
  // The app mounts under StrictMode, so the load effect is set up, torn down
  // and set up again on the SAME card. Anything the teardown disarms has to
  // be re-armed on the way back in.
  return render(opts.strict ? <StrictMode>{tree}</StrictMode> : tree);
}

beforeEach(() => {
  configureBranchModel({ defaultBranch: 'target-company-state', protectedBranches: ['current-company-state', 'target-company-state'] });
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(composed());
  fetchEditableMock.mockReset();
  fetchEditableMock.mockResolvedValue({
    workspaceId: 'target-company-state',
    source: '<!-- private starter notes -->\n',
    description: '',
  });
  saveMock.mockReset();
  saveMock.mockResolvedValue(undefined);
});

describe('the description', () => {
  it('centres the admin\'s description, with its count, and folds the platform message away', async () => {
    mount();
    expect(await screen.findByRole('heading', { name: 'Your description' })).toBeInTheDocument();
    expect(screen.getByTestId('preamble-count')).toHaveTextContent('1,240 / 6,000 characters');
    const description = screen.getByTestId('description-text');
    expect(description).toHaveTextContent('Acme builds solar farms.');
    expect(description).not.toHaveTextContent(HEADER); // the fixed part is not mixed into the admin's
    // The platform message is there, closed, and not editable.
    const drawer = screen.getByText('Platform message (fixed, sent first)');
    expect(drawer.tagName).toBe('SUMMARY');
    expect((drawer.closest('details') as HTMLDetailsElement).open).toBe(false);
    expect(screen.getByTestId('header-text')).toHaveTextContent(HEADER);
    // Says that access does not gate it.
    expect(screen.getByText(/whatever it may read/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('still lands under StrictMode, whose teardown and second setup run on the same card', async () => {
    mount({ strict: true });
    expect(await screen.findByTestId('description-text')).toHaveTextContent('Acme builds solar farms.');
  });

  it('explains an empty description instead of showing an empty box', async () => {
    fetchMock.mockResolvedValue(composed({ preamble: '', preambleChars: 0, toolPrefix: LINE, toolPrefixChars: LINE.length }));
    mount();
    expect(await screen.findByTestId('description-empty')).toHaveTextContent('platform message only');
    expect(screen.queryByTestId('description-text')).toBeNull();
    expect(screen.getByTestId('preamble-count')).toHaveTextContent('0 / 6,000 characters');
  });
});

describe('the Edit action', () => {
  it('is offered to admins as an inline action, not a link to another page', async () => {
    mount({ admin: asAdmin });
    const edit = await screen.findByRole('button', { name: /Edit description/ });
    expect(edit.tagName).toBe('BUTTON');
    expect(screen.queryByRole('link', { name: /Edit description/ })).toBeNull();
    expect(screen.queryByText(/mcp-description\.md at the repository root/)).toBeNull();
    expect(screen.queryByText(/first paragraph is automatically reused/)).toBeNull();
  });

  it('edits and saves the description in place, then refreshes the preview', async () => {
    const empty = composed({ preamble: '', preambleChars: 0, toolPrefix: LINE, toolPrefixChars: LINE.length });
    const saved = composed({
      preamble: 'Acme builds solar farms.',
      preambleChars: 'Acme builds solar farms.'.length,
      toolPrefix: `${LINE} Acme builds solar farms.`,
      toolPrefixChars: `${LINE} Acme builds solar farms.`.length,
    });
    fetchMock.mockResolvedValueOnce(empty).mockResolvedValueOnce(saved);
    const user = userEvent.setup();
    mount({ admin: asAdmin });

    await user.click(await screen.findByRole('button', { name: 'Edit description' }));
    const editor = await screen.findByRole('textbox', { name: 'Your description' });
    expect(editor).toHaveValue('');
    expect(editor).toHaveAttribute('rows', '1');
    expect(editor.className).toContain('[field-sizing:content]');
    expect(editor.className).not.toContain('min-h-40');
    expect(fetchEditableMock).toHaveBeenCalledWith('knowledge-base');

    await user.type(editor, 'Acme builds solar farms.');
    expect(screen.getByTestId('preamble-count')).toHaveTextContent('24 / 6,000 characters');
    await user.click(screen.getByRole('button', { name: 'Save description' }));

    await waitFor(() => {
      expect(saveMock).toHaveBeenCalledWith(
        'target-company-state',
        'knowledge-base',
        '<!-- private starter notes -->\n',
        'Acme builds solar farms.',
      );
    });
    expect(await screen.findByTestId('description-text')).toHaveTextContent('Acme builds solar farms.');
    expect(screen.queryByRole('textbox', { name: 'Your description' })).toBeNull();
  });

  it('keeps the post-save preview when the initial load answers after it', async () => {
    // The initial request is still in flight while the admin edits and saves.
    // Its response arrives last and must land nowhere: the page would
    // otherwise show the pre-save text as though the save had not happened.
    const before = composed({ preamble: 'Before.', preambleChars: 6 });
    const after = composed({ preamble: 'After.', preambleChars: 5 });
    let releaseInitialLoad: () => void = () => {};
    const initialLoad = new Promise<AgentInstructions>((resolve) => {
      releaseInitialLoad = () => resolve(before);
    });
    fetchMock.mockReturnValueOnce(initialLoad).mockResolvedValueOnce(after);
    fetchEditableMock.mockResolvedValue({
      workspaceId: 'target-company-state',
      source: 'Before.',
      description: 'Before.',
    });
    const user = userEvent.setup();
    mount({ admin: asAdmin });

    await user.click(await screen.findByRole('button', { name: 'Edit description' }));
    const editor = await screen.findByRole('textbox', { name: 'Your description' });
    await user.clear(editor);
    await user.type(editor, 'After.');
    await user.click(screen.getByRole('button', { name: 'Save description' }));

    expect(await screen.findByTestId('description-text')).toHaveTextContent('After.');
    releaseInitialLoad();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId('description-text')).toHaveTextContent('After.');
  });

  it('keeps the inline editor open and shows the save error', async () => {
    fetchEditableMock.mockResolvedValue({
      workspaceId: 'target-company-state',
      source: 'Before.',
      description: 'Before.',
    });
    saveMock.mockRejectedValue(new Error('File is locked by Ada.'));
    const user = userEvent.setup();
    mount({ admin: asAdmin });

    await user.click(await screen.findByRole('button', { name: 'Edit description' }));
    const editor = await screen.findByRole('textbox', { name: 'Your description' });
    await user.clear(editor);
    await user.type(editor, 'After.');
    await user.click(screen.getByRole('button', { name: 'Save description' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('File is locked by Ada.');
    expect(screen.getByRole('textbox', { name: 'Your description' })).toHaveValue('After.');
  });

  it('still opens the editor when the composed preview could not load', async () => {
    fetchMock.mockRejectedValue(new Error('Preview unavailable.'));
    fetchEditableMock.mockResolvedValue({
      workspaceId: 'target-company-state',
      source: 'Editable source.',
      description: 'Editable source.',
    });
    const user = userEvent.setup();
    mount({ admin: asAdmin });

    expect(await screen.findByRole('alert')).toHaveTextContent('Preview unavailable.');
    await user.click(screen.getByRole('button', { name: 'Edit description' }));

    expect(await screen.findByRole('textbox', { name: 'Your description' })).toHaveValue('Editable source.');
  });

  it('is withheld from non-admins without exposing repository implementation details', async () => {
    mount({ admin: nonAdmin });
    await screen.findByRole('heading', { name: 'Your description' });
    expect(screen.queryByRole('button', { name: /Edit/ })).toBeNull();
    expect(screen.queryByText(/mcp-description\.md at the repository root/)).toBeNull();
  });

  it('waits for the KB dir name: no edit action with a missing save path, ever', async () => {
    mount({ admin: asAdmin, kbDirName: null });
    await screen.findByRole('heading', { name: 'Your description' });
    expect(screen.queryByRole('button', { name: /Edit/ })).toBeNull();
  });

  it('offers no edit action for an empty KB dir name either — a button that could not save', async () => {
    mount({ admin: asAdmin, kbDirName: '' });
    await screen.findByRole('heading', { name: 'Your description' });
    expect(screen.queryByRole('button', { name: /Edit/ })).toBeNull();
  });

  it('tolerates absent providers: no admin context and no workspace context still render the card', async () => {
    mount({ admin: null, kbDirName: 'no-provider' });
    expect(await screen.findByRole('heading', { name: 'Your description' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Edit/ })).toBeNull();
  });
});

describe('warnings', () => {
  it('warns when the description is over its cap, with the count over the cap', async () => {
    fetchMock.mockResolvedValue(composed({ truncated: true, preambleChars: 7350 }));
    mount();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('agents receive only the first 6,000 characters');
    expect(screen.getByTestId('preamble-count')).toHaveTextContent('7,350 / 6,000 characters');
  });

  it('warns about an open comment and, for an admin, names the action on THIS page', async () => {
    // The file is hidden from the tree by this change, so "close it in
    // mcp-description.md" would be a repair the admin cannot reach.
    fetchMock.mockResolvedValue(composed({ unterminatedComment: true }));
    mount({ admin: asAdmin });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('A comment is left open');
    expect(alert).toHaveTextContent('withheld from agents');
    expect(alert).toHaveTextContent('Open the editor and save');
    expect(alert).not.toHaveTextContent('mcp-description.md');
  });

  it('tells a non-admin who can fix it', async () => {
    fetchMock.mockResolvedValue(composed({ unterminatedComment: true }));
    mount({ admin: nonAdmin });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('An admin can close it from this page');
  });

  it('warns when the tool-description channel is cutting the first paragraph', async () => {
    // The composer still cuts the prefix at its own cap and still reports it;
    // dropping the short-version preview must not drop the only signal.
    fetchMock.mockResolvedValue(composed({ toolPrefixTruncated: true, toolPrefixChars: 415 }));
    mount();
    const alert = await screen.findByRole('alert');
    // The count is the FIXED LINE plus the paragraph, so the warning must not
    // blame the paragraph alone: a 225-character paragraph trips a 300 cap.
    expect(alert).toHaveTextContent('The fixed line and your first paragraph');
    expect(alert).toHaveTextContent('together they are over');
    expect(alert).toHaveTextContent('300-character');
    expect(alert).toHaveTextContent('415');
    expect(alert).toHaveTextContent('Shorten the first paragraph');
  });

  it('lets an admin save a file whose only problem is the hidden open comment', async () => {
    // Save used to be disabled while the VISIBLE text was unchanged, so the
    // one repair for an open comment was unreachable.
    fetchEditableMock.mockResolvedValue({
      workspaceId: 'target-company-state',
      source: 'Public text.\n<!-- a note that was never closed',
      description: 'Public text.',
    });
    const user = userEvent.setup();
    mount({ admin: asAdmin });

    await user.click(await screen.findByRole('button', { name: 'Edit description' }));
    await screen.findByRole('textbox', { name: 'Your description' });
    const save = screen.getByRole('button', { name: 'Save and close the comment' });
    expect(save).toBeEnabled();

    await user.click(save);

    await waitFor(() => {
      expect(saveMock).toHaveBeenCalledWith(
        'target-company-state',
        'knowledge-base',
        'Public text.\n<!-- a note that was never closed',
        'Public text.',
      );
    });
  });

  it('keeps Save disabled when there is genuinely nothing to save', async () => {
    fetchEditableMock.mockResolvedValue({
      workspaceId: 'target-company-state',
      source: 'Public text.',
      description: 'Public text.',
    });
    const user = userEvent.setup();
    mount({ admin: asAdmin });

    await user.click(await screen.findByRole('button', { name: 'Edit description' }));
    await screen.findByRole('textbox', { name: 'Your description' });
    expect(screen.getByRole('button', { name: 'Save description' })).toBeDisabled();
  });

  it('shows each warning only when flagged', async () => {
    fetchMock.mockResolvedValue(composed({ truncated: true, unterminatedComment: true }));
    mount();
    const alerts = await screen.findAllByRole('alert');
    expect(alerts).toHaveLength(2);
  });
});

describe('a failed fetch', () => {
  it('shows an inline message and nothing else breaks', async () => {
    fetchMock.mockRejectedValue(new Error('boom'));
    mount();
    expect(await screen.findByRole('alert')).toHaveTextContent('boom');
    expect(screen.getByRole('heading', { name: 'What agents are told about this knowledge base' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Your description' })).toBeNull();
  });
});
