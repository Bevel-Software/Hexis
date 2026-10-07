/**
 * The embed page's HTTP surface.
 *
 * Deliberately NOT `authFetch`: there is no session here, and there must not
 * be one. The embed page is framed by any host, so a cookie that travelled
 * into that frame would let a hostile page read and write as whoever happened
 * to be signed in. Every call below carries the embed token and nothing else,
 * and every route refuses a request without one.
 */

/** What the embed page renders, as `GET /api/embed/load` answers it. */
export interface EmbedFileView {
  nodeName: string;
  repoRelative: string;
  /** Workspace-relative path (`<kbDir>/<repoRelative>`) — what the app's renderers take. */
  workspacePath: string;
  kbDirName: string;
  branch: string;
  /** The file's address in the app, absolute. */
  appUrl: string;
  /** The heading the view should open at, when the agent named one. */
  heading?: string;
  content: string;
  /** False for a file whose renderer fetches its own bytes (an image, a PDF). */
  contentIsText: boolean;
  linked: boolean;
  canRead: boolean;
  canWrite: boolean;
  linkUrl: string;
}

export interface EmbedLockResult {
  acquired: boolean;
  holderName?: string;
}

export interface EmbedProposalResult {
  branch: string;
  number?: number;
  url?: string;
}

/**
 * A refusal from an embed route, with its status — so the page can tell an
 * expired token (401, show the expired sentence) from a lock somebody else
 * holds (403/409, say who) from a real failure.
 */
export class EmbedApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'EmbedApiError';
    this.status = status;
  }
}

async function failure(res: Response): Promise<EmbedApiError> {
  let message = `HTTP ${res.status}`;
  try {
    const body = (await res.json()) as { error?: unknown } | null;
    if (typeof body?.error === 'string' && body.error) message = body.error;
  } catch {
    /* not JSON — the status is the whole of what we know */
  }
  return new EmbedApiError(res.status, message);
}

async function post(path: string, body: Record<string, unknown>): Promise<Response> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await failure(res);
  return res;
}

export async function loadEmbed(token: string): Promise<EmbedFileView> {
  const res = await fetch(`/api/embed/load?token=${encodeURIComponent(token)}`);
  if (!res.ok) throw await failure(res);
  return (await res.json()) as EmbedFileView;
}

/**
 * The URL that serves a file's bytes under this token — what the app's
 * byte-reading renderers put in an `<img src>` or fetch themselves.
 *
 * `path` is omitted for the embedded file itself and given for one beside it
 * (a picture a markdown page shows); the server resolves it relative to the
 * embedded file and re-checks the viewer's read access on it.
 */
export function embedRawUrl(
  token: string,
  path?: string,
  options: { version?: number } = {},
): string {
  let url = `/api/embed/raw?token=${encodeURIComponent(token)}`;
  if (path) url += `&path=${encodeURIComponent(path)}`;
  // A cache key, so a replaced picture reaches an open view. Absent or 0 adds
  // nothing, keeping the URL stable and browser-cacheable.
  if (options.version) url += `&v=${options.version}`;
  return url;
}

export async function lockEmbed(token: string): Promise<EmbedLockResult> {
  const res = await post('/api/embed/lock', { token });
  return (await res.json()) as EmbedLockResult;
}

export async function heartbeatEmbed(token: string): Promise<void> {
  await post('/api/embed/heartbeat', { token });
}

export async function cancelEmbed(token: string): Promise<void> {
  await post('/api/embed/cancel', { token });
}

export async function saveEmbed(token: string, content: string): Promise<void> {
  await post('/api/embed/save', { token, content });
}

export async function proposeEmbed(token: string, content: string): Promise<EmbedProposalResult> {
  const res = await post('/api/embed/propose', { token, content });
  return (await res.json()) as EmbedProposalResult;
}

/** Link the token's outside account to the signed-in user (the link page). */
export async function linkEmbedAccount(token: string, bearer: string | null): Promise<void> {
  const res = await fetch('/api/embed/link', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify({ token }),
  });
  if (!res.ok) throw await failure(res);
}
