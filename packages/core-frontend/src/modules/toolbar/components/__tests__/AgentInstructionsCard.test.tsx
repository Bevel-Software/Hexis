import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { configureBranchModel } from '@bevel-software/platform-shared';
import { AgentInstructionsCard } from '../AgentInstructionsCard';
import { AdminContext, type AdminContextValue } from '../../../admin/state/admin.context';
import { WorkspaceContext, type WorkspaceContextValue } from '../../../workspace/state/workspace.context';
import type { AgentInstructions } from '../../services/agent-instructions.api';

/**
 * The card shows what the server SENDS, organised around what the admin can
 * change: their description with its count, the fixed platform message
 * folded away, and the short version with the fixed sentence set apart from
 * the admin's paragraph. A warning for each way the text can be smaller than
 * the admin thinks (either cap, an open comment). The Edit action belongs to
 * admins, and only once the KB dir name is known.
 */

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));

vi.mock('../../services/agent-instructions.api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/agent-instructions.api')>()),
  fetchAgentInstructions: fetchMock,
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
});

describe('the description and the short version', () => {
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

  it('shows the short version with the fixed sentence apart from the admin\'s paragraph, and its count', async () => {
    mount();
    await screen.findByRole('heading', { name: 'Short version' });
    expect(screen.getByTestId('prefix-count')).toHaveTextContent('212 / 300 characters');
    const prefix = screen.getByTestId('prefix-text');
    expect(prefix).toHaveTextContent(`${LINE} Acme builds solar farms.`);
    const [fixed, own] = Array.from(prefix.querySelectorAll('span'));
    expect(fixed).toHaveTextContent(LINE);
    expect(fixed.className).toContain('text-ink-muted');
    expect(own).toHaveTextContent('Acme builds solar farms.');
    // Names the clients this exists for.
    expect(screen.getByText(/claude\.ai, Cline, the Agent SDK/)).toBeInTheDocument();
  });

  it('explains an empty description instead of showing an empty box', async () => {
    fetchMock.mockResolvedValue(composed({ preamble: '', preambleChars: 0, toolPrefix: LINE, toolPrefixChars: LINE.length }));
    mount();
    expect(await screen.findByTestId('description-empty')).toHaveTextContent('platform message only');
    expect(screen.queryByTestId('description-text')).toBeNull();
    expect(screen.getByTestId('preamble-count')).toHaveTextContent('0 / 6,000 characters');
    expect(screen.getByTestId('prefix-text')).toHaveTextContent(LINE);
  });
});

describe('the Edit action', () => {
  it('is offered to admins, pointing at mcp-description.md on the default branch under the KB dir', async () => {
    mount({ admin: asAdmin });
    const link = await screen.findByRole('link', { name: /Edit description/ });
    expect(link).toHaveAttribute('href', '/workspace/target-company-state/knowledge-base/mcp-description.md');
    expect(screen.getByText(/Kept in mcp-description\.md at the repository root/)).toBeInTheDocument();
    expect(screen.queryByText(/Admins edit it/)).toBeNull();
  });

  it('is withheld from non-admins, who are told where admins edit it', async () => {
    mount({ admin: nonAdmin });
    await screen.findByRole('heading', { name: 'Your description' });
    expect(screen.queryByRole('link', { name: /Edit/ })).toBeNull();
    expect(screen.getByText(/Admins edit it in mcp-description\.md at the repository root/)).toBeInTheDocument();
  });

  it('waits for the KB dir name: no link with a missing segment, ever', async () => {
    mount({ admin: asAdmin, kbDirName: null });
    await screen.findByRole('heading', { name: 'Your description' });
    expect(screen.queryByRole('link', { name: /Edit/ })).toBeNull();
  });

  it('tolerates absent providers: no admin context and no workspace context still render the card', async () => {
    mount({ admin: null, kbDirName: 'no-provider' });
    expect(await screen.findByRole('heading', { name: 'Your description' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Edit/ })).toBeNull();
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

  it('warns when the short version is over its cap, naming the first paragraph', async () => {
    fetchMock.mockResolvedValue(composed({ toolPrefixTruncated: true, toolPrefixChars: 412 }));
    mount();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('the four tools receive only the first 300 characters');
    expect(alert).toHaveTextContent('first paragraph');
    expect(screen.getByTestId('prefix-count')).toHaveTextContent('412 / 300 characters');
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
    fetchMock.mockResolvedValue(composed({ truncated: true, toolPrefixTruncated: true, unterminatedComment: true }));
    mount();
    const alerts = await screen.findAllByRole('alert');
    expect(alerts).toHaveLength(3);
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
