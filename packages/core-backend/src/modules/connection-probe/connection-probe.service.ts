import { randomUUID } from 'node:crypto';
import '@utcp/http'; // side effect: registers the 'http' UTCP communication protocol
import '@utcp/mcp'; // side effect: registers the 'mcp' protocol (remote MCP `.tool` sources)
import { CommunicationProtocol, UtcpClientConfigSerializer, type CallTemplate } from '@utcp/sdk';
import { CodeModeUtcpClient } from '@utcp/code-mode';
import { registerManual } from '@bevel-software/platform-mcp-core';
import type { IToolManualService, ToolHealthCheck, ToolProbeTarget } from '../tool-manuals/tool-manuals.contract.js';
import type { ISecretsVaultService } from '../secrets-vault/secrets-vault.contract.js';
// The concrete module, NOT the `secrets-vault` barrel: that barrel re-exports
// the routes, and the routes import this module's contract — so going through
// it would close an import cycle between the two modules.
import { bevelSecretsLoaderConfig } from '../secrets-vault/secrets-variable-loader.js';
import { utcpNamespacedKey } from '../../shared/utcp-namespace.js';
import { assertSafeFetchUrl } from '../../shared/ssrf.js';
import type { IConnectionProbeService, ProbeStatus, ProbeVerdict } from './connection-probe.contract.js';

/** How long a probe may take before we call it inconclusive. */
const PROBE_TIMEOUT_MS = 10_000;

/** A verdict before it is stamped with a time. */
interface Outcome {
  status: ProbeStatus;
  detail: string | null;
}

const OK: Outcome = { status: 'ok', detail: null };

const NO_PROBE: Outcome = {
  status: 'unverifiable',
  detail: "This tool doesn't offer a way to test its connection.",
};

/**
 * Variable references, in the SAME grammar UTCP itself substitutes.
 *
 * `@utcp/sdk`'s `DefaultVariableSubstitutor` accepts BOTH `${VAR}` and bare
 * `$VAR`, and so does the scanner that decides which variables the UI asks the
 * user to fill in. Matching only the braced form meant a manual written as
 * `Authorization: Bearer $API_KEY` — which works perfectly in real calls, and
 * whose `API_KEY` the tool page duly asks for — had the LITERAL string sent by
 * the probe, drawing a 401 and reporting a correct credential as "Not working".
 *
 * A fresh regex per call: `lastIndex` is mutable state on a `/g` pattern, and
 * this one is used for both scanning and replacing.
 */
function varRefPattern(): RegExp {
  return /\$\{([a-zA-Z0-9_]+)\}|\$([a-zA-Z0-9_]+)/g;
}

/**
 * Does this failure ACCUSE the credential, or merely fail to exonerate it?
 *
 * Only a definitive rejection may set `failed`, because that is the status that
 * tells a user their key is wrong. A provider that is down, rate-limiting, or
 * unreachable says nothing about the key, and reporting those as "not working"
 * would make the badge cry wolf during someone else's outage — which teaches
 * people to ignore it, landing us back where we started by a different road.
 *
 * Matching on message text is unavoidable for the MCP path: registration
 * failures surface as prose from the transport, not as a status code. The list
 * is deliberately narrow and the default is "we don't know", so the failure
 * mode of a miss is an over-cautious `unverifiable` rather than a false
 * accusation.
 */
function looksLikeAuthRejection(message: string): boolean {
  const m = message.toLowerCase();
  return (
    /\b(401|403)\b/.test(m) ||
    m.includes('unauthorized') ||
    m.includes('unauthenticated') ||
    m.includes('forbidden') ||
    m.includes('invalid_token') ||
    m.includes('invalid token') ||
    m.includes('invalid api key') ||
    m.includes('invalid_api_key') ||
    m.includes('authentication failed') ||
    m.includes('invalid_grant')
  );
}

/** What {@link withProbeTimeout} returns for work that outlived the deadline. */
const TIMED_OUT = Symbol('probe-timed-out');

/**
 * Resolve `work`, or {@link TIMED_OUT} if it outlives `PROBE_TIMEOUT_MS`.
 *
 * The declared-probe path gets its deadline from `AbortSignal.timeout`, but the
 * MCP path cannot: neither `CodeModeUtcpClient.create` nor `registerManual`
 * accepts a signal. Without this, an unresponsive server leaves a probe pending
 * forever and the caller never gets a verdict at all.
 *
 * Abandoning work is not the same as stopping it, and on the MCP path the
 * difference is a live socket. `@utcp/mcp` caches a session only AFTER its
 * `connect()` resolves, so a handshake still in flight at the deadline has
 * nothing for the caller's `finally` to find — and then caches its session (and
 * its standalone SSE stream) moments later with nobody left holding it. That is
 * one leaked session per probe against a slow server, on every credential save.
 * `onLateSettle` is the owner for exactly that window: it runs when abandoned
 * work eventually settles, and it is the only thing that can close a session
 * opened after the verdict was returned.
 */
async function withProbeTimeout<T>(
  work: Promise<T>,
  onLateSettle?: () => Promise<void> | void,
): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abandoned = false;
  // Attached before the race, so the continuation exists no matter when `work`
  // settles. Both branches: a rejection can also have opened something — a
  // successful `connect()` followed by a failing `listTools` leaves a session
  // cached and the promise rejected.
  void work
    .then(
      () => (abandoned ? onLateSettle?.() : undefined),
      () => (abandoned ? onLateSettle?.() : undefined),
    )
    .catch((err) => {
      console.warn(`[probe] late cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => {
      abandoned = true;
      resolve(TIMED_OUT);
    }, PROBE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Below this, a "secret" is too short to blank out without eating the message. */
const MIN_SECRET_CHARS = 6;
/** The shortest leading run of a secret we will treat as an echo of it. */
const MIN_ECHOED_PREFIX_CHARS = 8;
const REDACTED = '[redacted]';

/**
 * Every secret this probe resolved, so that none of them can come back out in
 * something we quote.
 *
 * A rejection is quoted verbatim because the provider's own words are the
 * actionable part — but providers routinely echo the credential they refused
 * ("Incorrect API key provided: sk-…"). Anyone who can READ a tool can probe
 * it, so without this a plain reader could recover part of a shared ADMIN key
 * they were never allowed to see by saving a probe's failure text. The 200-char
 * cap on the quote bounds it; it does not redact it.
 *
 * Leading PREFIXES count as well as whole values, because that echo is usually
 * masked in the middle ("sk-live-abcd…wxyz"): a whole-value search finds
 * nothing there and prints the head of the key regardless. Short values are
 * left alone — blanking a five-character string would hit unrelated text and
 * destroy the message that makes the verdict useful.
 */
class SecretRedactor {
  private readonly values = new Set<string>();

  remember(value: string): void {
    if (value.length >= MIN_SECRET_CHARS) this.values.add(value);
  }

  redact(text: string): string {
    let out = text;
    // Longest SECRET first, and not merely the longest prefix of each: when one
    // resolved value is a prefix of another (a key and that same key with a
    // suffix), redacting the short one first eats the head of the long one and
    // leaves its tail printed — the exact half-redaction this class exists to
    // avoid, arrived at from the other direction.
    for (const secret of [...this.values].sort((a, b) => b.length - a.length)) {
      // Longest match first: replacing the whole value when it is present beats
      // replacing a prefix of it and leaving the tail on screen.
      const shortest = Math.min(secret.length, MIN_ECHOED_PREFIX_CHARS);
      for (let len = secret.length; len >= shortest; len--) {
        const candidate = secret.slice(0, len);
        if (!out.includes(candidate)) continue;
        out = out.split(candidate).join(REDACTED);
        break;
      }
    }
    return out;
  }
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

function carriesCredential(fieldName: string): boolean {
  const name = fieldName.toLowerCase();
  return CREDENTIAL_MARKERS.some((marker) => name.includes(marker)) || CREDENTIAL_WORDS.test(name);
}

/**
 * Remember a credential the manual spelled out in full.
 *
 * {@link ConnectionProbeService.substitute} only ever learns values it resolved
 * from the vault, so a `.tool` whose header reads `Authorization: Bearer sk-…`
 * rather than `Bearer ${TOKEN}` left the redactor with nothing to look for. That
 * is the one credential a reader has no other route to: `ToolManualSummary`
 * withholds `headers` from the browser for precisely this reason, and a
 * provider quoting it in a 401 would have handed it back regardless.
 *
 * What follows the auth scheme is remembered as well as the whole value,
 * because `Bearer sk-…` is echoed as the bare token far more often than in
 * full, and `Bearer` by itself is not worth blanking out of a message.
 */
function rememberCredentialHeaders(headers: Record<string, unknown>, redactor: SecretRedactor): void {
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
function rememberCredentialQuery(url: string, redactor: SecretRedactor): void {
  let params: URLSearchParams;
  try {
    params = new URL(url).searchParams;
  } catch {
    return;
  }
  for (const [name, value] of params) {
    if (carriesCredential(name)) redactor.remember(value);
  }
}

/**
 * The same, for the headers an `mcp` manual carries on its server entry. This
 * path never substitutes them — UTCP's own loader does that inside the SDK — so
 * a templated value belongs to the vault and `rememberTemplateSecrets` already
 * holds it; only what the file spells out in full is new here, and skipping the
 * rest keeps a half-literal value like `example.com/${TENANT}` from lending its
 * public prefix to the redactor.
 */
function rememberLiteralServerHeaders(template: CallTemplate, redactor: SecretRedactor): void {
  const servers = (template as { config?: { mcpServers?: Record<string, unknown> } }).config?.mcpServers;
  for (const server of Object.values(servers ?? {})) {
    const headers = (server as { headers?: unknown }).headers;
    if (!headers || typeof headers !== 'object') continue;
    const literal = Object.fromEntries(
      Object.entries(headers as Record<string, unknown>).filter(
        ([, value]) => typeof value === 'string' && !varRefPattern().test(value),
      ),
    );
    rememberCredentialHeaders(literal, redactor);
  }
}

/**
 * A copy of `template` whose MCP server keys are unique to one probe.
 *
 * This is what makes an MCP probe test the credential rather than the cache.
 * `@utcp/mcp` registers a MODULE-LEVEL singleton protocol whose session map is
 * keyed only `<serverName>:<transport>`, and `_getOrCreateSession` returns a
 * cached hit WITHOUT consulting the auth it was handed — so a throwaway client
 * is emphatically not a throwaway session. Probing under the manual's own name
 * would hand back whatever session the MCP proxy opened earlier, `listTools`
 * would succeed on that older token, and a freshly mistyped key would be
 * reported **Connected**: the exact bug this module exists to remove, rebuilt
 * inside its own fix. It would also let one user's probe answer from another
 * user's session, and let a failing probe evict the session everyone is using.
 *
 * The key is only a cache key and a tool-name prefix (`<manual>.<server>.<tool>`),
 * and variables resolve against the MANUAL's name, not this one — so renaming
 * it changes nothing about what gets dialled or which secrets it carries.
 */
function withIsolatedServerKeys(template: CallTemplate): CallTemplate {
  const clone = structuredClone(template) as CallTemplate & {
    config?: { mcpServers?: Record<string, unknown> };
  };
  const servers = clone.config?.mcpServers;
  if (!servers) return clone;
  const nonce = randomUUID().replace(/-/g, '');
  clone.config!.mcpServers = Object.fromEntries(
    Object.entries(servers).map(([key, value]) => [`${key}__probe_${nonce}`, value]),
  );
  return clone;
}

/**
 * Close whatever MCP sessions this probe opened.
 *
 * Through the PROTOCOL rather than `client.deregisterManual(name)`, which only
 * works for a manual the client managed to register: on a failed handshake the
 * client never saves the manual, so the client-level call finds nothing and
 * returns `false` — while the session, created before `listTools` was ever
 * attempted, stays cached and open. A failed probe is exactly when that
 * happens, so cleanup has to be reachable without the registry. The protocol's
 * own `deregisterManual` takes the template directly and closes each
 * `<server>:<transport>` session it names.
 *
 * Best-effort: the probe has already produced its verdict, and failing to tidy
 * up must not turn a successful check into an error.
 */
async function closeProbeSessions(client: CodeModeUtcpClient, template: CallTemplate): Promise<void> {
  try {
    const protocol = CommunicationProtocol.communicationProtocols[template.call_template_type];
    await protocol?.deregisterManual(client as never, template);
  } catch (err) {
    console.warn(`[probe] closing session failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Runs one credential probe and hands back the answer. Holds no state and
 * writes nothing: see {@link ProbeVerdict} for why the verdict isn't stored.
 */
export class ConnectionProbeService implements IConnectionProbeService {
  constructor(
    private readonly toolManualService: IToolManualService,
    private readonly secretsVault: ISecretsVaultService,
  ) {}

  async probe(userId: string, userEmail: string, slug: string): Promise<ProbeVerdict | null> {
    // ONE catalog + ACL pass for every fact this probe needs: whether the tool
    // is local-only, what it declares as a health check, and the call template
    // an `mcp` handshake would dial.
    const target = await this.toolManualService.probeTargetFor(userEmail, slug);
    if (!target) return null;
    const outcome = await this.runProbe(userId, target);
    return { status: outcome.status, detail: outcome.detail, checkedAt: new Date() };
  }

  // --- internal --------------------------------------------------------------

  /**
   * Pick the probe for this manual.
   *
   * A DECLARED health check wins for every type, including `mcp`. The author
   * naming an endpoint is a stronger statement about how to test their tool
   * than any inference of ours, and honouring it means a declaration is never
   * silently ignored — which is the whole contract of the field.
   *
   * Failing that, an `mcp` manual tests itself: its handshake is authenticated,
   * so connecting at all proves the token. `http` and `inline` have no such
   * moment (an `http` manual's registration fetches its public DESCRIPTION; an
   * `inline` manual's points at Bevel's own API), so with nothing declared
   * there is genuinely nothing to call.
   */
  private async runProbe(userId: string, target: ToolProbeTarget): Promise<Outcome> {
    // A local-only tool runs in someone's own agent; this server cannot reach it
    // (that is what `remote: false` MEANS), so a failure here would say nothing
    // about the credential.
    if (target.remote === false) {
      return { status: 'unverifiable', detail: 'This tool runs only in a local agent, so the server cannot test it.' };
    }
    if (target.healthCheck) return this.probeDeclared(userId, target, target.healthCheck);
    if (target.type === 'mcp') return this.probeMcpHandshake(userId, target);
    return NO_PROBE;
  }

  /**
   * Call the endpoint the manual declared, carrying the caller's credential.
   *
   * Headers default to the manual's own — that is where the credential normally
   * lives, so the common case is a one-line `healthCheck: { url }` and the probe
   * authenticates exactly like a real call.
   */
  private async probeDeclared(userId: string, target: ToolProbeTarget, check: ToolHealthCheck): Promise<Outcome> {
    // `headers` is already defaulted to the manual's own at parse time, so a
    // one-line `healthCheck: { url }` still carries the credential.
    const headerTemplate = check.headers ?? {};
    // Collects what the substitutions resolve, so the provider cannot quote any
    // of it back at a reader who is not allowed to see it.
    const redactor = new SecretRedactor();
    let url: string;
    let headers: Record<string, string>;
    try {
      url = await this.substitute(userId, target.name, check.url, redactor);
      headers = Object.fromEntries(
        await Promise.all(
          Object.entries(headerTemplate).map(
            async ([k, v]) => [k, await this.substitute(userId, target.name, v, redactor)] as const,
          ),
        ),
      );
    } catch (err) {
      // An unset variable is not a broken credential — the vault's own status
      // already says "needs a key from you", and firing a request with an empty
      // Bearer would turn that into a spurious rejection.
      return { status: 'unverifiable', detail: err instanceof Error ? err.message : String(err) };
    }

    // A `.tool` may write its token straight into `headers` rather than through
    // a `${VAR}`, and substitution never saw it. Record what is actually about
    // to be sent, so the provider cannot quote it back at a reader.
    rememberCredentialHeaders(headers, redactor);
    rememberCredentialQuery(url, redactor);

    // Re-check at fetch time even though the declaration was checked at parse
    // time: a TEMPLATED host is unknowable until now, so this is the first
    // moment the real target exists (`${HOST}` could resolve to the metadata IP).
    try {
      assertSafeFetchUrl(url, { label: 'healthCheck.url' });
    } catch (err) {
      return { status: 'unverifiable', detail: err instanceof Error ? err.message : String(err) };
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method: check.method ?? 'GET',
        headers,
        // Don't follow redirects: a validated host could 302 to an internal
        // target, and a 3xx tells us nothing about the credential anyway.
        redirect: 'manual',
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
    } catch (err) {
      // Redacted like everything else quoted from outside: a transport error
      // names the url it failed on, and a templated url can carry a token.
      return {
        status: 'unverifiable',
        detail: `Couldn't reach the provider to check: ${redactor.redact(err instanceof Error ? err.message : String(err))}`,
      };
    }

    if (res.ok) return OK;
    if (res.status === 401 || res.status === 403) {
      return { status: 'failed', detail: await describeRejection(res, redactor) };
    }
    return {
      status: 'unverifiable',
      detail: `The provider answered ${res.status}, which doesn't say whether the credential is valid.`,
    };
  }

  /**
   * Register the manual on a throwaway client and a session of its own: for a
   * remote MCP server the handshake is authenticated, so a successful
   * registration IS proof the token works, and a rejection is the provider's own
   * verdict.
   */
  private async probeMcpHandshake(userId: string, target: ToolProbeTarget): Promise<Outcome> {
    if (!target.callTemplate) {
      return { status: 'unverifiable', detail: "This tool's definition couldn't be resolved, so it wasn't tested." };
    }
    // See `withIsolatedServerKeys`: without this the probe can be answered by a
    // session opened with an older credential.
    const template = withIsolatedServerKeys(target.callTemplate);
    const redactor = new SecretRedactor();

    // The SAME fetch-time SSRF re-check the declared probe gets, for the same
    // reason: a templated host does not exist at parse time, so the guard there
    // could not see it. Without this, an `mcp` manual whose url is
    // `https://${HOST}/mcp` reaches the metadata endpoint the moment someone
    // clicks Test connection. `@utcp/mcp`'s own `ensureSecureMcpUrl` is no help
    // here — it checks the SCHEME, and allows https to any host at all.
    const unsafe = await this.resolveServerUrls(userId, target.name, template, redactor);
    if (unsafe) return unsafe;
    // The rest of the template keeps its `${VAR}`s for UTCP's own loader; these
    // values are read only so that nothing quoted below can echo one back.
    await this.rememberTemplateSecrets(userId, target.name, target.callTemplate, redactor);
    rememberLiteralServerHeaders(target.callTemplate, redactor);

    const timedOut: Outcome = {
      status: 'unverifiable',
      detail: `The server didn't answer within ${PROBE_TIMEOUT_MS / 1000}s, so the credential wasn't tested.`,
    };

    let client: CodeModeUtcpClient | null = null;
    try {
      // No loopback seeding (`API_URL`/`CONNECTION_KEY`): those belong to
      // Bevel-hosted manuals, and this path only ever registers a third-party
      // MCP server. Its `${VAR}`s resolve lazily through the caller's own vault
      // loader, which is exactly the credential under test.
      const config = new UtcpClientConfigSerializer().validateDict({
        variables: {},
        load_variables_from: [bevelSecretsLoaderConfig(userId)],
      });
      // No late-settle owner: a client that arrives after the deadline has no
      // manual registered and therefore no session, and neither
      // `CodeModeUtcpClient` nor the SDK client it wraps exposes any disposal.
      const created = await withProbeTimeout(CodeModeUtcpClient.create(process.cwd(), config));
      if (created === TIMED_OUT) return timedOut;
      client = created;

      // The handshake IS the connection-opener, so its abandoned form gets a
      // closing owner: past the deadline the `finally` below has already run
      // and found nothing to close.
      const dialled = client;
      const result = await withProbeTimeout(registerManual(dialled, template), () =>
        closeProbeSessions(dialled, template),
      );
      if (result === TIMED_OUT) return timedOut;
      if (result.ok) return OK;
      // Classified on the raw error, shown redacted: the provider's rejection
      // text may quote the very credential under test back at us.
      const detail = redactor.redact(result.error);
      return looksLikeAuthRejection(result.error)
        ? { status: 'failed', detail }
        : { status: 'unverifiable', detail: `Couldn't reach the provider to check: ${detail}` };
    } catch (err) {
      return {
        status: 'unverifiable',
        detail: `Couldn't build the connection to test: ${redactor.redact(err instanceof Error ? err.message : String(err))}`,
      };
    } finally {
      // Runs on every path that got as far as a client: the session is keyed to
      // this probe alone, so leaving it open leaks one Streamable-HTTP session
      // per credential save. Past the deadline this finds nothing — the session
      // does not exist yet — which is what the late-settle owner above is for.
      if (client) await closeProbeSessions(client, template);
    }
  }

  /**
   * Resolve every MCP server url in `template` IN PLACE, or say why one of them
   * may not be dialled.
   *
   * The substitution and the check are the same act, deliberately: checking a
   * resolved url and then handing UTCP the `${HOST}` template back would leave
   * the vault free to answer differently the second time. A concurrent
   * `PUT …/vars/HOST` landing in that gap aims the handshake at whatever the
   * new value says — the metadata endpoint, say — with the guard's approval
   * behind it. Writing the resolved url back means the bytes that passed the
   * check are the bytes dialled, which is how the declared probe already works.
   */
  private async resolveServerUrls(
    userId: string,
    manualName: string,
    template: CallTemplate,
    redactor: SecretRedactor,
  ): Promise<Outcome | null> {
    const servers = (template as { config?: { mcpServers?: Record<string, unknown> } }).config?.mcpServers;
    for (const server of Object.values(servers ?? {})) {
      // `stdio` servers carry a command, not a url, and are never reached from
      // this process anyway (they imply `remote: false`, refused above).
      const entry = server as { url?: unknown };
      if (typeof entry.url !== 'string') continue;
      let resolved: string;
      try {
        resolved = await this.substitute(userId, manualName, entry.url, redactor);
      } catch (err) {
        // An unset variable, exactly as on the declared path: nothing to test,
        // and nothing said about the credential.
        return { status: 'unverifiable', detail: err instanceof Error ? err.message : String(err) };
      }
      try {
        assertSafeFetchUrl(resolved, { label: 'MCP server url' });
      } catch (err) {
        return { status: 'unverifiable', detail: err instanceof Error ? err.message : String(err) };
      }
      entry.url = resolved;
      rememberCredentialQuery(resolved, redactor);
    }
    return null;
  }

  /**
   * Read the values behind every variable `template` references, purely so
   * {@link SecretRedactor} can keep them out of anything quoted.
   *
   * The MCP path leaves headers and auth as `${VAR}` for UTCP's loader, so
   * unlike the declared probe it never learns those values in passing — and a
   * rejected handshake surfaces as prose from the transport, which on many
   * servers includes the response body and therefore the key. Best-effort by
   * design: redaction is a safety net over the quote, and failing to build it
   * must not fail the probe.
   */
  private async rememberTemplateSecrets(
    userId: string,
    manualName: string,
    template: CallTemplate,
    redactor: SecretRedactor,
  ): Promise<void> {
    const names = new Set(
      [...JSON.stringify(template).matchAll(varRefPattern())].map((m) => m[1] ?? m[2]),
    );
    for (const name of names) {
      try {
        const value = await this.secretsVault.resolve(userId, utcpNamespacedKey(manualName, name));
        if (value) redactor.remember(value);
      } catch {
        // A variable we cannot read is one the provider cannot echo either.
      }
    }
  }

  /**
   * Replace every variable reference with the caller's resolved secret. Throws
   * when one has no value, so the caller can report "not set yet" rather than
   * sending a request with an empty credential and reading the inevitable 401
   * as proof the key is wrong.
   *
   * One left-to-right pass, like the SDK's own substitutor, rather than a
   * replace per name: with bare `$VAR` accepted, substituting `$API` before
   * `$API_KEY` would corrupt the longer reference.
   */
  private async substitute(
    userId: string,
    manualName: string,
    template: string,
    redactor?: SecretRedactor,
  ): Promise<string> {
    // UTCP leaves any string containing `$ref` alone (JSON-Schema references),
    // so a probe that substituted one would stop testing what a real call sends.
    if (template.includes('$ref')) return template;

    const names = new Set([...template.matchAll(varRefPattern())].map((m) => m[1] ?? m[2]));
    if (names.size === 0) return template;

    const values = new Map<string, string>();
    for (const name of names) {
      const value = await this.secretsVault.resolve(userId, utcpNamespacedKey(manualName, name));
      if (value === null) throw new Error(`\${${name}} isn't set yet, so there was nothing to test.`);
      values.set(name, value);
      redactor?.remember(value);
    }
    return template.replace(varRefPattern(), (_full, braced?: string, bare?: string) => {
      const name = braced ?? bare;
      return name === undefined ? _full : (values.get(name) ?? _full);
    });
  }
}

/** How much of a rejecting body we are willing to read to quote it. */
const MAX_REJECTION_BYTES = 8 * 1024;
/** How much of what we read we are willing to show. */
const REJECTION_SNIPPET_CHARS = 200;

/**
 * A short, human-readable reason from a rejecting response — the provider's own
 * words are far more actionable than "401" — with every secret this probe
 * resolved taken back out of it (see {@link SecretRedactor}). Bounded and
 * best-effort: a body that is huge, binary, or unreadable falls back to the
 * status line.
 *
 * Read from the STREAM with a byte cap rather than `res.text()`. The body here
 * is written by whatever server the credential points at, so buffering all of
 * it to keep 200 characters lets that server decide how much memory this
 * process spends and how long an unattended probe takes. The reader is
 * cancelled as soon as we have enough, which closes the connection rather than
 * politely draining a response we already stopped caring about.
 */
async function describeRejection(res: Response, redactor: SecretRedactor): Promise<string> {
  const fallback = `The provider rejected this credential (${res.status}).`;
  try {
    // Redact BEFORE the snippet is cut, so a secret straddling the 200-character
    // boundary loses its head rather than surviving as one.
    const body = redactor.redact((await readCapped(res, MAX_REJECTION_BYTES)).trim());
    if (!body) return fallback;
    const snippet =
      body.length > REJECTION_SNIPPET_CHARS ? `${body.slice(0, REJECTION_SNIPPET_CHARS)}…` : body;
    return `${fallback} ${snippet}`;
  } catch {
    return fallback;
  }
}

/**
 * At most `limit` bytes of a response body, decoded as text.
 *
 * Each CHUNK is sliced to the remaining budget before being decoded, not just
 * counted against it: a provider that answers in one 5MB chunk would otherwise
 * put the whole thing through the decoder before the loop noticed it was over,
 * which is the bound bypassed by the very party it is meant to bound.
 *
 * Exported for its test — the property here is how much is held in memory,
 * which the caller's 200-character snippet hides completely.
 */
export async function readCapped(res: Response, limit: number): Promise<string> {
  const reader = res.body?.getReader();
  // No stream (a mocked or already-consumed response): fall back to the whole
  // body, which for those cases is ours and small.
  if (!reader) return (await res.text()).slice(0, limit);
  const decoder = new TextDecoder();
  let out = '';
  let read = 0;
  try {
    while (read < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = limit - read;
      const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      read += chunk.byteLength;
      out += decoder.decode(chunk, { stream: true });
      if (chunk.byteLength < value.byteLength) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return out;
}
