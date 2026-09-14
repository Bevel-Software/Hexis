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

/**
 * Whether an admin has marked this deployment registered with their Claude
 * organization. Any signed-in person may ask — the answer is a boolean and
 * nothing else — so the External agent access page can show the tutorial or
 * the "an admin has to set this up" notice.
 */
export async function fetchMarketplaceRegistration(): Promise<boolean> {
  const res = await authFetch('/api/github-facade/registration');
  if (!res.ok) await unwrap(res, "Couldn't check whether the marketplace is set up.");
  return ((await res.json()) as { registered: boolean }).registered === true;
}

/** Admins only: say the deployment is (or is no longer) registered with Claude. */
export async function setMarketplaceRegistration(registered: boolean): Promise<boolean> {
  const res = await authFetch('/api/admin/github-facade/registration', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ registered }),
  });
  if (!res.ok) await unwrap(res, "Couldn't save the marketplace registration.");
  return ((await res.json()) as { registered: boolean }).registered === true;
}

export async function rotateGitHubFacade(): Promise<GitHubFacadeCredentials> {
  const res = await authFetch('/api/admin/github-facade/rotate', { method: 'POST' });
  if (!res.ok) await unwrap(res, "Couldn't rotate the Claude connection.");
  return res.json() as Promise<GitHubFacadeCredentials>;
}
