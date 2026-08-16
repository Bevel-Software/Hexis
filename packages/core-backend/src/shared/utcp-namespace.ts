/**
 * UTCP namespacing and the Bevel-hosted seeding rule now live in
 * `@bevel-software/platform-mcp-core`: the local MCP server has to make the
 * SAME bearer-leak decision this file documents, and a security rule that
 * exists in two copies is a security rule that will eventually differ.
 * Re-exported here because this is the path the rest of the package imports.
 */
export {
  utcpNamespacePrefix,
  utcpNamespacedKey,
  seedBevelHostedManualVars,
} from '@bevel-software/platform-mcp-core';

/**
 * The synthetic per-user variable MCP OAuth auto-discovery hangs a remote
 * server's sign-in on (`<manual>_MCP_OAUTH`). Lives here — the one leaf both
 * sides import — so the tool-manuals decoration and the secrets-vault
 * discovery service can't drift apart on the name.
 */
export const MCP_OAUTH_VAR = 'MCP_OAUTH';

/**
 * The internal ("Bevel") UTCP manual namespace — the ONE manual the in-process
 * agent's code-mode client fully trusts (it carries the loopback `API_URL` and
 * the `source:'internal'` token). Single source of truth so the composition root
 * that seeds it and the tool-manuals scanner that must REFUSE a user `.tool` from
 * reproducing it (which would let the `.tool` read the seeded internal token +
 * connector creds under the shared namespace) can't drift.
 */
export const INTERNAL_MANUAL_NAME = 'Bevel';
