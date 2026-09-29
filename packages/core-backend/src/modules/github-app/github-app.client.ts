import { createSign } from 'node:crypto';

/** A GitHub App's identity and keys, as GitHub issued them. */
export interface GitHubAppCredentials {
  appId: string;
  slug: string;
  /** PEM. */
  privateKey: string;
  clientId: string;
  clientSecret: string;
}

/** What GitHub hands back when an app is created from a manifest. */
export interface RegisteredApp extends GitHubAppCredentials {
  /** The account that owns the app. */
  owner: string;
  htmlUrl: string;
}

export interface Installation {
  id: string;
  /** The user or organisation it is installed on. */
  account: string;
  /** `all`, or `selected` when the admin chose repositories. */
  repositorySelection: string;
}

export interface InstallationToken {
  token: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

export interface InstallationRepository {
  /** `owner/name`. */
  fullName: string;
  private: boolean;
  defaultBranch: string;
  /** Whether the installation may push to it. */
  writable: boolean;
}

export type GitHubFailureKind = 'unreachable' | 'refused' | 'not-found' | 'unexpected';

/** A call to GitHub that did not give what was asked. The message never carries a credential. */
export class GitHubAppError extends Error {
  constructor(
    readonly kind: GitHubFailureKind,
    message: string,
    readonly status = 0,
  ) {
    super(message);
    this.name = 'GitHubAppError';
  }
}

const API = 'https://api.github.com';
const WEB = 'https://github.com';
const API_VERSION = '2022-11-28';
/** Repositories listed per installation before the list is said to be cut short. */
const MAX_REPOSITORIES = 500;

/**
 * A private key as an operator is likely to have supplied it: the PEM
 * itself, the PEM with its line breaks written as `\n` (the only way most
 * environment files can hold it), or the PEM in base64.
 */
export function normalizePrivateKey(raw: string): string {
  const value = raw.trim();
  if (value.includes('-----BEGIN')) return value.replace(/\\n/g, '\n');
  try {
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    if (decoded.includes('-----BEGIN')) return decoded.trim();
  } catch {
    // Not base64: handed on as it is, and the signing says what is wrong with it.
  }
  return value;
}

/**
 * The JWT an app presents to GitHub as itself: RS256 over its id, good for
 * a few minutes. Issued a minute in the past, as GitHub advises, so a clock
 * that runs slightly ahead of theirs is not refused.
 */
export function appJwt(credentials: Pick<GitHubAppCredentials, 'appId' | 'privateKey'>, now: number = Date.now()): string {
  const seconds = Math.floor(now / 1000);
  const part = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  const body = `${part({ alg: 'RS256', typ: 'JWT' })}.${part({ iat: seconds - 60, exp: seconds + 9 * 60, iss: credentials.appId })}`;
  let signature: string;
  try {
    signature = createSign('RSA-SHA256').update(body).end().sign(normalizePrivateKey(credentials.privateKey), 'base64url');
  } catch {
    // What the key was is never quoted.
    throw new GitHubAppError('refused', 'The GitHub App private key could not be read. It must be the PEM GitHub issued.');
  }
  return `${body}.${signature}`;
}

/**
 * What the deployment asks of GitHub, as a GitHub App: every call it makes,
 * and nothing that decides anything. Injected with `fetch` so suites answer
 * for GitHub.
 */
export class GitHubAppClient {
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  /** The app GitHub created from a manifest, for the code it sent the browser back with. Good once, for an hour. */
  async convertManifest(code: string): Promise<RegisteredApp> {
    const body = await this.call<Record<string, unknown>>(`${API}/app-manifests/${encodeURIComponent(code)}/conversions`, {
      method: 'POST',
    });
    const owner = (body.owner as { login?: unknown } | undefined)?.login;
    const app: RegisteredApp = {
      appId: String(body.id ?? ''),
      slug: String(body.slug ?? ''),
      privateKey: String(body.pem ?? ''),
      clientId: String(body.client_id ?? ''),
      clientSecret: String(body.client_secret ?? ''),
      owner: typeof owner === 'string' ? owner : '',
      htmlUrl: String(body.html_url ?? ''),
    };
    if (!app.appId || !app.slug || !app.privateKey || !app.clientId || !app.clientSecret) {
      throw new GitHubAppError('unexpected', 'GitHub created the app but did not return its keys.');
    }
    return app;
  }

  /**
   * A token for the PERSON who has just come back from GitHub, in exchange
   * for the code they came back with. Used for one question (see
   * {@link installationsOf}) and then dropped.
   */
  async exchangeUserCode(credentials: Pick<GitHubAppCredentials, 'clientId' | 'clientSecret'>, code: string): Promise<string> {
    const body = await this.call<Record<string, unknown>>(`${WEB}/login/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: credentials.clientId, client_secret: credentials.clientSecret, code }),
    });
    // GitHub answers a refused exchange with 200 and an `error` field.
    if (typeof body.access_token !== 'string' || !body.access_token) {
      throw new GitHubAppError('refused', 'GitHub did not accept the sign-in that came back with the installation.');
    }
    return body.access_token;
  }

  /** The installations of this app that the person holding `userToken` can reach. */
  async installationsOf(userToken: string): Promise<Installation[]> {
    const found: Installation[] = [];
    for (let page = 1; page <= 10; page += 1) {
      const body = await this.call<{ installations?: unknown[] }>(`${API}/user/installations?per_page=100&page=${page}`, {
        headers: { Authorization: `Bearer ${userToken}` },
      });
      const batch = Array.isArray(body.installations) ? body.installations : [];
      for (const item of batch) found.push(installationOf(item));
      if (batch.length < 100) break;
    }
    return found;
  }

  /** One installation, asked for as the app. */
  async installation(credentials: GitHubAppCredentials, id: string): Promise<Installation> {
    const body = await this.call<unknown>(`${API}/app/installations/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${appJwt(credentials, this.now())}` },
    });
    return installationOf(body);
  }

  /** A token for the installation: what git presents. Good for an hour. */
  async installationToken(credentials: GitHubAppCredentials, id: string): Promise<InstallationToken> {
    const body = await this.call<Record<string, unknown>>(`${API}/app/installations/${encodeURIComponent(id)}/access_tokens`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${appJwt(credentials, this.now())}` },
    });
    const expiresAt = Date.parse(String(body.expires_at ?? ''));
    if (typeof body.token !== 'string' || !body.token || Number.isNaN(expiresAt)) {
      throw new GitHubAppError('unexpected', 'GitHub did not return a token for the installation.');
    }
    return { token: body.token, expiresAt };
  }

  /** The repositories the installation reaches, and whether the list was cut short. */
  async repositories(installationToken: string): Promise<{ repositories: InstallationRepository[]; more: boolean }> {
    const repositories: InstallationRepository[] = [];
    let total = 0;
    for (let page = 1; repositories.length < MAX_REPOSITORIES; page += 1) {
      const body = await this.call<{ total_count?: unknown; repositories?: unknown[] }>(
        `${API}/installation/repositories?per_page=100&page=${page}`,
        { headers: { Authorization: `Bearer ${installationToken}` } },
      );
      total = typeof body.total_count === 'number' ? body.total_count : total;
      const batch = Array.isArray(body.repositories) ? body.repositories : [];
      for (const item of batch) {
        const repo = item as Record<string, unknown>;
        if (typeof repo.full_name !== 'string') continue;
        repositories.push({
          fullName: repo.full_name,
          private: repo.private === true,
          defaultBranch: typeof repo.default_branch === 'string' ? repo.default_branch : '',
          writable: (repo.permissions as { push?: unknown } | undefined)?.push === true,
        });
      }
      if (batch.length < 100) break;
    }
    repositories.sort((a, b) => a.fullName.localeCompare(b.fullName));
    return { repositories, more: total > repositories.length };
  }

  private async call<T>(url: string, init: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        ...init,
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': API_VERSION,
          'User-Agent': 'hexis',
          ...(init.headers as Record<string, string> | undefined),
        },
      });
    } catch (err) {
      throw new GitHubAppError('unreachable', `GitHub could not be reached: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok) {
      // GitHub's own words name the cause (a permission, a suspended app) and carry no credential of ours.
      const said = ((await res.json().catch(() => ({}))) as { message?: unknown }).message;
      const detail = typeof said === 'string' && said ? `: ${said.slice(0, 200)}` : '';
      const kind: GitHubFailureKind = res.status === 404 ? 'not-found' : res.status === 401 || res.status === 403 ? 'refused' : 'unexpected';
      throw new GitHubAppError(kind, `GitHub answered ${res.status}${detail}`, res.status);
    }
    return (await res.json().catch(() => ({}))) as T;
  }
}

function installationOf(raw: unknown): Installation {
  const item = (raw ?? {}) as Record<string, unknown>;
  const account = (item.account as { login?: unknown } | undefined)?.login;
  return {
    id: String(item.id ?? ''),
    account: typeof account === 'string' ? account : '',
    repositorySelection: typeof item.repository_selection === 'string' ? item.repository_selection : '',
  };
}
