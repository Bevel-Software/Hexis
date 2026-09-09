import { useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { DEFAULT_BRANCH, PLUGINS_DIR, SKILLS_DIR, type FileTreeEntry } from '@bevel-software/platform-shared';
import { useWorkspace } from '../../workspace/state/workspace.context';
import { findKbRoot } from '../../workspace/utils/fileTree';
import { KB_ROUTE_PREFIX, kbFileUrl, safeDecode } from '../../workspace/routing/kb-routes';
import { useMergedWorkspaceTree } from '../../workspace/hooks/useMergedWorkspaceTree';
import {
  FileTreeNode,
  TreeChrome,
  UploadNotices,
  type TreeNav,
} from '../../workspace/components/FileExplorer';

/**
 * One of the Library's two reserved roots — `Skills/` or `Plugins/` — as a
 * file tree, made of the SAME rows as Knowledge's explorer — right-click menu
 * (new file, new folder, rename, delete, manage access, download), drag to
 * move, drop to upload, the caller's proposed files shown in accent. One tree
 * component in the app, holding a different root.
 *
 * The root is a collapsible folder row named after the folder, exactly as
 * Knowledge and Data are top-level folders in the Knowledge explorer: open
 * by default with its children collapsed under it, a drop target for uploads
 * into the root, the create buttons on hover, the folder's menu on
 * right-click — minus what a platform-owned root must not offer
 * (`FileTreeNode.reserved`: no rename, delete, drag or pin).
 *
 * Two things differ from Knowledge, and both are the surroundings' (see
 * `TreeChrome`), not the rows':
 *
 *  - A click opens the file on its ITEM PAGE, here in Skills & Tools — at
 *    the item's canonical default-branch URL, whatever branch is checked
 *    out. The Library speaks the default branch everywhere; this is no
 *    exception. A skill's SKILL.md opens the skill page; a plugin's
 *    manifest or a loose file opens the plugin page; a tool file opens the
 *    tool page — `WorkspaceItemRoute` decides, from the path alone.
 *  - The current row is the file the URL names, not the pane workspace's
 *    open tab, which the Library never sets.
 *
 * Renders nothing only while the tree is loading. Once it is here the
 * folder is always drawn — empty when the knowledge base has none yet, at
 * the path it will get — because the folder is where new things go, and a
 * person cannot put one there if the way there is not on screen. The
 * reserved root is forced visible by the tree filter even to a reader who
 * may open nothing beneath it, so the row is present for everyone.
 */
export function RootFolderTree({ dir, testId }: { dir: string; testId: string }) {
  const { kbDirName } = useWorkspace();
  const { tree, suggestionOnlyPaths } = useMergedWorkspaceTree();
  const location = useLocation();
  const navigate = useNavigate();

  const root = useMemo((): { entry: FileTreeEntry; absent: boolean } | null => {
    const kbRoot = findKbRoot(tree);
    if (!kbRoot) return null;
    const found = kbRoot.children?.find((c) => c.type === 'directory' && c.name === dir);
    if (found) return { entry: found, absent: false };
    // No folder yet (a knowledge base from before the root existed, or one
    // whose folder was removed): the row is drawn anyway, empty, at the
    // path the folder will have. Every write creates its parents, so the
    // first drop, file or subfolder made here creates the folder itself;
    // what would READ the folder (download) is withheld until then.
    const base = kbRoot.relativePath === '.' ? '' : `${kbRoot.relativePath}/`;
    return {
      entry: { name: dir, relativePath: `${base}${dir}`, type: 'directory', children: [] },
      absent: true,
    };
  }, [tree, dir]);

  const nav = useMemo<TreeNav>(
    () => ({
      activePath: activeWorkspacePath(location.pathname, kbDirName),
      open: (path) => navigate(kbFileUrl(DEFAULT_BRANCH, path)),
    }),
    [location.pathname, kbDirName, navigate],
  );

  if (!root) return null;

  return (
    <TreeChrome nav={nav} suggestionOnlyPaths={suggestionOnlyPaths}>
      {/* A right-click that lands between the tree's rows is the tree's, not
          the nav's behind it: with nothing wired for the gap the browser's
          own menu is the honest answer, as in Knowledge. The rows stop their
          own events before reaching here. */}
      <div data-testid={testId} onContextMenu={(e) => e.stopPropagation()}>
        <UploadNotices />
        <FileTreeNode entry={root.entry} depth={0} reserved absent={root.absent} collapseChildren />
      </div>
    </TreeChrome>
  );
}

/** The shared `Skills/` root. */
export function SkillsTree() {
  return <RootFolderTree dir={SKILLS_DIR} testId="skills-tree" />;
}

/** The `Plugins/` root — every plugin folder as it is on disk. */
export function PluginsTree() {
  return <RootFolderTree dir={PLUGINS_DIR} testId="plugins-tree" />;
}

/**
 * The workspace-relative path a Library URL names, or null. Library item
 * pages live at `/workspace/<default>/<kbDir>/...` — the inverse of
 * `kbFileUrl`, segment by segment. Any other URL (the index, a lens, a
 * plugin page) names no file, so no row is current.
 */
function activeWorkspacePath(pathname: string, kbDirName: string | null): string | null {
  const prefix = `${KB_ROUTE_PREFIX}/`;
  if (!pathname.startsWith(prefix)) return null;
  const [branch, ...rest] = pathname.slice(prefix.length).split('/').map(safeDecode);
  if (branch !== DEFAULT_BRANCH || rest.length < 2) return null;
  if (kbDirName !== null && rest[0] !== kbDirName) return null;
  return rest.join('/');
}
