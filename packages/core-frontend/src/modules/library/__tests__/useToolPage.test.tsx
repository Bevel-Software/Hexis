import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { ToolSecrets } from '../../secrets-vault/services/tool-secrets.api';
import type { ToolManualDetail } from '../services/tools.api';

/**
 * The hook's whole job is failure posture: which of three loads is allowed to
 * break the page, and which quietly degrade. Plus ordering — a reload that
 * overtakes an in-flight round must not be overwritten by it.
 */

const secretsMock = vi.hoisted(() => ({ listToolSecrets: vi.fn() }));
vi.mock('../../secrets-vault/services/tool-secrets.api', () => ({
  listToolSecrets: secretsMock.listToolSecrets,
}));

const toolsMock = vi.hoisted(() => ({ getToolDetail: vi.fn() }));
vi.mock('../services/tools.api', () => ({ getToolDetail: toolsMock.getToolDetail }));

const libraryMock = vi.hoisted(() => ({ listSkills: vi.fn(), getSkill: vi.fn() }));
vi.mock('../services/library.api', () => ({
  listSkills: libraryMock.listSkills,
  getSkill: libraryMock.getSkill,
}));

import { useToolPage } from '../hooks/useToolPage';

const GITHUB: ToolSecrets = {
  slug: 'github',
  name: 'github',
  path: 'Groups/Engineering/github.tool',
  type: 'inline',
  setup: null,
  canWrite: false,
  variables: [],
};

const DETAIL: ToolManualDetail = {
  slug: 'github',
  name: 'github',
  path: 'Groups/Engineering/github.tool',
  type: 'inline',
  description: 'Read and write GitHub issues.',
  capabilities: [{ name: 'create_issue', description: 'Open an issue.' }],
};

beforeEach(() => {
  secretsMock.listToolSecrets.mockReset().mockResolvedValue([GITHUB]);
  toolsMock.getToolDetail.mockReset().mockResolvedValue(DETAIL);
  libraryMock.listSkills.mockReset().mockResolvedValue([]);
  libraryMock.getSkill.mockReset().mockResolvedValue({ allowedTools: [] });
});

describe('useToolPage', () => {
  it('resolves the tool with the matching slug and its detail', async () => {
    const { result } = renderHook(() => useToolPage('github'));
    expect(result.current.loading).toBe(true);

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.tool).toEqual(GITHUB);
    expect(result.current.notFound).toBe(false);
    expect(result.current.error).toBeNull();
    await waitFor(() => expect(result.current.detail).toEqual(DETAIL));
  });

  it('reports notFound — not an error — when no accessible tool carries the slug', async () => {
    const { result } = renderHook(() => useToolPage('nope'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.notFound).toBe(true);
    expect(result.current.error).toBeNull();
    expect(result.current.tool).toBeNull();
  });

  it('surfaces only a listToolSecrets failure as error', async () => {
    secretsMock.listToolSecrets.mockRejectedValue(new Error("Couldn't load tool secrets."));
    const { result } = renderHook(() => useToolPage('github'));
    await waitFor(() => expect(result.current.error).toBe("Couldn't load tool secrets."));
    expect(result.current.notFound).toBe(false);
  });

  it('degrades a failed detail load to null without touching error', async () => {
    toolsMock.getToolDetail.mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useToolPage('github'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.detail).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('degrades a failed skill catalog to an empty index, still marked loaded', async () => {
    libraryMock.listSkills.mockRejectedValue(new Error('nope'));
    const { result } = renderHook(() => useToolPage('github'));
    await waitFor(() => expect(result.current.skillsLoaded).toBe(true));
    expect(result.current.poweredSkills).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it('builds the reverse index from allowed-tools frontmatter', async () => {
    libraryMock.listSkills.mockResolvedValue([
      { name: 'triage', description: '', path: 'Groups/Engineering/triage' },
      { name: 'newsletter', description: '', path: 'Skills/newsletter' },
    ]);
    libraryMock.getSkill.mockImplementation(async (name: string) =>
      name === 'triage' ? { allowedTools: ['github_create_issue'] } : { allowedTools: ['Bash'] },
    );

    const { result } = renderHook(() => useToolPage('github'));
    await waitFor(() => expect(result.current.skillsLoaded).toBe(true));
    await waitFor(() => expect(result.current.poweredSkills.map((s) => s.name)).toEqual(['triage']));
  });

  it('keeps one skill failing from emptying the whole index', async () => {
    libraryMock.listSkills.mockResolvedValue([
      { name: 'triage', description: '', path: 'Groups/Engineering/triage' },
      { name: 'broken', description: '', path: 'Skills/broken' },
    ]);
    libraryMock.getSkill.mockImplementation(async (name: string) => {
      if (name === 'broken') throw new Error('unreadable');
      return { allowedTools: ['github.create_issue'] };
    });

    const { result } = renderHook(() => useToolPage('github'));
    await waitFor(() => expect(result.current.poweredSkills.map((s) => s.name)).toEqual(['triage']));
  });

  it('discards a stale response from a superseded request', async () => {
    const stale: ToolSecrets = { ...GITHUB, name: 'stale-name' };
    let releaseFirst: (tools: ToolSecrets[]) => void = () => {};
    secretsMock.listToolSecrets
      .mockImplementationOnce(
        () =>
          new Promise<ToolSecrets[]>((resolve) => {
            releaseFirst = resolve;
          }),
      )
      .mockResolvedValue([GITHUB]);

    const { result } = renderHook(() => useToolPage('github'));
    // Reload while the first round is still in flight, then let it land late.
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.tool?.name).toBe('github'));
    act(() => releaseFirst([stale]));

    await waitFor(() => expect(result.current.tool?.name).toBe('github'));
    expect(result.current.tool?.name).not.toBe('stale-name');
  });
});
