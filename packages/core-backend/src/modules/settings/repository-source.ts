import { DEFAULT_GIT_USERNAME, type GitCredentials } from '../../shared/git.contract.js';
import type { ManagedRepository } from './managed-repository.js';

/**
 * The ways a deployment can be given the repository its knowledge base
 * lives in, in the order the setup screen offers them.
 *
 *  - `managed`: the deployment keeps the repository itself.
 *  - `github-app`: a repository on GitHub, reached through a GitHub App the
 *    admin installed on it.
 *  - `token`: any git host, by its address and an access token.
 */
export const GIT_MODES = ['managed', 'github-app', 'token'] as const;
export type GitMode = (typeof GIT_MODES)[number];

export function isGitMode(value: unknown): value is GitMode {
  return typeof value === 'string' && (GIT_MODES as readonly string[]).includes(value);
}

/** Reads one setting as it is in effect, or as it would be after a save. */
export type SettingReader = (key: string) => string;

/**
 * A repository reached through a GitHub App: which one, and the short-lived
 * token the app is given for it. Implemented by the GitHub App module; the
 * source only asks.
 */
export interface GitHubAppRepository {
  /** `https://github.com/<owner>/<name>.git`, or empty while none is chosen. */
  url(read: SettingReader): string;
  /** The installation token in hand, or null when there is none to give. */
  token(): string | null;
  /** Make sure {@link token} answers with one that is still good. */
  prepare(): Promise<void>;
  /** Whether the app, its installation and a repository are all there. */
  answered(read: SettingReader): boolean;
}

export interface RepositorySourceOptions {
  /** The deployment's settings, as they are in effect. */
  read: SettingReader;
  /**
   * What the environment gives the token mode beyond the settings
   * catalogue: the legacy spellings of the token variable, and the username
   * a deployment configured there.
   */
  fallback?: { username?: string; token?: string };
  managed: ManagedRepository;
  githubApp?: GitHubAppRepository;
}

/**
 * WHERE THE KNOWLEDGE BASE'S REPOSITORY IS, AND WHAT GIT PRESENTS TO IT —
 * the one place that knows there is more than one answer.
 *
 * Everything that runs git asks for two things: an address to clone from,
 * and a credential. Both used to be read straight from two settings, which
 * is one way of having a repository. With three ways, each reader deciding
 * for itself would be three places to disagree, so they all ask here, and
 * what they get back is the same two things as before.
 *
 * THE MODE IS INFERRED WHEN NOBODY CHOSE ONE. A deployment configured before
 * there was a choice has an address and a token and no mode; it is in
 * `token` mode, because that is what it has. One with nothing configured has
 * no mode, and the setup screen offers the first.
 */
export class RepositorySource {
  /** What git authenticates with, read on every call. */
  readonly credentials: GitCredentials;

  constructor(private readonly opts: RepositorySourceOptions) {
    this.credentials = {
      username: () => this.username(),
      token: () => this.token(),
      prepare: () => this.prepare(),
    };
  }

  /** The mode in effect, or the one a save of `read`'s values would put in effect. Null: nothing is configured. */
  mode(read: SettingReader = this.opts.read): GitMode | null {
    const chosen = read('gitMode').trim();
    if (isGitMode(chosen)) return chosen;
    return read('kbRepoUrl') || this.tokenIn(read) ? 'token' : null;
  }

  /** The address git clones from and pushes to. Empty while there is none. */
  url(read: SettingReader = this.opts.read): string {
    switch (this.mode(read)) {
      case 'managed':
        return this.opts.managed.path;
      case 'github-app':
        return this.opts.githubApp?.url(read) ?? '';
      case 'token':
        return read('kbRepoUrl');
      default:
        return '';
    }
  }

  /**
   * Whether the repository half of setup is answered: there is somewhere to
   * clone from and, where one is needed, something to present.
   */
  answered(read: SettingReader = this.opts.read): boolean {
    switch (this.mode(read)) {
      case 'managed':
        return true;
      case 'github-app':
        return this.opts.githubApp?.answered(read) ?? false;
      case 'token':
        return Boolean(read('kbRepoUrl') && this.tokenIn(read));
      default:
        return false;
    }
  }

  private username(): string {
    // Only a host that was given a token is given a name to go with it.
    if (this.mode() !== 'token') return DEFAULT_GIT_USERNAME;
    return this.opts.read('gitUsername') || this.opts.fallback?.username || DEFAULT_GIT_USERNAME;
  }

  /**
   * One mode's credential is never presented to another mode's repository:
   * a deployment that moved to a managed repository still has its old
   * token stored, and a path on its own disk has no use for it.
   */
  private token(): string | null {
    switch (this.mode()) {
      case 'token':
        return this.tokenIn(this.opts.read) || null;
      case 'github-app':
        return this.opts.githubApp?.token() ?? null;
      default:
        return null;
    }
  }

  private async prepare(): Promise<void> {
    if (this.mode() === 'github-app') await this.opts.githubApp?.prepare();
  }

  private tokenIn(read: SettingReader): string {
    // The fallback is the environment's, so it is in effect whatever a save brings.
    return read('gitToken') || this.opts.fallback?.token || '';
  }
}
