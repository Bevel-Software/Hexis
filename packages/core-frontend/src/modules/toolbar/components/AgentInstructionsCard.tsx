import { useContext, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Pencil } from 'lucide-react';
import { DEFAULT_BRANCH } from '@bevel-software/platform-shared';
import { AdminContext } from '../../admin/state/admin.context';
import { WorkspaceContext } from '../../workspace/state/workspace.context';
import { kbFileUrl } from '../../workspace/routing/kb-routes';
import { buttonClasses } from '../../../shared/components';
import { Markdown } from '../../../shared/markdown/Markdown';
import {
  PREAMBLE_CAP,
  PREAMBLE_FILE,
  TOOL_PREFIX_CAP,
  fetchAgentInstructions,
  type AgentInstructions,
} from '../services/agent-instructions.api';

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: AgentInstructions };

/** `1,240 / 6,000 characters`, the same count the server truncates on. */
function count(n: number, cap: number): string {
  return `${n.toLocaleString('en-US')} / ${cap.toLocaleString('en-US')} characters`;
}

const WARNING = 'text-meta text-wait bg-wait-soft border border-wait rounded-sm px-2 py-1.5';
const BOX = 'text-xs bg-sunken border border-line rounded-sm px-2.5 py-2';
/**
 * The description is a preview at the page's own size, not a document: the
 * prose defaults would render a `##` twice the size of everything around it.
 */
const DESCRIPTION_MARKDOWN =
  'text-xs leading-snug [&_h1]:text-xs [&_h2]:text-xs [&_h3]:text-xs [&_h4]:text-xs ' +
  '[&_h1]:font-medium [&_h2]:font-medium [&_h3]:font-medium [&_h4]:font-medium ' +
  '[&_h1]:mt-2.5 [&_h2]:mt-2.5 [&_h3]:mt-2 [&_h4]:mt-2 [&_h1]:mb-1 [&_h2]:mb-1 [&_h3]:mb-1 [&_h4]:mb-1 ' +
  '[&_p]:my-1.5 [&_ul]:my-1.5 [&_ol]:my-1.5 [&_li]:my-0.5';

/**
 * "What agents are told about this knowledge base": the text every MCP
 * session starts with, organised around the part the admin owns. The fixed
 * platform message sits in a closed drawer (it is sent first, and nobody here
 * can change it); the admin's description is the centrepiece, with its count
 * against the cap right beside it; and the short version shows what the
 * clients that ignore the connection message get instead, with the fixed
 * sentence muted so the admin's own paragraph stands out.
 *
 * Sits above the tab strip of the External agent access page because it
 * applies to both tabs: an interactive agent and an autonomous one receive
 * the same text.
 *
 * Both contexts are read WITHOUT their hooks' provider guard: the page renders
 * in tests and in shells that mount no admin or workspace provider, and a
 * card that throws there would take the whole page with it. Absent admin
 * context means no Edit action; absent `kbDirName` means no Edit action yet.
 */
export function AgentInstructionsCard() {
  const isAdmin = useContext(AdminContext)?.isAdmin ?? false;
  const kbDirName = useContext(WorkspaceContext)?.kbDirName ?? null;
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    fetchAgentInstructions().then(
      (data) => {
        if (!cancelled) setState({ status: 'ready', data });
      },
      (err: unknown) => {
        if (!cancelled) {
          setState({ status: 'error', message: err instanceof Error ? err.message : "Couldn't load what agents are told." });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  // The link is rendered only once the KB dir name is known: a URL with a
  // missing segment opens "File not found", which is worse than no link.
  const editHref = isAdmin && kbDirName ? kbFileUrl(DEFAULT_BRANCH, `${kbDirName}/${PREAMBLE_FILE}`) : null;

  return (
    <section className="px-4 py-3 border-b border-line space-y-3" aria-labelledby="agent-instructions-title">
      <div className="flex items-center justify-between gap-3">
        <h2 id="agent-instructions-title" className="text-xs font-medium text-ink">
          What agents are told about this knowledge base
        </h2>
        {editHref && (
          <Link to={editHref} className={buttonClasses({ variant: 'outline', size: 'sm' })}>
            <Pencil size={12} />
            Edit description
          </Link>
        )}
      </div>
      <p className="text-meta text-ink-muted leading-snug">
        Every agent that connects, on either tab, gets this at the start of each session, whatever it may read in
        the repository. A fixed platform message goes first, then your description of what is here.
      </p>

      {state.status === 'loading' && <p className="text-meta text-ink-muted">Loading…</p>}
      {state.status === 'error' && (
        <div role="alert" className="text-xs text-danger bg-danger-soft border border-danger rounded-sm px-2 py-1.5">
          {state.message}
        </div>
      )}
      {state.status === 'ready' && (
        <div className="space-y-3">
          <details className="border border-line rounded-sm">
            <summary className="cursor-pointer px-2.5 py-1.5 text-xs text-ink-muted">
              Platform message (fixed, sent first)
            </summary>
            <p className="px-2.5 pb-2 text-xs text-ink-muted leading-snug whitespace-pre-wrap" data-testid="header-text">
              {state.data.header}
            </p>
          </details>

          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="text-xs font-medium text-ink">Your description</h3>
              <span
                className={`text-meta ${state.data.truncated ? 'text-wait' : 'text-ink-muted'}`}
                data-testid="preamble-count"
              >
                {count(state.data.preambleChars, PREAMBLE_CAP)}
              </span>
            </div>
            {state.data.truncated && (
              <p role="alert" className={WARNING}>
                Over the cap: agents receive only the first {PREAMBLE_CAP.toLocaleString('en-US')} characters. Shorten{' '}
                {PREAMBLE_FILE}.
              </p>
            )}
            {state.data.unterminatedComment && (
              <p role="alert" className={WARNING}>
                A comment is left open: everything after the last <span className="font-mono">&lt;!--</span> is withheld
                from agents. Close it with <span className="font-mono">--&gt;</span> in {PREAMBLE_FILE}.
              </p>
            )}
            {state.data.preamble ? (
              <div className={`${BOX} max-h-56 overflow-y-auto overflow-x-hidden break-words`} data-testid="description-text">
                <Markdown className={DESCRIPTION_MARKDOWN}>{state.data.preamble}</Markdown>
              </div>
            ) : (
              <p className={`${BOX} text-ink-muted leading-snug`} data-testid="description-empty">
                Nothing written yet, so agents get the platform message only. Describe what this knowledge base holds,
                what is where, and when to look here first. The first paragraph doubles as the short version below.
              </p>
            )}
            <p className="text-meta text-ink-muted leading-snug">
              {isAdmin ? (
                <>
                  Kept in {PREAMBLE_FILE} at the repository root. Text inside an HTML comment stays private.
                </>
              ) : (
                <>Admins edit it in {PREAMBLE_FILE} at the repository root.</>
              )}
            </p>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="text-xs font-medium text-ink">Short version</h3>
              <span
                className={`text-meta ${state.data.toolPrefixTruncated ? 'text-wait' : 'text-ink-muted'}`}
                data-testid="prefix-count"
              >
                {count(state.data.toolPrefixChars, TOOL_PREFIX_CAP)}
              </span>
            </div>
            <p className="text-meta text-ink-muted leading-snug">
              Some clients (claude.ai, Cline, the Agent SDK) ignore the connection message and only read tool
              descriptions, so this goes at the top of the four search tools instead: a fixed sentence, then your
              first paragraph.
            </p>
            {state.data.toolPrefixTruncated && (
              <p role="alert" className={WARNING}>
                Over the cap: the four tools receive only the first {TOOL_PREFIX_CAP} characters. Shorten the first
                paragraph of {PREAMBLE_FILE}.
              </p>
            )}
            <p className={`${BOX} whitespace-pre-wrap break-words leading-snug`} data-testid="prefix-text">
              <span className="text-ink-muted">{state.data.toolPrefixLine}</span>
              <span className="text-ink">{state.data.toolPrefix.slice(state.data.toolPrefixLine.length)}</span>
            </p>
          </div>
        </div>
      )}
    </section>
  );
}
