import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { GitContext, type GitContextValue } from '../../../git/state/git.context';
import { WorkspaceContext } from '../../state/workspace.context';
import { makeWorkspaceFixture } from '../../__tests__/testFixtures';
import { useFileNav, resolveKbHref } from '../kb-routes';

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

  it('opens a tree path verbatim even when a folder inside it is named like the kbDirName', () => {
    navigateMock.mockClear();
    const { result } = renderNav('alice/draft');
    // A tree whose root is not the KB dir, holding a folder that happens to be
    // named like it. The junk-segment repair drops everything before that
    // segment, rewriting this to `knowledge-base/notes.md` — a different file.
    // A path that came from the tree is already correct and needs no repair.
    result.current.openWorkspacePath('Knowledge/knowledge-base/notes.md');
    expect(navigateMock).toHaveBeenCalledWith(
      '/workspace/alice%2Fdraft/Knowledge/knowledge-base/notes.md',
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

/**
 * The one grammar for a link or image destination. Link handlers and image
 * resolvers both go through it, so a case here is a case for every surface.
 */
describe('resolveKbHref', () => {
  const opts = { basePath: 'knowledge-base/Knowledge/Sub/Foo.md', kbDirName: 'knowledge-base' };

  it('classifies an http(s) URL as external', () => {
    expect(resolveKbHref('https://example.com/a.png', opts)).toEqual({ kind: 'external' });
    expect(resolveKbHref('http://example.com/x.md', opts)).toEqual({ kind: 'external' });
  });

  it('classifies a protocol-relative URL as external', () => {
    expect(resolveKbHref('//cdn.example.com/a.png', opts)).toEqual({ kind: 'external' });
  });

  it('parses an absolute app URL into its own branch, path and anchor', () => {
    expect(
      resolveKbHref('/workspace/target-company-state/knowledge-base/GTM/Bundle.md#status', opts),
    ).toEqual({
      kind: 'workspace',
      branch: 'target-company-state',
      path: 'knowledge-base/GTM/Bundle.md',
      hash: '#status',
    });
  });

  it('repairs a junk segment before the kbDirName in an absolute URL, and decodes the branch', () => {
    expect(
      resolveKbHref('/workspace/alice%2Fdraft/bevel-process-of-truth/knowledge-base/x.md', opts),
    ).toEqual({ kind: 'workspace', branch: 'alice/draft', path: 'knowledge-base/x.md', hash: '' });
  });

  it('resolves a relative destination against the base file, keeping the anchor', () => {
    expect(resolveKbHref('../NodeTypes/Process.md#goal', opts)).toEqual({
      kind: 'workspace',
      branch: null,
      path: 'knowledge-base/Knowledge/NodeTypes/Process.md',
      hash: '#goal',
    });
    expect(resolveKbHref('./assets/shot.png', opts)).toEqual({
      kind: 'workspace',
      branch: null,
      path: 'knowledge-base/Knowledge/Sub/assets/shot.png',
      hash: '',
    });
  });

  it('anchors a root-relative destination at the workspace root', () => {
    expect(resolveKbHref('/knowledge-base/assets/x.png', opts)).toMatchObject({
      kind: 'workspace',
      path: 'knowledge-base/assets/x.png',
    });
  });

  it('decodes percent-escapes, and leaves a malformed one as written', () => {
    expect(resolveKbHref('Some%20File.md', opts)).toMatchObject({
      path: 'knowledge-base/Knowledge/Sub/Some File.md',
    });
    expect(resolveKbHref('100%.md', opts)).toMatchObject({
      path: 'knowledge-base/Knowledge/Sub/100%.md',
    });
  });

  it('keeps a name with a colon in it inside the workspace', () => {
    expect(resolveKbHref('Notes: today.md', opts)).toMatchObject({
      kind: 'workspace',
      path: 'knowledge-base/Knowledge/Sub/Notes: today.md',
    });
  });

  it('returns null for an empty destination', () => {
    expect(resolveKbHref('', opts)).toBeNull();
  });
});

describe('useFileNav.openLink', () => {
  it('opens a relative link on the current branch, decoded and resolved against the file it sits in', () => {
    navigateMock.mockClear();
    const { result } = renderNav('alice/draft');
    result.current.openLink('Some%20File.md#goal', 'knowledge-base/Knowledge/Foo.md');
    expect(navigateMock).toHaveBeenCalledWith(
      '/workspace/alice%2Fdraft/knowledge-base/Knowledge/Some%20File.md#goal',
    );
  });

  // The branch rule: a link keeps the branch its URL names.
  it('keeps the branch of an absolute app URL', () => {
    navigateMock.mockClear();
    const { result } = renderNav('alice/draft');
    result.current.openLink(
      '/workspace/target-company-state/knowledge-base/x.md',
      'knowledge-base/Knowledge/Foo.md',
    );
    expect(navigateMock).toHaveBeenCalledWith('/workspace/target-company-state/knowledge-base/x.md');
  });

  it("ignores an external link: that one is the browser's", () => {
    navigateMock.mockClear();
    const { result } = renderNav('alice/draft');
    result.current.openLink('https://example.com/x.md', 'knowledge-base/Knowledge/Foo.md');
    expect(navigateMock).not.toHaveBeenCalled();
  });
});
