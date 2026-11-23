/**
 * What the database module offers the other modules. A consumer outside the
 * module imports from here, never from the files: they are the module's own
 * layout and free to move. Export what another module needs; nothing more.
 */
export type { Database } from './connection.js';
export { deploymentSettings } from './core-schema.js';
export { pgErrorCode } from './pg-error.js';
export { agentConnections, agentEvents, atlassianAccountLinks, changeRequests, externalApiKeys, fileLocks, githubFacadeCodes, githubFacadeIdentity, oauthAuthCodes, oauthClients, oauthTokens, pendingCommits, pluginJoinRequests, prFileApprovals, prMergeLog, secrets, users } from './schema.js';
