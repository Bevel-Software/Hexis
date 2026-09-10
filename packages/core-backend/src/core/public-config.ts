import { DEFAULT_BRANCH, PROTECTED_BRANCHES, currentKbLayout } from '@bevel-software/platform-shared';

/** The two addresses the server derives once and hands to {@link publicConfig}. */
export interface PublicConfigAddresses {
  /** The per-user marketplace git remote, userinfo stripped. */
  marketplaceGitUrl: string;
  /** This deployment's MCP endpoint, the same value the OAuth metadata publishes. */
  mcpUrl: string;
}

/**
 * The body of the unauthenticated `GET /api/config`: the handful of facts the
 * browser needs BEFORE it can render anything, and what a local bridge
 * learns about a deployment from one request.
 *
 * Unauthenticated on purpose. The login screen, the router and every module
 * that reads `DEFAULT_BRANCH` are loaded before a session exists, so a gated
 * endpoint could not answer in time. What it discloses is two branch names,
 * which every change request and every URL already shows to anyone who does
 * get in, and nothing about the repository they live in.
 *
 * This replaces baking the values into the frontend bundle at build time.
 * One artifact now serves any deployment, and renaming a branch no longer
 * means a rebuild.
 *
 * A pure function of its inputs, so the payload is testable without a server.
 */
export function publicConfig({ marketplaceGitUrl, mcpUrl }: PublicConfigAddresses) {
  return {
    branchModel: {
      defaultBranch: DEFAULT_BRANCH,
      protectedBranches: [...PROTECTED_BRANCHES],
    },
    /**
     * The three renameable KB roots, for the same reason as the branch
     * model: the file tree, the library router and every path rule read
     * them, and they used to be compile-time constants.
     */
    kbLayout: currentKbLayout(),
    /**
     * The per-user marketplace git remote (see modules/marketplace). Same
     * derivation as `mcpUrl`: our address, userinfo stripped; the caller
     * adds their own connection key.
     */
    marketplaceGitUrl,
    /**
     * The same value the OAuth metadata publishes (see `mcpResourceUrl`).
     *
     * The frontend used to build this from `window.location.origin`, which
     * is the browser's idea of our address rather than ours. The two agree
     * on a simple deployment and disagree behind a proxy, on a second
     * domain, or on an internal hostname, and the one that decides whether
     * a connection works is this one.
     *
     * That was survivable while every surface was copy-paste: a human sees
     * the host before pasting it. It stops being survivable the moment we
     * hand the URL to a third party (a connector install link), where
     * nobody reads it and the failure surfaces inside someone else's UI.
     */
    mcpUrl,
    /**
     * This deployment serves `GET /api/agent/instructions` and sends
     * instructions on every MCP handshake (see modules/agent-instructions).
     * The local `hexis-mcp` bridge fetches the text only when this is
     * advertised; its absence is how an older deployment looks. A capability
     * flag rather than a probe, because an unknown `/api/*` path on an older
     * deployment falls through to the JWT mounts and answers 401, which the
     * bridge would read as an expired sign-in.
     */
    agentInstructions: true as const,
  };
}
