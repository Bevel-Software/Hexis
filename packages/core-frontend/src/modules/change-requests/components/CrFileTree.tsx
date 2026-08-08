import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRightLeft,
  Check,
  ChevronRight,
  Clock,
  File,
  FileEdit,
  FilePlus2,
  FileX2,
  X,
} from 'lucide-react';
import type { FileApprovalState, PrFileStatus } from '@bevel-software/platform-shared';
import { cn } from '../../../lib/utils';

/**
 * The change request's files as a TREE — the Knowledge sidebar's visual
 * grammar (indent is the structure, caret slots, quiet rows), carrying the
 * OLD change-request view's row anatomy (bevel-platform-presplit
 * `PrFileRow`), which got this right:
 *
 *  - LEFT of the name: what HAPPENED to the file (added / removed / modified
 *    kind icon, colour-coded), never a control.
 *  - INLINE after the name: the approval STATE — green ✓ confirmed, amber
 *    clock for outdated confirmations, grey clock waiting — with the
 *    eligible approvers in the tooltip.
 *  - RIGHT, revealed on hover: the ACTION for eligible viewers — a filled
 *    green check to confirm the file, turning into an ✕ (withdraw) once
 *    YOUR confirmation is the current one.
 *
 * Right-click a revertable file for the destructive verb, armed inside its
 * own context menu. Selection (which file the diff shows) stays a plain
 * click on the name.
 */

export interface CrTreeFileState {
  /** Repo-relative path. */
  path: string;
  /** Changed by this request (scope base files list too, unchanged). */
  changed: boolean;
  /** Added by this request. */
  added: boolean;
  /** Git status when changed (drives the kind icon). */
  status?: PrFileStatus;
  approval?: FileApprovalState;
}

interface CrFileTreeProps {
  files: CrTreeFileState[];
  selected: string;
  /** The viewer — whose own current confirmation the withdraw action needs. */
  currentUserEmail: string;
  onSelect(path: string): void;
  /** Confirm `path`, or withdraw the viewer's own confirmation of it. */
  onToggleApprove(path: string, hasOwnApproval: boolean): void;
  /** Revert `path` on the source branch. Only called when approvable+changed. */
  onRevert(path: string): void;
  /** Disables the verbs while one is in flight. */
  busy: boolean;
}

interface TreeFolder {
  name: string;
  path: string;
  folders: TreeFolder[];
  files: CrTreeFileState[];
}

function buildTree(files: CrTreeFileState[]): TreeFolder {
  const root: TreeFolder = { name: '', path: '', folders: [], files: [] };
  for (const file of files) {
    const segments = file.path.split('/');
    let node = root;
    for (const segment of segments.slice(0, -1)) {
      let next = node.folders.find((f) => f.name === segment);
      if (!next) {
        next = {
          name: segment,
          path: node.path ? `${node.path}/${segment}` : segment,
          folders: [],
          files: [],
        };
        node.folders.push(next);
      }
      node = next;
    }
    node.files.push(file);
  }
  return root;
}

const indentFor = (depth: number) => 8 + depth * 13;

export function CrFileTree({
  files,
  selected,
  currentUserEmail,
  onSelect,
  onToggleApprove,
  onRevert,
  busy,
}: CrFileTreeProps) {
  const tree = useMemo(() => buildTree(files), [files]);
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<{ path: string; x: number; y: number } | null>(null);

  return (
    <div role="tree" aria-label="Files in this change request" className="py-1">
      <Level
        folder={tree}
        depth={0}
        closed={closed}
        onToggleFolder={(p) =>
          setClosed((prev) => {
            const next = new Set(prev);
            if (next.has(p)) next.delete(p);
            else next.add(p);
            return next;
          })
        }
        selected={selected}
        currentUserEmail={currentUserEmail}
        onSelect={onSelect}
        onToggleApprove={onToggleApprove}
        onContextMenu={(path, e) => {
          e.preventDefault();
          setMenu({ path, x: e.clientX, y: e.clientY });
        }}
        busy={busy}
      />
      {menu && (
        <RevertMenu
          {...menu}
          busy={busy}
          onRevert={() => {
            onRevert(menu.path);
            setMenu(null);
          }}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

function Level({
  folder,
  depth,
  closed,
  onToggleFolder,
  selected,
  currentUserEmail,
  onSelect,
  onToggleApprove,
  onContextMenu,
  busy,
}: {
  folder: TreeFolder;
  depth: number;
  closed: Set<string>;
  onToggleFolder(path: string): void;
  selected: string;
  currentUserEmail: string;
  onSelect(path: string): void;
  onToggleApprove(path: string, hasOwnApproval: boolean): void;
  onContextMenu(path: string, e: React.MouseEvent): void;
  busy: boolean;
}) {
  return (
    <>
      {folder.folders.map((child) => {
        const isClosed = closed.has(child.path);
        return (
          <div key={child.path} role="group">
            <button
              type="button"
              className="flex w-full items-center gap-1 rounded-sm py-1 pr-2 text-left text-meta font-medium text-ink-muted transition-colors hover:bg-hover"
              style={{ paddingLeft: indentFor(depth) }}
              onClick={() => onToggleFolder(child.path)}
              aria-expanded={!isClosed}
            >
              <span className="flex h-3.5 w-3.5 flex-none items-center justify-center text-ink-faint">
                <ChevronRight
                  size={13}
                  className={cn('transition-transform duration-150', !isClosed && 'rotate-90')}
                />
              </span>
              <span className="truncate">{child.name}</span>
            </button>
            {!isClosed && (
              <Level
                folder={child}
                depth={depth + 1}
                closed={closed}
                onToggleFolder={onToggleFolder}
                selected={selected}
                currentUserEmail={currentUserEmail}
                onSelect={onSelect}
                onToggleApprove={onToggleApprove}
                onContextMenu={onContextMenu}
                busy={busy}
              />
            )}
          </div>
        );
      })}
      {folder.files.map((file) => {
        const name = file.path.slice(file.path.lastIndexOf('/') + 1);
        const on = selected === file.path;
        const eligible = file.changed && file.approval?.viewerCanApprove === true;
        // The withdraw action toggles YOUR current confirmation, nobody
        // else's — stale rows stay for audit without arming it (presplit
        // PrFileRow's rule, kept verbatim).
        const email = currentUserEmail.trim().toLowerCase();
        const hasOwnApproval =
          !!email &&
          !!file.approval?.approvedBy.some(
            (a) => a.email.toLowerCase() === email && !a.isStale,
          );
        return (
          <div
            key={file.path}
            role="treeitem"
            aria-selected={on}
            className={cn(
              'group/row flex w-full items-center gap-1.5 rounded-sm py-1 pr-1.5 transition-colors',
              on ? 'bg-hover' : 'hover:bg-hover',
            )}
            style={{ paddingLeft: indentFor(depth) + 17 }}
            onContextMenu={(e) => {
              if (eligible) onContextMenu(file.path, e);
            }}
          >
            <KindIcon status={file.changed ? file.status : undefined} />
            <button
              type="button"
              className={cn(
                'min-w-0 flex-1 truncate text-left font-mono text-meta transition-colors',
                on ? 'font-semibold text-ink' : 'text-ink-muted',
              )}
              title={file.path}
              onClick={() => onSelect(file.path)}
            >
              {name}
            </button>
            <ApprovalStateBadge approval={file.changed ? file.approval : undefined} />
            {eligible && (
              <span className="flex flex-none items-center opacity-70 group-hover/row:opacity-100">
                {hasOwnApproval ? (
                  <button
                    type="button"
                    disabled={busy}
                    title="Withdraw your confirmation"
                    aria-label={`Withdraw your confirmation of ${file.path}`}
                    onClick={() => onToggleApprove(file.path, true)}
                    className="rounded-sm p-1 text-ok transition-colors hover:bg-danger-soft hover:text-danger disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <X size={12} />
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={busy}
                    title="Confirm this file"
                    aria-label={`Confirm ${file.path}`}
                    onClick={() => onToggleApprove(file.path, false)}
                    className="rounded-sm bg-ok p-1 text-white transition-colors hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Check size={12} />
                  </button>
                )}
              </span>
            )}
          </div>
        );
      })}
    </>
  );
}

/** What happened to the file — presplit PrFileRow's kind icons, on core tokens. */
function KindIcon({ status }: { status?: PrFileStatus }) {
  const size = 13;
  switch (status) {
    case 'added':
      return <FilePlus2 size={size} className="flex-none text-ok" />;
    case 'removed':
      return <FileX2 size={size} className="flex-none text-danger" />;
    case 'renamed':
    case 'copied':
      return <ArrowRightLeft size={size} className="flex-none text-ink-muted" />;
    case 'modified':
    case 'changed':
      return <FileEdit size={size} className="flex-none text-wait" />;
    default:
      // A scope file this request does not touch.
      return <File size={size} className="flex-none text-ink-faint" />;
  }
}

/**
 * The approval STATE, inline after the name — presplit PrApprovalBadge:
 * green ✓ confirmed, amber clock for outdated confirmations, grey clock
 * waiting; nothing at all for files outside the gate (keeps the tree quiet).
 */
function ApprovalStateBadge({ approval }: { approval?: FileApprovalState }) {
  if (!approval) return null;
  const hasEligible =
    approval.eligibleApprovers.roles.length > 0 || approval.eligibleApprovers.users.length > 0;
  if (!hasEligible) return null;
  const who = [
    ...approval.eligibleApprovers.roles,
    ...approval.eligibleApprovers.users.map((u) => u.name || u.email),
  ].join(', ');
  if (approval.isApproved) {
    const label = `Confirmed by ${who}`;
    return (
      <span role="img" aria-label={label} title={label} className="flex-none text-ok">
        <Check size={12} />
      </span>
    );
  }
  const stale = approval.approvedBy.some((a) => a.isStale);
  const label = stale
    ? 'Confirmation outdated — please re-confirm after the latest edits'
    : `Waiting on ${who}`;
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn('flex-none', stale ? 'text-wait' : 'text-ink-faint')}
    >
      <Clock size={12} />
    </span>
  );
}

/**
 * The right-click menu: one destructive verb with its confirm built in — the
 * first click arms it, the second fires. Click-away and Escape close it.
 */
function RevertMenu({
  path,
  x,
  y,
  busy,
  onRevert,
  onClose,
}: {
  path: string;
  x: number;
  y: number;
  busy: boolean;
  onRevert(): void;
  onClose(): void;
}) {
  const [armed, setArmed] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);
  return (
    <div
      ref={ref}
      role="menu"
      className="fixed z-[60] min-w-44 rounded-md border border-line bg-white py-1 shadow-lg"
      style={{ left: x, top: y }}
    >
      <div className="truncate px-3 py-1 font-mono text-label text-ink-faint" title={path}>
        {path.slice(path.lastIndexOf('/') + 1)}
      </div>
      <button
        type="button"
        role="menuitem"
        disabled={busy}
        className={cn(
          'w-full px-3 py-1.5 text-left text-detail transition-colors',
          armed ? 'font-medium text-danger hover:bg-hover' : 'text-ink hover:bg-hover',
        )}
        onClick={() => (armed ? onRevert() : setArmed(true))}
      >
        {armed ? 'Really revert this file?' : 'Revert file…'}
      </button>
    </div>
  );
}
