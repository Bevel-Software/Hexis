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
  /**
   * Make sure {@link token} answers with one that is still good. `asked`
   * is for a caller waiting on the answer itself, who is told a failure.
   */
  prepare(opts?: { asked?: boolean }): Promise<void>;
  /** Whether the deployment may be pointed at this repository (`owner/name`). */
  permits(repository: string, read: SettingReader): boolean;
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
 * TWO MODES, AND THEY ARE NOT ALWAYS THE SAME ONE.
 *
 *  - The mode IN EFFECT is the one this process is running on. Its working
 *    copies are clones of that mode's repository, and every address and
 *    credential this class hands out is that mode's. It is taken when the
 *    source is built and changes only in {@link takeEffect}.
 *  - The mode CHOSEN is what the settings say. A save changes it at once.
 *
 * They differ between the save that moves a serving deployment and the
 * restart that save owes. Reading the mode live would move the process the
 * moment the setting was stored: the new mode's credential presented to the
 * old mode's repository, which every working copy still points at, and new
 * branches cloned from a repository the startup phase has not prepared. So
 * the process stays where it is until it is started again, which is what
 * the setup screen tells the admin.
 *
 * WITHIN a mode the values are read live, as they always were: a rotated
 * token is the one the next push carries.
 *
 * THE MODE IS INFERRED WHEN NOBODY CHOSE ONE. A deployment configured before
 * there was a choice has an address and a token and no mode; it is in
 * `token` mode, because that is what it has. One with nothing configured has
 * no mode, and the setup screen offers the first.
 */
export class RepositorySource {
  /** What git authenticates with, read on every call. */
  readonly credentials: GitCredentials;
  private inEffect: GitMode | null;

  constructor(private readonly opts: RepositorySourceOptions) {
    this.inEffect = this.chosen();
    this.credentials = {
      username: () => this.username(),
      token: () => this.token(),
      prepare: () => this.prepare(),
    };
  }

  /**
   * Without a reader, the mode IN EFFECT. With one, the mode a save of that
   * reader's values would CHOOSE: the answer validation wants, about values
   * that are not stored yet. Null: nothing is configured.
   */
  mode(read?: SettingReader): GitMode | null {
    return read ? this.chosen(read) : this.inEffect;
  }

  /** The mode the settings say, which a restart would put in effect. */
  chosen(read: SettingReader = this.opts.read): GitMode | null {
    const named = read('gitMode').trim();
    if (isGitMode(named)) return named;
    return read('kbRepoUrl') || this.tokenIn(read) ? 'token' : null;
  }

  /**
   * Put the mode chosen in effect. Called where nothing is using the mode
   * that was: by a save made before the deployment was serving, which the
   * startup phase follows. A process that is serving is never moved; it is
   * restarted, and built on the mode chosen.
   */
  takeEffect(): void {
    this.inEffect = this.chosen();
  }

  /** The address git clones from and pushes to. Empty while there is none. Asked as {@link mode} is. */
  url(read?: SettingReader): string {
    const from = read ?? this.opts.read;
    switch (this.mode(read)) {
      case 'managed':
        return this.opts.managed.path;
      case 'github-app':
        return this.opts.githubApp?.url(from) ?? '';
      case 'token':
        return from('kbRepoUrl');
      default:
        return '';
    }
  }

  /**
   * Whether the repository half of setup is answered: there is somewhere to
   * clone from and, where one is needed, something to present. Asked as
   * {@link mode} is.
   */
  answered(read?: SettingReader): boolean {
    const from = read ?? this.opts.read;
    switch (this.mode(read)) {
      case 'managed':
        return true;
      case 'github-app':
        return this.opts.githubApp?.answered(from) ?? false;
      case 'token':
        return Boolean(from('kbRepoUrl') && this.tokenIn(from));
      default:
        return false;
    }
  }

  private username(): string {
    // Only a host that was given a token is given a name to go with it.
    if (this.inEffect !== 'token') return DEFAULT_GIT_USERNAME;
    return this.opts.read('gitUsername') || this.opts.fallback?.username || DEFAULT_GIT_USERNAME;
  }

  /**
   * One mode's credential is never presented to another mode's repository:
   * a deployment that moved to a managed repository still has its old
   * token stored, and a path on its own disk has no use for it. The mode is
   * the one IN EFFECT, because that is the repository git is talking to.
   */
  private token(): string | null {
    switch (this.inEffect) {
      case 'token':
        return this.tokenIn(this.opts.read) || null;
      case 'github-app':
        return this.opts.githubApp?.token() ?? null;
      default:
        return null;
    }
  }

  private async prepare(): Promise<void> {
    if (this.inEffect === 'github-app') await this.opts.githubApp?.prepare();
  }

  private tokenIn(read: SettingReader): string {
    // The fallback is the environment's, so it is in effect whatever a save brings.
    return read('gitToken') || this.opts.fallback?.token || '';
  }
}

