import { authFetch } from '../../../lib/api';

/** Caps the backend composer applies; mirrored so the card can show `N / cap`. */
export const PREAMBLE_CAP = 6_000;
export const TOOL_PREFIX_CAP = 300;

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
