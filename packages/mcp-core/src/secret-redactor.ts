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
/** The shortest piece of a secret we will treat as an echo of it. */
const MIN_ECHOED_PIECE_CHARS = 8;
/**
 * The length of a piece of the caller's text that counts as repeated
 * wherever it appears; a shorter string of theirs counts only glued to more
 * of theirs or, at times, standing alone. A credential shorter than this
 * withholds every quote made with the caller's text about. See
 * {@link SecretRedactor}.
 */
const MIN_CALLER_CHARS = 4;
/**
 * How much of what the caller sent `redact` reads at most; past it, none of
 * the text is quoted. It depends on nothing secret, so it tells nothing.
 */
const MAX_CALLER_CHARS_READ = 4_000_000;
const REDACTED = '[redacted]';
/** No letter or digit of any script (astral ones too) just before, or just after, a position. */
const NO_WORD_BEFORE = /(?<![\p{L}\p{N}])/uy;
const NO_WORD_AFTER = /(?![\p{L}\p{N}])/uy;

/** Whether `text` from `start` to `end` stands alone: no letter or digit glued to either side, read by code point. */
function standsAlone(text: string, start: number, end: number): boolean {
  NO_WORD_BEFORE.lastIndex = start;
  NO_WORD_AFTER.lastIndex = end;
  return NO_WORD_BEFORE.test(text) && NO_WORD_AFTER.test(text);
}

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
 * PIECES count as well as whole values (any eight characters or more of a
 * value, in a row), because that echo is usually masked in the middle
 * ("sk-live-abcd…wxyz"): a whole-value search finds nothing there and prints
 * the head and tail of the key regardless. So do the other spellings a value
 * travels in: trimmed, url-encoded and JSON-escaped.
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
 * With text the CALLER sent ({@link redact}'s `callerText`), a quote goes
 * whole or not at all: it is withheld, one `[redacted]` for all of it, when it
 * repeats any of that text, case aside, or holds any secret. It repeats it
 * when it has any four characters of a string the caller sent (as sent or in
 * one of the spellings above), or two or more of their shorter strings glued
 * into four characters or more; and, while a substituted value shorter than
 * four characters is held (see above), when one of their shorter strings, or a
 * word of one to three letters or digits inside a longer one, stands alone in
 * it. Anything finer answers guesses. Taking out only what repeats the
 * caller's text leaves the rest of a key whose head a right guess covered,
 * where a wrong guess leaves the key taken out whole; taking out the rest of a
 * key from the secrets answers whether a stretch next to the caller's text
 * (one they placed there with a short argument, say) is in a key. Whether a
 * quote is withheld reads the caller's text against the server's words, or
 * the secrets against words the caller's text is not in, so it says nothing
 * about whether a guess was right. The price is paid in the message: a failure
 * that repeats any piece of a call's arguments, a key's name included, is not
 * quoted. With no secret held there is nothing to keep, and the quote goes as
 * it came. A short guess glued to the server's own words is not recognised as
 * the caller's.
 *
 * Nothing here gives up on a long text: each secret is matched in time linear
 * in the text and the secret, and in space linear in the secret, so no bound
 * on the work can trip on one and not on another.
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
   * both taken out. `callerText`: the strings the caller sent with the request;
   * with any, the text goes whole or not at all (see the class comment).
   */
  redact(text: string, callerText: readonly string[] = []): string {
    const secrets = new Set([...this.credentials, ...this.substituted]);
    const hidden = hiddenIn(text, secrets, this.credentials);
    if (callerText.length > 0) {
      if (secrets.size === 0) return text;
      // A credential this short cannot be both taken out wherever it is and
      // kept from answering a guess glued to other text (see the class comment).
      if ([...this.credentials].some((secret) => secret.length < MIN_CALLER_CHARS)) return REDACTED;
      const shortValueHeld = [...this.substituted].some((value) => value.length < MIN_CALLER_CHARS);
      return hidden.includes(1) || repeatsCallerText(text, callerText, shortValueHeld) ? REDACTED : text;
    }
    let out = '';
    for (let i = 0; i < text.length; i++) {
      if (!hidden[i]) out += text[i];
      else if (i === 0 || !hidden[i - 1]) out += REDACTED;
    }
    return out;
  }
}

/**
 * Where `secrets` are in `text`: a credential (one of `credentials`) or a
 * value of six characters or more wherever it appears, a shorter value that is
 * not a credential only where it stands alone, and any piece of eight
 * characters or more of a value, each run filled once, without the spaces at
 * its edges (a piece of `Bearer <token>` can start with one).
 */
function hiddenIn(text: string, secrets: ReadonlySet<string>, credentials: ReadonlySet<string>): Uint8Array {
  const hidden = new Uint8Array(text.length);
  for (const secret of secrets) {
    if (secret.length < MIN_SECRET_CHARS && !credentials.has(secret)) {
      for (const match of text.matchAll(standingAlone(secret))) hidden.fill(1, match.index, match.index + secret.length);
    } else if (secret.length < MIN_ECHOED_PIECE_CHARS) {
      for (let at = text.indexOf(secret); at >= 0; at = text.indexOf(secret, at + 1)) hidden.fill(1, at, at + secret.length);
    } else {
      const covered = windowsOf(secret, text);
      for (let start = 0; start < text.length; start++) {
        if (!covered[start]) continue;
        let end = start;
        while (end < text.length && covered[end]) end++;
        let from = start;
        let to = end;
        while (from < to && /\s/.test(text[from]!)) from++;
        while (to > from && /\s/.test(text[to - 1]!)) to--;
        hidden.fill(1, from, to);
        start = end;
      }
    }
  }
  return hidden;
}

/**
 * Whether `text` repeats any of `callerText`, case aside (see the class
 * comment); and, past four million characters of it read, whether it might,
 * which depends on nothing secret. Their four-character pieces are looked up
 * in a table of the text's, and their short strings in one walk over it.
 */
function repeatsCallerText(text: string, callerText: readonly string[], shortValueHeld: boolean): boolean {
  const folded = foldCase(text);
  const pieces = new HashTable(folded.length);
  for (const [, a, b] of rolled(folded, MIN_CALLER_CHARS)) pieces.add(a, b);
  const shortStrings = new Set<string>();
  const shortWords = new Set<string>();
  let read = 0;
  for (const sent of callerText) {
    for (const spelling of new Set(spellings(sent))) {
      read += spelling.length;
      if (read > MAX_CALLER_CHARS_READ) return true;
      const sentFolded = foldCase(spelling);
      if (sentFolded.length < MIN_CALLER_CHARS) {
        shortStrings.add(sentFolded);
        continue;
      }
      for (const [, a, b] of rolled(sentFolded, MIN_CALLER_CHARS)) if (pieces.has(a, b)) return true;
      if (!shortValueHeld) continue;
      for (const word of sentFolded.matchAll(/[\p{L}\p{N}]+/gu)) if (word[0].length < MIN_CALLER_CHARS) shortWords.add(word[0]);
    }
  }
  if (shortStrings.size === 0 && shortWords.size === 0) return false;
  // How long a run of their short strings, glued, ends at each place.
  const gluedUpTo = new Int32Array(folded.length + 1);
  for (let at = 0; at < folded.length; at++) {
    for (let length = 1; length < MIN_CALLER_CHARS && at + length <= folded.length; length++) {
      const end = at + length;
      const piece = folded.slice(at, end);
      const theirs = shortStrings.has(piece);
      if (theirs) {
        gluedUpTo[end] = Math.max(gluedUpTo[end]!, gluedUpTo[at]! + length);
        if (gluedUpTo[end]! >= MIN_CALLER_CHARS) return true;
      }
      if (shortValueHeld && (theirs || shortWords.has(piece)) && standsAlone(folded, at, end)) return true;
    }
  }
  return false;
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

/** `value` url-encoded, or null for one that cannot be (a lone surrogate): no request could carry it that way. */
function urlEncoded(value: string): string | null {
  try {
    return encodeURIComponent(value);
  } catch {
    return null;
  }
}

/**
 * Which positions of `text` lie in a window of eight characters that also
 * occurs in `pattern`. The pattern's
 * windows go into an open-addressing table of two typed arrays (two rolling
 * hashes, so a collision can only take out more), and the text's are looked
 * up: time linear in both, space linear in the pattern. A run of covered
 * positions is a piece of the pattern, or made of its pieces.
 */
function windowsOf(pattern: string, text: string): Uint8Array {
  const size = MIN_ECHOED_PIECE_CHARS;
  const covered = new Uint8Array(text.length);
  if (pattern.length < size || text.length < size) return covered;
  const table = new HashTable(pattern.length);
  for (const [, a, b] of rolled(pattern, size)) table.add(a, b);
  for (const [start, a, b] of rolled(text, size)) if (table.has(a, b)) covered.fill(1, start, start + size);
  return covered;
}

/**
 * Each stretch of `size` units of `of`: where it starts, and its two rolling
 * hashes. Two hashes, so a collision can only match more.
 */
function* rolled(of: string, size: number): Generator<readonly [number, number, number]> {
  const [baseA, baseB] = [0x01000193, 0x5bd1e995];
  let [dropA, dropB] = [1, 1];
  for (let i = 1; i < size; i++) [dropA, dropB] = [Math.imul(dropA, baseA), Math.imul(dropB, baseB)];
  let [a, b] = [0, 0];
  for (let i = 0; i < of.length; i++) {
    if (i >= size) {
      const out = of.charCodeAt(i - size);
      [a, b] = [(a - Math.imul(out, dropA)) | 0, (b - Math.imul(out, dropB)) | 0];
    }
    const unit = of.charCodeAt(i);
    [a, b] = [(Math.imul(a, baseA) + unit) | 0, (Math.imul(b, baseB) + unit) | 0];
    if (i >= size - 1) yield [i + 1 - size, a, b];
  }
}

/** Pairs of hashes in an open-addressing table of typed arrays sized for `entries`. */
class HashTable {
  private readonly keyA: Int32Array;
  private readonly keyB: Int32Array;
  private readonly used: Uint8Array;
  private readonly mask: number;

  constructor(entries: number) {
    let slots = 1;
    while (slots < 2 * entries) slots *= 2;
    this.mask = slots - 1;
    this.keyA = new Int32Array(slots);
    this.keyB = new Int32Array(slots);
    this.used = new Uint8Array(slots);
  }

  add(a: number, b: number): void {
    const slot = this.slotOf(a, b);
    [this.keyA[slot], this.keyB[slot], this.used[slot]] = [a, b, 1];
  }

  has(a: number, b: number): boolean {
    return this.used[this.slotOf(a, b)] === 1;
  }

  /** The slot of hashes `a`, `b`: theirs, or the empty one where they would go. */
  private slotOf(a: number, b: number): number {
    let slot = (a ^ (a >>> 15)) & this.mask;
    while (this.used[slot] && !(this.keyA[slot] === a && this.keyB[slot] === b)) slot = (slot + 1) & this.mask;
    return slot;
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
