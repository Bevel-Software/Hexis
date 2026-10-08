import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { PullRequestSummary } from '@bevel-software/platform-shared';
import { getPullRequest } from '../../git/services/pr.api';
import { GitApiError } from '../../git/services/git.api';
import { KB_ROUTE_PREFIX } from '../../workspace/routing/kb-routes';
import { ChangeRequestDialog } from './ChangeRequestDialog';

/**
 * `/change-requests/<number>` — the link a person is handed for a change
 * request: by `open_change_request` and the change-request read tools (the
 * `url` on every summary), and by anything else that uses the backend's
 * change-request-link helper. The backend has built that address since the
 * link became absolute, and no route ever matched it: the shell's catch-all
 * sent it to the workspace with nothing open and no word about why, so an
 * agent's "here is the request" link opened nothing.
 *
 * What it opens is THE change-request view — {@link ChangeRequestDialog},
 * the same one the explorer and the skill page open — over a quiet page, on
 * the request's first changed file. Closing it, or applying the request,
 * goes to the workspace: there is nothing under the dialog to go back to.
 *
 * A number that is not one, a request that is not there, and one the
 * viewer may not see all read the same way: there is no request at this
 * address for them, and which of the three it is would tell a person who
 * may not see a request that it exists. Any other failure keeps its own
 * message, since it is the platform's, not the link's.
 */
export function ChangeRequestLink() {
  const { number: raw } = useParams();
  const number = changeRequestNumber(raw);
  // Keyed by the number: the router reuses this element across a change of
  // the parameter, and a lookup that had resolved would otherwise keep the
  // previous request on screen under the new address until the new fetch
  // settled. A new number is a fresh lookup from "loading".
  return number === null ? (
    <NoSuchRequest raw={raw ?? ''} />
  ) : (
    <OpenRequest key={number} number={number} />
  );
}

/** The largest number a request can have: the database sequence is a 32-bit integer. */
const MAX_CHANGE_REQUEST_NUMBER = 2_147_483_647;

/** A positive integer, spelled plainly — the only thing the link helper ever puts in the path. */
function changeRequestNumber(raw: string | undefined): number | null {
  if (!raw || !/^[1-9]\d*$/.test(raw)) return null;
  const number = Number(raw);
  return number <= MAX_CHANGE_REQUEST_NUMBER ? number : null;
}

type Lookup =
  | { kind: 'loading' }
  | { kind: 'open'; cr: PullRequestSummary }
  | { kind: 'missing' }
  | { kind: 'failed'; message: string };

function OpenRequest({ number }: { number: number }) {
  const navigate = useNavigate();
  const [lookup, setLookup] = useState<Lookup>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    getPullRequest(number).then(
      (cr) => {
        if (!cancelled) setLookup({ kind: 'open', cr });
      },
      (err: unknown) => {
        if (cancelled) return;
        // Not there, or not for this viewer: the same sentence for both, so
        // the address never says which.
        const hidden = err instanceof GitApiError && (err.status === 404 || err.status === 403);
        setLookup(
          hidden
            ? { kind: 'missing' }
            : { kind: 'failed', message: err instanceof Error ? err.message : String(err) },
        );
      },
    );
    return () => {
      cancelled = true;
    };
  }, [number]);

  // `replace`: the link's entry leaves history with the view, so Back after
  // closing does not land on the address again and reopen the request.
  const leave = () => navigate(KB_ROUTE_PREFIX, { replace: true });

  if (lookup.kind === 'missing') return <NoSuchRequest raw={String(number)} />;
  if (lookup.kind === 'failed') {
    return (
      <Quiet>
        <p>Change request #{number} could not be opened: {lookup.message}</p>
        <BackToKnowledge />
      </Quiet>
    );
  }
  return (
    <>
      <Quiet>
        <p>{lookup.kind === 'loading' ? `Opening change request #${number}…` : lookup.cr.title}</p>
        <BackToKnowledge />
      </Quiet>
      {lookup.kind === 'open' && (
        <ChangeRequestDialog cr={lookup.cr} onClose={leave} onResolved={leave} />
      )}
    </>
  );
}

function NoSuchRequest({ raw }: { raw: string }) {
  return (
    <Quiet>
      <p>
        There is no change request {raw ? `#${raw}` : 'at this address'} — it does not exist, or
        you may not see it.
      </p>
      <BackToKnowledge />
    </Quiet>
  );
}

/** The page under the dialog: a sentence and a way out, nothing to be read as content. */
function Quiet({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 bg-white text-sm text-ink-muted">
      {children}
    </div>
  );
}

/** The way out of the quiet page. `replace`, like the dialog's exits: the link's entry leaves with the page. */
function BackToKnowledge() {
  return (
    <Link to={KB_ROUTE_PREFIX} replace className="underline hover:text-ink">
      Back to the knowledge base
    </Link>
  );
}
