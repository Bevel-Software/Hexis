import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
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

function mount(opts: { admin?: AdminContextValue | null; kbDirName?: string | null | 'no-provider' } = {}) {
  const admin = opts.admin === undefined ? nonAdmin : opts.admin;
  const kb = opts.kbDirName === undefined ? 'knowledge-base' : opts.kbDirName;
  let tree = <AgentInstructionsCard />;
  if (kb !== 'no-provider') {
    tree = (
      <WorkspaceContext.Provider value={{ kbDirName: kb } as unknown as WorkspaceContextValue}>{tree}</WorkspaceContext.Provider>
    );
  }
  if (admin !== null) tree = <AdminContext.Provider value={admin}>{tree}</AdminContext.Provider>;
  return render(<MemoryRouter>{tree}</MemoryRouter>);
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

  it('warns about an open comment and names the fix', async () => {
    fetchMock.mockResolvedValue(composed({ unterminatedComment: true }));
    mount();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('A comment is left open');
    expect(alert).toHaveTextContent('withheld from agents');
    expect(within(alert).getByText('-->')).toBeInTheDocument();
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
