import type { CallTemplate } from '@utcp/sdk';

/*
 * Keeping a secret out of text we quote back. One mechanism for every place
 * that quotes a provider: the connection probe's verdicts and a downstream
 * tool's own error (`downstream-tool-errors.ts`). A provider can echo the
 * credential it was sent, so what is quoted is redacted against everything the
 * request carried before anyone below the secret's scope reads it.
 */

/**
 * Below this, a value is redacted only where it stands ALONE — see
 * {@link SecretRedactor}. It is still redacted; what it may not do is match
 * inside a longer run of letters and digits.
 */
const MIN_SECRET_CHARS = 6;
/** The shortest leading run of a secret we will treat as an echo of it. */
const MIN_ECHOED_PREFIX_CHARS = 8;
const REDACTED = '[redacted]';

/**
 * Every secret a request carried, so that none of them can come back out in
 * something we quote.
 *
 * A rejection is quoted verbatim because the provider's own words are the
 * actionable part, but providers routinely echo the credential they refused
 * ("Incorrect API key provided: sk-…"). Anyone who can READ a tool can probe
 * it or call it, so without this a plain reader could recover part of a shared
 * ADMIN key they were never allowed to see from a failure's text. A cap on the
 * quote's length bounds it; it does not redact it.
 *
 * Leading PREFIXES count as well as whole values, because that echo is usually
 * masked in the middle ("sk-live-abcd…wxyz"): a whole-value search finds
 * nothing there and prints the head of the key regardless.
 *
 * SHORT values are redacted too — a four-character key is still the key, and a
 * provider that quotes it back would otherwise hand it to any reader who can
 * probe the tool. They are matched only where they stand alone, though,
 * bounded by something other than a letter or digit. Not every value this
 * class is told about is a credential: it is handed whatever every `${VAR}`
 * in the manual resolved to, so a `${VERSION}` of `1` or a
 * `${REGION}` of `us` arrives here alongside the token. Blanking those
 * wherever their characters happened to fall would turn `answered 401` into
 * `answered 40[redacted]` and destroy the message that makes the verdict
 * useful — so the short ones may only match a run of their own.
 */
export class SecretRedactor {
  private readonly values = new Set<string>();

  remember(value: string): void {
    // Blank is not a secret, and a blank needle matches everywhere: `''` would
    // put `[redacted]` between every character of the message.
    if (value.trim()) this.values.add(value);
  }

  redact(text: string): string {
    let out = text;
    // Longest SECRET first: when one value is a prefix of another (a key and
    // that same key with a suffix), redacting the short one first eats the head
    // of the long one and leaves its tail printed.
    const secrets = [...this.values].sort((a, b) => b.length - a.length);
    // Every whole value first. Only then any echoed head: two values can share
    // a head (`sk-live-…`), and a head pass for one that ran before the other's
    // own turn would eat that shared head and leave the other's tail printed.
    for (const secret of secrets) {
      out = secret.length < MIN_SECRET_CHARS ? out.replace(standingAlone(secret), REDACTED) : out.split(secret).join(REDACTED);
    }
    // Then every echoed head of every value, longest first across all of them,
    // and each one present, not only the first: a provider can quote a value
    // and a masked head of it in one message ("sk-live-abcd…").
    const heads = new Set<string>();
    for (const secret of secrets) {
      if (secret.length < MIN_SECRET_CHARS) continue;
      for (let len = secret.length - 1; len >= Math.min(secret.length, MIN_ECHOED_PREFIX_CHARS); len--) {
        heads.add(secret.slice(0, len));
      }
    }
    for (const head of [...heads].sort((a, b) => b.length - a.length)) {
      if (out.includes(head)) out = out.split(head).join(REDACTED);
    }
    return out;
  }
}

/**
 * `value`, wherever it appears as a run of its own.
 *
 * Both ends are guarded, unconditionally. An earlier version applied the guard
 * only where the value's own edge was a letter or a digit, reasoning that a
 * value ending in punctuation cannot hide inside a longer word — but a value
 * made ENTIRELY of punctuation then compiled to a bare, unanchored pattern: a
 * `${SEPARATOR}` of `.` turned every sentence period and every dot of every
 * hostname in the provider's message into `[redacted]`, which destroys the
 * quote this class exists to keep readable.
 *
 * The cost is a narrow one, and the right way round: a sub-six-character value
 * whose edge is punctuation and which the provider echoes glued to a word
 * character (`sk-ab` for a value of `-ab`) is not redacted. That intersection
 * is far rarer than a punctuation-shaped `${VAR}`, and over-redaction cannot be
 * recovered from by the reader while this miss still needs a credential short
 * enough to carry almost no secret in the first place. Values of six
 * characters or more never come here at all.
 */
function standingAlone(value: string): RegExp {
  // Letters and digits of ANY script are word characters here: a value that
  // happens to be the tail of a provider's non-ASCII word (`clé`, `código`)
  // must not be cut out of it.
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(value)}(?![\\p{L}\\p{N}])`, 'gu');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Names — of a header or of a query parameter — whose value IS a credential
 * rather than a description of the request. Matched as substrings and on
 * purpose generously: a name wrongly treated as secret costs one blanked word
 * in an error message, while one wrongly treated as public costs the
 * credential. `signature` and `hmac` earn their place because a signed url
 * (`X-Amz-Signature`, an Azure SAS) grants access exactly as a bearer token
 * does — the secret is what derived it, and the derivation is what is sent.
 */
const CREDENTIAL_MARKERS = [
  'auth',
  'key',
  'token',
  'secret',
  'password',
  'cookie',
  'credential',
  'signature',
  'hmac',
];

/**
 * The same, for names too short to match as substrings: `sig` inside a word
 * would swallow `design`, `assign` and `signal`, and blanking those would eat
 * the message rather than protect anything in it.
 */
const CREDENTIAL_WORDS = /(?:^|[-_])(sig|hash)(?:$|[-_])/;

export function carriesCredential(fieldName: string): boolean {
  const name = fieldName.toLowerCase();
  return CREDENTIAL_MARKERS.some((marker) => name.includes(marker)) || CREDENTIAL_WORDS.test(name);
}

/**
 * Remember a credential the manual spelled out in full.
 *
 * Substitution only ever yields values resolved from the vault, so a `.tool`
 * whose header reads `Authorization: Bearer sk-…` rather than
 * `Bearer ${TOKEN}` would leave the redactor with nothing to look for. That
 * is the one credential a reader has no other route to: `ToolManualSummary`
 * withholds `headers` from the browser for precisely this reason, and a
 * provider quoting it in a 401 would have handed it back regardless.
 *
 * What follows the auth scheme is remembered as well as the whole value,
 * because `Bearer sk-…` is echoed as the bare token far more often than in
 * full, and `Bearer` by itself is not worth blanking out of a message.
 */
export function rememberCredentialHeaders(headers: Record<string, unknown>, redactor: SecretRedactor): void {
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value !== 'string' || !carriesCredential(name)) continue;
    redactor.remember(value);
    const afterScheme = /^\S+\s+(\S.*)$/.exec(value.trim());
    if (afterScheme) redactor.remember(afterScheme[1]);
  }
}

/**
 * The same, for a credential written into a query string (`?api_key=…`) rather
 * than a header. Only the values of credential-NAMED parameters: a rejection
 * usually names the endpoint it rejected, and blanking the url wholesale would
 * cost more of the message than it protects.
 */
export function rememberCredentialQuery(url: string, redactor: SecretRedactor): void {
  let query: string;
  try {
    query = new URL(url).search.slice(1);
  } catch {
    return;
  }
  // Both spellings of each value: a provider can quote the url as it was sent
  // (`a%2Bb`) or as it read it (`a+b`). Decoded by `URLSearchParams`, the
  // parser the request is read with, so a malformed escape (`%74oken%FF`)
  // decodes here exactly as it does there.
  for (const pair of query.split('&')) {
    const at = pair.indexOf('=');
    const [decoded] = new URLSearchParams(pair);
    if (at < 0 || !decoded || !carriesCredential(decoded[0])) continue;
    redactor.remember(pair.slice(at + 1));
    redactor.remember(decoded[1]);
  }
}

/**
 * Remember every credential an `mcp` call's template spells out in full, as
 * the client filled it in: credential-named headers (and the part after the
 * auth scheme), credential-named query parameters, credential-named
 * environment variables, and credential-named fields of the template's
 * `auth`. The values substituted into it are recorded where they are resolved,
 * at registration (`call-secrets.ts`), so nothing here reads them back out of
 * the text.
 */
export function rememberCallCredentials(redactor: SecretRedactor, processed: CallTemplate): void {
  const servers = (processed as { config?: { mcpServers?: unknown } }).config?.mcpServers;
  if (servers && typeof servers === 'object') {
    for (const entry of Object.values(servers as Record<string, unknown>)) {
      if (!entry || typeof entry !== 'object') continue;
      const server = entry as { headers?: unknown; url?: unknown; env?: unknown };
      if (server.headers && typeof server.headers === 'object') {
        rememberCredentialHeaders(server.headers as Record<string, unknown>, redactor);
      }
      if (typeof server.url === 'string') rememberCredentialQuery(server.url, redactor);
      if (server.env && typeof server.env === 'object') rememberCredentialFields(server.env, redactor);
    }
  }
  const auth = (processed as { auth?: unknown }).auth;
  if (auth && typeof auth === 'object') rememberCredentialFields(auth, redactor);
}

/** The string values of credential-named fields. */
function rememberCredentialFields(fields: object, redactor: SecretRedactor): void {
  for (const [name, value] of Object.entries(fields)) {
    if (typeof value === 'string' && carriesCredential(name)) redactor.remember(value);
  }
}
