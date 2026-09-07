import { authFetch } from '../../../lib/api';

/**
 * What an Owner pastes into Claude's admin settings to register this
 * deployment as a GitHub Enterprise Server — the credentials hexis generated
 * for that purpose. Admins only; every field is shown so it can be copied.
 */
export interface GitHubFacadeCredentials {
  /** The hostname to register. */
  host: string;
  appId: string;
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
  privateKeyPem: string;
  /** The marketplace URL people paste in Cowork and claude.ai — the same one Claude Code clones. */
  marketplaceUrl: string;
  createdAt: number;
  rotatedAt: number | null;
}

async function unwrap(res: Response, fallback: string): Promise<never> {
  let serverError: string | undefined;
  try {
    const body = (await res.json()) as { error?: string };
    if (typeof body.error === 'string' && body.error.length > 0) serverError = body.error;
  } catch {
    // Non-JSON error body — fall through.
  }
  throw new Error(serverError ?? fallback);
}

export async function fetchGitHubFacade(): Promise<GitHubFacadeCredentials> {
  const res = await authFetch('/api/admin/github-facade');
  if (!res.ok) await unwrap(res, "Couldn't load the Claude connection.");
  return res.json() as Promise<GitHubFacadeCredentials>;
}

export async function rotateGitHubFacade(): Promise<GitHubFacadeCredentials> {
  const res = await authFetch('/api/admin/github-facade/rotate', { method: 'POST' });
  if (!res.ok) await unwrap(res, "Couldn't rotate the Claude connection.");
  return res.json() as Promise<GitHubFacadeCredentials>;
}
