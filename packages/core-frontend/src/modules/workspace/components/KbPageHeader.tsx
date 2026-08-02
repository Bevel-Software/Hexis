import { useCallback, useRef, useState } from 'react';
import {
  ChevronDown,
  Clock4,
  Code2,
  Copy,
  FolderOpen,
  GitCompare,
  History,
  Info,
  Link2,
  Pencil,
  Users,
} from 'lucide-react';
import { cn } from '../../../lib/utils';
import { Badge, Button, IconButton, MenuItem, MenuPanel } from '../../../shared/components';
import { useDismissableMenu } from '../hooks/useDismissableMenu';

/**
 * The document's title, and the page's actions beside it.
 *
 * Replaces the 40px chrome strip, which named the file at 14px in the corner
 * of a toolbar and put its actions in the opposite corner. A document names
 * itself; chrome does not.
 *
 * Weight follows stakes, not frequency (proto:3781-3783). Share is the ONE
 * bounded button because it is the one action here with a consequence for
 * other people. Copy and Edit are icons — frequent, private, instantly
 * reversible. Everything monthly is behind `⋯`.
 */

/** Extensions we strip from the `<h1>`. Anything else stays verbatim. */
const KNOWN_EXTENSIONS =
  /\.(md|markdown|txt|csv|tsv|json|yaml|yml|html|htm|pdf|docx|xlsx|tool|png|jpe?g|gif|webp|svg)$/i;

function titleOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  return base.replace(KNOWN_EXTENSIONS, '');
}

export interface KbPageHeaderProps {
  /** Workspace-relative. */
  path: string;
  /**
   * `boolean | null` — NOT boolean. `useFileAccess` returns null while the
   * lookup is in flight, null when there is no path / kbDirName / workspaceId,
   * and null through the branch-bootstrap window; on error it deliberately
   * falls back to `true`. Only a hard `false` may hide Edit — treating null as
   * false flickers the button out on every file open.
   */
  canWrite: boolean | null;
  editMode: boolean;
  /** "Loading…" while the lock is acquired. */
  entering: boolean;
  /** Disables Edit and explains why via `title`. */
  lockedBy: string | null;
  railOpen: boolean;
  historyAvailable: boolean;
  /** → "Unsaved" badge. */
  isDirty: boolean;
  /** → "Agent update waiting" badge. */
  waitingOnAgentUpdate: boolean;
  /**
   * → "Reviewing agent update" badge, AND no Edit. Not decoration: this GATES
   * the Edit button, and `FileViewer.test.tsx` asserts the badge and the
   * button's absence in the same case.
   */
  isReviewingPending: boolean;
  activeTab: 'content' | 'history' | 'compare';
  onEdit(): void;
  onDone(): void;
  onToggleRail(): void;
  onOpenHistory(): void;
  onOpenCompare(): void;
  onShare(target: 'file' | 'folder'): void;
  /** The page as Markdown. Absent for a file that has no markdown to copy. */
  onCopyPage?: () => Promise<boolean>;
  /** The canonical URL, via `useCanonicalFileUrl`. */
  onCopyLink(): Promise<boolean>;
  onCopyPath(): Promise<boolean>;
  onViewRaw(): void;
}

/**
 * How a copy reports itself.
 *
 * Option (a) from the plan: local, on the control that was clicked, reusing
 * the pattern the deleted chrome strip already used. Knowledge has no toast
 * provider — `LibraryToastProvider` is mounted in exactly one place, inside
 * the Library's routes — and promoting it to the shell would drag two files
 * this plan does not otherwise touch into scope for a 1.5-second message.
 *
 * `null` is idle, `'ok'` and `'fail'` are the two answers. A copy that fails
 * MUST say so: `navigator.clipboard` rejects outright on a non-secure origin,
 * and a silent no-op is the worst possible answer to "copy this".
 */
type CopyState = null | 'ok' | 'fail';

export function KbPageHeader({
  path,
  canWrite,
  editMode,
  entering,
  lockedBy,
  railOpen,
  historyAvailable,
  isDirty,
  waitingOnAgentUpdate,
  isReviewingPending,
  activeTab,
  onEdit,
  onDone,
  onToggleRail,
  onOpenHistory,
  onOpenCompare,
  onShare,
  onCopyPage,
  onCopyLink,
  onCopyPath,
  onViewRaw,
}: KbPageHeaderProps) {
  const [shareOpen, setShareOpen] = useState(false);
  const [dotsOpen, setDotsOpen] = useState(false);
  const [copied, setCopied] = useState<Record<string, CopyState>>({});
  const shareTriggerRef = useRef<HTMLButtonElement>(null);
  const dotsTriggerRef = useRef<HTMLButtonElement>(null);

  const closeShare = useCallback(() => setShareOpen(false), []);
  const closeDots = useCallback(() => setDotsOpen(false), []);
  const shareRef = useDismissableMenu<HTMLDivElement>({
    open: shareOpen,
    onClose: closeShare,
    returnFocusTo: shareTriggerRef,
  });
  const dotsRef = useDismissableMenu<HTMLDivElement>({
    open: dotsOpen,
    onClose: closeDots,
    returnFocusTo: dotsTriggerRef,
  });

  const report = useCallback(async (key: string, run: () => Promise<boolean>) => {
    const ok = await run();
    setCopied((prev) => ({ ...prev, [key]: ok ? 'ok' : 'fail' }));
    window.setTimeout(() => setCopied((prev) => ({ ...prev, [key]: null })), 1800);
  }, []);

  const copyLabel = (key: string, idle: string) =>
    copied[key] === 'ok' ? 'Copied' : copied[key] === 'fail' ? "Couldn't copy" : idle;

  // Preserved verbatim from the chrome strip this replaces
  // (`FileViewer.tsx:688`). Dropping `isReviewingPending` breaks the test that
  // asserts the review badge and the button's absence together.
  const showEdit = canWrite !== false && !isReviewingPending && activeTab === 'content';

  return (
    <div className="mb-2 flex flex-wrap items-center gap-3">
      <h1 className="min-w-0 text-display font-semibold text-ink">{titleOf(path)}</h1>

      {/* The three chips the deleted strip used to carry. */}
      {isDirty && <Badge tone="wait">Unsaved</Badge>}
      {waitingOnAgentUpdate && (
        <Badge tone="wait">
          <Clock4 size={12} />
          Agent update waiting
        </Badge>
      )}
      {isReviewingPending && <Badge tone="ok">Reviewing agent update</Badge>}

      <div className="ml-auto flex flex-none items-center gap-1.5">
        {/* Share: bounded, and split. The chevron exists here and NOT on the
            Library's group Share because a FILE has two share scopes — itself
            and the folder it inherits from — and a group has one. */}
        <div className="relative inline-flex items-stretch rounded-md border border-line-strong">
          <Button
            variant="quiet"
            size="sm"
            leadingIcon={<Users size={13} />}
            className="rounded-r-none rounded-l-md border-0"
            onClick={() => onShare('file')}
          >
            Share
          </Button>
          <button
            ref={shareTriggerRef}
            type="button"
            aria-haspopup="menu"
            aria-expanded={shareOpen}
            aria-label="More sharing options"
            className={cn(
              'flex w-6 items-center justify-center rounded-r-md border-l border-line',
              'text-ink-faint transition-colors hover:bg-hover hover:text-ink',
              shareOpen && 'bg-hover text-ink',
            )}
            onClick={() => setShareOpen((v) => !v)}
          >
            <ChevronDown size={12} />
          </button>
          {shareOpen && (
            <div ref={shareRef} className="absolute right-0 top-[calc(100%+5px)] z-40">
              <MenuPanel role="menu" aria-label="Sharing options" className="min-w-[212px]">
                <MenuItem role="menuitem" onClick={() => { closeShare(); onShare('file'); }}>
                  <span className="flex items-center gap-2.5"><Users size={14} />Manage access…</span>
                </MenuItem>
                <MenuItem
                  role="menuitem"
                  onClick={() => { closeShare(); void report('link', onCopyLink); }}
                >
                  <span className="flex items-center gap-2.5">
                    <Link2 size={14} />
                    {copyLabel('link', 'Copy link to this page')}
                  </span>
                </MenuItem>
                <MenuItem role="menuitem" onClick={() => { closeShare(); onShare('folder'); }}>
                  <span className="flex items-center gap-2.5">
                    <FolderOpen size={14} />Share the whole folder
                  </span>
                </MenuItem>
              </MenuPanel>
            </div>
          )}
        </div>

        {onCopyPage && (
          <IconButton
            aria-label={copyLabel('page', 'Copy page as Markdown')}
            title={copyLabel('page', 'Copy page as Markdown')}
            active={copied.page === 'ok'}
            tone={copied.page === 'fail' ? 'danger' : 'default'}
            onClick={() => void report('page', onCopyPage)}
          >
            <Copy size={14} />
          </IconButton>
        )}

        {showEdit &&
          (editMode ? (
            <IconButton
              aria-label="Done"
              title="Save changes and return to view mode"
              active
              onClick={onDone}
            >
              <Pencil size={14} />
            </IconButton>
          ) : (
            <IconButton
              aria-label={entering ? 'Loading…' : 'Edit'}
              disabled={!!lockedBy || entering}
              title={
                lockedBy
                  ? `Locked by ${lockedBy}`
                  : entering
                    ? 'Acquiring lock and fetching latest content…'
                    : 'Click to edit this file'
              }
              onClick={onEdit}
            >
              <Pencil size={14} />
            </IconButton>
          ))}

        <div className="relative">
          <IconButton
            ref={dotsTriggerRef}
            aria-label="More actions"
            aria-haspopup="menu"
            aria-expanded={dotsOpen}
            active={dotsOpen}
            onClick={() => setDotsOpen((v) => !v)}
          >
            <span aria-hidden className="text-strong leading-none">⋯</span>
          </IconButton>
          {dotsOpen && (
            <div ref={dotsRef} className="absolute right-0 top-[calc(100%+5px)] z-40">
              <MenuPanel role="menu" aria-label="More actions" className="min-w-[212px]">
                <MenuItem role="menuitem" onClick={() => { closeDots(); onToggleRail(); }}>
                  <span className="flex items-center gap-2.5">
                    <Info size={14} />
                    {railOpen ? 'Hide file details' : 'File details'}
                  </span>
                </MenuItem>
                {/* Both history entries vanish when git is not ready — and the
                    menu must not be left with an empty separator behind them. */}
                {historyAvailable && (
                  <>
                    <MenuItem role="menuitem" onClick={() => { closeDots(); onOpenHistory(); }}>
                      <span className="flex items-center gap-2.5"><History size={14} />Version history</span>
                    </MenuItem>
                    <MenuItem role="menuitem" onClick={() => { closeDots(); onOpenCompare(); }}>
                      <span className="flex items-center gap-2.5">
                        <GitCompare size={14} />Compare versions
                      </span>
                    </MenuItem>
                  </>
                )}
                <MenuItem role="menuitem" onClick={() => { closeDots(); onViewRaw(); }}>
                  <span className="flex items-center gap-2.5"><Code2 size={14} />View raw file</span>
                </MenuItem>
                <MenuItem
                  role="menuitem"
                  onClick={() => { closeDots(); void report('path', onCopyPath); }}
                >
                  <span className="flex items-center gap-2.5">
                    <Link2 size={14} />
                    {copyLabel('path', 'Copy path')}
                  </span>
                </MenuItem>
              </MenuPanel>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
