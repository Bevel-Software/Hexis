import { DEFAULT_BRANCH } from '@bevel-software/platform-shared';
import { authFetch } from '../../../lib/api';
import {
  WorkspaceApiError,
  getOrCreateWorkspace,
  readFile,
  writeFile,
} from '../../workspace/services/workspace.api';

/** Caps the backend composer applies; mirrored so the card can show `N / cap`. */
export const PREAMBLE_CAP = 6_000;

/** The file an admin edits, at the repository root on the default branch. */
export const PREAMBLE_FILE = 'mcp-description.md';

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
 * Split the repository file into its public description and private comments.
 * This deliberately mirrors the backend composer's fail-closed comment rule:
 * an unclosed comment hides the rest of the file.
 */
export function editableDescriptionFromSource(source: string): string {
  let description = '';
  let from = 0;
  for (;;) {
    const open = source.indexOf('<!--', from);
    if (open === -1) {
      description += source.slice(from);
      break;
    }
    description += source.slice(from, open);
    const close = source.indexOf('-->', open + 4);
    if (close === -1) break;
    from = close + 3;
  }
  return description.replace(/\r\n?/g, '\n').trim();
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
    // an empty editor; the normal write path creates it on Save.
    if (!(err instanceof WorkspaceApiError) || err.status !== 404) throw err;
  }
  return {
    workspaceId: workspace.id,
    source,
    description: editableDescriptionFromSource(source),
  };
}

/** Save the public description without discarding private source comments. */
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
  );
}
