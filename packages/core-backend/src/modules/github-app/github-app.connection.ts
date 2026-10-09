import { logger } from '../../shared/logging.js';
import type { GitHubAppRepository, SettingReader } from '../settings/repository-source.js';
import {
  GitHubAppClient,
  type GitHubAppCredentials,
  type InstallationRepository,
} from './github-app.client.js';

/** Renewed this long before it would expire, so no git call starts on a token with minutes to live. */
const RENEW_AHEAD_MS = 10 * 60_000;
/** How long a failed renewal is remembered the first time, and the most it grows to. */
const FIRST_WAIT_MS = 5_000;
const LONGEST_WAIT_MS = 5 * 60_000;

/** The repositories a person may connect, as a setting holds them: one `owner/name` a line. */
export function repositoriesAsSetting(names: string[]): string {
  return [...new Set(names.map((name) => name.trim()).filter(Boolean))].join('\n');
}

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
 * acts as, the installation it was given, the repositories it may be
 * pointed at, and the token that stands for the first two when git runs.
 *
 * THE TOKEN EXPIRES. An installation token is good for an hour, which is
 * the point of it: nothing long-lived is stored that reaches the
 * repository. It is kept in memory, renewed before it runs out, and never
 * written anywhere. A deployment that restarts asks for a new one.
 *
 * What is stored is what cannot be asked for again: the app's private key,
 * encrypted like every secret, the number of the installation, and the
 * repositories the person who connected it could push to.
 *
 * WHAT THE INSTALLATION REACHES IS NOT WHAT THE DEPLOYMENT MAY USE. An
 * installation's token reads and writes every repository the installation
 * covers. The person who connected it may hold far less: being able to
 * read ONE of those repositories is enough for GitHub to count the
 * installation among theirs. So the deployment is limited to what that
 * person could push to with their own account, recorded when they
 * connected (see {@link permits}); the installation's reach is what git
 * works through, never what is offered.
 */
export class GitHubAppConnection implements GitHubAppRepository {
  private readonly client: GitHubAppClient;
  private readonly now: () => number;
  private readonly log = () => logger('github-app');
  /** The token in hand and what it is a token FOR: another app or installation is another token. */
  private held: { for: string; token: string; expiresAt: number } | null = null;
  /** One renewal at a time, shared by every git call that arrives during it. */
  private renewing: Promise<void> | null = null;
  /** The last renewal failed: how many in a row have, and until when GitHub is not asked again. */
  private failed: { times: number; until: number } | null = null;
  /**
   * The settings that were empty the last time no token could be asked for,
   * so the log says so ONCE per state and not before every git call. A
   * deployment in this state used to run for hours with every push failing
   * and nothing in the log naming the cause.
   */
  private saidUnaskable: string | null = null;

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

  /**
   * Whether the deployment may be pointed at `repository`: it is one the
   * person who connected the installation could push to.
   *
   * An installation the OPERATOR supplied, through the environment, has no
   * such person. It is the operator's statement about their own
   * deployment, and everything it reaches is permitted, as everything an
   * access token reaches is.
   */
  permits(repository: string, read: SettingReader = this.opts.read): boolean {
    if (this.opts.sourceOf('githubInstallationId') === 'env') return true;
    const wanted = repository.trim().toLowerCase();
    if (!wanted) return false;
    // GitHub's names do not tell case apart.
    return read('githubRepositoriesPermitted')
      .split('\n')
      .some((name) => name.trim().toLowerCase() === wanted);
  }

  token(): string | null {
    const held = this.held;
    if (!held || held.for !== this.holder() || held.expiresAt <= this.now()) return null;
    return held.token;
  }

  /**
   * Have a token for the call about to be made, WITHOUT MAKING THE CALL
   * WAIT ON GITHUB UNLESS IT HAS TO. This runs before every git call the
   * deployment makes, the ones that never leave the disk included.
   *
   *  - A token with time to spare: nothing is asked.
   *  - A token that is good but close to running out: a renewal is started
   *    and the call goes ahead with the token in hand.
   *  - No token that is good: the call waits for one, and gets what GitHub
   *    says, unless GitHub has just failed to give one. A failure is
   *    remembered for a short while that grows with each one in a row, and
   *    inside it nothing is asked: git runs with no token, and a call that
   *    needed one is told so by the host, at once.
   *
   * `asked` is for an admin waiting on the answer itself (the setup screen
   * listing repositories, proving a connection): GitHub is asked whatever
   * is remembered, and the failure is thrown.
   *
   * `refused` is the git runner reporting that the host threw out the token
   * in hand. However much time the clock gives it, that token is dead: it is
   * dropped first, so nothing presents it again, and GitHub is asked for
   * another the way `asked` asks — now, and with the failure thrown. A
   * renewal that fails leaves NO token, which is what tells the runner not
   * to run the command again with the one the host just refused.
   */
  async prepare(opts: { asked?: boolean; refused?: boolean } = {}): Promise<void> {
    const credentials = this.credentials();
    const installationId = this.installationId();
    if (!credentials || !installationId) {
      // Said once per state: every git call lands here while it lasts.
      const empty = ['githubAppId', 'githubAppSlug', 'githubAppPrivateKey', 'githubAppClientId', 'githubAppClientSecret', 'githubInstallationId']
        .filter((key) => !this.opts.read(key))
        .join(', ');
      if (this.saidUnaskable !== empty) {
        this.saidUnaskable = empty;
        this.log().error(
          `no installation token can be asked for while these settings are empty: ${empty}. ` +
            'Every git call to the repository host runs without a credential until they are set.',
        );
      }
      return;
    }
    this.saidUnaskable = null;
    if (opts.refused) {
      // The host's verdict outranks the clock: what it refused is not
      // presented again, by anyone, whatever a renewal in flight brings.
      this.held = null;
    }
    const insist = Boolean(opts.asked || opts.refused);
    const held = this.held?.for === this.holder() ? this.held : null;
    const good = held !== null && held.expiresAt > this.now();
    if (good && held.expiresAt - this.now() > RENEW_AHEAD_MS) return;
    if (!insist && this.failed && this.now() < this.failed.until) return;

    this.renewing ??= this.renew(credentials, installationId).finally(() => {
      this.renewing = null;
    });
    if (good && !insist) {
      // Not waited on, so not thrown to anyone: the renewal has logged it.
      this.renewing.catch(() => undefined);
      return;
    }
    await this.renewing;
  }

  /**
   * The repositories the deployment may be pointed at: those the
   * installation reaches AND the person who connected it could push to.
   * Asked of GitHub each time, so a repository taken out of the
   * installation since is not offered.
   */
  async repositories(): Promise<{ repositories: InstallationRepository[]; more: boolean }> {
    await this.prepare({ asked: true });
    const token = this.token();
    if (!token) return { repositories: [], more: false };
    const reached = await this.client.repositories(token);
    return { repositories: reached.repositories.filter((r) => this.permits(r.fullName)), more: reached.more };
  }

  /** Drop the token in hand: the installation it was for is no longer the deployment's. */
  forget(): void {
    this.held = null;
    this.failed = null;
  }

  private async renew(credentials: GitHubAppCredentials, installationId: string): Promise<void> {
    const holder = this.holder();
    try {
      const issued = await this.client.installationToken(credentials, installationId);
      this.held = { for: holder, token: issued.token, expiresAt: issued.expiresAt };
      this.failed = null;
    } catch (err) {
      const times = (this.failed?.times ?? 0) + 1;
      const wait = Math.min(FIRST_WAIT_MS * 2 ** (times - 1), LONGEST_WAIT_MS);
      this.failed = { times, until: this.now() + wait };
      // Once per failure, and a failure is once per wait.
      this.log().error(`GitHub gave no token for the installation; not asked again for ${Math.round(wait / 1000)} s:`, {
        detail: err instanceof Error ? err.message : String(err),
        failuresInARow: times,
      });
      throw err;
    }
  }

  private holder(): string {
    return `${this.opts.read('githubAppId')}:${this.installationId()}`;
  }
}
