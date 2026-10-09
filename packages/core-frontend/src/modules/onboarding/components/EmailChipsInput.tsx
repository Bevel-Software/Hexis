import { useRef, type ClipboardEvent, type KeyboardEvent } from 'react';
import { X } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { isValidEmail, splitEmails } from '../invite-emails';

/** `current` plus whatever of `added` it does not already hold, in order. */
function withAdded(current: string[], added: string[]): string[] {
  const next = [...current];
  for (const email of added) if (!next.includes(email)) next.push(email);
  return next;
}

interface EmailChipsInputProps {
  /** Labels the text input (pair with a `<label htmlFor>`). */
  id: string;
  emails: string[];
  onEmailsChange(next: string[]): void;
  /** The text not yet turned into a chip. Controlled, so a submit can include it. */
  draft: string;
  onDraftChange(next: string): void;
  placeholder?: string;
  /** Id of the hint below the field. */
  'aria-describedby'?: string;
  disabled?: boolean;
}

/**
 * An address field that turns what you type into chips: Enter or a comma
 * after each address, or paste a whole list at once. Backspace in an empty
 * field takes the last chip back. An address that cannot be one stays on
 * screen in the danger tone rather than vanishing — the person typed it,
 * and the fix is theirs to see.
 *
 * Borrows Manage access's chip picker look (a TextField that grew chips), but
 * not its code: that one picks principals from suggestions, this one only
 * ever holds addresses.
 */
export function EmailChipsInput({
  id,
  emails,
  onEmailsChange,
  draft,
  onDraftChange,
  placeholder,
  'aria-describedby': describedBy,
  disabled = false,
}: EmailChipsInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  function commit(text: string) {
    const added = splitEmails(text);
    if (added.length > 0) onEmailsChange(withAdded(emails, added));
    onDraftChange('');
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if ((e.key === 'Enter' || e.key === ',' || e.key === ';') && draft.trim()) {
      e.preventDefault();
      commit(draft);
      return;
    }
    if (e.key === 'Backspace' && draft === '' && emails.length > 0) {
      e.preventDefault();
      onEmailsChange(emails.slice(0, -1));
    }
  }

  // A single pasted address is ordinary typing; a LIST becomes chips at once,
  // so pasting thirty addresses does not leave one thirty-address chip.
  function onPaste(e: ClipboardEvent<HTMLInputElement>) {
    const text = e.clipboardData.getData('text');
    if (!/[\s,;<]/.test(text.trim())) return;
    e.preventDefault();
    commit(`${draft} ${text}`);
  }

  return (
    // The box, not just the input, is the click target: clicking between
    // chips should land the caret where the next address goes.
    <div
      className={cn(
        'flex w-full cursor-text flex-wrap items-center gap-1.5 rounded-md border border-line-strong bg-surface px-2 py-1.5',
        'focus-within:border-transparent focus-within:outline-2 focus-within:-outline-offset-1 focus-within:outline-accent',
        disabled && 'cursor-not-allowed opacity-50',
      )}
      onClick={() => inputRef.current?.focus()}
    >
      {emails.map((email) => {
        const valid = isValidEmail(email);
        return (
          <span
            key={email}
            className={cn(
              'inline-flex min-w-0 max-w-full items-center gap-1 rounded-full py-0.5 pl-2 pr-1 text-detail',
              valid ? 'bg-sunken text-ink' : 'bg-danger-soft text-danger',
            )}
            title={valid ? email : `${email} is not an email address`}
          >
            <span className="min-w-0 truncate">{email}</span>
            {!valid && <span className="sr-only">(not an email address)</span>}
            <button
              type="button"
              disabled={disabled}
              onClick={(e) => {
                e.stopPropagation();
                onEmailsChange(emails.filter((x) => x !== email));
                inputRef.current?.focus();
              }}
              className="flex size-4 shrink-0 items-center justify-center rounded-full text-ink-faint hover:bg-hover hover:text-ink"
              aria-label={`Remove ${email}`}
            >
              <X size={10} aria-hidden />
            </button>
          </span>
        );
      })}
      <input
        ref={inputRef}
        id={id}
        value={draft}
        disabled={disabled}
        onChange={(e) => onDraftChange(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        // Leaving the field keeps what was typed: a person who types one
        // address and reaches for the role select has not abandoned it.
        onBlur={() => {
          if (draft.trim()) commit(draft);
        }}
        placeholder={emails.length > 0 ? 'Add more…' : placeholder}
        autoComplete="off"
        spellCheck={false}
        aria-describedby={describedBy}
        className="min-w-40 flex-1 bg-transparent px-1 py-0.5 text-ui text-ink placeholder:text-ink-faint focus:outline-none"
      />
    </div>
  );
}
