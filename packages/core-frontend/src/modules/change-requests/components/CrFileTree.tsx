import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronRight } from 'lucide-react';
import type { FileApprovalState } from '@bevel-software/platform-shared';
import { Badge } from '../../../shared/components';
import { cn } from '../../../lib/utils';

/**
 * The change request's files as a TREE — the same visual grammar as the
 * Knowledge sidebar (indent is the structure, a caret slot per row, quiet
 * rows), because a reviewer who lives in one tree should not have to learn a
 * second one here.
 *
 * The tree is also the review surface's fast path: every file the viewer may
 * approve carries a green check control on its row — approving is ONE click,
 * where it used to live behind selecting the file first — and a right-click
 * on a revertable file offers the destructive verb with its own confirm
 * step. Selection (which file the diff pane shows) stays a plain click on
 * the name.
 */

export interface CrTreeFileState {
  /** Repo-relative path. */
  path: string;
  /** Changed by this request (scope base files list too, unchanged). */
  changed: boolean;
  /** Added by this request. */
  added: boolean;
  approval?: FileApprovalState;
}

interface CrFileTreeProps {
  files: CrTreeFileState[];
  selected: string;
  onSelect(path: string): void;
  /** Toggle the viewer's approval of `path`. Only called when approvable. */
  onToggleApprove(path: string, approved: boolean): void;
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

export function CrFileTree({ files, selected, onSelect, onToggleApprove, onRevert, busy }: CrFileTreeProps) {
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
  onSelect(path: string): void;
  onToggleApprove(path: string, approved: boolean): void;
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
        const approvable = file.changed && file.approval?.viewerCanApprove === true;
        const approved = file.approval?.isApproved === true;
        return (
          <div
            key={file.path}
            role="treeitem"
            aria-selected={on}
            className={cn(
              'group/row flex w-full items-center gap-1.5 rounded-sm py-1 pr-2 transition-colors',
              on ? 'bg-hover' : 'hover:bg-hover',
            )}
            style={{ paddingLeft: indentFor(depth) }}
            onContextMenu={(e) => {
              if (approvable) onContextMenu(file.path, e);
            }}
          >
            {/* The review fast path: the check IS the row's leading control.
                Green when the file is approved; an empty ring inviting the
                click when the viewer may approve it; a quiet dot when the
                file changed but somebody else has to say yes. */}
            {approvable ? (
              <button
                type="button"
                disabled={busy}
                aria-label={approved ? `Unapprove ${file.path}` : `Approve ${file.path}`}
                title={approved ? 'Approved — click to take it back' : 'Approve this file'}
                onClick={() => onToggleApprove(file.path, approved)}
                className={cn(
                  'flex h-4 w-4 flex-none items-center justify-center rounded-full border transition-colors',
                  approved
                    ? 'border-ok bg-ok text-white'
                    : 'border-line-strong text-transparent hover:border-ok hover:text-ok',
                )}
              >
                <Check size={11} strokeWidth={3} />
              </button>
            ) : (
              <span className="flex h-4 w-4 flex-none items-center justify-center">
                {file.changed &&
                  (approved ? (
                    <span title="Approved" className="flex h-4 w-4 items-center justify-center rounded-full border border-ok bg-ok text-white">
                      <Check size={11} strokeWidth={3} />
                    </span>
                  ) : (
                    <span className="size-1.5 rounded-full bg-wait-dot" title="Changed — awaiting its owners" />
                  ))}
              </span>
            )}
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
            {file.added && (
              <Badge tone="ok" size="xs" className="shrink-0">
                New
              </Badge>
            )}
          </div>
        );
      })}
    </>
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
