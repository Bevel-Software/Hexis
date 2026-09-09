import { useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { DEFAULT_BRANCH, PLUGINS_DIR, SKILLS_DIR, type FileTreeEntry } from '@bevel-software/platform-shared';
import { useWorkspace } from '../../workspace/state/workspace.context';
import { findKbRoot } from '../../workspace/utils/fileTree';
import { KB_ROUTE_PREFIX, kbFileUrl, safeDecode } from '../../workspace/routing/kb-routes';
import { useMergedWorkspaceTree } from '../../workspace/hooks/useMergedWorkspaceTree';
import { Puzzle } from 'lucide-react';
import {
  FileTreeNode,
  TreeChrome,
  UploadNotices,
  type TreeMenuItem,
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
export function RootFolderTree({
  dir,
  testId,
  menuItems,
}: {
  dir: string;
  testId: string;
  /**
   * The surface's own context-menu items for an entry, injected into the
   * tree's menu after its create verbs — see `TreeNav.menuItems`. The tree
   * itself grows no verb per caller.
   */
  menuItems?: (entry: FileTreeEntry) => TreeMenuItem[];
}) {
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
      menuItems,
    }),
    [location.pathname, kbDirName, navigate, menuItems],
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

/**
 * The `Plugins/` root — every plugin folder as it is on disk. A GROUPING
 * folder's row (the root, or a folder no plugin owns) offers "New plugin"
 * when the caller wires it, and the plugin is made THERE: the verb carries
 * the folder's path below the plugins root. The one verb this root has that
 * Knowledge's folders do not, injected rather than built into the tree. An
 * intent: the layout owns the dialog.
 */
export function PluginsTree({
  onCreatePlugin,
  isGroupingFolder = () => true,
}: {
  /** Make a plugin in `parent` — a path below the plugins root, `''` for the root. */
  onCreatePlugin?: (parent: string) => void;
  /**
   * Whether a repo-relative folder may HOLD a plugin: the root and folders no
   * plugin owns. A plugin's own folder, or anything beneath one, cannot — a
   * plugin claims its subtree, and a plugin made inside it would be listed
   * nowhere. The layout answers from the plugin index.
   */
  isGroupingFolder?: (repoRelFolder: string) => boolean;
} = {}) {
  const { kbDirName } = useWorkspace();
  const menuItems = useMemo(() => {
    if (!onCreatePlugin) return undefined;
    return (entry: FileTreeEntry): TreeMenuItem[] => {
      if (entry.type !== 'directory') return [];
      const rel = repoRelative(entry.relativePath, kbDirName);
      if (rel === null || !isGroupingFolder(rel)) return [];
      const parent = rel === PLUGINS_DIR ? '' : rel.slice(PLUGINS_DIR.length + 1);
      return [{ id: 'new-plugin', label: 'New plugin', icon: <Puzzle size={14} />, onSelect: () => onCreatePlugin(parent) }];
    };
  }, [onCreatePlugin, isGroupingFolder, kbDirName]);
  return <RootFolderTree dir={PLUGINS_DIR} testId="plugins-tree" menuItems={menuItems} />;
}

/**
 * A tree entry's path relative to the REPOSITORY (`Plugins/Teams`), from its
 * workspace-relative one (`<kbDir>/Plugins/Teams`); null when it does not
 * sit under the knowledge base at all.
 */
function repoRelative(workspacePath: string, kbDirName: string | null): string | null {
  if (kbDirName === null) return null;
  const prefix = `${kbDirName}/`;
  return workspacePath.startsWith(prefix) ? workspacePath.slice(prefix.length) : null;
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
