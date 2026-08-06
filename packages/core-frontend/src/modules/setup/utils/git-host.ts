/**
 * Which username a git host expects beside an access token.
 *
 * This is NOT a person's username, which is exactly why the setup screen no
 * longer asks for it in plain sight: every host has one correct answer and it
 * is a constant, so asking looked like a question about the operator's own
 * account. It is derived from the repository URL and shown only under
 * "Advanced", pre-filled, for the self-hosted cases where the host cannot be
 * recognised from its domain.
 *
 * `null` means "not recognised" — the caller keeps the default rather than
 * inventing something, and the advanced field is worth opening.
 */
export function tokenUsernameForHost(repoUrl: string): { username: string; host: string } | null {
  let hostname: string;
  try {
    hostname = new URL(repoUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
  // Matched on the registrable domain so `gitlab.example.com` is NOT taken for
  // GitLab: a self-hosted instance can sit on any domain, and guessing from a
  // substring would confidently produce the wrong credential.
  if (hostname === 'github.com' || hostname.endsWith('.github.com')) {
    return { username: 'x-access-token', host: 'GitHub' };
  }
  if (hostname === 'gitlab.com') return { username: 'oauth2', host: 'GitLab' };
  if (hostname === 'bitbucket.org') return { username: 'x-token-auth', host: 'Bitbucket' };
  if (hostname === 'dev.azure.com' || hostname.endsWith('.visualstudio.com')) {
    // Azure DevOps accepts any non-empty username beside a PAT.
    return { username: 'azure', host: 'Azure DevOps' };
  }
  return null;
}
