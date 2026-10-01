/**
 * Scrub credentials from anything that reaches a log or an error message:
 * the token in effect wherever it appears, URL userinfo — a remote spelled
 * `https://user:pass@host` would otherwise leak `pass` verbatim through every
 * git failure that quotes the URL back — and URL query strings, where a
 * presigned remote keeps its credential.
 *
 * "The token in effect" is every place one can come from: each environment
 * spelling `CoreConfig` accepts (the operator's, process-wide), plus whatever
 * the caller knows about — the knowledge base's own token as its git runner
 * carries it, a token a request brought along, or a remote's query values
 * ({@link urlQuerySecrets}). Longest first, so a secret that contains another
 * is not half-scrubbed.
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
  const ordered = [...new Set(tokens)].sort((a, b) => b.length - a.length);
  // Every whole value first, then every echoed PREFIX. Git and the providers
  // elide the middle of a token they quote back (`ghp_abcdef…`), and an exact
  // match would leave that head on screen — enough of a secret to be one.
  // Both can be in one text (the value in a URL, the elided form in the
  // host's reply), so the prefix pass runs whether or not the whole was
  // found — but only once every whole value is gone, or the head two tokens
  // share (`ghp_from…`) would garble the second before its own turn came.
  // Down to a floor, so a short common head (`ghp_`) does not garble every
  // other token in the log.
  for (const token of ordered) scrubbed = scrubbed.replaceAll(token, '***');
  // Every echoed prefix of every token, LONGEST FIRST ACROSS TOKENS — not
  // token by token: two tokens can share a head longer than the floor
  // (`ghp_abcdefgh…`), and one token's shorter prefix, taken first, would
  // scrub that head out of the other's echo and leave the rest of it on
  // screen (`***Y123…`). Longest first, the longer echo goes whole.
  const prefixes = ordered.flatMap((token) =>
    Array.from({ length: Math.max(0, token.length - MIN_ECHOED_PREFIX_LENGTH) }, (_, i) => token.slice(0, token.length - 1 - i)),
  );
  for (const prefix of [...new Set(prefixes)].sort((a, b) => b.length - a.length)) {
    if (scrubbed.includes(prefix)) scrubbed = scrubbed.replaceAll(prefix, '***');
  }
  return (
    scrubbed
      // Through the LAST `@` before the path: a password can carry an
      // unencoded `@` of its own (`https://user:p@ss@host`), and stopping at
      // the first would leave the rest of it in the log.
      .replace(/:\/\/[^/\s]*@/g, '://***@')
      // A presigned remote carries its credential in the query instead
      // (`?X-Amz-Signature=…`, `?access_token=…`). A git remote has no query
      // worth keeping in a log, so the whole of it goes — up to whitespace or
      // a fragment, not to the first quote: a credential can carry a quote
      // of its own, and stopping there would leave the rest of it in the log.
      // When git quoted the URL, the LAST quote of that kind before the next
      // space is the one closing it, and what follows it (`': 403`) is kept.
      .replace(
        /(\bhttps?:\/\/[^\s?#'"]+)\?([^\s#]*)/gi,
        (_m, url: string, query: string, offset: number, whole: string) => {
          const opener = whole[offset - 1];
          const closing = opener === "'" || opener === '"' ? query.lastIndexOf(opener) : -1;
          return `${url}?***${closing === -1 ? '' : query.slice(closing)}`;
        },
      )
  );
}

/** Shorter than this, a query value is not a credential (`X-Amz-Expires=3600`). */
const MIN_SECRET_LENGTH = 8;

/**
 * The shortest head of a token that is still scrubbed when only a prefix of
 * it was echoed — the same floor the connection probe's redactor uses. Below
 * it a head is a vendor's common prefix, not a secret.
 */
const MIN_ECHOED_PREFIX_LENGTH = 8;

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
