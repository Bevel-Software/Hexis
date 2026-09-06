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
 * The root's row is drawn as the section's HEADING (`FileTreeNode.heading`),
 * so the heading is a real row: drop files on it to upload into `Skills/`,
 * hover it for the create buttons and the pickers, right-click it for the
 * folder's menu. Its scopes sit directly under it at the nav's own indent.
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
 * part of the root — an empty "SKILLS" heading over nothing would be a
 * question, not a section.
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
          and the heading stop their own events before reaching here. */}
      <div data-testid="skills-tree" onContextMenu={(e) => e.stopPropagation()}>
        <UploadNotices />
        <FileTreeNode entry={root} depth={0} heading="Skills" collapseChildren />
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
