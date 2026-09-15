import { CopyBlock } from '../../../shared/mcp';
import type { GitHubFacadeCredentials } from '../services/github-facade.api';

/**
 * The six values Claude's "Add GitHub Enterprise" form asks for, in ITS
 * order, so the block reads as a copy source rather than a form of its own.
 *
 * Rendered by the Claude connection card, inside step 1 of the registration
 * steps in the Marketplace section of Deployment configuration — the fields
 * sit in the step that asks for them.
 */
export function ClaudeConnectionFields({ creds }: { creds: GitHubFacadeCredentials }) {
  return (
    <>
      <CopyBlock label="Hostname" value={creds.host} rows={1} />
      <CopyBlock label="App ID" value={creds.appId} rows={1} />
      <CopyBlock label="Client ID" value={creds.clientId} rows={1} />
      <CopyBlock label="Client secret" value={creds.clientSecret} rows={1} />
      <CopyBlock label="Webhook secret" value={creds.webhookSecret} rows={1} />
      <CopyBlock label="Private key" value={creds.privateKeyPem} rows={6} />
    </>
  );
}
