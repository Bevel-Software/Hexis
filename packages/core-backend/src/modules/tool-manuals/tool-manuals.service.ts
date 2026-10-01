import path from 'node:path';
import { createHash } from 'node:crypto';
import { logger } from '../../shared/logging.js';

const log = logger('tool-manuals');
import fs from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import '@utcp/http'; // side effect: register the 'http' call-template type (http + inline sub-manuals)
import '@utcp/mcp'; // side effect: register the 'mcp' call-template type (mcp `.tool` sources)
// side effect: register the 'cli' call-template type for PARSING ONLY — the
// executor is removed again, so this process cannot dispatch a shell command.
import { containsCliCallTemplate } from './utcp-cli-parse-only.js';
import {
  UtcpManualSerializer,
  CallTemplateSerializer,
  DefaultVariableSubstitutor,
  type CallTemplate,
} from '@utcp/sdk';
import { descriptorsFromMcpJson } from './mcp-json-discovery.js';
import type { PluginSource } from '../plugins/discovery/plugin-source.js';
import type { WorkspaceService } from '../workspace/workspace.service.js';
import type { KbContext } from '../../shared/kb-context.js';
import { workspaceIdForBranch } from '../../shared/workspace-id.js';
import type { IAccessControl } from '../access/access-control.interface.js';
import { assertSafeFetchUrl } from '../../shared/ssrf.js';
import { redactSecret } from '../../shared/redact-secret.js';
import { printable } from '../../shared/printable.js';
import { RESERVED_VARIABLE_NAMES, findReservedVariableRef } from '../../shared/variable-refs.js';
import { extractFrontmatter, resolveDeclaredId, isValidId, dedupeById } from '../../shared/frontmatter-id.js';
import type { ITreeWalker } from '../../shared/fs.contract.js';
import { TtlCache } from '../../shared/ttl-cache.js';
import {
  utcpNamespacePrefix,
  utcpNamespacedKey,
  MCP_OAUTH_VAR,
  INTERNAL_MANUAL_NAME,
} from '../../shared/utcp-namespace.js';
import {
  EXTERNAL_KB_MANUAL_NAME,
  MAX_CAPABILITIES,
  type IToolManualService,
  type ToolManualDescriptor,
  type ToolManualDescriptorBase,
  type ToolManualSummary,
  type ToolManualDetail,
  type InvalidToolManual,
  type AccessibleCatalog,
  type ToolCapability,
  type UtcpManualDict,
  type ToolManualPreview,
  type ToolManualType,
  type ToolVariable,
  type ToolHealthCheck,
  type ToolProbeTarget,
  type ToolVariableScope,
  type ToolVariableOAuth,
} from './tool-manuals.contract.js';

const CACHE_TTL_MS = 60_000;

/**
 * UTCP namespaces a user `.tool` may NOT claim: they belong to built-in manuals
 * whose loopback creds are pre-seeded on the agent's code-mode client (the
 * internal `Bevel` manual carries the `source:'internal'` token + connector
 * creds; the external KB manual carries the caller's bearer). A `.tool`
 * reproducing one of these namespaces would resolve those seeded vars and could
 * exfiltrate them, so the scanner refuses it. Compared case-insensitively —
 * defensive, though the live collision is the mixed-case `Bevel` reachable via
 * the `name` fallback (an explicit `id` must already be lowercase snake_case).
 */
const RESERVED_TOOL_NAMESPACES = [INTERNAL_MANUAL_NAME, EXTERNAL_KB_MANUAL_NAME].map((n) => n.toLowerCase());

/**
 * No user `.tool` may REFERENCE the platform-seeded variables (`${API_URL}` /
 * `$API_URL`), in any `.tool` type: the only seeded user namespace is an
 * inline `.tool`'s (its discovery template is platform-served), and a
 * reference inside author-written content would resolve platform creds into a
 * request the author shaped. Refusing every `.tool` at the producing boundary
 * makes "user tools never carry platform credentials" structural rather than
 * dependent on which namespaces happen to be seeded. The names and the
 * reference grammar live in `shared/variable-refs.ts` — one definition for
 * every boundary that classifies references.
 */

/**
 * Throw if any string in the `.tool` document references a reserved variable.
 *
 * `ref` is named because it is OURS — one of `RESERVED_VARIABLE_NAMES`, matched
 * from a fixed list rather than copied out of the file. That is the line every
 * refusal here holds: see {@link describeManualFault}.
 */
function assertNoReservedVariableRefs(doc: unknown): void {
  const ref = findReservedVariableRef(doc);
  if (ref !== null) {
    throw new Error(
      `this \`.tool\` references the reserved variable "${ref}" — ` +
        'API_URL and CONNECTION_KEY (bare or namespaced, e.g. `<namespace>_CONNECTION_KEY`) ' +
        'are seeded by the platform for its own manuals and may not appear anywhere in a `.tool`.',
    );
  }
}

/**
 * How much of a validation message may reach a listing. Long enough for every
 * sentence the normalizer writes; short enough that a message which interpolated
 * a chunk of the file (`unknown \`.tool\` type: <whatever was written there>`)
 * cannot smuggle a pasted credential out one character at a time.
 */
const MAX_REASON_LENGTH = 300;

/**
 * Why one `.tool` was refused, in a form safe to hand an agent, a browser and a
 * log — the `reason` of an {@link InvalidToolManual}.
 *
 * This is the LAST of two defences, not the only one. The first is upstream and
 * structural, and it is the one that carries the guarantee:
 *
 *   A REASON REPEATS NOTHING THE FILE SAID.
 *
 * Every refusal this module writes locates the fault — a field name we chose
 * (`` `id` ``, `` `healthCheck.url` ``), an ordinal (`` `variables[2].scope` ``,
 * `` `headers` entry 3 of 4 ``) — and states the rule. It never interpolates
 * what was written there, and that includes text which passed a check: a name
 * matching `[A-Za-z0-9_]+` is a legal identifier, not a string we may repeat,
 * and a token spelled with underscores matches it. The only author-derived
 * strings named anywhere are ones matched against a FIXED list of ours (a
 * reserved variable, a reserved namespace), where saying which one was hit
 * teaches nothing the platform did not already publish.
 *
 * It has to be that way round — no scrub can recognise an arbitrary
 * author-chosen string as a credential, so a message that interpolates one
 * cannot be made safe after the fact. What remains for this function is the
 * text the process does NOT author: the YAML parser's, which quotes the file at
 * its fault.
 *
 * Two things happen here, and both are about NOT echoing the file back.
 *
 * 1. A `YAMLParseError`'s `message` ends with a SOURCE SNIPPET: the offending
 *    lines, verbatim, under a caret. A `.tool` is content an author may have
 *    pasted a literal token into (`Authorization: Bearer <a real key>`), and
 *    the line that fails to parse is as likely to be that one as any other.
 *    So only the message's first line survives — the parser's own prose — and
 *    the location is re-stated from `linePos`, which is numbers, not text.
 * 2. Everything is then run through `redactSecret` and capped. The normalizer's
 *    own messages quote a url on an SSRF refusal, and a url can carry
 *    `user:pass@host` or a presigned query; that is precisely what the shared
 *    scrub takes out, and reusing it is what keeps one definition of "this must
 *    not reach a log" for the whole backend.
 *
 * What remains of the parser's prose still interpolates the odd token (`Missing
 * , between flow map items`, `Unexpected , in flow collection`) — a structural
 * character or a token type, never a value line. That is the point of the cut:
 * the fault is described, the file is not quoted.
 */
export function describeManualFault(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  // `linePos` is the `yaml` package's own location, on the error object — the
  // authority for WHERE, so the snippet never has to be read to find out.
  const pos = (err as { linePos?: [{ line: number; col: number }, ...unknown[]] } | null)?.linePos?.[0];
  // The prose, snippet dropped. `yaml` appends ` at line N, column M:` to it as
  // the snippet's header; drop that too, since the location is restated below
  // in a form that does not depend on the parser's phrasing.
  const prose = raw.split('\n')[0].replace(/ at line \d+, column \d+:?$/, '').trim();
  const located = pos ? `${prose} (line ${pos.line}, column ${pos.col})` : prose;
  const scrubbed = redactSecret(located);
  return scrubbed.length > MAX_REASON_LENGTH ? `${scrubbed.slice(0, MAX_REASON_LENGTH - 1)}…` : scrubbed;
}

/**
 * One scan of the manuals on disk: what parsed, and what did not.
 *
 * The two travel TOGETHER, through the cache and out to every surface, because
 * they are two halves of one answer. A caller handed only the manuals cannot
 * tell a catalog of three tools from a catalog of four with one broken — which
 * is exactly the confusion a silently-skipped file creates.
 */
interface ScanResult {
  manuals: ToolManualDescriptor[];
  invalid: InvalidToolManual[];
}

/**
 * The empty answer — a workspace that isn't there yet, or a caller who may read
 * nothing. A FUNCTION, not a shared constant: the arrays in a scan result are
 * handed to decoration passes and to the cache, and a single frozen-by-
 * convention instance is one push away from every empty scan in the process
 * inheriting another's contents.
 */
const emptyScan = (): ScanResult => ({ manuals: [], invalid: [] });

const manualSerializer = new UtcpManualSerializer();
const callTemplateSerializer = new CallTemplateSerializer();
// `findRequiredVariables` is a pure walk — one shared instance is fine.
const variableSubstitutor = new DefaultVariableSubstitutor();

/**
 * What the catalog needs from MCP OAuth auto-discovery (structurally satisfied
 * by `McpOAuthDiscoveryService` in modules/secrets-vault). A local port keeps
 * this module free of a secrets-vault import — the same decoupling discipline
 * the vault applies in the other direction with `VariableScopeResolver`.
 */
export interface McpAuthDiscoveryPort {
  statusFor(manualName: string, mcpUrl: string): Promise<McpAuthDiscoveryResult>;
  /**
   * The sign-in endpoints for an OWNER-REGISTERED client: the same metadata
   * walk as `statusFor`, stopping short of dynamic registration — the manual
   * already names its `clientId`. Nothing is persisted; the owner's
   * client-secret save pins the completed provider. Optional so a port that
   * only knows the zero-config path still satisfies the interface.
   */
  providerForDeclaredClient?(manualName: string, mcpUrl: string, clientId: string): Promise<McpAuthDiscoveryResult>;
}

export type McpAuthDiscoveryResult =
  | { status: 'open' }
  | {
      status: 'oauth';
      provider: {
        authorizationUrl: string;
        tokenUrl: string;
        clientId: string;
        scopes?: string[];
        resource?: string;
        pkce?: boolean;
      };
    }
  | { status: 'unsupported'; reason: string };

/**
 * Reads `*.tool` manuals from the DEFAULT-branch workspace (never the caller's
 * branch), so the catalog is one global, released set — same discipline as
 * Skills. Results are cached briefly; drop via `invalidate()` after a merge to
 * default. Any read failure degrades to an empty catalog: the MCP/UTCP endpoint
 * must never break because a `.tool` can't be read.
 */
export class ToolManualService implements IToolManualService {
  private readonly cache: TtlCache<ScanResult>;
  private mcpAuthDiscovery?: McpAuthDiscoveryPort;
  /**
   * The refused set as it was last written to the log, so the warnings are
   * logged ONCE PER CHANGE rather than once per scan. A broken `.tool` sits
   * there until someone fixes it, and the catalog is re-scanned every minute on
   * every surface — repeating the same three lines forever buries the scan that
   * actually changed something. `null` until the first scan, so the first state
   * is always reported.
   */
  private loggedInvalid: string | null = null;
  /**
   * The scan currently running, shared by everyone who asks while it runs.
   *
   * The TTL cache only holds a value once the scan RETURNS, so without this
   * every caller arriving during the walk starts its own — and a listing that
   * wants both halves of the catalog is exactly such a pair, as is a page that
   * fires two requests. Sharing the promise makes one cold listing one disk
   * walk, one MCP-discovery pass, and ONE snapshot for every reader of it.
   * Cleared by `invalidate()` as well as on settle, so a caller arriving after
   * a merge never inherits a scan that started on the tree it replaced — the
   * same rule `TtlCache`'s generation token enforces for the cached value.
   */
  private inFlightScan: Promise<ScanResult> | null = null;

  constructor(
    private readonly workspaceService: WorkspaceService,
    private readonly accessControl: IAccessControl,
    private readonly kb: KbContext,
    private readonly disk: ITreeWalker,
    /** Where plugins (and their MCP servers) come from — the one discovery every catalog shares. */
    private readonly source: PluginSource,
    now: () => number = Date.now,
  ) {
    this.cache = new TtlCache(CACHE_TTL_MS, now);
  }

  private get kbDirName(): string {
    return this.kb.kbDirName;
  }

  /**
   * Wire the MCP OAuth auto-discovery (setter injection: the discovery service
   * depends on the vault, which is constructed after this service — the same
   * reason the vault takes `scopeOfVariable` as a closure). Optional: without
   * it, bare `type: mcp` tools simply aren't decorated.
   */
  setMcpAuthDiscovery(discovery: McpAuthDiscoveryPort): void {
    this.mcpAuthDiscovery = discovery;
  }

  invalidate(): void {
    this.cache.invalidate();
    this.inFlightScan = null;
  }

  async listAccessible(userEmail: string): Promise<ToolManualSummary[]> {
    return (await this.accessibleManuals(userEmail)).map(toSummary);
  }

  async listAccessibleCatalog(userEmail: string): Promise<AccessibleCatalog> {
    const { manuals, invalid } = await this.accessibleScan(userEmail);
    return { tools: manuals.map(toSummary), invalid };
  }

  async listAllSummaries(): Promise<ToolManualSummary[]> {
    return (await this.scan()).manuals.map(toSummary);
  }

  async catalogFingerprints(userEmail: string): Promise<string[]> {
    return (await this.accessibleManuals(userEmail)).map(manualFingerprint);
  }

  async getDetail(userEmail: string, slug: string): Promise<ToolManualDetail | null> {
    // Resolved through `accessibleManuals` rather than `scan()` + a canRead call
    // so the cache, the dedupe, the mcp-oauth decoration and the fail-closed
    // batch ACL all apply exactly as they do to the catalog listing — one read
    // model, no second place for the access rules to drift.
    const found = (await this.accessibleManuals(userEmail)).find((m) => m.slug === slug);
    if (!found) return null;
    return {
      ...toSummary(found),
      description: found.description ?? null,
      capabilities: capabilitiesOf(found),
    };
  }

  async listLocalOnly(userEmail: string): Promise<{ slug: string; name: string; path: string }[]> {
    const manuals = await this.accessibleManuals(userEmail);
    return manuals.filter((m) => m.remote === false).map((m) => ({ slug: m.slug, name: m.name, path: m.path }));
  }

  async listDeclaredOnlyOnBranch(
    userEmail: string,
    branch: string,
  ): Promise<{ name: string; path: string; type: ToolManualType }[]> {
    if (!branch || branch === this.kb.defaultBranch) return [];
    // Only a draft this process already holds a clone of — the one the caller
    // wrote the declaration on. `scanDisk` would otherwise BOOTSTRAP any branch
    // name a caller sends, before the read gate below has had a say: a clone
    // and a fetch per guessed, private or nonexistent branch. A declaration on
    // a branch nobody has checked out here is nothing this answer can report.
    if (!(await this.workspaceService.hasBootstrappedWorkspace(workspaceIdForBranch(branch)))) return [];
    // Names and paths only — `scanDisk` never probes a server, so asking about
    // a draft costs no network and registers no OAuth client for a declaration
    // that may never be merged.
    const onBranch = (await this.scanDisk(branch)).manuals;
    if (onBranch.length === 0) return [];
    // Compared by NAMESPACE, the catalog's own identity (see the dedupe in
    // `scanDisk`): a draft entry whose namespace the default branch already
    // serves is an edit of a live tool, not a tool missing from the catalog.
    const released = new Set((await this.scan()).manuals.map((m) => utcpNamespacePrefix(m.name)));
    const pending = onBranch.filter((m) => !released.has(utcpNamespacePrefix(m.name)));
    if (pending.length === 0) return [];
    // Read-gated on the BRANCH's workspace, where the declaration lives — the
    // same default-deny rule as the catalog, so this can't reveal a draft file
    // the caller could not open with `read_file`.
    const allowed = await this.accessControl.canReadBatch(
      workspaceIdForBranch(branch),
      userEmail,
      pending.map((m) => m.path),
    );
    return pending
      .filter((m) => allowed.get(m.path) === true)
      .map((m) => ({ name: m.name, path: m.path, type: m.type }));
  }

  async userScopedKeysForManual(
    manualName: string,
  ): Promise<
    { key: string; name: string; label: string | null; oauth: boolean; oauthScopes?: string[] }[]
  > {
    // The per-user (`user`-scoped) variables a manual declares, keyed the SAME
    // way the vault stores them — the UTCP-namespaced key (underscores in the
    // manual name doubled), so a readiness check reads the exact rows `resolve`
    // would. `oauth` lets the pre-check treat a not-yet-authorized sign-in as
    // still-missing.
    const manual = (await this.scan()).manuals.find((m) => m.name === manualName);
    return (manual?.variables ?? [])
      .filter((v) => v.scope === 'user')
      .map((v) => ({
        key: utcpNamespacedKey(manualName, v.name),
        name: v.name,
        label: v.label ?? null,
        oauth: v.oauth != null,
        // The permissions the tool declares RIGHT NOW — the pre-check compares these
        // against the caller's granted scopes to catch a token that predates a scope
        // addition. Read live so a `.tool` edit self-heals on the next call.
        oauthScopes: v.oauth?.scopes,
      }));
  }

  async scopeOfVariable(effectiveKey: string): Promise<ToolVariableScope> {
    // UTCP looks up `<namespace-with-doubled-underscores>_<VAR>`. Find the manual
    // whose namespace prefixes this key; the declared var is the remainder. Match
    // the LONGEST prefix so a manual `a` can't shadow `a_b` when both exist. (A
    // plain first-underscore split would mis-parse a snake_case manual name.)
    let best: { manual: ToolManualDescriptor; varName: string; len: number } | null = null;
    for (const m of (await this.scan()).manuals) {
      const prefix = utcpNamespacePrefix(m.name);
      if (effectiveKey.startsWith(prefix) && (!best || prefix.length > best.len)) {
        best = { manual: m, varName: effectiveKey.slice(prefix.length), len: prefix.length };
      }
    }
    if (!best) return 'admin';
    const declared = best.manual.variables?.find((v) => v.name === best!.varName);
    return declared?.scope ?? 'admin';
  }

  /**
   * The probe config for a manual this caller can read — the internal
   * counterpart to everything on `ToolManualSummary`.
   *
   * Access-gated through `accessibleManuals` like every other read, so this
   * cannot become a way to learn what a `.tool` you can't see declares.
   */
  async probeTargetFor(userEmail: string, slug: string): Promise<ToolProbeTarget | null> {
    const manuals = await this.accessibleManuals(userEmail);
    const m = manuals.find((x) => x.slug === slug);
    if (!m) return null;
    // Built here, from the manual already in hand. `toManualCallTemplates`
    // would validate every manual in the workspace to hand back the one we
    // want; an invalid template for THIS manual is not an error, just a probe
    // that has nothing to dial (the caller reports it as unverifiable).
    //
    // Only for the ONE path that dials it — an `mcp` manual, reachable from
    // this process, that declared no health check of its own. Everywhere else
    // the template is built, validated and thrown away, and an http tool with
    // an unvalidatable template warn-logs on every probe about a value nothing
    // was ever going to use.
    const dialsTheTemplate = m.type === 'mcp' && !m.healthCheck && m.remote !== false;
    let callTemplate: CallTemplate | null = null;
    if (dialsTheTemplate) {
      try {
        callTemplate = callTemplateSerializer.validateDict(this.buildCallTemplateDict(m));
      } catch (err) {
        log.warn(`no valid call template for "${m.path}": ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { name: m.name, type: m.type, remote: m.remote, healthCheck: m.healthCheck, callTemplate };
  }

  async toManualCallTemplates(userEmail: string, opts?: { remoteOnly?: boolean }): Promise<CallTemplate[]> {
    const manuals = await this.accessibleManuals(userEmail);
    const out: CallTemplate[] = [];
    for (const m of manuals) {
      // Remote consumers (the hosted MCP proxy) don't get local-only manuals —
      // they'd fail server-side. Discovery of them happens via `list_local_tools`.
      if (opts?.remoteOnly && m.remote === false) continue;
      try {
        out.push(callTemplateSerializer.validateDict(this.buildCallTemplateDict(m)));
      } catch (err) {
        // A `.tool` that produces an invalid call-template is dropped here — at
        // the producing boundary — so the served list is always valid.
        log.warn(`skipping "${m.path}": ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return out;
  }

  async resolveInlineManual(userEmail: string, slug: string): Promise<UtcpManualDict | null> {
    const found = (await this.scan()).manuals.find((m) => m.slug === slug);
    if (!found || found.type !== 'inline') return null;
    const wsId = this.kb.defaultWorkspaceId();
    if (!(await this.accessControl.canRead(wsId, userEmail, found.path))) return null;
    try {
      return manualSerializer.validateDict({
        utcp_version: '1.1.0',
        manual_version: '1.0.0',
        tools: found.tools ?? [],
      }) as unknown as UtcpManualDict;
    } catch {
      return null;
    }
  }

  async preview(content: string): Promise<ToolManualPreview> {
    let descriptor: ToolManualDescriptor;
    try {
      descriptor = normalizeToolManual('draft', 'Plugins/draft.tool', content);
    } catch (err) {
      return { ok: false, errors: [err instanceof Error ? err.message : String(err)] };
    }
    if (descriptor.type === 'inline') {
      try {
        const manual = manualSerializer.validateDict({
          utcp_version: '1.1.0',
          manual_version: '1.0.0',
          tools: descriptor.tools ?? [],
        }) as { tools?: { name?: unknown; description?: unknown }[] };
        const tools = (manual.tools ?? []).map((t) => ({
          name: String(t.name ?? ''),
          description: typeof t.description === 'string' ? t.description : undefined,
        }));
        return { ok: true, tools };
      } catch (err) {
        return { ok: false, errors: [err instanceof Error ? err.message : String(err)] };
      }
    }
    // http / mcp resolve their tools at runtime (a network round-trip we don't
    // perform in preview), but still validate the call-template the same way
    // `toManualCallTemplates` does, so a draft that discovery would reject is
    // reported here instead of appearing valid.
    try {
      callTemplateSerializer.validateDict(this.buildCallTemplateDict(descriptor));
    } catch (err) {
      return { ok: false, errors: [err instanceof Error ? err.message : String(err)] };
    }
    return { ok: true, tools: [] };
  }

  // --- internal --------------------------------------------------------------

  /** Build the raw UTCP manual call-template dict for one descriptor (validated by the caller). */
  private buildCallTemplateDict(m: ToolManualDescriptor): Record<string, unknown> {
    if (m.type === 'inline') {
      return {
        name: m.name,
        call_template_type: 'http',
        http_method: 'GET',
        url: `\${API_URL}/api/tools/${m.slug}/manual`,
        content_type: 'application/json',
        headers: { Authorization: 'Bearer ${CONNECTION_KEY}' },
      };
    }
    if (m.type === 'mcp' && m.stdio) {
      // A stdio server, for LOCAL consumers only (`remote: false` is implied
      // at discovery). Command/args/env/cwd pass through verbatim — the Agent
      // Plugins placeholders (`${PLUGIN_ROOT}`/`${PLUGIN_DATA}`) are expanded
      // by the LOCAL runtime against its materialized plugin copy; this
      // process has no such paths and must not guess them.
      return {
        name: m.name,
        call_template_type: 'mcp',
        config: {
          mcpServers: {
            [m.name]: {
              transport: 'stdio',
              command: m.stdio.command,
              args: m.stdio.args,
              ...(m.stdio.env ? { env: m.stdio.env } : {}),
              ...(m.stdio.cwd ? { cwd: m.stdio.cwd } : {}),
            },
          },
        },
      };
    }
    if (m.type === 'mcp') {
      // Remote (HTTP/streamable) MCP server. Exact plugin field shape is
      // finalized in Phase 4 (native `@utcp/mcp`); the proxy try/catches
      // registration so an unsupported template never breaks the session.
      return {
        name: m.name,
        call_template_type: 'mcp',
        config: {
          mcpServers: {
            [m.name]: {
              transport: 'http',
              url: m.url,
              ...(m.headers ? { headers: m.headers } : {}),
            },
          },
        },
      };
    }
    // http: a URL returning a UTCP manual.
    return {
      name: m.name,
      call_template_type: 'http',
      http_method: m.httpMethod ?? 'GET',
      url: m.url,
      content_type: 'application/json',
      ...(m.headers ? { headers: m.headers } : {}),
    };
  }

  private async accessibleManuals(userEmail: string): Promise<ToolManualDescriptor[]> {
    return (await this.accessibleScan(userEmail)).manuals;
  }

  /**
   * The scan cut to what this caller may read — manuals AND refusals, through
   * ONE `canReadBatch`. Both halves are paths in the same workspace judged by
   * the same rule, and splitting them into two calls would pay a second
   * round-trip to ask the same question.
   */
  private async accessibleScan(userEmail: string): Promise<ScanResult> {
    const { manuals, invalid } = await this.scan();
    if (manuals.length === 0 && invalid.length === 0) return emptyScan();
    const wsId = this.kb.defaultWorkspaceId();
    const allowed = await this.accessControl.canReadBatch(wsId, userEmail, [
      ...new Set([...manuals.map((m) => m.path), ...invalid.map((i) => i.path)]),
    ]);
    // Fail closed: keep an entry only on an explicit `true` verdict (a missing
    // entry is treated as denied, matching the KB's default-deny read model).
    // A REFUSED file is gated the same way a listed one is: its path is a fact
    // about the knowledge base, and "there is a broken tool at this path" is
    // not something to tell someone who may not read that path.
    return {
      manuals: manuals.filter((m) => allowed.get(m.path) === true),
      invalid: invalid.filter((i) => allowed.get(i.path) === true),
    };
  }

  private async scan(): Promise<ScanResult> {
    const cached = this.cache.get();
    if (cached) return cached;
    // See `inFlightScan`: the cache is populated only when the walk finishes,
    // so between the miss above and that moment, callers share this promise
    // instead of each starting a walk of their own.
    if (this.inFlightScan) return this.inFlightScan;
    const started = this.runScan().finally(() => {
      // Only if it is still OURS: an `invalidate()` during the scan already
      // cleared the field (and may have installed a newer scan), and this
      // settle must not undo that.
      if (this.inFlightScan === started) this.inFlightScan = null;
    });
    this.inFlightScan = started;
    return started;
  }

  private async runScan(): Promise<ScanResult> {
    // See `TtlCache.begin`: taken before the read so an `invalidate()` that
    // lands mid-scan discards this result instead of being overwritten by it.
    const token = this.cache.begin();
    const { manuals, invalid } = await this.scanDisk();
    await this.decorateMcpOAuth(manuals);
    // AFTER the oauth decoration, so an injected `${MCP_OAUTH}` header ref is
    // already declared and isn't re-surfaced as a bare admin key.
    for (const m of manuals) this.surfaceReferencedVariables(m);
    const result = { manuals, invalid };
    this.cache.set(result, token);
    return result;
  }

  /**
   * Say what the scan refused — once per CHANGE, not once per scan. Every
   * surface re-scans on its own TTL, so a file that stays broken would
   * otherwise repeat these lines in the log forever and drown the scan where
   * something actually moved. A fixed file is worth a line too: the set going
   * empty is the recovery, said out loud.
   */
  private logInvalidOnChange(invalid: InvalidToolManual[]): void {
    const signature = JSON.stringify(invalid);
    if (signature === this.loggedInvalid) return;
    const first = this.loggedInvalid === null;
    this.loggedInvalid = signature;
    // Both halves are author-written — a KB filename and a parser's words about
    // a KB file — so both go through `printable`: a newline in either would
    // otherwise forge a second log line, and an escape sequence would paint the
    // operator's terminal.
    // (`printable` quotes what it escapes, so the path keeps its quotes here.)
    for (const i of invalid) log.warn(`skipping ${printable(i.path)}: ${printable(i.reason)}`);
    if (invalid.length === 0 && !first) log.info('every `.tool` in the catalog parses again.');
  }

  /**
   * Auto-surface every `${VAR}` a manual actually references, for ANY tool
   * type — using UTCP's own required-variables walk, so the surfaced list
   * can't drift from what substitution will demand at registration/call time.
   * Referenced-but-undeclared vars become `scope: admin` entries (matching
   * `scopeOfVariable`'s default for undeclared keys), which puts them in the
   * secrets UI without the author having to write a `variables:` block. The
   * block stays the way to add metadata: `scope: user`, labels, oauth.
   */
  private surfaceReferencedVariables(m: ToolManualDescriptor): void {
    let refs: string[];
    try {
      refs = variableSubstitutor.findRequiredVariables(this.buildCallTemplateDict(m), m.name);
      // An inline manual's credential refs live in its embedded tools'
      // templates, not the (Bevel-hosted) discovery template.
      if (m.type === 'inline' && m.tools) {
        refs.push(...variableSubstitutor.findRequiredVariables(m.tools, m.name));
      }
      // A probe-only credential still has to reach the secrets UI. The call
      // template is built from `url`/`headers` and never carries `healthCheck`,
      // so a `${VAR}` used solely by the probe would never be surfaced for
      // provisioning — and `probeDeclared` would then report `unverifiable`
      // forever on a variable no screen ever offered anyone to fill in.
      if (m.healthCheck) {
        refs.push(
          ...variableSubstitutor.findRequiredVariables(
            { url: m.healthCheck.url, headers: m.healthCheck.headers ?? {} },
            m.name,
          ),
        );
      }
    } catch {
      return; // a malformed template is reported elsewhere; never break the scan
    }
    const prefix = utcpNamespacePrefix(m.name);
    const declared = new Set((m.variables ?? []).map((v) => v.name));
    for (const ref of new Set(refs)) {
      if (!ref.startsWith(prefix)) continue;
      const name = ref.slice(prefix.length);
      // Reserved names are seeded by the proxy per session — not credentials.
      if (name === 'API_URL' || name === 'CONNECTION_KEY' || declared.has(name)) continue;
      m.variables = [...(m.variables ?? []), { name, scope: 'admin' }];
    }
  }

  /**
   * Zero-config OAuth for bare `type: mcp` manuals: when discovery finds the
   * remote server demands OAuth (and the file doesn't configure auth itself),
   * decorate the descriptor with a synthetic user-scoped `MCP_OAUTH` variable
   * and an `Authorization: Bearer ${MCP_OAUTH}` header. Decorating HERE — the
   * one place descriptors are built — means every consumer inherits it:
   * /connect lists the sign-in, `scopeOfVariable` resolves it per-user,
   * `userScopedKeysForManual` gates unauthorized callers, and the call
   * template carries the header for the variable loader to fill.
   */
  private async decorateMcpOAuth(manuals: ToolManualDescriptor[]): Promise<void> {
    const discovery = this.mcpAuthDiscovery;
    if (!discovery) return;
    const bare: ToolManualDescriptor[] = [];
    const declared: { m: ToolManualDescriptor; v: ToolVariable }[] = [];
    for (const m of manuals) {
      if (m.type !== 'mcp') continue;
      const oauthVar = (m.variables ?? []).find((v) => v.oauth != null);
      if (oauthVar) {
        // An owner-registered client is `oauth-manual` by definition — whether
        // the declaration is complete or still needs its endpoints discovered.
        // Explicit wins over discovery: never registered over, never probed
        // for anything but the endpoints the declaration left out.
        m.setup = { kind: 'oauth-manual' };
        const o = oauthVar.oauth!;
        if (!o.authorizationUrl || !o.tokenUrl) declared.push({ m, v: oauthVar });
        continue;
      }
      // The file configures auth itself — explicit wins over discovery.
      const hasAuthHeader = Object.keys(m.headers ?? {}).some((h) => h.toLowerCase() === 'authorization');
      if (!hasAuthHeader && isProbeableMcpServer(m)) bare.push(m);
    }
    // Probe every eligible server CONCURRENTLY — a cold scan with several bare
    // mcp tools shouldn't pay one network round-trip per tool in series. The
    // mutation still happens per-manual after its own probe settles.
    await Promise.all([
      ...declared.map(({ m, v }) => this.completeDeclaredOAuth(discovery, m, v)),
      ...bare.map(async (m) => {
        try {
          const found = await discovery.statusFor(m.name, m.url!);
          // Record the setup requirement so the secrets UI can tell an admin
          // whether anything needs configuring — especially the `unsupported`
          // case, which otherwise only surfaced in server logs.
          if (found.status === 'open') {
            m.setup = { kind: 'open' };
            return;
          }
          if (found.status === 'unsupported') {
            m.setup = { kind: 'oauth-manual', reason: found.reason };
            return;
          }
          m.setup = { kind: 'oauth-auto' };
          m.headers = { ...(m.headers ?? {}), Authorization: `Bearer \${${MCP_OAUTH_VAR}}` };
          // A declared healthCheck froze its headers during normalize —
          // BEFORE this decoration — so it would dial without the bearer
          // every real call now carries and read its own 401 as a rejected
          // credential. The injected sign-in reaches the check too, unless
          // the check declares its own Authorization.
          if (
            m.healthCheck &&
            !Object.keys(m.healthCheck.headers ?? {}).some((h) => h.toLowerCase() === 'authorization')
          ) {
            m.healthCheck = {
              ...m.healthCheck,
              headers: { ...(m.healthCheck.headers ?? {}), Authorization: `Bearer \${${MCP_OAUTH_VAR}}` },
            };
          }
          m.variables = [
            ...(m.variables ?? []),
            {
              name: MCP_OAUTH_VAR,
              scope: 'user',
              label: `${m.name} sign-in`,
              // NO `scopes` here, deliberately. A variable's declared scopes are
              // REQUIRED back from the token (needsReauth + the call-time gate),
              // which is right for file-authored scopes but not for discovery's
              // machine-guessed ones (the PRM's `scopes_supported`): providers
              // don't reliably echo them (e.g. Granola's AS grants OIDC scopes
              // instead), which would permanently flag-and-block an authorized
              // sign-in. The shared provider row still carries them, so the
              // authorize request itself is unchanged; an under-scoped token
              // simply 401s at call time and re-enters auth there.
              oauth: {
                authorizationUrl: found.provider.authorizationUrl,
                tokenUrl: found.provider.tokenUrl,
                clientId: found.provider.clientId,
              },
            },
          ];
        } catch (err) {
          // Discovery must never break the catalog — the tool just stays bare.
          log.warn(`mcp auth discovery failed for "${m.path}": ${err instanceof Error ? err.message : String(err)}`);
        }
      }),
    ]);
  }

  /**
   * "Bring your own client": a declared sign-in that names only its `clientId`
   * (the owner registered an app with a provider that offers no dynamic
   * registration — HubSpot, Google) gets its endpoints, PKCE and resource
   * indicator from the server's own OAuth metadata, exactly as the zero-config
   * path would. The descriptor is completed IN MEMORY: the client-secret route
   * reads the completed declaration and pins it with the secret, so nothing
   * here persists. When the metadata can't be had, the declaration stays
   * incomplete and `setup.reason` says so — the secret route then refuses
   * with the same reason instead of pinning a provider with no endpoints.
   */
  private async completeDeclaredOAuth(
    discovery: McpAuthDiscoveryPort,
    m: ToolManualDescriptor,
    v: ToolVariable,
  ): Promise<void> {
    const declaredByHand = 'declare `authorizationUrl` and `tokenUrl` on the sign-in variable';
    if (!isProbeableMcpServer(m)) {
      m.setup = {
        kind: 'oauth-manual',
        reason: `the sign-in endpoints can't be discovered for a local-only or templated server URL — ${declaredByHand}`,
      };
      return;
    }
    if (!discovery.providerForDeclaredClient) {
      m.setup = { kind: 'oauth-manual', reason: `sign-in endpoint discovery is unavailable — ${declaredByHand}` };
      return;
    }
    try {
      const found = await discovery.providerForDeclaredClient(m.name, m.url!, v.oauth!.clientId);
      if (found.status !== 'oauth') {
        m.setup = {
          kind: 'oauth-manual',
          reason:
            found.status === 'unsupported'
              ? found.reason
              : `the server did not ask for a sign-in and publishes no OAuth metadata — ${declaredByHand} if it needs one`,
        };
        return;
      }
      v.oauth = {
        ...v.oauth!,
        authorizationUrl: found.provider.authorizationUrl,
        tokenUrl: found.provider.tokenUrl,
        // A hand-declared resource wins; otherwise the server's own canonical URL.
        ...(!v.oauth!.resource && found.provider.resource ? { resource: found.provider.resource } : {}),
      };
    } catch (err) {
      // Never break the catalog — the sign-in just isn't ready yet.
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`sign-in endpoint discovery failed for "${m.path}": ${msg}`);
      m.setup = { kind: 'oauth-manual', reason: `sign-in endpoint discovery failed: ${msg}` };
    }
  }

  /**
   * Parse every declaration on `branch`'s workspace — the default branch for
   * the catalog, a draft for `listDeclaredOnlyOnBranch`. Pure disk: no
   * discovery, no access filter; callers add what their surface needs.
   *
   * ONE FILE'S FAULT IS ONE FILE'S FAULT. Every per-manual step below is
   * contained — read, parse, validate, and the namespace dedup — so the answer
   * is always "here is every manual that parses, and here is what the rest got
   * wrong". There is no path through this loop on which a single bad `.tool`
   * costs the catalog a manual that is fine, and nothing is remembered between
   * calls: a refusal lives only in the scan it came from, so a fixed file is a
   * valid manual on the very next scan.
   */
  private async scanDisk(branch: string = this.kb.defaultBranch): Promise<ScanResult> {
    let wsId: string;
    try {
      wsId = (await this.workspaceService.getOrCreateForBranch(branch)).id;
    } catch {
      return emptyScan();
    }
    const kbRoot = path.join(await this.workspaceService.getWorkspacePath(wsId), this.kbDirName);

    // A `.tool` sits under `Plugins/`, beside the skills that use it.
    const files: { abs: string; rel: string }[] = [];
    const layout = this.kb.layout;
    const root = path.join(kbRoot, layout.pluginsDir);
    for (const rel of await this.disk.walkFiles(root, (n) => n.toLowerCase().endsWith('.tool'))) {
      files.push({ abs: path.join(root, rel), rel: `${layout.pluginsDir}/${rel}` });
    }

    // MCP servers come from each plugin's mcp.json — the AUTHORITATIVE source
    // (the Agent Plugins fixed location), synthesized into the same descriptor
    // shape. Listed BEFORE the `.tool` files: on a name collision (a legacy
    // mcp `.tool` the migration has not converted yet), the shared dedup keeps
    // the first occurrence, and the authoritative source must be the one kept.
    // The plugins (and their mcp.json text) come from the configured source, so
    // a dialect that expands servers from a registry lands here unchanged.
    const parsed: ToolManualDescriptor[] = [];
    const discovered = await this.source.discover(kbRoot);
    for (const plugin of discovered.plugins) {
      if (plugin.mcpJsonText === null) continue; // no servers is the common case, not an error
      // One stamp for every server the file declares: the two texts together
      // are the whole source of these descriptors, so any edit to either
      // (a URL, a header, an added or dropped server, a `local: true` flip)
      // moves every server's digest — which is correct, if slightly generous.
      const from = sourceDigest(plugin.mcpJsonText + '\u0000' + (plugin.manifestText ?? ''));
      for (const d of descriptorsFromMcpJson(plugin.relFolder, plugin.mcpJsonText, plugin.manifestText, layout)) {
        d.sourceRevision = from;
        parsed.push(d);
      }
    }

    const invalid: InvalidToolManual[] = [];
    for (const f of files) {
      let content: string;
      try {
        content = await fs.readFile(f.abs, 'utf-8');
      } catch (err) {
        // Not a malformed manual — a file the walk saw and the read could not
        // open (deleted under us, a permission fault). Reported like one anyway:
        // to the person looking for their tool, "it isn't here" needs a reason
        // whichever step lost it.
        //
        // The CODE, not the message: an fs error quotes the absolute path it
        // tried, which is this server's disk layout rather than anything about
        // the knowledge base, and this string is handed to agents and browsers.
        const code = (err as NodeJS.ErrnoException | null)?.code;
        invalid.push({
          path: f.rel,
          reason: `the file could not be read${code ? ` (${code})` : ''} — it may have just been moved or deleted.`,
        });
        continue;
      }
      let descriptor: ToolManualDescriptor;
      try {
        descriptor = normalizeToolManual(baseName(f.rel), f.rel, content);
      } catch (err) {
        // A malformed `.tool` is skipped rather than breaking the catalog —
        // and NAMED, rather than vanishing. Skipping in silence is the same
        // outage from where the author stands: the tool is gone from every
        // listing, with nothing anywhere saying which file or why.
        invalid.push({ path: f.rel, reason: describeManualFault(err) });
        continue;
      }
      // The route slug IS the id (unique after dedup below, snake_case → URL-safe),
      // so the URL a user sees matches the tool's declared identity.
      descriptor.slug = descriptor.name;
      // Stamped from the BYTES, here, before `decorateMcpOAuth` and
      // `surfaceReferencedVariables` mutate the descriptor: those two derive
      // from the network and from the file respectively, and a digest taken
      // afterwards would move whenever an OAuth probe happened to fail.
      descriptor.sourceRevision = sourceDigest(content);
      parsed.push(descriptor);
    }
    // The manual name (= its id) is the UTCP variable namespace secrets bind to, so
    // it must be unique. A collision is REFUSED — not auto-suffixed, which would
    // silently rebind a configured secret to a different file. The winner is
    // deterministic (files scanned in sorted path order); the shared `dedupeById`
    // is the one dedup rule across tools and skills.
    // Deduped by NAMESPACE, not by name. The comment below has always said the
    // id is the secret-variable namespace and must be unique — but the check
    // compared raw names, and the two are not the same function. Namespacing
    // maps every non-word character to `_` and then doubles it, so `a-b` and
    // `a_b` are different names with the SAME namespace `a__b_`. A `.tool` id
    // cannot contain a hyphen, but an mcp.json server name can, so the pair is
    // reachable — and the consequence is that two manuals share one set of
    // vault keys, with either able to resolve the other's secrets.
    const manuals = dedupeById(parsed, (m) => utcpNamespacePrefix(m.name), (m) =>
      // A collision drops a manual from every surface just as surely as a parse
      // error does, so it is reported the same way rather than only reaching a
      // log that nobody browsing the catalog can see.
      invalid.push({
        path: m.path,
        // Neither the manual's name nor the namespace it resolved to is
        // repeated: both are the author's text put through a transform, and a
        // reason carries none of it (see `describeManualFault`). `path` says
        // which file, and the rule says what to look for in it.
        reason:
          'this manual resolves to a secret-variable namespace another manual already uses. ' +
          'Names differing only in `-` vs `_` share one namespace — rename one of them.',
      }),
    );
    // Sorted so the refused set is a stable VALUE: the change-detecting log
    // below compares one scan against the last, and two orderings of the same
    // three faults are not a change worth repeating.
    invalid.sort((a, b) => a.path.localeCompare(b.path));
    // Only the CATALOG's scan talks. `listDeclaredOnlyOnBranch` re-scans a
    // draft workspace, and a draft's half-written `.tool` is not news about the
    // served catalog — it would also flap the log every time an agent saves.
    if (branch === this.kb.defaultBranch) this.logInvalidOnChange(invalid);
    return { manuals, invalid };
  }
}

// --- helpers ------------------------------------------------------------------

/**
 * A short digest of the text a descriptor was parsed from. Truncated because
 * this is only ever compared for equality, and 128 bits of it is far past what
 * a per-workspace catalog could collide in.
 */
function sourceDigest(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 32);
}

/**
 * One manual's line in the catalog fingerprint: what makes it the tool it is,
 * plus the digest of the file it came from.
 *
 * The named fields rather than the whole descriptor, deliberately: `setup` and
 * `variables` carry OAuth auto-discovery results, which are re-probed on every
 * scan and can differ between two scans of an unchanged file — hashing them
 * would report a catalog change that no commit made. `sourceRevision` is what
 * covers everything else the file says, so nothing is lost by leaving the
 * decorated fields out.
 */
function manualFingerprint(m: ToolManualDescriptor): string {
  return [
    m.slug,
    m.name,
    m.path,
    m.type,
    m.remote === false ? 'local' : 'remote',
    m.description ?? '',
    m.sourceRevision ?? '',
    // NUL-joined, like the skill lines this sits beside: no field can contain
    // one, so two different manuals can never render the same line by having
    // a separator inside one of their own fields.
  ].join('\u0000');
}

/**
 * The one descriptor → summary projection, shared by every list surface
 * (`listAccessible`, `listAllSummaries`, and the summary half of `getDetail`).
 */
function toSummary(m: ToolManualDescriptor): ToolManualSummary {
  return {
    slug: m.slug,
    name: m.name,
    path: m.path,
    type: m.type,
    description: m.description,
    variables: m.variables,
    remote: m.remote,
    setup: m.setup,
  };
}

/**
 * What an `inline` manual's embedded tools say the assistant can do. `tools` is
 * typed `unknown[]` (it is only validated when actually served as a UTCP
 * manual), so every entry is re-checked here: an entry without a string `name`
 * has nothing to display and is dropped rather than rendering a blank bullet.
 * Non-inline manuals discover their tools over the network at call time, so
 * there is nothing to derive without a round-trip this endpoint won't make.
 */
function capabilitiesOf(m: ToolManualDescriptor): ToolCapability[] {
  if (m.type !== 'inline' || !Array.isArray(m.tools)) return [];
  const out: ToolCapability[] = [];
  for (const entry of m.tools) {
    if (out.length >= MAX_CAPABILITIES) break;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const t = entry as Record<string, unknown>;
    if (typeof t.name !== 'string' || !t.name.trim()) continue;
    out.push({
      name: t.name.trim(),
      description: typeof t.description === 'string' && t.description.trim() ? t.description.trim() : null,
    });
  }
  return out;
}

/**
 * A `.tool` file's PROVISIONAL slug — its filename without the extension, which
 * is what `normalizeToolManual` falls back to when the frontmatter names
 * nothing. It is not the served id: `scanDisk` overwrites `slug` with the
 * resolved manual `name` just below. Exported for the pending-tool surface,
 * which parses a `.tool` read at a change request's branch and must feed the
 * parser the same provisional value — and then resolve the slug the same way.
 */
export function baseName(rel: string): string {
  const base = rel.slice(rel.lastIndexOf('/') + 1);
  return base.replace(/\.tool$/i, '');
}

/**
 * Deterministically derive a `.tool`'s UTCP manual name — the variable namespace
 * secrets bind to via `<manual>_<VAR>`. ALPHANUMERIC ONLY (no underscores) so the
 * prefix splits cleanly on a single underscore, and a pure function of the file's
 * own declared name: it never depends on what other `.tool`s exist, so a
 * configured secret's namespace can't drift when the catalog changes. Collisions
 * are refused by the scanner (see `scanDisk`), not silently suffixed. A name that
 * strips to empty (or starts with a digit) is prefixed `tool`; because the KB
 * manual name (`KNOWLEDGE_BASE`) contains an underscore, a user name can never
 * collide with it after stripping.
 */
function manualName(raw: string): string {
  const name = raw.replace(/[^a-zA-Z0-9]/g, '');
  if (!name || /^[0-9]/.test(name)) return `tool${name}`;
  return name;
}

/**
 * Parse + normalize a `.tool` file into a descriptor. THE TOOL IS THE
 * FRONTMATTER: a fenced file's single `---` YAML block carries everything —
 * `id`/`name`, access verbs (`read`/`write`/`owner`/`download`, read straight
 * from the file by the access resolver, not here), and the config
 * (`type`/`url`/`variables`/…). Text after the closing fence is free-form notes
 * the parser ignores. A fence-less file is the legacy form (the whole file is
 * the object — JSON can't carry fences). Throws on a structurally invalid
 * object or a malformed explicit `id`. `slug` is provisional (the scanner
 * dedups it); `name` is the FINAL UTCP manual namespace.
 */
export function normalizeToolManual(
  provisionalSlug: string,
  repoPath: string,
  content: string,
): ToolManualDescriptor {
  // THE TOOL IS THE FRONTMATTER. A fenced `.tool` is one `---` YAML block
  // carrying everything — identity (`id`/`name`), access verbs, and config —
  // and anything after the closing fence is free-form notes the parser ignores
  // (like a SKILL.md body). One object serves every reader: the access resolver
  // finds its verbs inside the fence, the id index finds `id`/`name`, and the
  // config keys live in the same object. A fence-less file is the legacy form
  // (the whole file is the object) — JSON `.tool`s can't carry fences.
  const fm = extractFrontmatter(content);
  const source = fm ? fm.frontmatter : content;
  const parsed = parseYaml(source) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('`.tool` file must be a YAML/JSON object (in the `---` block when fenced)');
  }
  const obj = parsed as Record<string, unknown>;
  const type = normalizeType(obj.type);

  // Identity: an explicit `id` is used VERBATIM as the UTCP manual namespace, so
  // it must be lowercase snake_case (UTCP's namespace grammar). With no explicit
  // id, fall back to `name` then the filename and sanitize (legacy behaviour —
  // keeps existing tools' namespaces).
  const explicitId = typeof obj.id === 'string' ? obj.id.trim() : '';
  let name: string;
  if (explicitId) {
    if (!isValidId(explicitId)) {
      // The rejected id is NOT quoted back — see `describeManualFault`: this
      // message becomes an `invalid[].reason` on an agent transcript, a browser
      // and a log, and `id` is a field an author can paste anything into,
      // including the token they meant for a header. The field name plus the
      // rule is what the author needs; the value is in front of them.
      throw new Error('tool `id` must be lowercase snake_case (letters, digits, underscores)');
    }
    name = explicitId;
  } else {
    name = manualName(resolveDeclaredId(obj, provisionalSlug));
  }

  // A `.tool` may not reproduce a built-in manual's UTCP namespace — that would
  // let it read the loopback creds seeded under that namespace on the agent's
  // code-mode client (internal token, connector creds, KB bearer).
  if (RESERVED_TOOL_NAMESPACES.includes(name.toLowerCase())) {
    throw new Error(
      'the tool namespace this file resolves to is reserved for a built-in manual — ' +
        "choose a different `id`/`name` (a `.tool` sharing a built-in namespace could read " +
        "that manual's seeded credentials).",
    );
  }

  // Any `.tool` content — url, headers, inline tool templates, notes — may not
  // reference the platform-seeded variables.
  assertNoReservedVariableRefs(obj);

  // The non-stdio constituent of the union, by name: `.tool` parsing can
  // never produce a spawn spec, and the stdio side pins `remote: false`,
  // which this builder must stay free to set from the file's own `remote:`.
  const descriptor: ToolManualDescriptorBase & { remote?: boolean; stdio?: undefined } = {
    slug: provisionalSlug,
    name,
    path: repoPath,
    type,
  };

  // Cosmetic prose for the browser tool page. Unlike every other field here, a
  // malformed value is IGNORED rather than thrown on: `description` buys the
  // reader a sentence, and no sentence is worth taking a working integration out
  // of the catalog (a throw skips the whole file). So: a non-empty string wins,
  // anything else — number, object, null, blank — silently leaves it absent.
  const description = typeof obj.description === 'string' ? obj.description.trim() : '';
  if (description) descriptor.description = description;

  const variables = normalizeVariables(obj.variables);
  if (variables.length) descriptor.variables = variables;

  descriptor.remote = normalizeRemote(obj.remote);

  // A `.tool` that shells out is LOCAL, always. The hosted platform parses and
  // lists these so the local MCP server can find them, but it must never be the
  // thing that runs them — a `.tool` is knowledge-base content, and agents write
  // to the knowledge base. A declared `remote: true` beside a shell command is
  // therefore a refusal rather than a warning: silently correcting it would let
  // an author believe they had published a remote tool, and would leave the
  // catalog disagreeing with the file about what the platform will do.
  if (containsCliCallTemplate(obj)) {
    if (obj.remote === true) {
      throw new Error(
        'this `.tool` declares `remote: true` but contains a `cli` call template — ' +
          'shell tools execute only in a local runtime (drop `remote: true`, or the `cli` template).',
      );
    }
    descriptor.remote = false;
  }

  if (type === 'inline') {
    const tools = Array.isArray(obj.tools) ? obj.tools : undefined;
    if (!tools) throw new Error('inline `.tool` must have a `tools` array');
    descriptor.tools = tools;
  } else {
    const url = typeof obj.url === 'string' ? obj.url.trim() : '';
    if (!url) throw new Error(`${type} \`.tool\` must have a \`url\``);
    descriptor.url = url;
    // SSRF: a remote-capable `.tool` triggers a server-side discovery fetch to
    // this URL (the MCP proxy AND now the in-process agent + headless routines),
    // so a literal private/loopback/metadata host is refused at the producing
    // boundary. Only a TEMPLATED HOSTNAME (resolved at call time) is
    // uncheckable here — a `${...}` in the scheme, userinfo, port, path, or
    // query still leaves a concrete network target (`${S}://169.254.169.254/x`
    // and `http://${U}@169.254.169.254/x` target the metadata IP no matter what
    // resolves), so the guard must still run against the literal host. The
    // authority is therefore taken from `://` INDEPENDENT of the scheme being
    // literal, and when the raw url can't parse (templated scheme or port) the
    // check runs on a synthetic `<scheme-or-http>//host`. A BACKSLASH behaves as
    // a slash for http(s) in WHATWG `new URL` — BOTH as the scheme separator
    // (`${S}:\\169.254.169.254\\p` → the IP is the host) and inside the
    // authority (`http://169.254.169.254\@${HOST}/x` fetches the IP, the `\@…`
    // becoming path). So the authority separator is `:` + two `[\/]` (not just
    // `://`), and `\` also terminates the authority alongside `/?#`; otherwise a
    // literal internal host slips past as a templated scheme or userinfo.
    // Local-only (`remote: false`) `.tool`s are never fetched server-side, so
    // are exempt.
    if (descriptor.remote !== false) {
      assertSafeManualFetchUrl(url, '`url`');
    }
    if (obj.headers && typeof obj.headers === 'object' && !Array.isArray(obj.headers)) {
      descriptor.headers = obj.headers as Record<string, string>;
    }
    if (type === 'http') {
      const m = typeof obj.httpMethod === 'string' ? obj.httpMethod.toUpperCase() : 'GET';
      descriptor.httpMethod = m === 'POST' ? 'POST' : 'GET';
    }
  }

  // LAST, because it inherits the manual's own `headers` when it declares none
  // — which is the common case, and the reason a one-line `healthCheck: {url}`
  // authenticates exactly like a real call. Resolving that default here, where
  // the whole descriptor is in hand, keeps the probe self-contained: nothing
  // downstream has to re-derive which headers a manual would have sent.
  //
  // For `http`/`mcp` only. An `inline` manual's execution never sends its
  // top-level `headers` — each embedded tool carries its own call template —
  // so inheriting them would have the probe prove a request no real call
  // makes. An inline probe declares its own headers on the healthCheck, or
  // sends none.
  const declaredHeaders =
    type !== 'inline' && obj.headers && typeof obj.headers === 'object' && !Array.isArray(obj.headers)
      ? (obj.headers as Record<string, string>)
      : undefined;
  const healthCheck = normalizeHealthCheck(obj.healthCheck, descriptor.remote, declaredHeaders);
  if (healthCheck) descriptor.healthCheck = healthCheck;

  return descriptor;
}

/**
 * SSRF guard for a URL a `.tool` will make the SERVER fetch — its manual `url`
 * and its declared `healthCheck.url` alike, which is why this is a function
 * rather than an inline block: two fetch targets policed by one rule cannot
 * drift apart.
 *
 * A remote-capable `.tool` triggers a server-side fetch (the MCP proxy, the
 * in-process agent, headless routines, and now the credential probe), so a
 * literal private/loopback/metadata host is refused at the producing boundary.
 * Only a TEMPLATED HOSTNAME (resolved at call time) is uncheckable here — a
 * `${...}` in the scheme, userinfo, port, path, or query still leaves a
 * concrete network target (`${S}://169.254.169.254/x` and
 * `http://${U}@169.254.169.254/x` target the metadata IP no matter what
 * resolves), so the guard must still run against the literal host. The
 * authority is therefore taken from `://` INDEPENDENT of the scheme being
 * literal, and when the raw url can't parse (templated scheme or port) the
 * check runs on a synthetic `<scheme-or-http>//host`. A BACKSLASH behaves as a
 * slash for http(s) in WHATWG `new URL` — BOTH as the scheme separator
 * (`${S}:\\169.254.169.254\\p` → the IP is the host) and inside the authority
 * (`http://169.254.169.254\\@${HOST}/x` fetches the IP, the `\\@…` becoming
 * path). So the authority separator is `:` + two `[\/]` (not just `://`), and
 * `\` also terminates the authority alongside `/?#`; otherwise a literal
 * internal host slips past as a templated scheme or userinfo.
 *
 * Callers gate on `remote !== false`: a local-only `.tool` is never fetched
 * server-side, so it is exempt.
 */
function assertSafeManualFetchUrl(url: string, label: string): void {
  const literalScheme = /^([a-zA-Z][a-zA-Z0-9+.-]*:)[\\/]{2}/.exec(url)?.[1];
  const sepMatch = /:[\\/]{2}/.exec(url);
  const sepIdx = sepMatch ? sepMatch.index : -1;
  const authority = sepIdx >= 0 ? url.slice(sepIdx + 3).split(/[/\\?#]/, 1)[0] : url;
  const hostPort = authority.slice(authority.lastIndexOf('@') + 1);
  const host = hostPort.startsWith('[') ? hostPort.slice(0, hostPort.indexOf(']') + 1) : hostPort.split(':')[0];
  // A templated host resolves to something we can't know yet — nothing to check.
  if (host.includes('${')) return;
  const checkUrl =
    literalScheme && !authority.includes('${')
      ? url // fully literal scheme + authority → validate the URL as-is
      : sepIdx >= 0
        ? `${literalScheme ?? 'http:'}//${host}` // templated scheme/userinfo/port, literal host
        : url; // no authority shape at all → parse raw (refuses malformed)
  assertSafeFetchUrl(checkUrl, { label });
}

/**
 * Parse the optional `healthCheck:` block — the read-only call that proves this
 * tool's credential works (see {@link ToolHealthCheck}).
 *
 * Throws on a malformed block rather than dropping it, matching `variables`
 * and for the same reason inverted: a silently-ignored probe would leave the
 * tool reporting "can't verify" forever while its author believes they wired
 * one up, and the whole point of the field is to stop the UI overclaiming.
 *
 * `method` accepts only `GET`. A probe that can mutate is not a probe — it runs
 * unattended on every save and re-check, so `POST` is refused outright instead
 * of being quietly downgraded.
 */
function normalizeHealthCheck(
  raw: unknown,
  remote: boolean | undefined,
  manualHeaders: Record<string, string> | undefined,
): ToolHealthCheck | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('`healthCheck` must be an object');
  const e = raw as Record<string, unknown>;
  const url = typeof e.url === 'string' ? e.url.trim() : '';
  if (!url) throw new Error('`healthCheck` must have a `url`');
  if (remote !== false) {
    assertSafeManualFetchUrl(url, '`healthCheck.url`');
  }
  const check: ToolHealthCheck = { url };
  if (e.method !== undefined) {
    const m = typeof e.method === 'string' ? e.method.toUpperCase() : '';
    if (m !== 'GET') throw new Error('`healthCheck.method` must be `GET` — a health check may not mutate');
    check.method = 'GET';
  }
  // Whichever headers the probe ends up carrying get checked — declared OR
  // inherited. Validating only the declared branch left the common case
  // unguarded: `healthCheck: { url }` alone inherits the manual's headers, so a
  // YAML `Authorization: 1234` there still reached the probe untouched.
  if (e.headers !== undefined) {
    if (!e.headers || typeof e.headers !== 'object' || Array.isArray(e.headers)) {
      throw new Error('`healthCheck.headers` must be an object');
    }
    check.headers = assertStringHeaders(e.headers as Record<string, unknown>, 'healthCheck.headers');
  } else if (manualHeaders) {
    check.headers = assertStringHeaders(manualHeaders as Record<string, unknown>, 'headers');
  }
  return check;
}

/**
 * The VALUES of a header map, not just its container.
 *
 * YAML types `Authorization: 1234` as a number, and a cast alone let it through
 * to the probe, where substitution calls `.matchAll` on it — surfacing
 * `text.matchAll is not a function` to the user as the reason their credential
 * is unhealthy. Caught at parse time, next to `url` and `method`, it reads as
 * what it is: a mistake in the `.tool` file.
 */
function assertStringHeaders(headers: Record<string, unknown>, label: string): Record<string, string> {
  // Located by POSITION, not by its key. A header name is text the author
  // wrote, and a refusal reason carries none of that — see
  // {@link describeManualFault}. The `.tool` has a handful of headers and the
  // reader is looking at the file, so an ordinal finds the line as surely as
  // the name would.
  const entries = Object.entries(headers);
  for (const [i, [, v]] of entries.entries()) {
    if (typeof v !== 'string') {
      throw new Error(
        `\`${label}\` entry ${i + 1} of ${entries.length} must have a string value ` +
          '(quote it if it looks like a number)',
      );
    }
  }
  return headers as Record<string, string>;
}

/**
 * Parse the optional `variables:` block of a `.tool` file. Each entry names a
 * `${VAR}` and who provisions it (`admin` default | `user`). Throws on a
 * malformed entry so the whole file is skipped (never silently mis-scoped) — a
 * mis-scoped variable is a security-relevant mistake, not a soft warning.
 */
function normalizeVariables(raw: unknown): ToolVariable[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error('`variables` must be an array');
  const seen = new Set<string>();
  return raw.map((entry, i) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`\`variables[${i}]\` must be an object`);
    }
    const e = entry as Record<string, unknown>;
    const name = typeof e.name === 'string' ? e.name.trim() : '';
    // EVERY refusal in this block is located by `variables[i]`, never by the
    // name the entry declared — passing `[A-Za-z0-9_]+` makes a string a legal
    // identifier, not a string this process may repeat. A token spelled with
    // underscores passes that test, and the field an author mis-pastes a token
    // into is not one we get to choose. See {@link describeManualFault}.
    const at = `\`variables[${i}]`;
    if (!/^[A-Za-z0-9_]+$/.test(name)) {
      throw new Error(`${at}.name\` must match [A-Za-z0-9_]+`);
    }
    if (RESERVED_VARIABLE_NAMES.includes(name)) {
      // `name` is one of OURS here — matched against a fixed list — so saying
      // which reserved name was taken repeats nothing the file taught us.
      throw new Error(
        `${at}.name\` is "${name}", which is reserved for platform seeding and may not be declared by a \`.tool\``,
      );
    }
    if (seen.has(name)) throw new Error(`${at}.name\` duplicates an earlier entry's`);
    seen.add(name);
    const rawScope = typeof e.scope === 'string' ? e.scope.toLowerCase().trim() : '';
    if (rawScope && rawScope !== 'admin' && rawScope !== 'user') {
      throw new Error(`${at}.scope\` is invalid (expected admin|user)`);
    }
    const scope: ToolVariableScope = rawScope === 'user' ? 'user' : 'admin';
    const label = typeof e.label === 'string' && e.label.trim() ? e.label.trim() : undefined;
    const oauth = normalizeVariableOAuth(at, e.oauth);
    // OAuth is inherently per-caller — each user signs in for their own token. An
    // admin-shared OAuth token would leak one user's token to all callers.
    if (oauth && scope !== 'user') {
      throw new Error(`${at}\` has \`oauth\`, so its \`scope\` must be \`user\``);
    }
    return {
      name,
      scope,
      ...(label ? { label } : {}),
      ...(oauth ? { oauth } : {}),
    };
  });
}

/**
 * Whether the platform can reach an MCP server's URL for OAuth discovery.
 * Local-only servers aren't probeable from here; templated URLs aren't
 * resolvable without a caller. Both keep their file-declared behavior — the
 * one rule for the zero-config probe and for completing a declared client.
 */
function isProbeableMcpServer(m: ToolManualDescriptor): boolean {
  return !!m.url && m.remote !== false && !m.url.includes('${');
}

/**
 * Parse a variable's optional OAuth provider config. Carries PUBLIC config only —
 * never a client secret. Both URLs are validated with the SAME SSRF-safe check the
 * vault uses for OAuth endpoints (`assertSafeFetchUrl` with https required), so a
 * `.tool` author can't aim a sign-in/token exchange at an internal host. Both
 * URLs are REQUIRED here: a `.tool` (http/inline) has no server whose OAuth
 * metadata could fill them in — that convenience belongs to mcp.json servers.
 *
 * `at` is the entry's position — `` `variables[2] `` with its opening backtick,
 * each message closing it after the field — rather than the variable's name.
 * Same rule as everywhere else a refusal is written: the reason locates the
 * fault in the file without repeating anything the file said. See
 * {@link describeManualFault}.
 */
function normalizeVariableOAuth(at: string, raw: unknown): ToolVariableOAuth | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${at}.oauth\` must be an object`);
  }
  const o = raw as Record<string, unknown>;
  // Confidential OAuth material is provisioned only through the protected
  // client-secret route; reject it here so a plaintext `.tool` can't smuggle one in.
  for (const forbidden of ['clientSecret', 'client_secret', 'secret']) {
    if (o[forbidden] !== undefined) {
      throw new Error(`${at}.oauth.${forbidden}\` must be set through the protected client-secret route`);
    }
  }
  const safeUrl = (v: unknown, field: string): string => {
    const s = typeof v === 'string' ? v.trim() : '';
    try {
      assertSafeFetchUrl(s, { requireHttps: true, label: `${at}.oauth.${field}\`` });
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : `${at}.oauth.${field}\` is invalid`);
    }
    return s;
  };
  const authorizationUrl = safeUrl(o.authorizationUrl, 'authorizationUrl');
  const tokenUrl = safeUrl(o.tokenUrl, 'tokenUrl');
  const clientId = typeof o.clientId === 'string' && o.clientId.trim() ? o.clientId.trim() : '';
  if (!clientId) throw new Error(`${at}.oauth.clientId\` is required`);
  let scopes: string[] | undefined;
  if (o.scopes !== undefined) {
    if (!Array.isArray(o.scopes) || !o.scopes.every((s) => typeof s === 'string')) {
      throw new Error(`${at}.oauth.scopes\` must be string[]`);
    }
    scopes = o.scopes as string[];
  }
  let authParams: Record<string, string> | undefined;
  if (o.authParams !== undefined) {
    if (typeof o.authParams !== 'object' || Array.isArray(o.authParams)) {
      throw new Error(`${at}.oauth.authParams\` must be an object of string values`);
    }
    const entries = Object.entries(o.authParams as Record<string, unknown>);
    if (!entries.every(([, v]) => typeof v === 'string')) {
      throw new Error(`${at}.oauth.authParams\` values must be strings`);
    }
    authParams = Object.fromEntries(entries) as Record<string, string>;
  }
  // PKCE is on unless the file says `false`; only the opt-out is ever stored.
  if (o.pkce !== undefined && typeof o.pkce !== 'boolean') {
    throw new Error(`${at}.oauth.pkce\` must be a boolean`);
  }
  // Never fetched (it rides as a request param), but it names the remote
  // server — same https/SSRF bar as the endpoints.
  const resource = o.resource !== undefined ? safeUrl(o.resource, 'resource') : undefined;
  return {
    authorizationUrl,
    tokenUrl,
    clientId,
    ...(scopes ? { scopes } : {}),
    ...(authParams ? { authParams } : {}),
    ...(o.pkce === false ? { pkce: false } : {}),
    ...(resource ? { resource } : {}),
  };
}

/**
 * Parse the optional `remote` flag. Absent ⇒ `true` (remote-capable, the default).
 * A non-boolean throws so the file is skipped rather than silently mis-classified.
 */
function normalizeRemote(raw: unknown): boolean {
  if (raw === undefined || raw === null) return true;
  if (typeof raw !== 'boolean') throw new Error('`remote` must be a boolean');
  return raw;
}

function normalizeType(raw: unknown): ToolManualType {
  const t = typeof raw === 'string' ? raw.toLowerCase().trim() : '';
  if (t === 'http') return 'http';
  if (t === 'mcp') return 'mcp';
  if (t === 'inline' || t === 'text' || t === '') return 'inline';
  // The written value is not echoed (see the `id` refusal above): the accepted
  // set says more than the rejected value does, and a `type:` line is one
  // mis-paste away from holding a credential like any other.
  throw new Error('unknown `.tool` `type` (expected `http`, `mcp`, `inline`, or absent)');
}
