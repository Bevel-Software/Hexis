import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { renderHook } from '@testing-library/react';
import { GitContext, type GitContextValue } from '../../../git/state/git.context';
import { WorkspaceContext } from '../../state/workspace.context';
import { makeWorkspaceFixture } from '../../__tests__/testFixtures';
import { useFileNav, useNodeIdNav, resolveKbHref } from '../kb-routes';

// Capture what openFile navigates to, and stand in for the URL it reads the
// branch out of.
const navigateMock = vi.hoisted(() => vi.fn());
const routerMock = vi.hoisted(() => ({ pathname: '/', search: '' }));
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateMock,
  useLocation: () => ({ pathname: routerMock.pathname, search: routerMock.search, hash: '', state: null, key: 'k' }),
}));

// `window.open` answering with a tab, as a browser does when it opens one.
// A link inside a file opens its target there and never navigates this tab.
let openMock: MockInstance<typeof window.open>;
let openedTab: { opener: unknown };
beforeEach(() => {
  navigateMock.mockClear();
  routerMock.search = '';
  openedTab = { opener: window };
  openMock = vi.spyOn(window, 'open').mockImplementation(() => openedTab as unknown as Window);
});
afterEach(() => openMock.mockRestore());

function expectNewTab(url: string) {
  expect(openMock).toHaveBeenCalledWith(url, '_blank');
  expect(navigateMock).not.toHaveBeenCalled();
}

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

/**
 * `branch` is what git status reports; `pathname` is the URL the app is on.
 * They agree except mid-switch, which is what the switch tests below exercise.
 * Default: a URL outside `/workspace`, so the status is the only branch there is.
 */
function renderNav(
  branch: string,
  kbDirName: string | null = 'knowledge-base',
  pathname = '/',
  search = '',
) {
  routerMock.pathname = pathname;
  routerMock.search = search;
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

  it('asks the viewer for the editor through router state, never through the URL', () => {
    navigateMock.mockClear();
    const { result } = renderNav('alice/draft');
    result.current.openWorkspacePath('knowledge-base/KnowledgeBase/Untitled.md', { edit: true });
    expect(navigateMock).toHaveBeenCalledWith(
      '/workspace/alice%2Fdraft/knowledge-base/KnowledgeBase/Untitled.md',
      { state: { startEditing: true, startEditingPath: 'knowledge-base/KnowledgeBase/Untitled.md' } },
    );
  });

  // A page's "Open in the platform", asked for from inside the page: a new
  // tab, which carries no router state, so the ask rides in the address.
  it('opens a page on its FILE PAGE in a new tab, by an address that asks for it', () => {
    const { result } = renderNav('main');
    result.current.openFilePage('knowledge-base/Skills/qa-bridge/view.html');
    expectNewTab('/workspace/main/knowledge-base/Skills/qa-bridge/view.html?as=file');
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
    expectNewTab(
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
    expectNewTab('/workspace/target-company-state/knowledge-base/x.md');
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

  // What a reader clicking a link WRITTEN IN AN HTML PAGE reaches: the
  // sanitizer now keeps those hrefs, the nav bridge cancels the click the
  // sandbox would not let the iframe make, and the address lands here.
  it('opens a page linked by a relative path, resolved against the linking page', () => {
    navigateMock.mockClear();
    const { result } = renderNav('alice/draft');
    result.current.openLink('Board.html', 'knowledge-base/Dashboards/a.html');
    expectNewTab(
      '/workspace/alice%2Fdraft/knowledge-base/Dashboards/Board.html',
    );
  });

  it('opens a page up a folder and keeps its fragment', () => {
    navigateMock.mockClear();
    const { result } = renderNav('alice/draft');
    result.current.openLink('../Reports/Q3.html#totals', 'knowledge-base/Dashboards/a.html');
    expectNewTab(
      '/workspace/alice%2Fdraft/knowledge-base/Reports/Q3.html#totals',
    );
  });

  // A link to a page nobody wrote is still a navigation: the route goes to
  // that path and `FileRoute` answers with its own "File not found" screen,
  // exactly as it does for a mistyped URL. Resolution does not second-guess
  // whether the file is there.
  it('navigates to a page that does not exist, leaving not-found to the route', () => {
    navigateMock.mockClear();
    const { result } = renderNav('alice/draft');
    result.current.openLink('Missing.html', 'knowledge-base/Dashboards/a.html');
    expectNewTab(
      '/workspace/alice%2Fdraft/knowledge-base/Dashboards/Missing.html',
    );
  });

  // Generated markup writes an href on its own line, and `sanitizeAgentHtml`
  // keeps it by reading past the padding. The resolver has to read past the
  // same padding or the kept link lands on a filename with spaces in it.
  it('resolves a page link written on its own line, padding and all', () => {
    navigateMock.mockClear();
    const { result } = renderNav('alice/draft');
    result.current.openLink('\n      Board.html\n    ', 'knowledge-base/Dashboards/a.html');
    expectNewTab(
      '/workspace/alice%2Fdraft/knowledge-base/Dashboards/Board.html',
    );
  });

  it('resolves a padded citation URL as a citation URL, not a relative path', () => {
    navigateMock.mockClear();
    const { result } = renderNav('alice/draft');
    result.current.openLink(
      '  /workspace/bob%2Fmain/knowledge-base/Reports/Q3.html#totals  ',
      'knowledge-base/Dashboards/a.html',
    );
    expectNewTab(
      '/workspace/bob%2Fmain/knowledge-base/Reports/Q3.html#totals',
    );
  });

  it('keeps a padded same-document anchor on the file it sits in', () => {
    const { result } = renderNav('alice/draft', 'knowledge-base', '/workspace/alice%2Fdraft/knowledge-base/Dashboards/a.html');
    result.current.openLink('  #goal  ', 'knowledge-base/Dashboards/a.html');
    expect(navigateMock).toHaveBeenCalledWith('/workspace/alice%2Fdraft/knowledge-base/Dashboards/a.html#goal');
    expect(openMock).not.toHaveBeenCalled();
  });

  // `window.open` would strip the padding itself, but the address handed over
  // is the one the allowlist approved, so it goes over clean.
  it('opens a padded external link at the address it names', () => {
    navigateMock.mockClear();
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const { result } = renderNav('alice/draft');
    result.current.openLink('\n  https://example.com/docs\n', 'knowledge-base/Dashboards/a.html');
    expect(open).toHaveBeenCalledWith('https://example.com/docs', '_blank', 'noopener,noreferrer');
    expect(navigateMock).not.toHaveBeenCalled();
    open.mockRestore();
  });

  // A section link is a scroll, not a navigation to somewhere else.
  it('keeps a same-document anchor on the file it sits in', () => {
    const { result } = renderNav('alice/draft', 'knowledge-base', '/workspace/alice%2Fdraft/knowledge-base/Knowledge/Foo.md');
    result.current.openLink('#overview', 'knowledge-base/Knowledge/Foo.md');
    expect(navigateMock).toHaveBeenCalledWith('/workspace/alice%2Fdraft/knowledge-base/Knowledge/Foo.md#overview');
    expect(openMock).not.toHaveBeenCalled();
  });

  // The section link moves this tab by its fragment ONLY: a node shown at its
  // id URL stays there, and full screen (`?fullscreen=1`) stays on.
  it('scrolls a section link in place on this tab\'s own address, query kept', () => {
    const { result } = renderNav('alice/draft', 'knowledge-base', '/workspace/alice%2Fdraft/foo-node', '?fullscreen=1');
    result.current.openLink('Foo.md#overview', 'knowledge-base/Knowledge/Foo.md');
    expect(navigateMock).toHaveBeenCalledWith('/workspace/alice%2Fdraft/foo-node?fullscreen=1#overview');
    expect(openMock).not.toHaveBeenCalled();
  });

  // The same file on ANOTHER branch is another file.
  it('opens the same path on another branch in a new tab', () => {
    const { result } = renderNav('alice/draft', 'knowledge-base', '/workspace/alice%2Fdraft/knowledge-base/Knowledge/Foo.md');
    result.current.openLink('/workspace/main/knowledge-base/Knowledge/Foo.md#overview', 'knowledge-base/Knowledge/Foo.md');
    expectNewTab('/workspace/main/knowledge-base/Knowledge/Foo.md#overview');
  });

  it('in full screen, opens another file at its plain address and leaves this tab alone', () => {
    const { result } = renderNav('alice/draft', 'knowledge-base', '/workspace/alice%2Fdraft/knowledge-base/Dashboards/a.html', '?fullscreen=1');
    result.current.openLink('../Knowledge/Plan.md', 'knowledge-base/Dashboards/a.html');
    expectNewTab('/workspace/alice%2Fdraft/knowledge-base/Knowledge/Plan.md');
  });

  // The new tab is the app's own page, opened without `noopener` only so a
  // refusal can be told from a success; the opener is cut the same moment.
  it('severs the new tab\'s opener', () => {
    const { result } = renderNav('alice/draft');
    result.current.openLink('Board.html', 'knowledge-base/Dashboards/a.html');
    expect(openedTab.opener).toBeNull();
  });

  it('reports a tab the browser refused to open, rather than swallowing the click', () => {
    openMock.mockImplementation(() => null);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { result } = renderNav('alice/draft');
    result.current.openLink('Board.html', 'knowledge-base/Dashboards/a.html');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('/workspace/alice%2Fdraft/knowledge-base/Dashboards/Board.html'));
    expect(navigateMock).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  // What an anchor carries is what the click opens.
  it('answers linkTarget with the address and the tab openLink uses', () => {
    const { result } = renderNav('alice/draft', 'knowledge-base', '/workspace/alice%2Fdraft/knowledge-base/Knowledge/Foo.md');
    expect(result.current.linkTarget('Other.md', 'knowledge-base/Knowledge/Foo.md')).toEqual({
      href: '/workspace/alice%2Fdraft/knowledge-base/Knowledge/Other.md',
      newTab: true,
    });
    expect(result.current.linkTarget('#a', 'knowledge-base/Knowledge/Foo.md')).toEqual({
      href: '/workspace/alice%2Fdraft/knowledge-base/Knowledge/Foo.md#a',
      newTab: false,
    });
    expect(result.current.linkTarget('https://example.com', 'knowledge-base/Knowledge/Foo.md')).toBeNull();
  });

  // The skill page reads its files from the default branch whatever is
  // checked out: told so, a relative link opens there, and a link to the
  // file itself is still a section of this tab.
  it('resolves a relative link on the home branch it is told the file was read from', () => {
    const { result } = renderNav('alice/draft', 'knowledge-base', '/skills-and-tools/skills/newsletter');
    const base = 'knowledge-base/Skills/newsletter/SKILL.md';
    expect(result.current.linkTarget('ref.md', base, 'main')).toEqual({
      href: '/workspace/main/knowledge-base/Skills/newsletter/ref.md',
      newTab: true,
    });
    expect(result.current.linkTarget('SKILL.md#steps', base, 'main')).toEqual({
      href: '/skills-and-tools/skills/newsletter#steps',
      newTab: false,
    });
    result.current.openLink('ref.md', base, { homeBranch: 'main' });
    expectNewTab('/workspace/main/knowledge-base/Skills/newsletter/ref.md');
  });

  // A host whose address does not scroll to a fragment (an HTML page's frame,
  // the skill page) takes a section link itself: handed the fragment, while
  // this tab stays where it is. Another file still opens a new tab.
  it('hands a section link to the host that scrolls it, and moves nothing', () => {
    navigateMock.mockClear();
    const { result } = renderNav('main', 'knowledge-base', '/workspace/main/knowledge-base/Dashboards/Roadmap.html');
    const base = 'knowledge-base/Dashboards/Roadmap.html';
    const onSection = vi.fn();
    result.current.openLink('Roadmap.html#q3', base, { onSection });
    result.current.openLink('/workspace/main/knowledge-base/Dashboards/Roadmap.html#q4', base, { onSection });
    expect(onSection.mock.calls).toEqual([['#q3'], ['#q4']]);
    expect(navigateMock).not.toHaveBeenCalled();
    result.current.openLink('Board.html#q3', base, { onSection });
    expect(onSection).toHaveBeenCalledTimes(2);
    expectNewTab('/workspace/main/knowledge-base/Dashboards/Board.html#q3');
  });
});

/**
 * A tree click during a branch switch. `git.status.branch` reports the branch
 * being LEFT until the destination workspace bootstraps and answers, so a
 * click built from it landed the user back on the branch they were leaving —
 * the switch appearing to undo itself. The URL is the authority for which
 * branch is on screen, so the click follows it.
 */
describe('useFileNav: which branch a click lands on', () => {
  it('opens on the branch the URL is switching TO, not the one git status still reports', () => {
    navigateMock.mockClear();
    const { result } = renderNav(
      'alice/draft',
      'knowledge-base',
      '/workspace/target-company-state/knowledge-base/Knowledge/Old.md',
    );
    result.current.openFile('knowledge-base/Knowledge/New.md');
    expect(navigateMock).toHaveBeenCalledWith(
      '/workspace/target-company-state/knowledge-base/Knowledge/New.md',
    );
  });

  it('decodes the URL branch exactly once — the pathname is still encoded', () => {
    navigateMock.mockClear();
    // `alice%2Fdraft` would prove nothing: decoding it twice gives the same
    // `alice/draft` as decoding it once. This segment survives a second decode
    // visibly — once gives `alice%25`, which re-encodes to the URL below;
    // twice gives `alice%`, which re-encodes to `/workspace/alice%25/…`.
    const { result } = renderNav('main', 'knowledge-base', '/workspace/alice%2525/Knowledge/Old.md');
    result.current.openFile('Knowledge/New.md');
    expect(navigateMock).toHaveBeenCalledWith('/workspace/alice%2525/Knowledge/New.md');
  });

  it('a relative link during the same switch also follows the URL branch', () => {
    navigateMock.mockClear();
    const { result } = renderNav(
      'alice/draft',
      'knowledge-base',
      '/workspace/target-company-state/knowledge-base/Knowledge/Old.md',
    );
    result.current.openLink('./New.md', 'knowledge-base/Knowledge/Old.md');
    expectNewTab(
      '/workspace/target-company-state/knowledge-base/Knowledge/New.md',
    );
  });

  it('falls back to git status off a workspace route, where the URL names no branch', () => {
    navigateMock.mockClear();
    const { result } = renderNav('alice/draft', 'knowledge-base', '/library/skills');
    result.current.openFile('Knowledge/New.md');
    expect(navigateMock).toHaveBeenCalledWith('/workspace/alice%2Fdraft/Knowledge/New.md');
  });
});

/**
 * An id-link is a link inside a file too. The new tab gets the node's id URL
 * and resolves it there (its route answers not-found for an id the reader
 * cannot see), so the tab opens inside the click rather than after a round
 * trip, at the address a middle-click on the same anchor would open.
 */
describe('useNodeIdNav', () => {
  function renderNodeNav(pathname: string, search = '') {
    routerMock.pathname = pathname;
    routerMock.search = search;
    return renderHook(() => useNodeIdNav(), {
      wrapper: ({ children }) => (
        <GitContext.Provider value={gitOnBranch('alice/draft')}>
          <WorkspaceContext.Provider value={makeWorkspaceFixture({ kbDirName: 'knowledge-base' })}>
            {children}
          </WorkspaceContext.Provider>
        </GitContext.Provider>
      ),
    });
  }

  it('opens another node in a new tab at its id URL, heading kept', () => {
    const { result } = renderNodeNav('/workspace/alice%2Fdraft/knowledge-base/Knowledge/Foo.md');
    result.current.openNodeId('plan-node#goal');
    expectNewTab('/workspace/alice%2Fdraft/plan-node#goal');
  });

  it('in full screen, opens the plain id URL and leaves this tab alone', () => {
    const { result } = renderNodeNav('/workspace/alice%2Fdraft/foo-node', '?fullscreen=1');
    result.current.openNodeId('plan-node');
    expectNewTab('/workspace/alice%2Fdraft/plan-node');
  });

  it('scrolls a link to the node on screen in place, address and query kept', () => {
    const { result } = renderNodeNav('/workspace/alice%2Fdraft/foo-node', '?fullscreen=1');
    result.current.openNodeId('foo-node#goal');
    expect(navigateMock).toHaveBeenCalledWith('/workspace/alice%2Fdraft/foo-node?fullscreen=1#goal');
    expect(openMock).not.toHaveBeenCalled();
  });

  // The node on screen told by its id: a tab still on the file's path URL —
  // canonicalizing, or a `FileRoute` that never canonicalizes — keeps a link
  // to it in place; any other id is still a new tab.
  it('scrolls a link to the node on screen in place on its path URL when told its id', () => {
    const path = '/workspace/alice%2Fdraft/knowledge-base/Knowledge/Foo.md';
    const { result } = renderNodeNav(path, '?fullscreen=1');
    expect(result.current.nodeIdTarget('foo-node#goal', 'foo-node')).toEqual({
      href: `${path}?fullscreen=1#goal`,
      newTab: false,
    });
    result.current.openNodeId('foo-node#goal', 'foo-node');
    expect(navigateMock).toHaveBeenCalledWith(`${path}?fullscreen=1#goal`);
    expect(openMock).not.toHaveBeenCalled();
    navigateMock.mockClear();
    result.current.openNodeId('plan-node', 'foo-node');
    expectNewTab('/workspace/alice%2Fdraft/plan-node');
  });

  it('answers nodeIdTarget with the same address', () => {
    const { result } = renderNodeNav('/workspace/alice%2Fdraft/foo-node');
    expect(result.current.nodeIdTarget('plan-node#goal')).toEqual({
      href: '/workspace/alice%2Fdraft/plan-node#goal',
      newTab: true,
    });
  });
});

/**
 * The app's own navigation is not a link inside a file: the tree, the tabs,
 * search and the library open in place, through `openFile` and
 * `openWorkspacePath`, in full screen or not.
 */
describe('useFileNav: the app\'s own navigation stays in this tab', () => {
  it('opens a tree path in place', () => {
    const { result } = renderNav('alice/draft', 'knowledge-base', '/workspace/alice%2Fdraft/knowledge-base/Knowledge/Old.md', '?fullscreen=1');
    result.current.openWorkspacePath('knowledge-base/Knowledge/New.md');
    expect(navigateMock).toHaveBeenCalledWith('/workspace/alice%2Fdraft/knowledge-base/Knowledge/New.md');
    expect(openMock).not.toHaveBeenCalled();
  });

  it('opens a tab\'s file in place', () => {
    const { result } = renderNav('alice/draft', 'knowledge-base', '/workspace/alice%2Fdraft/knowledge-base/Knowledge/Old.md');
    result.current.openFile('knowledge-base/Knowledge/New.md');
    expect(navigateMock).toHaveBeenCalledWith('/workspace/alice%2Fdraft/knowledge-base/Knowledge/New.md');
    expect(openMock).not.toHaveBeenCalled();
  });
});
