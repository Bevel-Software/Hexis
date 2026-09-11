import {
  DEFAULT_BRANCH,
  PREAMBLE_CAP,
  PREAMBLE_FILE,
  TOOL_PREFIX_CAP,
  stripHtmlComments,
} from '@bevel-software/platform-shared';
import { authFetch } from '../../../lib/api';
import {
  WorkspaceApiError,
  getOrCreateWorkspace,
  readFile,
  writeFile,
} from '../../workspace/services/workspace.api';

// The caps, the file name and the comment rule come from
// `@bevel-software/platform-shared`, the same module the backend composer
// reads them from: the card shows what the composer sends, and a mirrored
// copy here would eventually show one thing while agents received another.
// Re-exported so the card keeps importing them from its own service module.
export { PREAMBLE_CAP, PREAMBLE_FILE, TOOL_PREFIX_CAP };

/** What `GET /api/agent/instructions` answers: the composer's result. */
export interface AgentInstructions {
  /** The header, then the preamble body: what the initialize handshake carries. */
  instructions: string;
  /** The fixed platform message, sent first. Not editable. */
  header: string;
  /** The admin's description as sent (cut and marked when over the cap); empty when there is none. */
  preamble: string;
  /** The fixed first sentence of the tool prefix; the rest is the admin's first paragraph. */
  toolPrefixLine: string;
  /** The fixed line, then the first paragraph: what the four knowledge-base tools carry. */
  toolPrefix: string;
  /** The preamble was cut at the cap. */
  truncated: boolean;
  /** Preamble length before the cut. */
  preambleChars: number;
  /** The tool prefix was cut at its cap. */
  toolPrefixTruncated: boolean;
  /** Tool prefix length before the cut. */
  toolPrefixChars: number;
  /** The file has a `<!--` with no `-->`; everything after it is withheld. */
  unterminatedComment: boolean;
}

export interface EditableAgentDescription {
  /** Default-branch workspace used for the eventual save. */
  workspaceId: string;
  /** Full file bytes, retained so private HTML comments survive the inline edit. */
  source: string;
  /** Only the text agents receive; private HTML comments are omitted. */
  description: string;
}

/**
 * The public description inside the repository file: what agents receive, and
 * so the only thing the editor shows. The comment rule is the composer's own
 * (`stripHtmlComments`), not a copy of it, so an unclosed comment hides the
 * rest of the file here exactly as it does for agents.
 */
export function editableDescriptionFromSource(source: string): string {
  return stripHtmlComments(source).text.replace(/\r\n?/g, '\n').trim();
}

/**
 * Whether the file holds a `<!--` that is never closed, which withholds
 * everything after it from agents.
 *
 * The card needs this to offer a way OUT of that state: the broken comment is
 * in the part the editor does not show, so the visible text can be unchanged
 * while the file is still hiding content, and `mergeEditableDescription`
 * closes the comment on save.
 */
export function sourceHasUnterminatedComment(source: string): boolean {
  return stripHtmlComments(source).unterminated;
}

/**
 * Replace the agent-visible text while retaining every private HTML comment.
 * Comments are collected ahead of the public text because their exact source
 * position is not represented in the inline editor. An unclosed comment is
 * closed so the newly saved description cannot accidentally remain hidden.
 */
export function mergeEditableDescription(source: string, description: string): string {
  const comments: string[] = [];
  let from = 0;
  for (;;) {
    const open = source.indexOf('<!--', from);
    if (open === -1) break;
    const close = source.indexOf('-->', open + 4);
    if (close === -1) {
      comments.push(`${source.slice(open).trimEnd()}\n-->`);
      break;
    }
    comments.push(source.slice(open, close + 3));
    from = close + 3;
  }

  const publicText = description.replace(/\r\n?/g, '\n').trim();
  const parts = [...comments, publicText].filter((part) => part.length > 0);
  return parts.length > 0 ? `${parts.join('\n\n')}\n` : '';
}

/**
 * What every connected agent is told at session start, as the hosted proxy
 * composes it. Read through the browser session: the route accepts a JWT
 * beside the agent credentials, because it is the same text an agent gets.
 */
export async function fetchAgentInstructions(): Promise<AgentInstructions> {
  const res = await authFetch('/api/agent/instructions');
  if (!res.ok) {
    let serverError: string | undefined;
    try {
      const body = (await res.json()) as { error?: string };
      if (typeof body.error === 'string' && body.error.length > 0) serverError = body.error;
    } catch {
      // Non-JSON error body: fall through to the fallback.
    }
    throw new Error(serverError ?? "Couldn't load what connected agents are told.");
  }
  return res.json() as Promise<AgentInstructions>;
}

/** Load the raw default-branch file for an admin's inline edit. */
export async function fetchEditableAgentDescription(kbDirName: string): Promise<EditableAgentDescription> {
  const { workspace } = await getOrCreateWorkspace(DEFAULT_BRANCH);
  const path = `${kbDirName}/${PREAMBLE_FILE}`;
  let source = '';
  try {
    source = await readFile(workspace.id, path);
  } catch (err) {
    // A pre-template knowledge base may not have the file yet. Treat that as
    // an empty editor; the normal write path creates it on Save. Only a 404
    // means that: the file route answers 404 for a missing file alone and
    // gives any other read failure its own status, so an unreadable file
    // surfaces as an error here instead of an empty editor over live text.
    if (!(err instanceof WorkspaceApiError) || err.status !== 404) throw err;
  }
  return {
    workspaceId: workspace.id,
    source,
    description: editableDescriptionFromSource(source),
  };
}

/**
 * Save the public description without discarding private source comments.
 *
 * `source` is both the snapshot the private comments are merged out of and
 * the write's precondition: the file must still hold exactly it, or the
 * backend refuses with a 409. Without that, an editor left open while
 * another admin saves would put its stale comments back and drop theirs.
 */
export async function saveAgentDescription(
  workspaceId: string,
  kbDirName: string,
  source: string,
  description: string,
): Promise<void> {
  await writeFile(
    workspaceId,
    `${kbDirName}/${PREAMBLE_FILE}`,
    mergeEditableDescription(source, description),
    { ifMatch: source },
  );
}
