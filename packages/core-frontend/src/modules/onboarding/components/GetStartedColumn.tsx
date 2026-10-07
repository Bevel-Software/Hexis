import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Check, Copy, X } from 'lucide-react';
import {
  KNOWLEDGE_BASE_DIR,
  currentKbLayout,
  isPersonalPluginDir,
  type FileTreeEntry,
} from '@bevel-software/platform-shared';
import { Button, IconButton, buttonClasses } from '../../../shared/components';
import { cn } from '../../../lib/utils';
import { copyToClipboard } from '../../../lib/clipboard';
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
import { useAgentConnection } from '../state/agent-connection';
import { FIRST_PAGE_PROMPT, chatGptPromptUrl, claudePromptUrl, firstPageRoute } from '../first-page-prompt';
import { useInviteDialog } from '../state/invite-dialog.context';
import { WELCOME_PATH } from '../paths';

/** The starter page every new knowledge base is seeded with (`kb-template/`). */
const GUIDE_FILE = 'How to get started.md';

/**
 * What "New page" writes: a title, so the page is a page from its first save,
 * and a blank line under it for the cursor to land on.
 */
const NEW_PAGE_CONTENT = '# Untitled\n\n';

interface SetupAction {
  label: string;
  onClick(): void;
  primary?: boolean;
  disabled?: boolean;
}

interface SetupItem {
  id: string;
  title: string;
  done: boolean;
  hint?: string;
  action?: SetupAction;
  /** Anything the step offers beyond one button, under it. */
  extra?: ReactNode;
  /** Why the step's action just failed, said on the step itself. */
  error?: string | null;
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

/**
 * `Untitled.md` in `folder`, or the first `Untitled N.md` the tree does not
 * already hold — a second click makes a second page, never overwrites the
 * first one.
 */
function untitledPagePath(tree: FileTreeEntry | null, folder: string): string {
  let path = `${folder}/Untitled.md`;
  for (let n = 2; findEntry(tree, path); n++) path = `${folder}/Untitled ${n}.md`;
  return path;
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
  const { kbDirName, openFilePath, createFile } = useWorkspace();
  const { tree } = useMergedWorkspaceTree();
  const { openWorkspacePath } = useFileNav();
  const invite = useInviteDialog();

  /**
   * Whether the person's agent has reached the platform — asked ONCE here
   * (the welcome page is the one that polls), so someone who connected
   * without ever opening that page still gets the tick. Connecting is what
   * the onboarding asked for, so it concludes it too: the pill goes. Once
   * per mount, for the reason the welcome page gives.
   */
  const agent = useAgentConnection({ enabled: !checklist.dismissed });
  const concluded = useRef(false);
  const { showPill, markDone } = onboarding;
  useEffect(() => {
    if (!agent.connected || !showPill || concluded.current) return;
    concluded.current = true;
    markDone();
  }, [agent.connected, showPill, markDone]);

  const onWelcome = pathname === WELCOME_PATH;
  const askServer = isAdmin && !checklist.dismissed;
  const plugin = useTeamPluginExists(askServer, isLibraryLocation(pathname) ? pathname : '');
  const teammate = useHasTeammate(askServer, invite?.invitedRevision ?? 0);

  const knowledgeRoot = kbDirName ? `${kbDirName}/${KNOWLEDGE_BASE_DIR}` : null;
  const guidePath = knowledgeRoot ? `${knowledgeRoot}/${GUIDE_FILE}` : null;
  const guideExists = guidePath !== null && findEntry(tree, guidePath) !== null;

  /**
   * "New page": create a Markdown page in the Knowledge folder and open it
   * already in the editor. The failure is kept here and shown on the step
   * because nothing else would say it — toasts only speak inside the
   * Library, and a refusal (a protected branch's write gate) is exactly what
   * the person needs to read.
   */
  const [newPage, setNewPage] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const createFirstPage = async () => {
    if (!knowledgeRoot || newPage.busy) return;
    const path = untitledPagePath(tree, knowledgeRoot);
    setNewPage({ busy: true, error: null });
    try {
      await createFile(path, NEW_PAGE_CONTENT);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setNewPage({ busy: false, error: `Couldn’t create the page: ${msg}` });
      return;
    }
    setNewPage({ busy: false, error: null });
    // The step ticks itself from the refreshed tree (any page but the guide
    // counts); `edit` opens the page with the cursor in it.
    openWorkspacePath(path, { edit: true });
  };

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
    done: !showPill || agent.connected,
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
  const newPageAction: SetupAction | undefined = knowledgeRoot
    ? {
        label: newPage.busy ? 'Creating…' : 'New page',
        onClick: () => void createFirstPage(),
        disabled: newPage.busy,
      }
    : undefined;
  /**
   * With an agent connected, the quickest first page is one it writes: a new
   * chat with the request already typed (or the request to paste, for an
   * agent no link can open), and the tick arrives by itself when the page
   * lands in the tree. Before then that button would open a chat
   * that cannot reach this knowledge base, so the step says what connecting
   * would add instead.
   */
  items.push({
    id: 'page',
    title: 'Write your first page',
    done: knowledgeRoot !== null && guidePath !== null && hasOwnContent(findEntry(tree, knowledgeRoot), guidePath),
    ...(agent.connected
      ? {
          hint: 'Have your agent write it, or start one here.',
          extra: <FirstPagePromptActions client={agent.client} newPage={newPageAction} />,
        }
      : {
          hint: 'Start one here, or drop files into the file tree.',
          action: newPageAction,
          extra: <span className="text-meta text-ink-faint">Connect your agent and it can write pages for you.</span>,
        }),
    error: newPage.error,
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
              {!item.done && (item.hint || item.action || item.extra) && (
                <div className="mt-1 grid justify-items-start gap-2 text-detail text-ink-muted">
                  {item.hint && <span>{item.hint}</span>}
                  {item.action && (
                    <Button
                      size="sm"
                      variant={item.action.primary ? 'primary' : 'outline'}
                      onClick={item.action.onClick}
                      disabled={item.action.disabled}
                    >
                      {item.action.label}
                    </Button>
                  )}
                  {item.extra}
                  {item.error && (
                    <span role="alert" className="text-danger">
                      {item.error}
                    </span>
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

/** The prompt opened in a new chat, as a real link (see `FirstPagePromptActions`). */
function PromptLink({ href, primary, children }: { href: string; primary?: boolean; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={
        primary
          ? buttonClasses({ variant: 'primary', size: 'sm' })
          : 'text-ink-muted transition-colors hover:text-ink'
      }
    >
      {children}
    </a>
  );
}

/**
 * The agent's way to the first-page prompt, led by the one that suits the
 * agent that connected (`firstPageRoute`), with the others quiet beneath it.
 *
 * Claude's and ChatGPT's connectors get "Ask … to write it", a new chat with
 * the prompt typed. Every other agent — Claude Code, Cursor, anything on the
 * local server, an unknown name — has no link that would reach it, so Copy
 * prompt leads there and says where to paste; the two web links stay as
 * quiet extras for someone who uses those too.
 *
 * Real links rather than buttons that call `window.open`: a new tab is what
 * they are, so they should say so to the browser — middle-click, "copy link",
 * and the status-bar preview of where they go all work.
 *
 * Copying answers on the button itself and in a live region; there is no
 * toast to fall back on out here (toasts speak inside the Library only).
 */
function FirstPagePromptActions({ client, newPage }: { client?: string; newPage?: SetupAction }) {
  const [copied, setCopied] = useState<'idle' | 'ok' | 'fail'>('idle');
  const resetTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(resetTimer.current), []);
  const { primary, agentName } = firstPageRoute(client);

  async function copy() {
    const ok = await copyToClipboard(FIRST_PAGE_PROMPT);
    window.clearTimeout(resetTimer.current);
    setCopied(ok ? 'ok' : 'fail');
    resetTimer.current = window.setTimeout(() => setCopied('idle'), 1500);
  }

  const copyButton = (lead: boolean) => (
    <Button
      size={lead ? 'sm' : 'tiny'}
      variant={lead ? 'primary' : 'quiet'}
      onClick={() => void copy()}
      leadingIcon={
        copied === 'ok' ? (
          <Check size={12} aria-hidden className={lead ? undefined : 'text-ok'} />
        ) : copied === 'fail' ? (
          <X size={12} aria-hidden className={lead ? undefined : 'text-danger'} />
        ) : (
          <Copy size={12} aria-hidden />
        )
      }
    >
      Copy prompt
    </Button>
  );
  const claudeLink = (lead: boolean) => (
    <PromptLink href={claudePromptUrl(FIRST_PAGE_PROMPT)} primary={lead}>
      {lead ? 'Ask Claude to write it' : 'Open in Claude'}
    </PromptLink>
  );
  const chatGptLink = (lead: boolean) => (
    <PromptLink href={chatGptPromptUrl(FIRST_PAGE_PROMPT)} primary={lead}>
      {lead ? 'Ask ChatGPT to write it' : 'Open in ChatGPT'}
    </PromptLink>
  );

  const lead = primary === 'claude' ? claudeLink(true) : primary === 'chatgpt' ? chatGptLink(true) : copyButton(true);
  const quiet =
    primary === 'claude'
      ? [chatGptLink(false), copyButton(false)]
      : primary === 'chatgpt'
        ? [claudeLink(false), copyButton(false)]
        : [claudeLink(false), chatGptLink(false)];

  return (
    <div className="grid justify-items-start gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        {lead}
        {newPage && (
          <Button size="sm" variant="outline" onClick={newPage.onClick} disabled={newPage.disabled}>
            {newPage.label}
          </Button>
        )}
      </div>
      {primary === 'copy' && (
        <span className="text-meta text-ink-faint">Paste it into {agentName ?? 'your agent'}.</span>
      )}
      <div className="flex items-center gap-1 text-meta">
        {quiet[0]}
        <span aria-hidden className="text-ink-faint">
          ·
        </span>
        {quiet[1]}
        <span role="status" aria-live="polite" className="sr-only">
          {copied === 'ok' ? 'Prompt copied' : copied === 'fail' ? 'Couldn’t copy the prompt' : ''}
        </span>
      </div>
    </div>
  );
}
