import { useCallback, useEffect, useState } from 'react';
import { Banner, Button, TextAreaField } from '../../../shared/components';
import {
  fetchAccessRequestStatus,
  sendAccessRequest,
  LEVEL_WORDS,
  REQUEST_NOTE_MAX,
  type AccessRequestStatus,
  type RequestLevel,
} from '../requests.api';

/**
 * "You can read this, but you can't share it" — with something to do about it.
 *
 * The read-only Manage access dialog used to end at "Ask an owner: Ed." and
 * leave the reader to find Ed some other way. This is the rest of that
 * sentence: choose Can edit or Owner, say why if it helps, and the people who
 * can already edit the item answer it in the same dialog.
 *
 * ONE OPEN REQUEST PER PERSON PER ITEM. While it is open the control is
 * replaced by what was asked and who is being waited on, and the level cannot
 * be changed — a person who wants the other level waits for the answer, or an
 * editor grants it directly. Sending twice (a double click, two tabs) is
 * answered by the request the first send opened, so there is still exactly
 * one.
 *
 * NOTHING SAYS "Requested" UNLESS THE REQUEST EXISTS. The state is read back
 * from the server, and a send that fails says so and keeps the control — a
 * hopeful local "sent!" is the one lie this surface must not tell, because
 * the person would then wait on nobody.
 */
export interface AccessRequestControlProps {
  workspaceId: string;
  /** The item, exactly as the dialog addresses it for a grant. */
  target: { path: string; kind: 'folder' | 'file' };
  /** `file` or `folder` — the word the surrounding sentences use. */
  targetKind: 'folder' | 'file';
  /**
   * The same up-to-three names the "Ask an owner" line shows, or '' when the
   * item names nobody. Kept identical on purpose: the line that says who to
   * ask and the line that says who is being waited on must not disagree.
   */
  ownerNames: string;
}

export function AccessRequestControl({
  workspaceId,
  target,
  targetKind,
  ownerNames,
}: AccessRequestControlProps) {
  const [status, setStatus] = useState<AccessRequestStatus | null>(null);
  const [level, setLevel] = useState<RequestLevel>('write');
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { path, kind } = target;

  useEffect(() => {
    let cancelled = false;
    fetchAccessRequestStatus(workspaceId, { path, kind })
      .then((next) => {
        if (!cancelled) setStatus(next);
      })
      .catch(() => {
        // A status that cannot be read is reported as nothing outstanding:
        // the control stays, and a send would find the open request anyway.
        if (!cancelled) setStatus({ state: 'none' });
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, path, kind]);

  const send = useCallback(async () => {
    setSending(true);
    setError(null);
    try {
      const opened = await sendAccessRequest(workspaceId, {
        path,
        kind,
        level,
        note: note.trim() || undefined,
      });
      // The server's answer, not the click's hope: a second send while a
      // request is open comes back with THAT request, level and all.
      setStatus({ state: 'pending', level: opened.level, number: opened.number });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }, [workspaceId, path, kind, level, note]);

  // Nothing at all until the server has spoken: a control that flashes up and
  // is then replaced by "Requested" reads as a send that happened by itself.
  if (!status) return null;

  if (status.state === 'pending') {
    const who = ownerNames || `the people who can edit its access`;
    return (
      <p className="mt-2 text-detail text-ink-muted" role="status">
        {`Requested: ${LEVEL_WORDS[status.level ?? 'write']}. Waiting on ${who}.`}
      </p>
    );
  }

  return (
    <div className="mt-2 flex flex-col gap-2">
      {status.state === 'not-accepted' && (
        <p className="text-detail text-ink-muted">
          {`Your last request for ${LEVEL_WORDS[status.level ?? 'write']} wasn't accepted.`}
        </p>
      )}
      <div
        role="radiogroup"
        aria-label={`What to ask for on this ${targetKind}`}
        className="flex items-center gap-4"
      >
        {(['write', 'owner'] as const).map((option) => (
          <label key={option} className="flex items-center gap-1.5 text-detail text-ink">
            <input
              type="radio"
              name="access-request-level"
              value={option}
              checked={level === option}
              disabled={sending}
              onChange={() => setLevel(option)}
            />
            {LEVEL_WORDS[option]}
          </label>
        ))}
      </div>
      <TextAreaField
        aria-label="Why you need it (optional)"
        placeholder="Why you need it (optional)"
        maxLength={REQUEST_NOTE_MAX}
        disabled={sending}
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <div>
        <Button variant="outline" size="sm" disabled={sending} onClick={() => void send()}>
          Request access
        </Button>
      </div>
      {error && (
        <Banner tone="danger" role="alert">
          {/* One trailing stop, whatever the server's sentence ended with. */}
          {`Couldn't send your request: ${error.replace(/\s*\.$/, '')}.`}
        </Banner>
      )}
    </div>
  );
}
