/**
 * Scrub credentials from anything that reaches a log or an error message:
 * the token in effect wherever it appears, URL userinfo — a remote spelled
 * `https://user:pass@host` would otherwise leak `pass` verbatim through every
 * git failure that quotes the URL back — and URL query strings, where a
 * presigned remote keeps its credential.
 *
 * "The token in effect" is every place one can come from: each environment
 * spelling `CoreConfig` accepts (it normalises them onto `GITHUB_TOKEN` at
 * boot, but a later write to one of them is not normalised), plus whatever the
 * caller knows about — the settings-stored token, a token a request brought
 * along, or a remote's query values ({@link urlQuerySecrets}). Longest first,
 * so a secret that contains another is not half-scrubbed.
 *
 * Shared, not a module's own: the KB startup phase and the setup routes both
 * log git's words, and one scrub is the only way they cannot disagree about
 * what a secret is.
 */
export function redactSecret(text: string, secrets: readonly (string | null | undefined)[] = []): string {
  const tokens = [
    process.env.GITHUB_TOKEN,
    process.env.GIT_TOKEN,
    process.env.GH_TOKEN,
    ...secrets,
  ]
    .map((t) => t?.trim())
    .filter((t): t is string => !!t);
  let scrubbed = text;
  for (const token of [...new Set(tokens)].sort((a, b) => b.length - a.length)) {
    scrubbed = scrubbed.replaceAll(token, '***');
  }
  return (
    scrubbed
      // Through the LAST `@` before the path: a password can carry an
      // unencoded `@` of its own (`https://user:p@ss@host`), and stopping at
      // the first would leave the rest of it in the log.
      .replace(/:\/\/[^/\s]*@/g, '://***@')
      // A presigned remote carries its credential in the query instead
      // (`?X-Amz-Signature=…`, `?access_token=…`). A git remote has no query
      // worth keeping in a log, so the whole of it goes.
      .replace(/(\bhttps?:\/\/[^\s?#'"]+)\?[^\s#'"]*/gi, '$1?***')
  );
}

/** Shorter than this, a query value is not a credential (`X-Amz-Expires=3600`). */
const MIN_SECRET_LENGTH = 8;

/**
 * A remote's query, named as literal secrets for {@link redactSecret}: the
 * query as written and each value in it, raw and percent-decoded.
 *
 * `redactSecret` drops a query that FOLLOWS a URL. Naming the values as well
 * scrubs them wherever else they turn up — decoded, or on their own — where no
 * URL pattern can see them. Values too short to be a credential are left alone,
 * so a `3600` in the query does not garble every number in the log.
 */
export function urlQuerySecrets(url: string | null | undefined): string[] {
  let query: string;
  try {
    query = url ? new URL(url.trim()).search.slice(1) : '';
  } catch {
    return [];
  }
  const secrets = new Set<string>();
  if (query.length >= MIN_SECRET_LENGTH) secrets.add(query);
  for (const part of query.split('&')) {
    const raw = part.slice(part.indexOf('=') + 1);
    for (const value of [raw, decoded(raw)]) {
      if (value.length >= MIN_SECRET_LENGTH) secrets.add(value);
    }
  }
  return [...secrets];
}

function decoded(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return value;
  }
}
