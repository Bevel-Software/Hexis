import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Check, X } from 'lucide-react';
import {
  KNOWLEDGE_BASE_DIR,
  currentKbLayout,
  isPersonalPluginDir,
  type FileTreeEntry,
} from '@bevel-software/platform-shared';
import { Button, IconButton } from '../../../shared/components';
import { cn } from '../../../lib/utils';
import { useAdmin } from '../../admin/state/admin.context';
import { listAccounts } from '../../auth/services/account.api';
import { listPlugins, type PluginSummary } from '../../library/services/plugins.api';
import { LIBRARY_ROOT, isLibraryLocation } from '../../library/routes/library-paths';
import { useMediaQuery } from '../../layout/hooks/useMediaQuery';
import { SETUP_COLUMN_HIDDEN_QUERY } from '../../layout/breakpoints';
import { useWorkspace } from '../../workspace/state/workspace.context';
import { useMergedWorkspaceTree } from '../../workspace/hooks/useMergedWorkspaceTree';
import { useFileNav } from '../../workspace/routing/kb-routes';
import { useOnboarding, useSetupChecklist } from '../state/onboarding';
import { useInviteDialog } from '../state/invite-dialog.context';
import { WELCOME_PATH } from '../paths';

/** The starter page every new knowledge base is seeded with (`kb-template/`). */
const GUIDE_FILE = 'How to get started.md';

interface SetupItem {
  id: string;
  title: string;
  done: boolean;
  hint?: string;
  action?: { label: string; onClick(): void; primary?: boolean };
}

/**
 * Whether the Knowledge folder holds anything a person put there: any file
 * other than the starter guide, the repository's dot-files and the folder
 * access rules. A dropped PDF counts — "write your first page" is about the
 * knowledge base having the team's content in it, not about Markdown.
 */
function hasOwnContent(entry: FileTreeEntry | null | undefined, guidePath: string): boolean {
  if (!entry) return false;
  for (const child of entry.children ?? []) {
    if (child.name.startsWith('.')) continue;
    if (child.type === 'directory') {
      if (hasOwnContent(child, guidePath)) return true;
      continue;
    }
    if (child.relativePath === guidePath || child.name.toLowerCase() === 'access.md') continue;
    return true;
  }
  return false;
}

function findEntry(tree: FileTreeEntry | null, path: string): FileTreeEntry | null {
  if (!tree) return null;
  if (tree.relativePath === path) return tree;
  for (const child of tree.children ?? []) {
    if (path === child.relativePath || path.startsWith(`${child.relativePath}/`)) {
      const found = findEntry(child, path);
      if (found) return found;
    }
  }
  return null;
}

/** A plugin for a team, not somebody's personal shelf. */
function isTeamPlugin(plugin: PluginSummary): boolean {
  const layout = currentKbLayout();
  return plugin.folders.some((folder) => !isPersonalPluginDir(folder, layout));
}

/**
 * "Is there a team plugin yet?", asked of `GET /api/plugins` — the same
 * catalog the Library reads, fetched here on its own because the Library's
 * provider only exists under its routes and this column sits beside both
 * apps. Asked again as the person moves around Skills & Tools (that is where
 * a plugin gets made), and never again once the answer is yes.
 */
function useTeamPluginExists(enabled: boolean, refreshKey: string): { found: boolean; settled: boolean } {
  const [found, setFound] = useState(false);
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (!enabled || found) return;
    let cancelled = false;
    listPlugins()
      .then((plugins) => {
        if (!cancelled && plugins.some(isTeamPlugin)) setFound(true);
      })
      .catch(() => {
        /* unanswered is "not yet": the step stays open, nothing breaks */
      })
      .finally(() => {
        if (!cancelled) setSettled(true);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, found, refreshKey]);
  return { found, settled };
}

/**
 * "Is anybody else here yet?" — more than one account a person signs in
 * with. The platform's own machine accounts (`isSystem`) are not a team.
 * Re-asked whenever the invite dialog created somebody.
 */
function useHasTeammate(enabled: boolean, revision: number): { found: boolean; settled: boolean } {
  const [found, setFound] = useState(false);
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (!enabled || found) return;
    let cancelled = false;
    listAccounts()
      .then((accounts) => {
        if (!cancelled && accounts.filter((a) => !a.isSystem).length > 1) setFound(true);
      })
      .catch(() => {
        /* as above: unknown leaves the step open */
      })
      .finally(() => {
        if (!cancelled) setSettled(true);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, found, revision]);
  return { found, settled };
}

/**
 * The "Get set up" column: a short checklist beside both apps that ticks
 * itself off from what the app already knows, rather than from clicks on it.
 *
 * Every tick is DERIVED — the server's onboarding flag, the file tree, the
 * plugin catalog, the account list — so doing a step anywhere in the app
 * counts, and the column never claims something the workspace does not show.
 * Only "read the guide" has no server fact behind it; that one, and the
 * dismissal, are per-browser notes (see `useSetupChecklist`).
 *
 * It gets out of the way on its own terms: on the welcome page (which is the
 * same instructions, full-size), below the width where a 288px column still
 * leaves a readable page, once every step is done, and for good once closed.
 * The admin-only steps (storage, plugin, invite) are hidden from members,
 * whose checklist is about using the workspace, not setting it up.
 */
export function GetStartedColumn() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const tooNarrow = useMediaQuery(SETUP_COLUMN_HIDDEN_QUERY);
  const onboarding = useOnboarding();
  const checklist = useSetupChecklist();
  const { isAdmin, isAdminLoading = false } = useAdmin();
  const { kbDirName, openFilePath } = useWorkspace();
  const { tree } = useMergedWorkspaceTree();
  const { openWorkspacePath } = useFileNav();
  const invite = useInviteDialog();

  const onWelcome = pathname === WELCOME_PATH;
  const askServer = isAdmin && !checklist.dismissed;
  const plugin = useTeamPluginExists(askServer, isLibraryLocation(pathname) ? pathname : '');
  const teammate = useHasTeammate(askServer, invite?.invitedRevision ?? 0);

  const knowledgeRoot = kbDirName ? `${kbDirName}/${KNOWLEDGE_BASE_DIR}` : null;
  const guidePath = knowledgeRoot ? `${knowledgeRoot}/${GUIDE_FILE}` : null;
  const guideExists = guidePath !== null && findEntry(tree, guidePath) !== null;

  // Opening the guide by any route counts — the tree, a link, this column.
  const { readGuide, markGuideRead } = checklist;
  useEffect(() => {
    if (guidePath && openFilePath === guidePath && !readGuide) markGuideRead();
  }, [guidePath, openFilePath, readGuide, markGuideRead]);

  const items: SetupItem[] = [
    { id: 'workspace', title: 'Create your workspace', done: true },
  ];
  if (isAdmin) {
    // Reaching this column at all means the setup gate let you through, and
    // the gate's last question is where the knowledge lives.
    items.push({ id: 'storage', title: 'Choose where your knowledge lives', done: true });
  }
  items.push({
    id: 'agent',
    title: 'Connect your agent',
    done: !onboarding.showPill,
    hint: 'So it can read and write this knowledge base.',
    action: { label: 'Connect', onClick: () => navigate(WELCOME_PATH), primary: true },
  });
  if (guideExists && guidePath) {
    items.push({
      id: 'guide',
      title: 'Read “How to get started”',
      done: readGuide,
      hint: 'Two minutes on how pages, plugins and change requests fit together.',
      action: {
        label: 'Open it',
        onClick: () => {
          markGuideRead();
          openWorkspacePath(guidePath);
        },
      },
    });
  }
  items.push({
    id: 'page',
    title: 'Write your first page',
    done: knowledgeRoot !== null && guidePath !== null && hasOwnContent(findEntry(tree, knowledgeRoot), guidePath),
    hint: 'Use New file on the Knowledge folder, or drop files into the tree.',
  });
  if (isAdmin) {
    items.push({
      id: 'plugin',
      title: 'Create a plugin for your team',
      done: plugin.found,
      hint: 'A shared place for your team’s skills and tools.',
      action: { label: 'Open Skills & Tools', onClick: () => navigate(LIBRARY_ROOT) },
    });
    items.push({
      id: 'invite',
      title: 'Invite your team',
      done: teammate.found,
      hint: 'They sign in with their work account.',
      action: invite ? { label: 'Invite people', onClick: invite.open } : undefined,
    });
  }

  const doneCount = items.filter((i) => i.done).length;
  // Until the admin verdict and its two questions are answered, the list is
  // not known — and showing a half-ticked list for a moment to an admin who
  // has done everything would be a column that flashes on every load.
  const settled = !isAdminLoading && (!isAdmin || (plugin.settled && teammate.settled));
  if (onWelcome || tooNarrow || checklist.dismissed || !settled || doneCount === items.length) {
    return null;
  }

  return (
    <aside
      aria-label="Get set up"
      className="w-72 flex-none overflow-y-auto border-l border-line bg-canvas px-4.5 py-4"
    >
      <div className="flex h-8 items-center gap-2">
        <h2 className="text-strong font-semibold text-ink">Get set up</h2>
        <span className="ml-auto text-meta text-ink-faint tabular-nums">
          {doneCount} of {items.length}
        </span>
        <IconButton size={24} aria-label="Dismiss Get set up" title="Dismiss" onClick={checklist.dismiss}>
          <X size={14} aria-hidden />
        </IconButton>
      </div>
      <div
        role="progressbar"
        aria-label="Setup progress"
        aria-valuemin={0}
        aria-valuemax={items.length}
        aria-valuenow={doneCount}
        className="mt-1.5 mb-1 h-1 overflow-hidden rounded-full bg-line"
      >
        <div
          className="h-full bg-ok transition-[width] duration-300 motion-reduce:transition-none"
          style={{ width: `${(doneCount / items.length) * 100}%` }}
        />
      </div>
      <ul>
        {items.map((item) => (
          <li
            key={item.id}
            className="grid grid-cols-[18px_minmax(0,1fr)] gap-2.5 border-t border-line py-2.5 first:border-t-0"
          >
            <span
              aria-hidden
              className={cn(
                'mt-0.5 flex size-4 items-center justify-center rounded-full border-[1.5px]',
                item.done ? 'border-ok bg-ok text-white' : 'border-line-strong',
              )}
            >
              {item.done && <Check size={10} strokeWidth={3} />}
            </span>
            <div className="min-w-0">
              <div
                className={cn(
                  'text-ui',
                  item.done ? 'font-medium text-ink-faint line-through' : 'font-semibold text-ink',
                )}
              >
                {item.title}
                {item.done && <span className="sr-only"> (done)</span>}
              </div>
              {!item.done && (item.hint || item.action) && (
                <div className="mt-1 grid justify-items-start gap-2 text-detail text-ink-muted">
                  {item.hint && <span>{item.hint}</span>}
                  {item.action && (
                    <Button
                      size="sm"
                      variant={item.action.primary ? 'primary' : 'outline'}
                      onClick={item.action.onClick}
                    >
                      {item.action.label}
                    </Button>
                  )}
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
    </aside>
  );
}
