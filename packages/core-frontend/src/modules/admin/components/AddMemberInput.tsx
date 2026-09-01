import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { DEFAULT_BRANCH } from '@bevel-software/platform-shared';
import { suggestPrincipals } from '../../access/api';
import { initials } from '../../../lib/email';

/** A person offered by the suggest endpoint — name and email, nothing more. */
export interface PersonSuggestion {
  name: string;
  email: string;
}

/**
 * The server withholds people until the query is at least this long (its
 * anti-harvesting guard). Mirrored here so a shorter query costs no request
 * at all rather than one that can only come back empty.
 */
const SUGGEST_MIN_CHARS = 2;

/** Typing settles for this long before a suggest request goes out. */
const SUGGEST_DEBOUNCE_MS = 200;

/** The default-branch workspace id — the admin surfaces are managed there. */
// A function, not a constant: the branch model arrives from `/api/config`
// during boot, and a module-scope capture would freeze this at the empty
// string that exists before it.
const suggestWorkspaceId = () => encodeURIComponent(DEFAULT_BRANCH);

export interface AddMemberInputProps {
  /** Controlled input value — the caller owns it, and owns clearing it. */
  value: string;
  onValueChange: (value: string) => void;
  /**
   * Add the given email. Called with the typed value (Enter / the Add button)
   * or with a chosen suggestion's email — the two paths are indistinguishable
   * from here, which is the point. Validation and the request are the
   * caller's: this component knows nothing about roles or groups.
   */
  onSubmit: (value: string) => void;
  /** Emails already on the target — never offered as suggestions. */
  exclude: readonly string[];
  /** Accessible name of the input (each card names its own target). */
  inputLabel: string;
  /** A mutation is in flight: input and button go inert, the button spins. */
  busy?: boolean;
  placeholder?: string;
  /** Layout classes for the row (spacing above it differs per page). */
  className?: string;
}

/**
 * The add-member input shared by Roles & Members and the Groups page: an
 * email field that suggests people from the deployment as you type, plus its
 * Add button.
 *
 * SUGGESTIONS ASSIST, THEY NEVER RESTRICT. The list is a shortcut for a value
 * the caller could always have typed in full — a person who has never signed
 * in is still addable, and a suggest request that fails or answers a shape
 * this doesn't recognise simply leaves an ordinary email input behind. That
 * is why every read of the response is defensive and every failure path ends
 * in "no suggestions", never an error the form has to show.
 */
export function AddMemberInput({
  value,
  onValueChange,
  onSubmit,
  exclude,
  inputLabel,
  busy = false,
  placeholder = 'Add member by email',
  className = '',
}: AddMemberInputProps) {
  const [suggestions, setSuggestions] = useState<PersonSuggestion[]>([]);
  const [showSuggest, setShowSuggest] = useState(false);
  // Bumped per request so a slow response never repopulates the list after a
  // newer query (or a backspace below the threshold) has superseded it.
  const suggestReq = useRef(0);

  // A newline-joined key rather than the array itself: callers build `exclude`
  // inline (`[...members, ...pending]`), so a reference dependency would
  // re-run this effect on every render. The key changes only when the set does.
  const excludeKey = [...new Set(exclude.map((e) => e.trim().toLowerCase()))]
    .sort()
    .join('\n');

  useEffect(() => {
    const q = value.trim();
    if (q.length < SUGGEST_MIN_CHARS) {
      // Invalidate any in-flight request so a late long-query response can't
      // repopulate the dropdown after the user backspaced below the threshold.
      suggestReq.current++;
      setSuggestions([]);
      return;
    }
    const myReq = ++suggestReq.current;
    const t = setTimeout(() => {
      suggestPrincipals(suggestWorkspaceId(), q)
        .then((res) => {
          if (myReq !== suggestReq.current) return;
          // People only; drop anyone the caller already counts as a member.
          const existing = new Set(excludeKey ? excludeKey.split('\n') : []);
          setSuggestions(
            (res.people ?? []).filter((p) => !existing.has(p.email.toLowerCase())),
          );
        })
        .catch(() => {
          // The suggestion feature degrades; the input keeps working.
          if (myReq === suggestReq.current) setSuggestions([]);
        });
    }, SUGGEST_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [value, excludeKey]);

  return (
    <div className={`flex items-center gap-1.5 ${className}`}>
      {/* The input is capped rather than fixed-width, and its wrapper may shrink,
          so the row fits the card on a narrow viewport instead of pushing the
          Add button past the card border. */}
      <div className="relative flex-1 min-w-0 max-w-[16rem]">
        <input
          type="email"
          value={value}
          onChange={(e) => {
            onValueChange(e.target.value);
            setShowSuggest(true);
          }}
          onFocus={() => setShowSuggest(true)}
          // Delay so a click on a suggestion lands before the list unmounts.
          onBlur={() => setTimeout(() => setShowSuggest(false), 150)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSubmit(value);
            if (e.key === 'Escape') setShowSuggest(false);
          }}
          placeholder={placeholder}
          disabled={busy}
          className="text-xs px-2 py-1 border border-line rounded-sm focus:outline-none focus:border-accent w-full min-w-0"
          aria-label={inputLabel}
          autoComplete="off"
        />
        {showSuggest && suggestions.length > 0 && (
          <ul className="absolute z-10 mt-1 w-full sm:w-72 max-w-full max-h-56 overflow-auto bg-white border border-line rounded-lg shadow-lg py-1">
            {suggestions.map((p) => (
              <li key={p.email}>
                <button
                  type="button"
                  // onMouseDown (not onClick) so it fires before the input's blur.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    onSubmit(p.email);
                  }}
                  className="w-full text-left px-2 py-1.5 hover:bg-hover flex items-center gap-2"
                >
                  <span className="w-5 h-5 rounded-full bg-ink-muted text-white text-[9px] font-semibold flex items-center justify-center shrink-0">
                    {initials(p.email)}
                  </span>
                  <span className="flex-1 truncate text-xs text-ink">{p.name || p.email}</span>
                  <span className="text-[10px] text-ink-faint truncate">{p.email}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <button
        type="button"
        onClick={() => onSubmit(value)}
        disabled={busy}
        className="shrink-0 px-3 py-1 text-xs rounded-sm border border-line hover:bg-hover disabled:opacity-50 flex items-center gap-1"
      >
        {busy && <Loader2 size={12} className="animate-spin" />}
        Add
      </button>
    </div>
  );
}
