/**
 * The OAuth-callback outcome carried in the URL fragment.
 *
 * The backend callback redirects the browser to
 * `<returnTo>#authorized=<id>` or `<returnTo>#error=<message>`; whichever page
 * asked for the sign-in is the page that has to read it.
 *
 * Two rules make this correct, and both are easy to get wrong:
 *
 *  1. Read it ONCE, SYNCHRONOUSLY — `useState(readOAuthFragment)`, never an
 *     effect. The page also strips the fragment in an effect, and effects run
 *     in mount order, so a read-in-an-effect races the stripper and loses.
 *  2. `URLSearchParams` already percent-decodes. A second `decodeURIComponent`
 *     corrupts any message containing a literal `%`, which is exactly what a
 *     provider error string tends to contain.
 */

export type OAuthFragmentOutcome =
  | { kind: 'authorized' }
  | { kind: 'error'; message: string }
  | null;

export function readOAuthFragment(): OAuthFragmentOutcome {
  const hash = window.location.hash.replace(/^#/, '');
  if (!hash) return null;
  const params = new URLSearchParams(hash);
  if (params.has('authorized')) return { kind: 'authorized' };
  if (params.has('error')) {
    return { kind: 'error', message: params.get('error') || 'Authorization failed.' };
  }
  return null;
}
