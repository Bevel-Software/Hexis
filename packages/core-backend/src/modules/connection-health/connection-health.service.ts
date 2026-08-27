import { and, eq, inArray, lt } from 'drizzle-orm';
import '@utcp/http'; // side effect: registers the 'http' UTCP communication protocol
import '@utcp/mcp'; // side effect: registers the 'mcp' protocol (remote MCP `.tool` sources)
import { UtcpClientConfigSerializer } from '@utcp/sdk';
import { CodeModeUtcpClient } from '@utcp/code-mode';
import { registerManual } from '@bevel-software/platform-mcp-core';
import type { Database } from '../database/connection.js';
import { connectionHealth } from '../database/core-schema.js';
import type { IToolManualService, ToolHealthCheck, ToolManualSummary } from '../tool-manuals/tool-manuals.contract.js';
import type { ISecretsVaultService } from '../secrets-vault/secrets-vault.contract.js';
import { bevelSecretsLoaderConfig } from '../secrets-vault/index.js';
import { utcpNamespacedKey } from '../../shared/utcp-namespace.js';
import { assertSafeFetchUrl } from '../../shared/ssrf.js';
import type {
  ConnectionHealthRecord,
  ConnectionHealthStatus,
  IConnectionHealthService,
} from './connection-health.contract.js';

/** How long a probe may take before we call it inconclusive. */
const PROBE_TIMEOUT_MS = 10_000;

/** A probe verdict before it is stamped with a manual name and a time. */
interface Outcome {
  status: ConnectionHealthStatus;
  detail: string | null;
}

const OK: Outcome = { status: 'ok', detail: null };

/**
 * What invalidation writes. An UPDATE rather than a DELETE for two reasons:
 * it stamps `probeStartedAt` with the moment the credential changed, which is
 * what lets the write guard in {@link ConnectionHealthService.probe} refuse an
 * older probe's stale answer; and it leaves an explicit "not checked since you
 * changed this" verdict instead of an absent row, which reads identically in
 * the UI but says so on purpose.
 */
function invalidated() {
  const now = monotonicNow();
  return {
    status: 'unverifiable' as const,
    error: "This hasn't been tested since the credential changed.",
    checkedAt: now,
    // MUST be evaluated per call, not once at module load: this stamp is what
    // the write guard compares against, so a frozen value would let every
    // probe started after the process booted overwrite a later invalidation.
    probeStartedAt: now,
  };
}

const NO_PROBE: Outcome = {
  status: 'unverifiable',
  detail: "This tool doesn't offer a way to test its connection.",
};

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

/**
 * Resolve `work`, or `onTimeout` if it outlives `PROBE_TIMEOUT_MS`.
 *
 * The declared-probe path gets its deadline from `AbortSignal.timeout`, but the
 * MCP path cannot: neither `CodeModeUtcpClient.create` nor `registerManual`
 * accepts a signal. Without this, an unresponsive server leaves an unattended
 * probe — one that fires on every key save — pending forever, and the caller
 * never gets a verdict at all.
 *
 * The abandoned work is NOT cancelled, because there is no API to cancel it;
 * it settles into a void later. That is a leak we accept over a hung request,
 * and it is bounded by how often a probe can be triggered.
 */
async function withProbeTimeout<T>(work: Promise<T>, onTimeout: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout), PROBE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * A stamp that is STRICTLY greater than every stamp this process has issued.
 *
 * `probe_started_at` is an ordering token, and `Date.now()` has millisecond
 * resolution — which is coarser than the gap between the two writes that race
 * on the primary path. Saving a key invalidates (stamp T) and the client
 * immediately asks for a probe, which can start within the same millisecond;
 * with equal stamps the guard's strict `<` refuses the probe, and the user is
 * left looking at "not tested since the credential changed" after a check they
 * explicitly triggered.
 *
 * Ties still fail SAFE across processes (equal stamps refuse the write, keeping
 * "we don't know" rather than publishing a possibly-stale verdict), so this
 * only has to remove the same-process collisions — which are the frequent ones,
 * because they are the ones a single request path produces.
 */
let lastStamp = 0;
function monotonicNow(): Date {
  const now = Date.now();
  lastStamp = now > lastStamp ? now : lastStamp + 1;
  return new Date(lastStamp);
}

/** Every distinct `${VAR}` referenced in a string. */
function varRefs(text: string): string[] {
  return [...text.matchAll(/\$\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]);
}

export class ConnectionHealthService implements IConnectionHealthService {
  constructor(
    private readonly db: Database,
    private readonly toolManualService: IToolManualService,
    private readonly secretsVault: ISecretsVaultService,
  ) {}

  async probe(userId: string, userEmail: string, manualName: string): Promise<ConnectionHealthRecord> {
    const manuals = await this.toolManualService.listAccessible(userEmail);
    const manual = manuals.find((m) => m.name === manualName);
    if (!manual) throw new Error(`No readable tool manual named "${manualName}"`);

    // Stamped BEFORE the probe runs, and the value the write is guarded on.
    // A probe describes the credential as it was when the probe STARTED, so
    // anything that happened since — a new key saved, a newer probe already
    // landed — must win over this result no matter which finishes last.
    const probeStartedAt = monotonicNow();
    const outcome = await this.runProbe(userId, userEmail, manual);
    const checkedAt = new Date();
    const written = await this.db
      .insert(connectionHealth)
      .values({
        userId,
        manualName,
        status: outcome.status,
        error: outcome.detail,
        checkedAt,
        probeStartedAt,
      })
      .onConflictDoUpdate({
        target: [connectionHealth.userId, connectionHealth.manualName],
        set: { status: outcome.status, error: outcome.detail, checkedAt, probeStartedAt },
        // Only overwrite a verdict OLDER than this probe. `forget` stamps the
        // row with the moment of invalidation, so a probe that began before a
        // key changed cannot resurrect its own stale answer; and of two
        // concurrent probes the later-started one wins regardless of finishing
        // order. Without this, saving twice in quick succession could leave the
        // badge describing the key the user just replaced.
        //
        // STRICTLY less-than, so an equal stamp does NOT overwrite — the safe
        // direction, since an equal stamp means we cannot tell which came
        // first. `monotonicNow` removes the same-process collisions that would
        // otherwise make that refusal routine (see its note); `lte` would be
        // the wrong relief, letting a stale probe overwrite the very
        // invalidation meant to supersede it.
        setWhere: lt(connectionHealth.probeStartedAt, probeStartedAt),
      })
      .returning({ id: connectionHealth.id });

    // The guard refused: something newer already speaks for this credential.
    // Report what is actually stored rather than the verdict we discarded.
    if (Array.isArray(written) && written.length === 0) {
      const [current] = await this.statusFor(userId, [manualName]);
      if (current) return current;
    }
    return { manualName, status: outcome.status, detail: outcome.detail, checkedAt };
  }

  async statusFor(userId: string, manualNames: string[]): Promise<ConnectionHealthRecord[]> {
    if (manualNames.length === 0) return [];
    const rows = await this.db
      .select({
        manualName: connectionHealth.manualName,
        status: connectionHealth.status,
        error: connectionHealth.error,
        checkedAt: connectionHealth.checkedAt,
      })
      .from(connectionHealth)
      .where(and(eq(connectionHealth.userId, userId), inArray(connectionHealth.manualName, manualNames)));
    return rows.map((r) => ({
      manualName: r.manualName,
      status: r.status as ConnectionHealthStatus,
      detail: r.error,
      checkedAt: r.checkedAt,
    }));
  }

  async forget(userId: string, manualName: string): Promise<void> {
    const mark = invalidated();
    // UPSERT, not UPDATE. An UPDATE writes nothing when the pair has no row
    // yet, which leaves the invalidation with no trace — and a probe that
    // started before the credential changed would then find no conflict, take
    // the plain INSERT path, and publish its stale verdict with the guard never
    // consulted. Persisting the mark is what gives that INSERT something to
    // collide with, so the guard can refuse it.
    await this.db
      .insert(connectionHealth)
      .values({ userId, manualName, ...mark })
      .onConflictDoUpdate({
        target: [connectionHealth.userId, connectionHealth.manualName],
        set: mark,
        // The SAME ordering rule the probe write obeys, for the same reason:
        // this invalidation describes the credential as of `mark.probeStartedAt`,
        // so it must not overwrite a verdict from a probe that started LATER.
        // Without it the guard was one-directional — probes deferred to
        // invalidations, but a delayed invalidation could still clobber a newer
        // probe's valid result. Ordering only means something if both writers
        // respect it.
        //
        // The INSERT half is deliberately unguarded: with no row there is
        // nothing to be newer than, and the whole point of upserting here is to
        // leave a mark for a stale probe's INSERT to collide with.
        setWhere: lt(connectionHealth.probeStartedAt, mark.probeStartedAt),
      });
  }

  /**
   * KNOWN GAP, deliberately not closed here. This marks every EXISTING row for
   * the manual, which covers every user who has been probed before. A user with
   * no row yet — their first probe in flight while the shared credential
   * changes — has nothing to mark, so that one probe can still publish a
   * verdict about the replaced key. It self-corrects on the next probe.
   *
   * Closing it needs an invalidation stamp that exists independently of any
   * user's row (a per-manual epoch the INSERT also checks), which is a second
   * table and therefore a schema decision — and this table's design is already
   * with a tech lead. Raised there rather than settled unilaterally mid-review.
   */
  async forgetAll(manualName: string): Promise<void> {
    await this.db.update(connectionHealth).set(invalidated()).where(eq(connectionHealth.manualName, manualName));
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
  private async runProbe(userId: string, userEmail: string, manual: ToolManualSummary): Promise<Outcome> {
    // A local-only tool runs in someone's own agent; this server cannot reach it
    // (that is what `remote: false` MEANS), so a failure here would say nothing
    // about the credential.
    if (manual.remote === false) {
      return { status: 'unverifiable', detail: 'This tool runs only in a local agent, so the server cannot test it.' };
    }
    // Read through the internal accessor: probe config carries `headers`, which
    // a `.tool` may write as a literal token, so it deliberately does not ride
    // on the browser-facing summary this method is otherwise working from.
    const healthCheck = await this.toolManualService.healthCheckFor(userEmail, manual.name);
    if (healthCheck) return this.probeDeclared(userId, manual, healthCheck);
    if (manual.type === 'mcp') return this.probeMcpHandshake(userId, userEmail, manual);
    return NO_PROBE;
  }

  /**
   * Call the endpoint the manual declared, carrying the caller's credential.
   *
   * Headers default to the manual's own — that is where the credential normally
   * lives, so the common case is a one-line `healthCheck: { url }` and the probe
   * authenticates exactly like a real call.
   */
  private async probeDeclared(
    userId: string,
    manual: ToolManualSummary,
    check: ToolHealthCheck,
  ): Promise<Outcome> {
    // `headers` is already defaulted to the manual's own at parse time, so a
    // one-line `healthCheck: { url }` still carries the credential.
    const headerTemplate = check.headers ?? {};
    let url: string;
    let headers: Record<string, string>;
    try {
      url = await this.substitute(userId, manual.name, check.url);
      headers = Object.fromEntries(
        await Promise.all(
          Object.entries(headerTemplate).map(
            async ([k, v]) => [k, await this.substitute(userId, manual.name, v)] as const,
          ),
        ),
      );
    } catch (err) {
      // An unset variable is not a broken credential — the vault's own status
      // already says "needs a key from you", and firing a request with an empty
      // Bearer would turn that into a spurious rejection.
      return { status: 'unverifiable', detail: err instanceof Error ? err.message : String(err) };
    }

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
      return {
        status: 'unverifiable',
        detail: `Couldn't reach the provider to check: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    if (res.ok) return OK;
    if (res.status === 401 || res.status === 403) {
      return { status: 'failed', detail: await describeRejection(res) };
    }
    return {
      status: 'unverifiable',
      detail: `The provider answered ${res.status}, which doesn't say whether the credential is valid.`,
    };
  }

  /**
   * Register the manual on a throwaway UTCP client: for a remote MCP server the
   * handshake is authenticated, so a successful registration IS proof the token
   * works, and a rejection is the provider's own verdict.
   *
   * This is the same call the MCP proxy makes when it builds a session — the
   * difference is only that here the answer is kept.
   */
  private async probeMcpHandshake(
    userId: string,
    userEmail: string,
    manual: ToolManualSummary,
  ): Promise<Outcome> {
    let template;
    try {
      const templates = await this.toolManualService.toManualCallTemplates(userEmail, { remoteOnly: true });
      template = templates.find((t) => String((t as { name?: unknown }).name) === manual.name);
    } catch (err) {
      return {
        status: 'unverifiable',
        detail: `Couldn't build the connection to test: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (!template) {
      return { status: 'unverifiable', detail: "This tool's definition couldn't be resolved, so it wasn't tested." };
    }

    const TIMED_OUT: Outcome = {
      status: 'unverifiable',
      detail: `The server didn't answer within ${PROBE_TIMEOUT_MS / 1000}s, so the credential wasn't tested.`,
    };

    let client: CodeModeUtcpClient;
    try {
      // No loopback seeding (`API_URL`/`CONNECTION_KEY`): those belong to
      // Bevel-hosted manuals, and this path only ever registers a third-party
      // MCP server. Its `${VAR}`s resolve lazily through the caller's own vault
      // loader, which is exactly the credential under test.
      const config = new UtcpClientConfigSerializer().validateDict({
        variables: {},
        load_variables_from: [bevelSecretsLoaderConfig(userId)],
      });
      const built = await withProbeTimeout(CodeModeUtcpClient.create(process.cwd(), config), null);
      if (!built) return TIMED_OUT;
      client = built;
    } catch (err) {
      return {
        status: 'unverifiable',
        detail: `Couldn't build the connection to test: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    return withProbeTimeout(
      registerManual(client, template).then((result): Outcome => {
        if (result.ok) return OK;
        return looksLikeAuthRejection(result.error)
          ? { status: 'failed', detail: result.error }
          : { status: 'unverifiable', detail: `Couldn't reach the provider to check: ${result.error}` };
      }),
      TIMED_OUT,
    );
  }

  /**
   * Replace every `${VAR}` with the caller's resolved secret. Throws when one
   * has no value, so the caller can report "not set yet" rather than sending a
   * request with an empty credential and reading the inevitable 401 as proof
   * the key is wrong.
   */
  private async substitute(userId: string, manualName: string, template: string): Promise<string> {
    let out = template;
    for (const name of new Set(varRefs(template))) {
      const value = await this.secretsVault.resolve(userId, utcpNamespacedKey(manualName, name));
      if (value === null) throw new Error(`\${${name}} isn't set yet, so there was nothing to test.`);
      out = out.split(`\${${name}}`).join(value);
    }
    return out;
  }
}

/**
 * A short, human-readable reason from a rejecting response — the provider's own
 * words are far more actionable than "401". Bounded and best-effort: a body
 * that is huge, binary, or unreadable falls back to the status line.
 */
async function describeRejection(res: Response): Promise<string> {
  const fallback = `The provider rejected this credential (${res.status}).`;
  try {
    const body = (await res.text()).trim();
    if (!body) return fallback;
    const snippet = body.length > 200 ? `${body.slice(0, 200)}…` : body;
    return `${fallback} ${snippet}`;
  } catch {
    return fallback;
  }
}
