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
 *
 * Spliced as TEXT, not set through `URL.password`: the URL parser
 * percent-encodes what it is given, and the placeholder `<external-api-key>`
 * came out as `%3Cexternal-api-key%3E` — a thing to paste that looks like a
 * secret. A real key never needs encoding: it is a tenant prefix plus base64url,
 * all of it URL-safe by construction.
 */
export function withConnectionKey(key: string): string {
  const { protocol, host, pathname } = new URL(marketplaceGitUrl());
  return `${protocol}//key:${key}@${host}${pathname}`;
}

/** The marketplace's registered name — what `plugin@<name>` refers to in Claude Code. */
export const MARKETPLACE_NAME = 'hexis';
/**
 * The one-install plugin every compiled marketplace carries: every skill the
 * person may read plus the knowledge base's MCP endpoint, as content — the
 * same plugin on Claude Code, Cowork and claude.ai.
 */
export const BUNDLE_PLUGIN = 'hexis-all';
/**
 * The plugin Codex installs to reach the knowledge base. Codex's catalogue
 * leaves the bundle out (it would repeat every other entry), so `hexis-all`
 * is not found there; the Codex-served plugin carrying the Hexis MCP server
 * is the skills plugin — the backend's `SKILLS_PLUGIN_NAME`.
 */
export const CODEX_PLUGIN = 'skills-and-knowledge';
/** The MCP server's name inside the compiled plugins — what `codex mcp login` takes. */
export const MCP_SERVER_NAME = 'hexis';

/**
 * The KIND stored on a connection key minted when a person connects an
 * account on a product that treats this deployment as a GitHub Enterprise
 * host (claude.ai, Cowork) — the backend's `GITHUB_LINK_KEY_KIND`, spelled
 * once more here so the key list can tell those links from keys people
 * created by hand. The kind, never the label: a label is free text anyone
 * can type.
 */
export const GITHUB_LINK_KIND = 'github-link';

/**
 * The commands the settings page shows, with the key in the URL — Claude
 * Code's background refresh disables credential helpers, so the key has
 * nowhere else to live. `key` may be a placeholder.
 *
 * Codex's is a four-line block, in the forms checked against Codex CLI
 * 0.154.0: adding a marketplace installs nothing, so the plugin is added by
 * name (`plugin add`, there is no `plugin install`); the plugin's server
 * entry carries no credentials, so `mcp login` signs in through the browser;
 * the last line asks Codex to call a Hexis tool, so the person sees it answer.
 */
export function marketplaceCommands(key: string): { claude: string; codex: string; skills: string } {
  const url = withConnectionKey(key);
  return {
    claude: `claude plugin marketplace add ${url} && claude plugin install ${BUNDLE_PLUGIN}@${MARKETPLACE_NAME}`,
    codex: [
      `codex plugin marketplace add ${url}`,
      `codex plugin add ${CODEX_PLUGIN}@${MARKETPLACE_NAME}`,
      `codex mcp login ${MCP_SERVER_NAME}`,
      `codex exec --skip-git-repo-check "Call the ${MCP_SERVER_NAME} MCP server's list_tools tool and print the tool names it returns."`,
    ].join('\n'),
    skills: `npx skills add ${url} --all -y`,
  };
}

/** Why the Codex block has a login line — said beside the block wherever it is shown. */
export const CODEX_LOGIN_NOTE =
  "Codex signs in through your browser once: the login line is needed because the plugin's server entry carries no credentials.";

/** For tests — module-global state must not leak between them. */
export function resetMarketplaceGitUrlForTests(): void {
  configured = null;
}
