import { logger } from '../../shared/logging.js';
import type { GitHubAppRepository, SettingReader } from '../settings/repository-source.js';
import {
  GitHubAppClient,
  type GitHubAppCredentials,
  type InstallationRepository,
} from './github-app.client.js';

/** Renewed this long before it would expire, so no git call starts on a token with minutes to live. */
const RENEW_AHEAD_MS = 10 * 60_000;

export interface GitHubAppConnectionOptions {
  /** The deployment's settings, as they are in effect. */
  read: SettingReader;
  /** Where a setting's value comes from: what tells an app the operator supplied from one setup registered. */
  sourceOf(key: string): 'env' | 'stored' | 'unset';
  client?: GitHubAppClient;
  now?: () => number;
}

/**
 * The deployment's connection to GitHub through a GitHub App: the app it
 * acts as, the installation it was given, and the token that stands for
 * both when git runs.
 *
 * THE TOKEN EXPIRES. An installation token is good for an hour, which is
 * the point of it: nothing long-lived is stored that reaches the
 * repository. It is kept in memory, renewed before it runs out, and never
 * written anywhere. A deployment that restarts asks for a new one.
 *
 * What is stored is what cannot be asked for again: the app's private key,
 * encrypted like every secret, and the number of the installation.
 */
export class GitHubAppConnection implements GitHubAppRepository {
  private readonly client: GitHubAppClient;
  private readonly now: () => number;
  private readonly log = () => logger('github-app');
  /** The token in hand and what it is a token FOR: another app or installation is another token. */
  private held: { for: string; token: string; expiresAt: number } | null = null;
  /** One renewal at a time, shared by every git call that arrives during it. */
  private renewing: Promise<void> | null = null;

  constructor(private readonly opts: GitHubAppConnectionOptions) {
    this.client = opts.client ?? new GitHubAppClient();
    this.now = opts.now ?? Date.now;
  }

  /** The app the deployment acts as, or null while any part of it is missing. */
  credentials(read: SettingReader = this.opts.read): GitHubAppCredentials | null {
    const credentials = {
      appId: read('githubAppId'),
      slug: read('githubAppSlug'),
      privateKey: read('githubAppPrivateKey'),
      clientId: read('githubAppClientId'),
      clientSecret: read('githubAppClientSecret'),
    };
    return Object.values(credentials).every(Boolean) ? credentials : null;
  }

  /** Who supplied the app: whoever operates the deployment, or the setup screen. Null: there is none. */
  registeredBy(): 'environment' | 'setup' | null {
    if (!this.credentials()) return null;
    return this.opts.sourceOf('githubAppId') === 'env' ? 'environment' : 'setup';
  }

  installationId(read: SettingReader = this.opts.read): string {
    return read('githubInstallationId');
  }

  url(read: SettingReader = this.opts.read): string {
    const repository = read('githubRepository');
    return repository ? `https://github.com/${repository}.git` : '';
  }

  answered(read: SettingReader = this.opts.read): boolean {
    return Boolean(this.credentials(read) && this.installationId(read) && read('githubRepository'));
  }

  token(): string | null {
    const held = this.held;
    if (!held || held.for !== this.holder() || held.expiresAt <= this.now()) return null;
    return held.token;
  }

  /**
   * Have a token that will outlast the call about to be made. Asks GitHub
   * only when the one in hand is missing, is another installation's, or is
   * about to run out. Throws when GitHub will not give one; the token in
   * hand, if any, stays in hand.
   */
  async prepare(): Promise<void> {
    const credentials = this.credentials();
    const installationId = this.installationId();
    if (!credentials || !installationId) return;
    const held = this.held;
    if (held && held.for === this.holder() && held.expiresAt - this.now() > RENEW_AHEAD_MS) return;
    this.renewing ??= this.renew(credentials, installationId).finally(() => {
      this.renewing = null;
    });
    await this.renewing;
  }

  /** The repositories the installation reaches. */
  async repositories(): Promise<{ repositories: InstallationRepository[]; more: boolean }> {
    await this.prepare();
    const token = this.token();
    if (!token) return { repositories: [], more: false };
    return this.client.repositories(token);
  }

  /** Drop the token in hand: the installation it was for is no longer the deployment's. */
  forget(): void {
    this.held = null;
  }

  private async renew(credentials: GitHubAppCredentials, installationId: string): Promise<void> {
    const holder = this.holder();
    try {
      const issued = await this.client.installationToken(credentials, installationId);
      this.held = { for: holder, token: issued.token, expiresAt: issued.expiresAt };
    } catch (err) {
      this.log().error('GitHub gave no token for the installation:', { detail: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }

  private holder(): string {
    return `${this.opts.read('githubAppId')}:${this.installationId()}`;
  }
}
