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

  // Any scheme is external, not only the web ones: an app's own (`sms:`,
  // `geo:`, `x-devonthink-item:`) names no workspace file either. A bare
  // colon-name would read as a scheme too, but both sanitizers drop an href
  // with a scheme they do not know before the pipeline sees it; a path with a
  // segment before the colon is still a path.
  it('classifies any scheme as external, and keeps a colon inside a path segment', () => {
    for (const href of ['sms:555', 'geo:0,0', 'about:config', 'x-devonthink-item://abc']) {
      expect(resolveKbHref(href, opts)).toEqual({ kind: 'external' });
    }
    expect(resolveKbHref('./Notes: today.md', opts)).toMatchObject({
      kind: 'workspace',
      path: 'knowledge-base/Knowledge/Sub/Notes: today.md',
    });
  });

  it('returns null for an empty destination', () => {
    expect(resolveKbHref('', opts)).toBeNull();
  });

  // Without a same-document row the empty location falls through to
  // `resolveRelativePath`, which drops the file segment off the base path: a
  // reader clicking a section link lands on the folder listing instead of
  // scrolling down the page they are on.
  it('resolves a bare anchor to the file it sits in, not to its parent folder', () => {
    expect(resolveKbHref('#overview', opts)).toEqual({
      kind: 'workspace',
      branch: null,
      path: 'knowledge-base/Knowledge/Sub/Foo.md',
      hash: '#overview',
    });
  });

  // The junk-segment repair exists for a LINK a model may have mangled. An
  // image src is a path an author wrote, and the repair rewrites any path
  // whose later segment happens to equal the KB dir — so on a correctly
  // authored `./assets/knowledge-base/shot.png` it truncates a real path into
  // a 404 and the reader gets a placeholder where a picture belongs.
  it('leaves a path alone when the repair is off, even one with a kbDirName segment in it', () => {
    // A skill's own file, holding a picture in a folder the author happened to
    // name after the KB dir.
    const inSkill = { basePath: 'Skills/deploy/SKILL.md', kbDirName: 'knowledge-base' };
    const href = './assets/knowledge-base/shot.png';
    expect(resolveKbHref(href, { ...inSkill, repairMangledPath: false })).toEqual({
      kind: 'workspace',
      branch: null,
      path: 'Skills/deploy/assets/knowledge-base/shot.png',
      hash: '',
    });
    // The SAME destination with the repair on: everything before the later
    // `knowledge-base` segment is dropped and the picture 404s. Right for a
    // citation link a model mangled, wrong for a path its author wrote.
    expect(resolveKbHref(href, inSkill)).toEqual({
      kind: 'workspace',
      branch: null,
      path: 'knowledge-base/shot.png',
      hash: '',
    });
  });

  it('leaves an absolute URL path alone when the repair is off', () => {
    const href = '/workspace/main/assets/knowledge-base/shot.png';
    expect(resolveKbHref(href, { ...opts, repairMangledPath: false })).toEqual({
      kind: 'workspace',
      branch: 'main',
      path: 'assets/knowledge-base/shot.png',
      hash: '',
    });
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

  // Every caller reaches `openLink` by CANCELLING the browser's navigation
  // first — the HTML sandbox `preventDefault`s each anchor and posts the href
  // up, the frontmatter panel does the same. So "leave it to the browser" is
  // not deference here, it is a dead click.
  it('opens an external link in a new tab rather than dropping it', () => {
    navigateMock.mockClear();
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const { result } = renderNav('alice/draft');
    result.current.openLink('https://example.com/x.md', 'knowledge-base/Knowledge/Foo.md');
    expect(open).toHaveBeenCalledWith('https://example.com/x.md', '_blank', 'noopener,noreferrer');
    expect(navigateMock).not.toHaveBeenCalled();
    open.mockRestore();
  });

  it('opens a mailto: link, which is external and openable', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const { result } = renderNav('alice/draft');
    result.current.openLink('mailto:a@b.com', 'knowledge-base/Knowledge/Foo.md');
    expect(open).toHaveBeenCalledWith('mailto:a@b.com', '_blank', 'noopener,noreferrer');
    open.mockRestore();
  });

  // `window.open('javascript:…')` runs the script in a document that inherits
  // THIS page's origin. Agent HTML can call `bevel.navigate(anyString)`
  // directly, so the bridge is reachable with a string no sanitizer saw — the
  // allowlist is what keeps the sandbox a sandbox.
  it('refuses to open a javascript: destination, so the HTML sandbox stays sealed', () => {
    navigateMock.mockClear();
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const { result } = renderNav('alice/draft');
    result.current.openLink('javascript:alert(1)', 'knowledge-base/Knowledge/Foo.md');
    expect(open).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
    open.mockRestore();
  });

  it('refuses a data: destination too', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const { result } = renderNav('alice/draft');
    result.current.openLink('data:text/html,<script>x</script>', 'knowledge-base/Knowledge/Foo.md');
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
  });

  // A section link is a scroll, not a navigation to somewhere else.
  it('keeps a same-document anchor on the file it sits in', () => {
    navigateMock.mockClear();
    const { result } = renderNav('alice/draft');
    result.current.openLink('#overview', 'knowledge-base/Knowledge/Foo.md');
    expect(navigateMock).toHaveBeenCalledWith(
      '/workspace/alice%2Fdraft/knowledge-base/Knowledge/Foo.md#overview',
    );
  });
});
