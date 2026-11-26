import type { CallTemplate } from '@utcp/sdk';
import { VARIABLE_REFERENCE_PATTERN } from './utcp-namespace.js';

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
    // Longest SECRET first, and not merely the longest prefix of each: when one
    // resolved value is a prefix of another (a key and that same key with a
    // suffix), redacting the short one first eats the head of the long one and
    // leaves its tail printed — the exact half-redaction this class exists to
    // avoid, arrived at from the other direction.
    for (const secret of [...this.values].sort((a, b) => b.length - a.length)) {
      if (secret.length < MIN_SECRET_CHARS) {
        out = out.replace(standingAlone(secret), REDACTED);
        continue;
      }
      // Longest match first: replacing the whole value when it is present beats
      // replacing a prefix of it and leaving the tail on screen. Then on down:
      // a provider can quote the whole value and a masked head of it in one
      // message ("sk-live-abcd…"), and stopping at the first match left the
      // head printed.
      const shortest = Math.min(secret.length, MIN_ECHOED_PREFIX_CHARS);
      for (let len = secret.length; len >= shortest; len--) {
        const candidate = secret.slice(0, len);
        if (out.includes(candidate)) out = out.split(candidate).join(REDACTED);
      }
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
 * Remember everything a call to an `mcp` manual carried that may be a secret,
 * from the template as the client filled it in (`processed`) and as it is
 * stored (`raw`, with its `${VAR}` references):
 *
 * - every value substitution put in, each on its own (`substitutedValues`).
 *   The public text around them (a url's scheme and host, an auth scheme) is
 *   not remembered, so it is not blanked out of the message;
 * - every credential a server entry spells out in full: credential-named
 *   headers (and the part after the auth scheme), credential-named query
 *   parameters, credential-named environment variables, and credential-named
 *   fields of the template's `auth`.
 */
export function rememberCallCredentials(redactor: SecretRedactor, processed: CallTemplate, raw?: CallTemplate): void {
  if (raw) rememberSubstitutions(redactor, raw, processed);
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

/** Walk both templates side by side and remember what substitution put in. */
function rememberSubstitutions(redactor: SecretRedactor, raw: unknown, processed: unknown): void {
  if (typeof processed === 'string') {
    if (typeof raw === 'string' && raw !== processed) {
      for (const value of substitutedValues(raw, processed)) redactor.remember(value);
    }
    return;
  }
  if (!processed || typeof processed !== 'object' || !raw || typeof raw !== 'object') return;
  for (const [key, value] of Object.entries(processed)) {
    rememberSubstitutions(redactor, (raw as Record<string, unknown>)[key], value);
  }
}

/** Past this many candidate values in one string, its changed span is remembered instead (see `substitutedValues`). */
const MAX_CANDIDATES = 512;

/**
 * Every value each reference in `raw` could have taken in `processed`.
 *
 * The stored string's references (`VARIABLE_REFERENCE_PATTERN`, the
 * substitutor's grammar) split it into literal pieces. A value is the text
 * between two pieces, but a value may itself contain the piece after it, so
 * one string can read several ways (`${A}|${B}|${C}` filled in as
 * `a|middle|secret|d`). Every reading is kept: for each reference, every
 * start the text before it allows and every end the text after it allows,
 * found from both ends, and every value between such a start and end. A
 * string the stored one does not describe (it changed some other way) yields
 * its changed span; so does a pathological one (adjacent references, which
 * any split satisfies) once it passes {@link MAX_CANDIDATES}.
 */
function substitutedValues(raw: string, processed: string): string[] {
  const pieces = raw.split(new RegExp(VARIABLE_REFERENCE_PATTERN.source)).filter((_, i) => i % 3 === 0);
  // `split` interleaves each match's two capture groups: every third piece is literal text.
  const references = pieces.length - 1;
  if (references < 1) return [];
  const n = processed.length;
  const first = pieces[0]!;
  const last = pieces[references]!;
  if (!processed.startsWith(first) || !processed.endsWith(last) || first.length + last.length > n) {
    return [changedSpan(raw, processed)];
  }
  // From the front: where value i can start.
  const starts: Set<number>[] = [new Set([first.length])];
  for (let i = 0; i < references; i++) {
    const piece = pieces[i + 1]!;
    const next = new Set<number>();
    for (const s of starts[i]!) {
      for (let e = s; e + piece.length <= n; e++) if (processed.startsWith(piece, e)) next.add(e + piece.length);
    }
    starts.push(next);
  }
  if (!starts[references]!.has(n)) return [changedSpan(raw, processed)];
  // From the back: where value i can end and still leave a reading of the rest.
  const values = new Set<string>();
  let after = new Set([n]);
  for (let i = references - 1; i >= 0; i--) {
    const piece = pieces[i + 1]!;
    const ends = [...after].map((p) => p - piece.length).filter((e) => e >= 0 && processed.startsWith(piece, e));
    const reachable = new Set<number>();
    for (const s of starts[i]!) {
      for (const e of ends) {
        if (e < s) continue;
        reachable.add(s);
        values.add(processed.slice(s, e));
        if (values.size > MAX_CANDIDATES) return [changedSpan(raw, processed)];
      }
    }
    after = reachable;
  }
  return [...values];
}

/** The text between the longest head and tail `raw` and `processed` share. */
function changedSpan(raw: string, processed: string): string {
  let head = 0;
  while (head < raw.length && head < processed.length && raw[head] === processed[head]) head++;
  let tail = 0;
  while (
    tail < raw.length - head &&
    tail < processed.length - head &&
    raw[raw.length - 1 - tail] === processed[processed.length - 1 - tail]
  ) {
    tail++;
  }
  return processed.slice(head, processed.length - tail);
}
