import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { GitContext, type GitContextValue } from '../../../git/state/git.context';
import { WorkspaceContext } from '../../state/workspace.context';
import { makeWorkspaceFixture } from '../../__tests__/testFixtures';
import { useFileNav } from '../kb-routes';

// Capture what openFile navigates to.
const navigateMock = vi.hoisted(() => vi.fn());
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateMock,
}));

function gitOnBranch(branch: string): GitContextValue {
  return {
    status: { branch, hasUpstream: true, unmergedFromUpstream: false },
    branches: [],
    availability: 'ready',
    lastError: null,
    refreshStatus: async () => null,
    refreshBranches: async () => {},
    createBranch: async () => {},
    deleteBranch: async () => {},
    pull: async () => {},
    fetchForkBase: async () => null,
    fetchFileHistory: async () => [],
    fetchFileDiff: async () => '',
    fetchFileAtChange: async () => ({ baseline: null, current: null }),
    fetchFileComparison: async () => '',
  };
}

function renderNav(branch: string, kbDirName: string | null = 'knowledge-base') {
  return renderHook(() => useFileNav(), {
    wrapper: ({ children }) => (
      <GitContext.Provider value={gitOnBranch(branch)}>
        <WorkspaceContext.Provider value={makeWorkspaceFixture({ kbDirName })}>
          {children}
        </WorkspaceContext.Provider>
      </GitContext.Provider>
    ),
  });
}

describe('useFileNav.openFile', () => {
  it('preserves a heading anchor on a relative path instead of encoding the #', () => {
    navigateMock.mockClear();
    const { result } = renderNav('alice/draft');
    result.current.openFile('Knowledge/Node.md#goal');
    // The `#goal` survives as a real URL fragment; only the path segments are encoded.
    expect(navigateMock).toHaveBeenCalledWith('/workspace/alice%2Fdraft/Knowledge/Node.md#goal');
  });

  it('preserves a heading anchor on an absolute workspace citation URL (with its own branch)', () => {
    navigateMock.mockClear();
    const { result } = renderNav('alice/draft');
    result.current.openFile(
      '/workspace/target-company-state/knowledge-base/GTM/NodeTypes/Bundle.md#status',
    );
    expect(navigateMock).toHaveBeenCalledWith(
      '/workspace/target-company-state/knowledge-base/GTM/NodeTypes/Bundle.md#status',
    );
  });

  it('routes an absolute workspace URL with no anchor unchanged', () => {
    navigateMock.mockClear();
    const { result } = renderNav('alice/draft');
    result.current.openFile('/workspace/target-company-state/knowledge-base/x.md');
    expect(navigateMock).toHaveBeenCalledWith(
      '/workspace/target-company-state/knowledge-base/x.md',
    );
  });

  // The model sometimes mangles a citation URL by inserting a junk segment
  // before the KB dir (a blend of the branch + dir names). Self-heal by
  // dropping everything before the `<kbDirName>/` segment so the link still
  // resolves instead of 404ing.
  it('strips a hallucinated junk segment before the kbDirName (absolute URL)', () => {
    navigateMock.mockClear();
    const { result } = renderNav('single-source-of-truth');
    result.current.openFile(
      '/workspace/single-source-of-truth/bevel-process-of-truth/knowledge-base/KnowledgeBase/Product/Knowledge/Bundles/functional/bdl-cpb-service-terms.md#id',
    );
    expect(navigateMock).toHaveBeenCalledWith(
      '/workspace/single-source-of-truth/knowledge-base/KnowledgeBase/Product/Knowledge/Bundles/functional/bdl-cpb-service-terms.md#id',
    );
  });

  it('treats # in a filename as part of the path when told it IS a path', () => {
    navigateMock.mockClear();
    const { result } = renderNav('alice/draft');
    // `openFile` parses link-shaped input, so `#` means "anchor" there.
    // `openWorkspacePath` is for real tree paths, where `#` is a character in
    // a filename and must be encoded, not split off.
    result.current.openWorkspacePath('knowledge-base/Knowledge/Q#A.md');
    expect(navigateMock).toHaveBeenCalledWith(
      '/workspace/alice%2Fdraft/knowledge-base/Knowledge/Q%23A.md',
    );
  });

  it('leaves a well-formed path untouched and ignores a kbDirName substring match', () => {
    navigateMock.mockClear();
    const { result } = renderNav('alice/draft');
    // `knowledge-base-backup` is NOT the repo dir — segment-exact match must
    // not treat it as the marker, so the path is passed through unchanged.
    result.current.openFile('/workspace/alice%2Fdraft/knowledge-base-backup/x.md');
    expect(navigateMock).toHaveBeenCalledWith(
      '/workspace/alice%2Fdraft/knowledge-base-backup/x.md',
    );
  });
});
