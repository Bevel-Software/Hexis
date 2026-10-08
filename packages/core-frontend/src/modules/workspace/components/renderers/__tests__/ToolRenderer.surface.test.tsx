import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ToolRenderer } from '../ToolRenderer';
import { RendererSurfaceContext, type RendererSurface } from '../rendererSurface';

/**
 * The `.tool` renderer's right-hand panels — the Secrets Vault palette, the
 * tool's own secrets and the live Preview — act under the signed-in session.
 * On a renderer surface (the embed, in a chat or an Atlassian panel) there is
 * no session, only the embed token, which none of those routes take: the
 * panels are not drawn and their requests are not made. In the app nothing
 * changes.
 */

const TOOL = ['---', 'id: my_tool', 'type: http', 'remote: true', 'url: https://api.example.com/utcp', '---', ''].join('\n');

const SURFACE: RendererSurface = {
  kbDirName: 'knowledge-base',
  openLink: () => undefined,
  openWorkspacePath: () => undefined,
  openNodeId: () => undefined,
  canonicalUrlFor: () => null,
  rawUrl: () => '',
  rawFetch: async () => new Response(),
  offersDownload: false,
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ secrets: [], tools: [] }) }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('the .tool renderer on a renderer surface', () => {
  it('draws no session-backed panel and makes no session call', async () => {
    const { container } = render(
      <RendererSurfaceContext.Provider value={SURFACE}>
        <ToolRenderer content={TOOL} filePath="knowledge-base/Tools/my_tool.tool" onSave={async () => undefined} />
      </RendererSurfaceContext.Provider>,
    );
    await settle();
    expect(screen.queryByText('Preview')).toBeNull();
    expect(screen.queryByText('Secrets for this tool')).toBeNull();
    expect(screen.queryByText('Secret variables')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    // The file itself is still there to read and edit, and a writer keeps the
    // scaffolds — the one panel that needs no session.
    expect(screen.getByText('my_tool.tool')).toBeTruthy();
    expect(screen.getByText('Scaffold')).toBeTruthy();
    expect(container.querySelector('aside')).not.toBeNull();
  });

  it('read-only on a surface, draws no side column at all', async () => {
    const { container } = render(
      <RendererSurfaceContext.Provider value={SURFACE}>
        <ToolRenderer content={TOOL} filePath="knowledge-base/Tools/my_tool.tool" onSave={async () => undefined} readOnly />
      </RendererSurfaceContext.Provider>,
    );
    await settle();
    expect(container.querySelector('aside')).toBeNull();
    expect(screen.getByText('my_tool.tool')).toBeTruthy();
  });

  it('in the app draws them and asks the session for the vault', async () => {
    render(<ToolRenderer content={TOOL} filePath="knowledge-base/Tools/my_tool.tool" onSave={async () => undefined} />);
    await settle();
    expect(screen.getByText('Preview')).toBeTruthy();
    expect(screen.getByText('Secrets for this tool')).toBeTruthy();
    expect(screen.getByText('Secret variables')).toBeTruthy();
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    // The palette's own call, exactly — not satisfied by the tool-secrets
    // catalog call that shares the prefix.
    expect(urls).toContain('/api/secrets');
  });
});
