import { useCallback, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  Clock4,
  Copy,
  History,
  Link2,
  Pencil,
  Users,
  X,
} from 'lucide-react';
import { cn } from '../../../lib/utils';
import { Badge, Button, IconButton, MenuItem, MenuPanel } from '../../../shared/components';
import { useDismissableMenu } from '../../../shared/components';

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
  /\.(md|markdown|txt|csv|tsv|json|yaml|yml|html|htm|pdf|docx|xlsx|pptx|doc|ppt|xls|odt|odp|ods|tool|png|jpe?g|gif|webp|svg)$/i;

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
  /**
   * The reader-without-write-permission editor is open. Mutually exclusive
   * with `editMode` in practice: propose is only offered where Edit is hidden
   * (`canWrite === false`), and Edit only where it isn't.
   */
  proposeMode: boolean;
  /** The proposal is on the wire — "Send" disables and says so. */
  proposalBusy: boolean;
  onPropose(): void;
  onSendProposal(): void;
  onDiscardProposal(): void;
  /**
   * The write action (Edit / Propose changes / Done) lives in the file pane
   * card's bar instead of here. True for prose documents — the ones that GET
   * a pane card; full-bleed renderers keep the header's controls, because
   * they have no bar to carry them.
   */
  writeActionInPane?: boolean;
  /** Disables Edit and explains why via `title`. */
  lockedBy: string | null;
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
  onOpenHistory(): void;
  /**
   * Opens Manage access on THIS FILE. There is no folder target: sharing a
   * whole folder from a file's page was one click away from handing over
   * everything inside it, so it moved to the folder's own row in the tree.
   */
  onShare(): void;
  /** The page as Markdown. Absent for a file that has no markdown to copy. */
  onCopyPage?: () => Promise<boolean>;
  /** The canonical URL, via `useCanonicalFileUrl`. The only copy-a-reference
   *  action on this page — see the note where the `⋯` menu is built. */
  onCopyLink(): Promise<boolean>;
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

/** How long a copy confirmation stays on the control that was clicked. */
const COPY_FEEDBACK_MS = 1800;

export function KbPageHeader({
  path,
  canWrite,
  editMode,
  entering,
  proposeMode,
  proposalBusy,
  onPropose,
  onSendProposal,
  onDiscardProposal,
  writeActionInPane = false,
  lockedBy,
  historyAvailable,
  isDirty,
  waitingOnAgentUpdate,
  isReviewingPending,
  activeTab,
  onEdit,
  onDone,
  onOpenHistory,
  onShare,
  onCopyPage,
  onCopyLink,
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
    window.setTimeout(() => setCopied((prev) => ({ ...prev, [key]: null })), COPY_FEEDBACK_MS);
  }, []);

  const copyLabel = (key: string, idle: string) =>
    copied[key] === 'ok' ? 'Copied' : copied[key] === 'fail' ? "Couldn't copy" : idle;

  // Preserved verbatim from the chrome strip this replaces
  // (`FileViewer.tsx:688`). Dropping `isReviewingPending` breaks the test that
  // asserts the review badge and the button's absence together.
  // `writeActionInPane` retires the whole cluster: the pane card's bar owns
  // Edit/Propose for documents, and two controls for one action is a trap.
  const showEdit =
    !writeActionInPane && canWrite !== false && !isReviewingPending && activeTab === 'content';
  // The counterpart for readers: exactly where Edit is REFUSED (a hard
  // `canWrite === false`, never the in-flight null), the page offers the
  // review path instead. Same gates otherwise — same tab, no agent review.
  const showPropose =
    !writeActionInPane && canWrite === false && !isReviewingPending && activeTab === 'content';

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
        {/* Share: bounded, and split. Bounded because it is the one action on
            this page with a consequence for other people. The chevron carries
            the quieter sibling errand — copying a link to the page — so that
            the button itself stays one thing: "let someone in". */}
        <div className="relative inline-flex items-stretch rounded-md border border-line-strong">
          <Button
            variant="quiet"
            size="sm"
            leadingIcon={<Users size={13} />}
            className="rounded-r-none rounded-l-md border-0"
            onClick={onShare}
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
                <MenuItem role="menuitem" onClick={() => { closeShare(); onShare(); }}>
                  <span className="flex items-center gap-2.5"><Users size={14} />Manage access…</span>
                </MenuItem>
                {/* The confirmation for THIS copy lives on the row itself, so
                    closing the panel first unmounts the only thing that says
                    whether it worked — and a copy that silently fails is the
                    worst possible answer. Copy, let the row say so, and take
                    the menu away once it has been said. */}
                <MenuItem
                  role="menuitem"
                  onClick={async () => {
                    await report('link', onCopyLink);
                    window.setTimeout(closeShare, COPY_FEEDBACK_MS);
                  }}
                >
                  <span className="flex items-center gap-2.5">
                    <Link2 size={14} />
                    {copyLabel('link', 'Copy link to this page')}
                  </span>
                </MenuItem>
                {/* "Share the whole folder" lived here and was cut. Sharing a
                    folder from a file's page is a much bigger act than the row
                    it sat in suggested — one click, and everything inside the
                    folder changes hands. The folder's own row in the tree is
                    where that belongs, behind its right-click → Manage access,
                    which is also where you can see what you are about to
                    affect. */}
              </MenuPanel>
            </div>
          )}
        </div>

        {/* The icon CHANGES on success — it does not merely tint.
            A background shift is the same signal this button already gives on
            hover, so a copy that only tinted read as "nothing happened" and got
            clicked again. A tick is unambiguous, and it is the one confirmation
            people already expect from a copy button. `aria-live` carries the
            same news to a screen reader, which a swapped icon would not. */}
        {onCopyPage && (
          <IconButton
            aria-label={copyLabel('page', 'Copy page as Markdown')}
            title={copyLabel('page', 'Copy page as Markdown')}
            active={copied.page === 'ok'}
            tone={copied.page === 'fail' ? 'danger' : 'default'}
            onClick={() => void report('page', onCopyPage)}
          >
            {copied.page === 'ok' ? (
              <Check size={14} className="text-ok" />
            ) : copied.page === 'fail' ? (
              <X size={14} />
            ) : (
              <Copy size={14} />
            )}
          </IconButton>
        )}
        {/* Announced once, then cleared with the icon. Outside the button so
            swapping the glyph does not re-announce the label as well. */}
        <span className="sr-only" role="status" aria-live="polite">
          {copied.page === 'ok'
            ? 'Page copied as Markdown'
            : copied.page === 'fail'
              ? "Couldn't copy the page"
              : ''}
        </span>

        {/* The reader's write path. Labelled buttons, not icons: proposing is
            neither frequent nor instantly reversible — it opens a change
            request other people will read — so it carries words, the same
            weight rule that keeps Share labelled. */}
        {showPropose &&
          (proposeMode ? (
            <>
              <Button variant="quiet" size="sm" onClick={onDiscardProposal} disabled={proposalBusy}>
                Discard
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={onSendProposal}
                disabled={proposalBusy}
                title="Send your proposed change for approval"
              >
                {proposalBusy ? 'Sending…' : 'Send proposal'}
              </Button>
            </>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={onPropose}
              leadingIcon={<Pencil size={13} />}
              title="You can't edit this file directly. Propose a change for its owners to approve"
            >
              Propose changes
            </Button>
          ))}

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

        {/* Version history is the whole menu now, so the trigger goes where it
            goes: git not ready means there is nothing behind ⋯, and an overflow
            that opens onto an empty panel is worse than no overflow at all. */}
        {historyAvailable && (
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
                  <MenuItem role="menuitem" onClick={() => { closeDots(); onOpenHistory(); }}>
                    <span className="flex items-center gap-2.5"><History size={14} />Version history</span>
                  </MenuItem>
                  {/* "Copy path" is NOT here. Copying a reference to this page is
                      one errand, and Share already owns it ("Copy link to this
                      page"); two menus offering near-identical copies is how a
                      user ends up pasting the wrong one. The tree's right-click
                      menu keeps its own Copy path, because there it reaches rows
                      that are not open — a different job. */}
                </MenuPanel>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
