import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

import {
  WorkspaceContext,
  type WorkspaceContextValue,
} from '../../workspace/state/workspace.context';

const apiMock = vi.hoisted(() => ({
  fetchFileAccess: vi.fn(),
}));
vi.mock('../api', () => ({
  fetchFileAccess: apiMock.fetchFileAccess,
  fetchFileAccessBatch: vi.fn(),
}));

import { useFileAccess, formatEligible } from '../hooks/useFileAccess';

// Default branch for tests that exercise the network path. The hook
// short-circuits to canWrite=true on non-protected (draft) branches without
// hitting the API, so tests covering the API behavior need a protected branch.
const PROTECTED = 'current-company-state';
const DRAFT = 'alice/fix-onboarding';

function makeWorkspace(overrides: Partial<WorkspaceContextValue> = {}): WorkspaceContextValue {
  return {
    workspaceId: 'ws-1',
    kbDirName: 'knowledge-base',
    ...overrides,
  } as unknown as WorkspaceContextValue;
}

function withWorkspace(value: WorkspaceContextValue) {
  return ({ children }: { children: ReactNode }) => (
    <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>
  );
}

describe('useFileAccess', () => {
  beforeEach(() => {
    apiMock.fetchFileAccess.mockReset();
  });

  it('returns canWrite=null while the request is in flight, then the resolved value', async () => {
    apiMock.fetchFileAccess.mockResolvedValueOnce({
      canWrite: true,
      eligible: { roles: ['Admin'], users: [] },
    });

    const { result } = renderHook(
      () => useFileAccess('knowledge-base/Knowledge/Foo.md', PROTECTED),
      { wrapper: withWorkspace(makeWorkspace()) },
    );

    expect(result.current.canWrite).toBeNull();
    expect(result.current.loading).toBe(true);

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.canWrite).toBe(true);
    expect(result.current.eligible.roles).toEqual(['Admin']);
  });

  it('returns canWrite=false with eligible when the backend denies a repo file', async () => {
    apiMock.fetchFileAccess.mockResolvedValueOnce({
      canWrite: false,
      eligible: {
        roles: ['Admin', 'Product Manager'],
        users: [{ name: 'Felix Kissel', email: 'felix.kissel@example.com' }],
      },
    });

    const { result } = renderHook(
      () => useFileAccess('knowledge-base/Knowledge/Sales/Foo.md', PROTECTED),
      { wrapper: withWorkspace(makeWorkspace()) },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.canWrite).toBe(false);
    expect(result.current.eligible.roles).toEqual(['Admin', 'Product Manager']);
    expect(result.current.eligible.users[0].email).toBe('felix.kissel@example.com');
  });

  it('default-allows on transient API failure (does not trap the user)', async () => {
    apiMock.fetchFileAccess.mockRejectedValueOnce(new Error('network down'));

    const { result } = renderHook(
      () => useFileAccess('knowledge-base/Knowledge/Foo.md', PROTECTED),
      { wrapper: withWorkspace(makeWorkspace()) },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.canWrite).toBe(true);
    expect(result.current.error).toMatch(/network down/);
  });

  it('returns the no-path state without firing a request when path is null', () => {
    renderHook(() => useFileAccess(null, PROTECTED), {
      wrapper: withWorkspace(makeWorkspace()),
    });
    expect(apiMock.fetchFileAccess).not.toHaveBeenCalled();
  });

  // Regression for Bug B (path-prefix mismatch): the resolver expects
  // repo-relative paths, so the hook must strip the kbDirName prefix before
  // calling the API. A pre-fix call with `knowledge-base/Knowledge/Sales/Foo.md`
  // would only match the root access.md and silently drop the Sales/ grant.
  it('strips the kbDirName prefix before calling fetchFileAccess', async () => {
    apiMock.fetchFileAccess.mockResolvedValueOnce({
      canWrite: true,
      eligible: { roles: ['Product Manager'], users: [] },
    });

    renderHook(
      () => useFileAccess('knowledge-base/Knowledge/Sales/Foo.md', PROTECTED),
      { wrapper: withWorkspace(makeWorkspace()) },
    );

    await waitFor(() =>
      expect(apiMock.fetchFileAccess).toHaveBeenCalledWith(
        'ws-1',
        'Knowledge/Sales/Foo.md',
      ),
    );
  });

  // Bug A: files outside the KB are user-owned scratch space and must never
  // be gated. Treat them as immediately writable; never hit the network.
  it('short-circuits to canWrite=true for paths outside the KB repo', async () => {
    const { result } = renderHook(() => useFileAccess('my-notes.txt', PROTECTED), {
      wrapper: withWorkspace(makeWorkspace()),
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.canWrite).toBe(true);
    expect(result.current.eligible).toEqual({ roles: [], users: [] });
    expect(apiMock.fetchFileAccess).not.toHaveBeenCalled();
  });

  it('also short-circuits deeper non-repo paths (uploads, extracted zips)', async () => {
    const { result } = renderHook(
      () => useFileAccess('uploads/spec/diagram.png', PROTECTED),
      { wrapper: withWorkspace(makeWorkspace()) },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.canWrite).toBe(true);
    expect(apiMock.fetchFileAccess).not.toHaveBeenCalled();
  });

  // The substring-not-prefix foot-gun: `knowledge-base-backup/...` happens
  // to start with the kbDirName text but is NOT inside the repo dir. The
  // `kbDirName + '/'` check guards against this.
  it('treats `<kbDirName>-suffix/...` as non-repo (substring is not prefix)', async () => {
    const { result } = renderHook(
      () => useFileAccess('knowledge-base-backup/Knowledge/Foo.md', PROTECTED),
      { wrapper: withWorkspace(makeWorkspace()) },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.canWrite).toBe(true);
    expect(apiMock.fetchFileAccess).not.toHaveBeenCalled();
  });

  // Clicking the KB folder entry itself (no trailing slash) shouldn't fire a
  // request — directories don't have file-level write semantics here.
  it('returns no-path state for the kbDirName entry itself (no trailing slash)', async () => {
    const { result } = renderHook(() => useFileAccess('knowledge-base', PROTECTED), {
      wrapper: withWorkspace(makeWorkspace()),
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.canWrite).toBe(true);
    expect(apiMock.fetchFileAccess).not.toHaveBeenCalled();
  });

  // Before WorkspaceInfo hydrates, kbDirName is null. We can't classify the
  // path yet, so hold the no-path state and don't fire a misclassified call.
  it('holds the no-path state while kbDirName is still null (bootstrap)', () => {
    renderHook(
      () => useFileAccess('knowledge-base/Knowledge/Foo.md', PROTECTED),
      { wrapper: withWorkspace(makeWorkspace({ kbDirName: null })) },
    );

    expect(apiMock.fetchFileAccess).not.toHaveBeenCalled();
  });

  it('respects a non-default kbDirName from config', async () => {
    apiMock.fetchFileAccess.mockResolvedValueOnce({
      canWrite: true,
      eligible: { roles: ['Admin'], users: [] },
    });

    renderHook(() => useFileAccess('custom-kb/Knowledge/Foo.md', PROTECTED), {
      wrapper: withWorkspace(makeWorkspace({ kbDirName: 'custom-kb' })),
    });

    await waitFor(() =>
      expect(apiMock.fetchFileAccess).toHaveBeenCalledWith('ws-1', 'Knowledge/Foo.md'),
    );
  });

  // Drafts are free-for-all. The backend skips the per-path gate on
  // non-protected branches (lock-acquire, commit, push, revert all bail
  // early), so the editor must mirror that — no API call, immediate
  // canWrite=true, no read-only flicker.
  it('skips the API on a non-protected branch and returns canWrite=true', async () => {
    const { result } = renderHook(
      () => useFileAccess('knowledge-base/Knowledge/Foo.md', DRAFT),
      { wrapper: withWorkspace(makeWorkspace()) },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.canWrite).toBe(true);
    expect(result.current.eligible).toEqual({ roles: [], users: [] });
    expect(apiMock.fetchFileAccess).not.toHaveBeenCalled();
  });

  // Switching files must not leak the PREVIOUS file's verdicts into the new
  // lookup's in-flight window: both canWrite and canDownload reset to null
  // (optimistic) the moment the new request starts.
  it('resets canWrite/canDownload to null while a new file lookup is in flight', async () => {
    apiMock.fetchFileAccess.mockResolvedValueOnce({
      canWrite: false,
      canDownload: false,
      eligible: { roles: ['Admin'], users: [] },
      owners: { roles: [], users: [] },
    });
    // The second file's request stays pending until we resolve it.
    let resolveSecond!: (v: unknown) => void;
    apiMock.fetchFileAccess.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSecond = resolve;
        }),
    );

    const { result, rerender } = renderHook(
      ({ path }: { path: string }) => useFileAccess(path, PROTECTED),
      {
        wrapper: withWorkspace(makeWorkspace()),
        initialProps: { path: 'knowledge-base/Knowledge/First.md' },
      },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.canWrite).toBe(false);
    expect(result.current.canDownload).toBe(false);

    rerender({ path: 'knowledge-base/Knowledge/Second.md' });
    // In flight for the SECOND file: the first file's hard "no" must not show.
    expect(result.current.loading).toBe(true);
    expect(result.current.canWrite).toBeNull();
    expect(result.current.canDownload).toBeNull();

    resolveSecond({
      canWrite: true,
      canDownload: true,
      eligible: { roles: [], users: [] },
      owners: { roles: [], users: [] },
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.canWrite).toBe(true);
    expect(result.current.canDownload).toBe(true);
  });

  // Branch still loading: hold canWrite=null so the caller stays optimistic
  // (editor editable) until we know which gate applies. Don't fire the API
  // yet because we'd be guessing.
  it('holds canWrite=null while branch is still null (status bootstrap)', () => {
    renderHook(
      () => useFileAccess('knowledge-base/Knowledge/Foo.md', null),
      { wrapper: withWorkspace(makeWorkspace()) },
    );

    expect(apiMock.fetchFileAccess).not.toHaveBeenCalled();
  });
});

describe('formatEligible', () => {
  it('joins roles and named users', () => {
    expect(
      formatEligible({
        roles: ['Admin', 'Product Manager'],
        users: [{ name: 'Felix Kissel', email: 'felix@example.com' }],
      }),
    ).toBe('Admin, Product Manager; Felix Kissel (felix@example.com)');
  });

  it('falls back to "no one" on empty', () => {
    expect(formatEligible({ roles: [], users: [] })).toBe('no one');
  });

  it('formats users without names as bare email', () => {
    expect(
      formatEligible({ roles: [], users: [{ name: '', email: 'x@y.z' }] }),
    ).toBe('x@y.z');
  });
});
