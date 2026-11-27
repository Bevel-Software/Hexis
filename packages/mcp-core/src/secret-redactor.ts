import type { CallTemplate } from '@utcp/sdk';

/*
 * Keeping a secret out of text we quote back. One mechanism for every place
 * that quotes a provider: the connection probe's verdicts and a downstream
 * tool's own error (`downstream-tool-errors.ts`). A provider can echo the
 * credential it was sent, so what is quoted is redacted against everything the
 * request carried before anyone below the secret's scope reads it.
 */

/**
 * Below this, a substituted value not known to be a credential is redacted only
 * where it stands ALONE — see {@link SecretRedactor}. It is still redacted;
 * what it may not do is match inside a longer run of letters and digits.
 */
const MIN_SECRET_CHARS = 6;
/** The shortest leading run of a secret we will treat as an echo of it. */
const MIN_ECHOED_PREFIX_CHARS = 8;
/**
 * The length from which the caller's text is taken out in any piece, and a
 * credential wherever it appears; below it, each only where it stands alone
 * — see {@link SecretRedactor}.
 */
const MIN_CALLER_CHARS = 4;
/**
 * How much of what the caller sent `redact` reads at most; past it, none of
 * the text is quoted. It depends on nothing secret, so it tells nothing.
 */
const MAX_CALLER_CHARS_READ = 4_000_000;
const REDACTED = '[redacted]';
/** A letter or digit of any script: what a short value may not be glued to, to stand alone. */
const WORD_CHAR = /[\p{L}\p{N}]/u;

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
 * nothing there and prints the head of the key regardless. So do the other
 * spellings a value travels in: trimmed, url-encoded and JSON-escaped.
 *
 * A KNOWN credential ({@link remember}) is taken out wherever it appears,
 * whatever its length: a four-character key is still the key, and one echoed
 * glued to other text (`xa9B2y`) is still echoed. The price is paid in the
 * message: a short credential blanks its characters wherever they fall. One
 * shorter than four characters cannot also be kept from answering a guess the
 * caller glues to other text, so while one is held, a quote made with the
 * caller's text about ({@link redact}'s `callerText`) is not quoted at all:
 * the same `[redacted]` whatever was sent.
 *
 * A value that is only known to have been SUBSTITUTED ({@link rememberSubstituted})
 * is one too when its variable's name says so. Otherwise it may be anything:
 * this class is handed whatever every `${VAR}` in the manual resolved to, so a
 * `${VERSION}` of `1` or a `${REGION}` of `us` arrives alongside the token.
 * Blanking those wherever their characters happened to fall would turn
 * `answered 401` into `answered 40[redacted]` and destroy the message that
 * makes the verdict useful, so a SHORT one of those may only match a run of
 * its own. Six characters or more, it is taken out wherever it appears too.
 *
 * Text the CALLER sent ({@link redact}'s `callerText`) is taken out too,
 * whether or not a secret is in it: every four characters of the quote that
 * also occur, case aside, in a string the caller sent (as sent or in one of
 * the spellings above); and, where it stands alone in the quote, every string
 * of theirs shorter than that, punctuation included, and every word of one to
 * three letters or digits inside a longer string of theirs (the way a short
 * value that is not a credential is matched, below). Otherwise the
 * quote would answer the caller's guesses: a guess at a key echoed back,
 * whole, shortened at either end or re-cased, or a list of candidates sent
 * alongside a server that quotes the key itself, would come back `[redacted]`
 * or not depending on whether it was right. Nothing taken out there depends
 * on a secret, so it comes back the same either way. The price is paid in the
 * message, which loses every piece it shares with what the caller sent; a
 * short piece only where it stands alone, since blanking every `a` or `1`
 * inside other words would destroy it. A short guess glued to other text is
 * left as it came, right or wrong: nothing that short is matched inside other
 * text while the caller's text is about. A piece shorter than four characters
 * cut from a longer string of the caller's is not recognised.
 *
 * Nothing here gives up on a long text: each secret is matched in time linear
 * in the text and the secret, so no bound on the work can trip on one and not
 * on another.
 */
export class SecretRedactor {
  /** Taken out wherever they appear. */
  private readonly credentials = new Set<string>();
  /** Substituted values not known to be credentials: a short one only where it stands alone. */
  private readonly substituted = new Set<string>();

  /** A known credential: a value the request sent as one. */
  remember(value: string): void {
    for (const spelling of spellings(value)) this.credentials.add(spelling);
  }

  /**
   * The value `${name}` resolved to. A credential when the name says so
   * ({@link carriesCredential}); otherwise see the class comment.
   */
  rememberSubstituted(name: string, value: string): void {
    if (carriesCredential(name)) {
      this.remember(value);
      return;
    }
    for (const spelling of spellings(value)) this.substituted.add(spelling);
  }

  /**
   * `text` with every secret taken out, each run of taken-out characters as
   * one `[redacted]`. Every match is found in the text as it came, so no value
   * can match inside a marker another one left, and echoes that overlap are
   * both taken out. `callerText`: the strings the caller sent with the request,
   * taken out wherever they are repeated (see the class comment).
   */
  redact(text: string, callerText: readonly string[] = []): string {
    // A credential this short cannot be both taken out wherever it is and
    // kept from answering a guess glued to other text; with the caller's text
    // about, the quote goes whole (see the class comment).
    if (callerText.length > 0 && [...this.credentials].some((secret) => secret.length < MIN_CALLER_CHARS)) return REDACTED;
    const hidden = new Uint8Array(text.length);
    const hide = (start: number, end: number) => hidden.fill(1, start, end);
    // What the caller sent, case aside: each four characters of the folded
    // text found in a folded string of theirs, taken out over the characters
    // of the text it came from, and each short word that stands alone and is
    // one of their short words.
    if (callerText.length > 0) {
      const { folded, from, to } = foldWithSpans(text);
      const startsOf = new Map<string, number[]>();
      for (let i = 0; i + MIN_CALLER_CHARS <= folded.length; i++) {
        const piece = folded.slice(i, i + MIN_CALLER_CHARS);
        const starts = startsOf.get(piece);
        if (starts) starts.push(i);
        else startsOf.set(piece, [i]);
      }
      const shortRuns = new Map<string, Array<readonly [number, number]>>();
      for (const run of text.matchAll(/[\p{L}\p{N}]+/gu)) {
        if (run[0].length >= MIN_CALLER_CHARS) continue;
        const key = foldCase(run[0]);
        const spans = shortRuns.get(key);
        const span = [run.index, run.index + run[0].length] as const;
        if (spans) spans.push(span);
        else shortRuns.set(key, [span]);
      }
      const shortSent = new Set<string>();
      let read = 0;
      for (const sent of callerText) {
        for (const spelling of new Set(spellings(sent))) {
          read += spelling.length;
          if (read > MAX_CALLER_CHARS_READ) return REDACTED;
          const sentFolded = foldCase(spelling);
          for (let i = 0; i + MIN_CALLER_CHARS <= sentFolded.length && startsOf.size > 0; i++) {
            const piece = sentFolded.slice(i, i + MIN_CALLER_CHARS);
            for (const start of startsOf.get(piece) ?? []) hide(from[start]!, to[start + MIN_CALLER_CHARS - 1]!);
            startsOf.delete(piece);
          }
          // A short string of theirs, punctuation included, looked for once
          // all are known (below); a short word inside a longer one: each
          // where it stands alone.
          if (sentFolded.trim().length > 0 && sentFolded.length < MIN_CALLER_CHARS) shortSent.add(sentFolded);
          for (const word of sentFolded.matchAll(/[\p{L}\p{N}]+/gu)) {
            if (word[0].length >= MIN_CALLER_CHARS) continue;
            for (const [start, end] of shortRuns.get(word[0]) ?? []) hide(start, end);
            shortRuns.delete(word[0]);
          }
        }
      }
      // Each short string of theirs where it stands alone: one walk over the
      // text, every start tried against the set, however many they sent.
      for (let at = 0; at < folded.length && shortSent.size > 0; at++) {
        if (at > 0 && WORD_CHAR.test(folded[at - 1]!)) continue;
        for (let length = 1; length < MIN_CALLER_CHARS && at + length <= folded.length; length++) {
          const end = at + length;
          if (shortSent.has(folded.slice(at, end)) && (end === folded.length || !WORD_CHAR.test(folded[end]!))) {
            hide(from[at]!, to[end - 1]!);
          }
        }
      }
    }
    for (const secret of new Set([...this.credentials, ...this.substituted])) {
      if (secret.length < MIN_SECRET_CHARS && !this.credentials.has(secret)) {
        for (const match of text.matchAll(standingAlone(secret))) hide(match.index, match.index + secret.length);
        continue;
      }
      // The whole value, and any echoed head of it: each run that starts with
      // its first characters, as far as it goes on matching.
      const least = Math.min(secret.length, MIN_ECHOED_PREFIX_CHARS);
      const matched = prefixMatches(secret, text);
      for (let at = 0; at < text.length; at++) if (matched[at]! >= least) hide(at, at + matched[at]!);
    }
    let out = '';
    for (let i = 0; i < text.length; i++) {
      if (!hidden[i]) out += text[i];
      else if (i === 0 || !hidden[i - 1]) out += REDACTED;
    }
    return out;
  }
}

/** The spellings a value can travel in: as it is, trimmed, url-encoded, JSON-escaped (with `/` escaped or not). */
function spellings(value: string): string[] {
  const trimmed = value.trim();
  // Blank is not a secret, and a blank needle matches everywhere.
  if (!trimmed) return [];
  const escaped = JSON.stringify(value).slice(1, -1);
  return [value, trimmed, urlEncoded(value), escaped, escaped.replaceAll('/', '\\/')].filter(
    (spelling): spelling is string => !!spelling?.trim(),
  );
}

/**
 * One character case-folded: upper- then lower-cased, so the pairs a case
 * change expands or shrinks meet (`ß` and `SS`, `İ` and `i̇`).
 */
function foldChar(ch: string): string {
  return ch.toUpperCase().toLowerCase();
}

/** `text` case-folded one character at a time ({@link foldChar}); printable ASCII takes the short way, to the same result. */
function foldCase(text: string): string {
  if (/^[ -~]*$/.test(text)) return text.toLowerCase();
  let folded = '';
  for (const ch of text) folded += foldChar(ch);
  return folded;
}

/**
 * `text` case-folded as {@link foldCase} does, with, for each unit of the
 * folded text, where the character it came from starts (`from`) and ends
 * (`to`) in `text`: a piece found in the folded text is taken out over the
 * characters it came from, however long their folding made it.
 */
function foldWithSpans(text: string): { folded: string; from: number[]; to: number[] } {
  let folded = '';
  const from: number[] = [];
  const to: number[] = [];
  let at = 0;
  for (const ch of text) {
    const fold = foldChar(ch);
    for (let unit = 0; unit < fold.length; unit++) {
      from.push(at);
      to.push(at + ch.length);
    }
    folded += fold;
    at += ch.length;
  }
  return { folded, from, to };
}

/** `value` url-encoded, or null for one that cannot be (a lone surrogate): no request could carry it that way. */
function urlEncoded(value: string): string | null {
  try {
    return encodeURIComponent(value);
  } catch {
    return null;
  }
}

/**
 * For each position of `text`, how many characters from there match the start
 * of `pattern`: the Z-algorithm carried over the text, in time linear in both.
 */
function prefixMatches(pattern: string, text: string): Int32Array {
  const self = new Int32Array(pattern.length);
  self[0] = pattern.length;
  for (let i = 1, left = 0, right = 0; i < pattern.length; i++) {
    let k = i < right ? Math.min(self[i - left]!, right - i) : 0;
    while (i + k < pattern.length && pattern[k] === pattern[i + k]) k++;
    self[i] = k;
    if (i + k > right) [left, right] = [i, i + k];
  }
  const matched = new Int32Array(text.length);
  for (let i = 0, left = 0, right = 0; i < text.length; i++) {
    let k = i < right ? Math.min(self[i - left]!, right - i) : 0;
    while (k < pattern.length && i + k < text.length && text[i + k] === pattern[k]) k++;
    matched[i] = k;
    if (i + k > right) [left, right] = [i, i + k];
  }
  return matched;
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
 * Only a short substituted value not known to be a credential comes here
 * (see {@link SecretRedactor}); a known credential, and any value of six
 * characters or more, is taken out wherever it appears.
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
 * Names — of a header, a query parameter, an environment variable, an auth
 * field or a `${VAR}` — whose value IS a credential rather than a description
 * of the request. Matched as substrings and on purpose generously: a name
 * wrongly treated as secret costs its value, blanked wherever it appears in a
 * quoted message (inside other words too, when the value is short), while one
 * wrongly treated as public costs the credential. `signature` and `hmac` earn
 * their place because a signed url (`X-Amz-Signature`, an Azure SAS) grants
 * access exactly as a bearer token does — the secret is what derived it, and
 * the derivation is what is sent.
 */
const CREDENTIAL_MARKERS = [
  'auth',
  'key',
  'token',
  'secret',
  'password',
  'passwd',
  'passcode',
  'passphrase',
  'pwd',
  'cookie',
  'credential',
  'session',
  'bearer',
  'jwt',
  'signature',
  'hmac',
];

/**
 * The same, for names too short to match as substrings, matched as whole
 * words of the name (split at punctuation and at camelCase humps: `X-Pin`,
 * `client_cred`, `dbPass`, `APIPin`): `sig` inside a word would swallow `design`,
 * `assign` and `signal`, `pin` would swallow `mapping`, `pass` would swallow
 * `bypass`, `cred` would swallow `credit`, and blanking those would eat the
 * message rather than protect anything in it.
 */
const CREDENTIAL_WORDS = new Set(['sig', 'hash', 'pin', 'pat', 'otp', 'sid', 'pw', 'pass', 'cred', 'creds']);

export function carriesCredential(fieldName: string): boolean {
  const name = fieldName.toLowerCase();
  if (CREDENTIAL_MARKERS.some((marker) => name.includes(marker))) return true;
  return fieldName
    .split(/[^a-zA-Z0-9]+|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/)
    .some((word) => CREDENTIAL_WORDS.has(word.toLowerCase()));
}

/** Whatever takes the credentials found below: a {@link SecretRedactor}, or a collector of the fields' text. */
type Remembers = Pick<SecretRedactor, 'remember'>;

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
export function rememberCredentialHeaders(headers: Record<string, unknown>, redactor: Remembers): void {
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
export function rememberCredentialQuery(url: string, redactor: Remembers): void {
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
export function rememberCallCredentials(redactor: Remembers, processed: CallTemplate): void {
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
function rememberCredentialFields(fields: object, redactor: Remembers): void {
  for (const [name, value] of Object.entries(fields)) {
    if (typeof value === 'string' && carriesCredential(name)) redactor.remember(value);
  }
}
