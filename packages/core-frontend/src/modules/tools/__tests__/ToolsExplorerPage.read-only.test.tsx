import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ConfirmProvider } from '../../../shared/components';
import { ToolsExplorerPage } from '../ToolsExplorerPage';
import type { ToolHint } from '../tool-hints.api';

/**
 * The read-only hints on the Tools page: what MCP clients are told about each
 * platform tool and each code-mode meta-tool, a toggle and a reset for an
 * admin, the value alone for everyone else, and the meta-tools in a section of
 * their own.
 */

const authFetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
vi.mock('../../../lib/api', () => ({ authFetch: (url: string, init?: RequestInit) => authFetch(url, init) }));

const httpTool = (name: string, tags: string[]) => ({
  name,
  description: `the ${name} tool`,
  inputs: { type: 'object', properties: {} },
  outputs: { type: 'object', properties: {} },
  tags,
  tool_call_template: { call_template_type: 'http', url: `\${API_URL}/api/agent/tools/${name}`, http_method: 'POST' },
});

const hint = (name: string, kind: ToolHint['kind'], builtIn: boolean, override: boolean | null = null): ToolHint => ({
  name,
  kind,
  builtIn,
  override,
  readOnly: override ?? builtIn,
});

/** The deployment: its manual, its hints, and every PUT the page sends. */
function serve(canEdit: boolean, hints: ToolHint[]) {
  const puts: Array<{ name: string; readOnly: unknown }> = [];
  authFetch.mockImplementation(async (url, init) => {
    if (url === '/api/agent/utcp') {
      return Response.json({ tools: [httpTool('read_file', ['workspace', 'read-only']), httpTool('write_file', ['workspace', 'write'])] });
    }
    if (url === '/api/tool-hints') return Response.json({ canEdit, tools: hints });
    const put = /^\/api\/tool-hints\/(.+)$/.exec(url);
    if (put && init?.method === 'PUT') {
      const name = decodeURIComponent(put[1]!);
      const { readOnly } = JSON.parse(String(init.body)) as { readOnly: boolean | null };
      puts.push({ name, readOnly });
      const current = hints.find((h) => h.name === name)!;
      return Response.json(hint(name, current.kind, current.builtIn, readOnly));
    }
    return new Response('{}', { status: 404 });
  });
  return { puts };
}

const HINTS = [
  hint('read_file', 'platform', true),
  hint('write_file', 'platform', false),
  hint('list_tools', 'meta', true),
  hint('tools_info', 'meta', true),
  hint('call_tool_chain', 'meta', false),
];

function renderPage() {
  render(
    <ConfirmProvider>
      <ToolsExplorerPage />
    </ConfirmProvider>,
  );
}

afterEach(() => {
  authFetch.mockReset();
  vi.restoreAllMocks();
});

describe('the Tools page, for an admin', () => {
  it('shows a read-only toggle at its effective value on every platform tool and every meta-tool', async () => {
    serve(true, HINTS);
    renderPage();
    expect(await screen.findByRole('switch', { name: 'Read-only: read_file' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('switch', { name: 'Read-only: write_file' })).toHaveAttribute('aria-checked', 'false');
    const codeMode = screen.getByTestId('code-mode-section');
    for (const [name, value] of [['list_tools', 'true'], ['tools_info', 'true'], ['call_tool_chain', 'false']] as const) {
      expect(within(codeMode).getByRole('switch', { name: `Read-only: ${name}` })).toHaveAttribute('aria-checked', value);
    }
  });

  it('turns a reader off with no question asked', async () => {
    const { puts } = serve(true, HINTS);
    renderPage();
    fireEvent.click(await screen.findByRole('switch', { name: 'Read-only: read_file' }));
    await waitFor(() => expect(puts).toEqual([{ name: 'read_file', readOnly: false }]));
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Read-only: read_file' })).toHaveAttribute('aria-checked', 'false'),
    );
    expect(within(screen.getByTestId('read-only-read_file')).getByText('overridden')).toBeInTheDocument();
  });

  it('warns before marking a writer read-only; Cancel changes nothing, confirming saves it', async () => {
    const { puts } = serve(true, HINTS);
    renderPage();
    fireEvent.click(await screen.findByRole('switch', { name: 'Read-only: write_file' }));
    let dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toMatch(/stop\s+asking before they run it/);
    expect(dialog.textContent).toContain('change the knowledge base');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(puts).toEqual([]);
    expect(screen.getByRole('switch', { name: 'Read-only: write_file' })).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(screen.getByRole('switch', { name: 'Read-only: write_file' }));
    dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mark read-only' }));
    await waitFor(() => expect(puts).toEqual([{ name: 'write_file', readOnly: true }]));
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Read-only: write_file' })).toHaveAttribute('aria-checked', 'true'),
    );
  });

  it('warns the same way for `call_tool_chain`', async () => {
    const { puts } = serve(true, HINTS);
    renderPage();
    fireEvent.click(await screen.findByRole('switch', { name: 'Read-only: call_tool_chain' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mark read-only' }));
    await waitFor(() => expect(puts).toEqual([{ name: 'call_tool_chain', readOnly: true }]));
  });

  it('resets an overridden tool by removing the override', async () => {
    const { puts } = serve(true, [hint('read_file', 'platform', true, false), ...HINTS.slice(1)]);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Reset read_file/ }));
    await waitFor(() => expect(puts).toEqual([{ name: 'read_file', readOnly: null }]));
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Read-only: read_file' })).toHaveAttribute('aria-checked', 'true'),
    );
    expect(screen.queryByRole('button', { name: /Reset read_file/ })).toBeNull();
  });
});

describe('the Tools page, for everyone else', () => {
  it('shows each effective value and no toggle or reset', async () => {
    serve(false, [hint('read_file', 'platform', true), hint('write_file', 'platform', false, true), ...HINTS.slice(2)]);
    renderPage();
    expect(await within(await screen.findByTestId('read-only-read_file')).findByText('Read-only')).toBeInTheDocument();
    expect(within(screen.getByTestId('read-only-write_file')).getByText('Read-only')).toBeInTheDocument();
    expect(within(screen.getByTestId('read-only-call_tool_chain')).getByText('Not read-only')).toBeInTheDocument();
    expect(screen.queryAllByRole('switch')).toEqual([]);
    expect(screen.queryByRole('button', { name: /Reset/ })).toBeNull();
  });
});

describe('the two sections', () => {
  it('lists the endpoints and, apart from them, the code-mode meta-tools as MCP features', async () => {
    serve(false, HINTS);
    renderPage();
    const endpoints = await screen.findByTestId('endpoint-section');
    const codeMode = await screen.findByTestId('code-mode-section');
    expect(within(endpoints).getByRole('heading', { name: 'Endpoints of this deployment' })).toBeInTheDocument();
    expect(within(endpoints).getByText('read_file')).toBeInTheDocument();
    expect(within(endpoints).queryByText('call_tool_chain')).toBeNull();

    expect(within(codeMode).getByRole('heading', { name: 'Code mode' })).toBeInTheDocument();
    expect(codeMode.textContent).toContain('features of the MCP servers');
    expect(codeMode.textContent).toContain('not endpoints of this deployment');
    for (const name of ['list_tools', 'tools_info', 'call_tool_chain']) {
      expect(within(codeMode).getByText(name)).toBeInTheDocument();
    }
    expect(within(codeMode).queryByText('read_file')).toBeNull();
  });

  it('does not show the read-only tag as a chip: the hint control says it', async () => {
    serve(false, HINTS);
    renderPage();
    const endpoints = await screen.findByTestId('endpoint-section');
    await within(endpoints).findByText('read_file');
    expect(within(endpoints).queryByText('read-only')).toBeNull();
  });
});
