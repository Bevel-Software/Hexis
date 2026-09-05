import { useMemo, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { FilePlus, FolderPlus } from 'lucide-react';
import { DEFAULT_BRANCH, SKILLS_DIR } from '@bevel-software/platform-shared';
import { IconButton } from '../../../shared/components';
import { useWorkspace } from '../../workspace/state/workspace.context';
import { findKbRoot } from '../../workspace/utils/fileTree';
import { KB_ROUTE_PREFIX, kbFileUrl } from '../../workspace/routing/kb-routes';
import { useMergedWorkspaceTree } from '../../workspace/hooks/useMergedWorkspaceTree';
import {
  FileTreeNode,
  TreeChrome,
  UploadNotices,
  type FileTreeNodeControls,
  type TreeNav,
} from '../../workspace/components/FileExplorer';
import { SectionLabel } from './PluginsSidebar';

/**
 * The Skills section of the Library's nav: the shared `Skills/` root as a
 * file tree, made of the SAME rows as Knowledge's explorer — right-click menu
 * (new file, new folder, rename, delete, manage access, download), drag to
 * move, drop to upload, the caller's proposed files shown in accent. One tree
 * component in the app, holding a different root.
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
 * The root's own row is not drawn: the section label is its heading, and the
 * scopes sit directly under it, at the nav's own indent. The label carries
 * the create buttons that row would have had.
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

  // The root's row is not drawn, so its create verbs live on the label and
  // reach the node through its handle.
  const controls = useRef<FileTreeNodeControls>(null);

  if (!root) return null;

  return (
    <TreeChrome nav={nav} suggestionOnlyPaths={suggestionOnlyPaths}>
      <SectionLabel
        spaced
        actions={
          <>
            <IconButton
              size={18}
              title="New file"
              aria-label={`New file in ${SKILLS_DIR}`}
              onClick={() => controls.current?.create('file')}
            >
              <FilePlus size={13} />
            </IconButton>
            <IconButton
              size={18}
              title="New folder"
              aria-label={`New folder in ${SKILLS_DIR}`}
              onClick={() => controls.current?.create('directory')}
            >
              <FolderPlus size={13} />
            </IconButton>
          </>
        }
      >
        Skills
      </SectionLabel>
      <UploadNotices />
      <div data-testid="skills-tree">
        <FileTreeNode
          entry={root}
          depth={0}
          hideRow
          collapseChildren
          controls={controls}
        />
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

/** A malformed escape is a bad link, not a crash — fall back to the raw segment. */
function safeDecode(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
