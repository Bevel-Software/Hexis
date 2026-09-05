/**
 * The per-user marketplace git remote, as `/api/config` names it — the same
 * "configured at boot, read through a function" shape as `mcpEndpointUrl`
 * (see `shared/mcp/connect-snippets.ts` for why a module-scope constant would
 * snapshot the wrong value).
 *
 * The URL never carries a credential: the person adds their own connection
 * key when they paste the command, and `withConnectionKey` is how the
 * settings card composes that.
 */

const GIT_PATH = '/git/marketplace.git';

let configured: string | null = null;

/** Record what the server said; absent or unusable falls back to the origin. */
export function configureMarketplaceGitUrl(url: unknown): void {
  if (typeof url !== 'string' || url.trim() === '') {
    configured = null;
    return;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      configured = null;
      return;
    }
    parsed.username = '';
    parsed.password = '';
    configured = parsed.toString();
  } catch {
    configured = null;
  }
}

/** The remote to show people, without any credential. */
export function marketplaceGitUrl(): string {
  return configured ?? `${window.location.origin}${GIT_PATH}`;
}

/**
 * The remote with a connection key in the userinfo — what git sends as HTTP
 * Basic, and what Claude Code's background refresh needs because it disables
 * credential helpers. `key` is the placeholder when the person has not
 * minted one yet.
 */
export function withConnectionKey(key: string): string {
  const parsed = new URL(marketplaceGitUrl());
  parsed.username = 'key';
  parsed.password = key;
  return parsed.toString();
}

/** The marketplace's registered name — what `plugin@<name>` refers to in Claude Code. */
export const MARKETPLACE_NAME = 'hexis';
/** The one-install bundle plugin every compiled marketplace carries. */
export const BUNDLE_PLUGIN = 'hexis-all';

/**
 * The three one-liners the settings page shows, with the key in the URL —
 * Claude Code's background refresh disables credential helpers, so the key
 * has nowhere else to live. `key` may be a placeholder.
 */
export function marketplaceCommands(key: string): { claude: string; codex: string; skills: string } {
  const url = withConnectionKey(key);
  return {
    claude: `claude plugin marketplace add ${url} && claude plugin install ${BUNDLE_PLUGIN}@${MARKETPLACE_NAME}`,
    codex: `codex plugin marketplace add ${url}`,
    skills: `npx skills add ${url} --all -y`,
  };
}

/** For tests — module-global state must not leak between them. */
export function resetMarketplaceGitUrlForTests(): void {
  configured = null;
}
