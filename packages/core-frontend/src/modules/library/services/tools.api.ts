import { authFetch } from '../../../lib/api';

/**
 * The browser tool-detail read (`GET /api/tools/:slug`) — the two human-facing
 * fields the catalog listing has no use for.
 *
 * Deliberately NOT the same surface as `tool-secrets.api.ts`. That one answers
 * "what does this person still owe this tool"; this one answers "what IS this
 * tool". The tool page needs both, from two endpoints, with different failure
 * postures: a secrets failure is a page error, a detail failure is a degraded
 * page that still connects. Keeping them apart is what makes that possible.
 *
 * The wire carries the full summary (`variables`, `remote`, `setup`) too; the
 * page reads those from the secrets surface instead, where they arrive with the
 * caller's config status attached, so they are not mirrored here.
 */

/** One thing an inline manual's embedded tool list says the assistant can do. */
export interface ToolCapability {
  name: string;
  description: string | null;
}

export interface ToolManualDetail {
  slug: string;
  name: string;
  path: string;
  type: 'inline' | 'http' | 'mcp';
  /** The `.tool` frontmatter description, or null when the file declares none. */
  description: string | null;
  /**
   * `[]` for every `http`/`mcp` manual — those resolve their tools at call time,
   * which this endpoint deliberately does not do. Hide the section on
   * EMPTINESS, never on `type`: an inline tool with no embedded tools is the
   * same "nothing to show" as a remote one.
   */
  capabilities: ToolCapability[];
}

async function unwrap(res: Response, fallback: string): Promise<never> {
  let message = fallback;
  try {
    const body = (await res.json()) as { error?: string };
    if (body?.error) message = body.error;
  } catch {
    // non-JSON body — keep the fallback
  }
  throw new Error(message);
}

/**
 * One readable tool by slug. A 404 means "no such tool, or not yours" — the
 * backend keeps those indistinguishable on purpose, so callers must not try to
 * tell them apart either.
 */
export async function getToolDetail(slug: string): Promise<ToolManualDetail> {
  const res = await authFetch(`/api/tools/${encodeURIComponent(slug)}`);
  if (!res.ok) await unwrap(res, "Couldn't load this tool.");
  return ((await res.json()) as { tool: ToolManualDetail }).tool;
}

/**
 * The server-scoped view/edit surface for an mcp.json-backed tool. One
 * server's truth spans two files (mcp.json + plugin.json's extensions block);
 * these endpoints are the pair kept in step, so the form never shows a writer
 * half of it. Absent (404) for `.tool`-backed manuals — those edit as files.
 */
export type McpTransport = 'streamable-http' | 'sse' | 'stdio';

export interface McpServerView {
  name: string;
  transport: McpTransport;
  url?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  literalHeaders: Record<string, string>;
  authHeaders: Record<string, string>;
  variables: { name: string; scope: 'admin' | 'user'; label?: string }[];
  description?: string;
  local: boolean;
  canWrite: boolean;
}

export type McpServerWrite = Omit<Partial<McpServerView>, 'name' | 'canWrite'> & {
  transport: McpTransport;
  newName?: string;
};

export async function getMcpServer(slug: string): Promise<McpServerView | null> {
  const res = await authFetch(`/api/tools/${encodeURIComponent(slug)}/server`);
  if (res.status === 404) return null; // a .tool-backed manual — no server pair
  if (!res.ok) await unwrap(res, "Couldn't load the server configuration.");
  return (await res.json()) as McpServerView;
}

export async function putMcpServer(slug: string, write: McpServerWrite): Promise<{ name: string }> {
  const res = await authFetch(`/api/tools/${encodeURIComponent(slug)}/server`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(write),
  });
  if (!res.ok) await unwrap(res, "Couldn't save the server configuration.");
  return (await res.json()) as { name: string };
}
