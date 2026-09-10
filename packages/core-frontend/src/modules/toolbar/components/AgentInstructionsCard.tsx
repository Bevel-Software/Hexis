import { useContext, useEffect, useState } from 'react';
import { Pencil } from 'lucide-react';
import { AdminContext } from '../../admin/state/admin.context';
import { WorkspaceContext } from '../../workspace/state/workspace.context';
import { Button } from '../../../shared/components';
import { Markdown } from '../../../shared/markdown/Markdown';
import {
  PREAMBLE_CAP,
  PREAMBLE_FILE,
  fetchEditableAgentDescription,
  fetchAgentInstructions,
  saveAgentDescription,
  type AgentInstructions,
  type EditableAgentDescription,
} from '../services/agent-instructions.api';

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: AgentInstructions };

/** `1,240 / 6,000 characters`, the same count the server truncates on. */
function count(n: number, cap: number): string {
  return `${n.toLocaleString('en-US')} / ${cap.toLocaleString('en-US')} characters`;
}

// `text-ink`, not `text-wait`: tokens.css marks `wait` too light for text on
// its own soft ground (2.63:1). Same pairing as Banner's `wait` tone.
const WARNING = 'text-meta text-ink bg-wait-soft border border-wait rounded-sm px-2 py-1.5';
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
 * against the cap right beside it.
 *
 * Sits in its own card below connection setup: it applies to every connection
 * type, but it is a separate administrative concern rather than part of the
 * user's setup flow.
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
  const [editor, setEditor] = useState<(EditableAgentDescription & { value: string }) | null>(null);
  const [editBusy, setEditBusy] = useState<'loading' | 'saving' | null>(null);
  const [editError, setEditError] = useState<string | null>(null);

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

  // The editor is offered only once the KB dir name is known: the save path
  // otherwise has a missing segment and cannot safely target the source file.
  const canEdit = isAdmin && kbDirName !== null;

  const beginEdit = async () => {
    if (!kbDirName || editBusy) return;
    setEditError(null);
    setEditBusy('loading');
    try {
      const editable = await fetchEditableAgentDescription(kbDirName);
      setEditor({ ...editable, value: editable.description });
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "Couldn't load the description editor.");
    } finally {
      setEditBusy(null);
    }
  };

  const saveEdit = async () => {
    if (!kbDirName || !editor || editBusy) return;
    setEditError(null);
    setEditBusy('saving');
    try {
      await saveAgentDescription(editor.workspaceId, kbDirName, editor.source, editor.value);
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "Couldn't save the description.");
      setEditBusy(null);
      return;
    }

    // The write has landed. Close the editor even if refreshing the composed
    // preview fails, so a successful save is never presented as unsaved work.
    setEditor(null);
    try {
      setState({ status: 'ready', data: await fetchAgentInstructions() });
    } catch (err) {
      setState({
        status: 'error',
        message: `Description saved, but the preview couldn't refresh: ${err instanceof Error ? err.message : 'unknown error'}`,
      });
    } finally {
      setEditBusy(null);
    }
  };

  const displayedPreambleChars = editor ? editor.value.trim().length : state.status === 'ready' ? state.data.preambleChars : 0;
  const displayedPreambleTruncated = editor ? displayedPreambleChars > PREAMBLE_CAP : state.status === 'ready' && state.data.truncated;
  return (
    <section
      className="bg-white border border-line rounded-lg px-4 py-3 space-y-3"
      aria-labelledby="agent-instructions-title"
      data-testid="agent-instructions-section"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 id="agent-instructions-title" className="text-xs font-medium text-ink">
          What agents are told about this knowledge base
        </h2>
        {canEdit && !editor && (
          <Button
            size="sm"
            leadingIcon={<Pencil size={12} />}
            onClick={() => void beginEdit()}
            disabled={editBusy !== null}
          >
            {editBusy === 'loading' ? 'Loading editor…' : 'Edit description'}
          </Button>
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
      {editError && (
        <div role="alert" className="text-xs text-danger bg-danger-soft border border-danger rounded-sm px-2 py-1.5">
          {editError}
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
                className={`text-meta ${displayedPreambleTruncated ? 'text-wait' : 'text-ink-muted'}`}
                data-testid="preamble-count"
              >
                {count(displayedPreambleChars, PREAMBLE_CAP)}
              </span>
            </div>
            {displayedPreambleTruncated && (
              <p role="alert" className={WARNING}>
                Over the cap: agents receive only the first {PREAMBLE_CAP.toLocaleString('en-US')} characters. Shorten
                the description.
              </p>
            )}
            {state.data.unterminatedComment && (
              <p role="alert" className={WARNING}>
                A comment is left open: everything after the last <span className="font-mono">&lt;!--</span> is withheld
                from agents. Close it with <span className="font-mono">--&gt;</span> in {PREAMBLE_FILE}.
              </p>
            )}
            {editor ? (
              <div className="space-y-2">
                <textarea
                  aria-label="Your description"
                  className={`${BOX} block w-full min-h-[44px] max-h-56 [field-sizing:content] resize-y leading-snug text-ink focus:outline-2 focus:outline-offset-1 focus:outline-ink-muted`}
                  rows={1}
                  value={editor.value}
                  onChange={(event) => setEditor({ ...editor, value: event.target.value })}
                  placeholder="Describe what this knowledge base holds, what is where, and when agents should look here first."
                  autoFocus
                />
                <div className="flex items-center justify-end gap-2">
                  <Button
                    size="sm"
                    variant="quiet"
                    onClick={() => {
                      setEditor(null);
                      setEditError(null);
                    }}
                    disabled={editBusy === 'saving'}
                  >
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => void saveEdit()}
                    disabled={editBusy === 'saving' || editor.value === editor.description}
                  >
                    {editBusy === 'saving' ? 'Saving…' : 'Save description'}
                  </Button>
                </div>
              </div>
            ) : state.data.preamble ? (
              <div className={`${BOX} max-h-56 overflow-y-auto overflow-x-hidden break-words`} data-testid="description-text">
                <Markdown className={DESCRIPTION_MARKDOWN}>{state.data.preamble}</Markdown>
              </div>
            ) : (
              <p className={`${BOX} text-ink-muted leading-snug`} data-testid="description-empty">
                Nothing written yet, so agents get the platform message only. Describe what this knowledge base holds,
                what is where, and when to look here first.
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
