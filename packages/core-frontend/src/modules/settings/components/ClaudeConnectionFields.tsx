import { CopyBlock } from '../../../shared/mcp';
import type { GitHubFacadeCredentials } from '../services/github-facade.api';

/**
 * The six values Claude's "Add GitHub Enterprise" form asks for, in ITS
 * order, so the block reads as a copy source rather than a form of its own.
 *
 * Shared by the two places an admin needs them: the Deployment page's Claude
 * connection card, and step 1 of the Cowork walkthrough on the External agent
 * access page. Sending the reader from one page to the other to copy six
 * fields was friction with nothing on the other end of it, so the fields go
 * wherever the instruction is; this component is what keeps the two copies
 * from drifting.
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
