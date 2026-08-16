import { useCallback, useRef, useState } from 'react';
import { Link2, Plus, Trash2, Users } from 'lucide-react';
import { cn } from '../../../lib/utils';
import {
  Button,
  IconButton,
  MenuItem,
  MenuPanel,
  useDismissableMenu,
} from '../../../shared/components';

/**
 * The three actions beside a place's title — the prototype's `spaceActs`
 * (proto:3012-3025).
 *
 * Everyone sees all three, and they do the same thing for everyone. That is
 * the whole point of the component existing: the plugin page used to render
 * `canWrite ? "Add skills or tools" : "Propose a skill or tool"` — the same
 * button, in the same spot, opening a different flow with different words
 * depending on who pressed it. In the prototype's words, "the person who
 * taught you the app could not tell you what you would see." Who reviews what
 * is a property of the place, not of the door; the dialog behind `+` says so
 * in its own copy.
 *
 * Weight follows stakes. Share is the one bounded button because it is the
 * only action here with a consequence for other people. `+` is an icon —
 * frequent and reversible. Everything else lives behind `⋯`.
 *
 * No chevron on Share, unlike a Knowledge page: a file can be shared at two
 * scopes (itself, or its folder); a place has exactly one thing to share.
 */

export interface PageActionsProps {
  /**
   * Opens Manage access. Omitted when there is no folder to manage — the
   * personal page is the live case: its items are the ones in NO plugin, so
   * there is no `access.md` behind them and a Share button would promise an
   * editor with nothing to edit.
   */
  onShare?: () => void;
  /** Opens the add dialog. Never gated on role — see the note above. */
  onAdd(): void;
  /** Copies a link to this page. Resolves false if the clipboard refused. */
  onCopyLink(): Promise<boolean>;
  /**
   * Opens the delete confirmation. Present ONLY when the caller owns the
   * place (`isOwner` — the same verdict the DELETE route enforces), which is
   * the one gating exception to "everyone sees the same menu": an item that
   * 404s for everyone but the owner is a broken promise, not a consistency.
   */
  onDelete?: () => void;
  /** Names the thing, for the `+` tooltip and the accessible names. */
  addLabel?: string;
}

export function PageActions({
  onShare,
  onAdd,
  onCopyLink,
  onDelete,
  addLabel = 'Add a skill or tool',
}: PageActionsProps) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<null | 'ok' | 'fail'>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const menuRef = useDismissableMenu<HTMLDivElement>({
    open,
    onClose: close,
    returnFocusTo: triggerRef,
  });

  const copy = useCallback(async () => {
    close();
    const ok = await onCopyLink();
    setCopied(ok ? 'ok' : 'fail');
    window.setTimeout(() => setCopied(null), 1800);
  }, [close, onCopyLink]);

  return (
    <div className="flex flex-none items-center gap-1.5">
      {onShare && (
        <Button variant="outline" size="sm" onClick={onShare}>
          <Users size={13} />
          Share
        </Button>
      )}

      <IconButton aria-label={addLabel} title={addLabel} onClick={onAdd}>
        <Plus size={15} />
      </IconButton>

      <div className="relative">
        <IconButton
          ref={triggerRef}
          aria-label="More actions"
          aria-haspopup="menu"
          aria-expanded={open}
          active={open}
          onClick={() => setOpen((v) => !v)}
        >
          <span aria-hidden className="text-strong leading-none">
            ⋯
          </span>
        </IconButton>
        {open && (
          <div ref={menuRef} className="absolute right-0 top-[calc(100%+5px)] z-40">
            <MenuPanel role="menu" aria-label="More actions" className="min-w-[188px]">
              <MenuItem role="menuitem" onClick={() => void copy()}>
                <span className="flex items-center gap-2.5">
                  <Link2 size={14} />
                  Copy link
                </span>
              </MenuItem>
              {/* "Leave this subscription" (proto:3020) is deliberately NOT
                  built yet: no backend endpoint stands behind it, and a menu
                  item that cannot do its job is worse than one that is not
                  there. The menu exists so it drops in without moving
                  anything. */}
              {onDelete && (
                <MenuItem
                  role="menuitem"
                  tone="danger"
                  onClick={() => {
                    close();
                    onDelete();
                  }}
                >
                  <span className="flex items-center gap-2.5">
                    <Trash2 size={14} />
                    Delete plugin
                  </span>
                </MenuItem>
              )}
            </MenuPanel>
          </div>
        )}
      </div>

      {/* The copy's answer, announced once. A clipboard write can be refused
          outright on a non-secure origin, and a silent no-op is the worst
          possible reply to "copy this". */}
      <span
        role="status"
        aria-live="polite"
        className={cn(
          'text-meta transition-opacity',
          copied ? 'opacity-100' : 'opacity-0',
          copied === 'fail' ? 'text-danger' : 'text-ink-faint',
        )}
      >
        {copied === 'ok' ? 'Link copied' : copied === 'fail' ? "Couldn't copy" : ''}
      </span>
    </div>
  );
}
