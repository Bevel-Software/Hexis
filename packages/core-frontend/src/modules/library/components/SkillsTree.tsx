import { useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { DEFAULT_BRANCH, SKILLS_DIR } from '@bevel-software/platform-shared';
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
 * The Skills section of the Library's nav: the shared `Skills/` root as a
 * file tree, made of the SAME rows as Knowledge's explorer — right-click menu
 * (new file, new folder, rename, delete, manage access, download), drag to
 * move, drop to upload, the caller's proposed files shown in accent. One tree
 * component in the app, holding a different root.
 *
 * The root is a collapsible folder row called Skills, exactly as Knowledge
 * and Data are top-level folders in the Knowledge explorer: open by default
 * with its scopes collapsed under it, a drop target for uploads into
 * `Skills/`, the create buttons on hover, the folder's menu on right-click —
 * minus what a platform-owned root must not offer (`FileTreeNode.reserved`:
 * no rename, delete, drag or pin).
 *
 * Two things differ from Knowledge, and both are the surroundings' (see
 * `TreeChrome`), not the rows':
 *
 *  - A click opens the file on its SKILL PAGE, here in Skills & Tools — at
 *    the item's canonical default-branch URL, whatever branch is checked
 *    out. The Library speaks the default branch everywhere; this is no
 *    exception.
 *  - The current row is the file the URL names, not the pane workspace's
 *    open tab, which the Library never sets.
 *
 * Renders nothing while the tree is loading or when the caller can read no
 * part of the root — an empty Skills folder would be a question, not a
 * section.
 */
export function SkillsTree() {
  const { kbDirName } = useWorkspace();
  const { tree, suggestionOnlyPaths } = useMergedWorkspaceTree();
  const location = useLocation();
  const navigate = useNavigate();

  const root = useMemo(() => {
    const kids = findKbRoot(tree)?.children;
    return kids?.find((c) => c.type === 'directory' && c.name === SKILLS_DIR) ?? null;
  }, [tree]);

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
          the plugin nav's behind it: with nothing wired for the gap the
          browser's own menu is the honest answer, as in Knowledge. The rows
          stop their own events before reaching here. */}
      <div data-testid="skills-tree" onContextMenu={(e) => e.stopPropagation()}>
        <UploadNotices />
        <FileTreeNode entry={root} depth={0} reserved collapseChildren />
      </div>
    </TreeChrome>
  );
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
