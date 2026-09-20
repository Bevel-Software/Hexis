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

/**
 * A declared `${VAR}` of an mcp.json server, exactly as plugin.json stores it.
 * `oauth` makes it a sign-in (user-scoped only): the owner's OAuth app's client
 * id, and optionally the provider endpoints — absent, they are discovered from
 * the server's own OAuth metadata. PKCE is on unless `pkce: false`. The client
 * SECRET is never here; it lives in the vault, set on the tool's page.
 */
export interface McpServerVariable {
  name: string;
  scope: 'admin' | 'user';
  label?: string;
  oauth?: {
    authorizationUrl?: string;
    tokenUrl?: string;
    clientId: string;
    scopes?: string[];
    authParams?: Record<string, string>;
    pkce?: boolean;
    resource?: string;
  };
}

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
  variables: McpServerVariable[];
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
  if (res.status === 404) {
    // Two 404s share this status and only ONE is an absence: `Not found` is
    // the expected no-server-pair case (a .tool-backed manual), while `Not
    // available` means the edit service isn't wired at all — a deployment
    // fault that must surface, not render as a quietly server-less page.
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    if (body?.error === 'Not found') return null;
    throw new Error(body?.error ?? "Couldn't load the server configuration.");
  }
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

/**
 * A tool that exists only on an open change request's branch — proposed, and
 * waiting on somebody to approve it. The mirror of `PendingSkillSummary`, and
 * separate from every catalog type for the same reason: it is not in the
 * catalog, nothing registers it, nothing calls it, and it is visible only to
 * its author and to whoever could approve it.
 */
export interface PendingToolSummary {
  slug: string;
  name: string;
  /** The `.tool` file, or the plugin's `mcp.json` — what the card files under. */
  path: string;
  type: 'inline' | 'http' | 'mcp';
  description?: string;
  /** The plugin folder the declaration targets, or null when it targets none. */
  plugin: string | null;
  changeRequestNumber: number;
  branch: string;
  authorName: string;
  createdAt: string;
  /** True when the caller proposed it themselves. */
  isAuthor: boolean;
}

/**
 * Tools awaiting approval that the caller may see. The backend does the
 * filtering — author or possible approver — so this is a plain read.
 */
export async function listPendingTools(): Promise<PendingToolSummary[]> {
  const res = await authFetch('/api/tools/pending');
  if (!res.ok) await unwrap(res, "Couldn't load proposed tools.");
  const body = (await res.json()) as { tools?: PendingToolSummary[] } | null;
  // Guarded, not trusted: a backend BUILT BEFORE this route existed answers
  // through `/tools/:slug` — a 200 whose shape is not this one. The review
  // shelf degrading to empty is the right failure; `undefined` reaching the
  // item mapper takes the whole library down (blank page), which is exactly
  // what it did on the skills side before its own guard. A bare `null` body is
  // one of those shapes, and reading `.tools` off it would throw BEFORE the
  // guard ran — so the optional chain is the guard's first half, not decoration.
  return Array.isArray(body?.tools) ? body.tools : [];
}
