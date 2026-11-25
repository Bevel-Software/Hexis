import express, { type Request, type RequestHandler } from 'express';
import { logger } from '../../shared/logging.js';

const log = logger('declared-variables');
import { utcpNamespacedKey } from '../../shared/utcp-namespace.js';
import type { IToolManualService } from '../tool-manuals/index.js';
import type { ISecretsVaultService } from '../secrets-vault/index.js';
import { resolveConnectionScope, type IAgentScopeResolver } from '../agent-scope/index.js';

type ResolveUserEmail = (userId: string) => Promise<string | undefined>;
type MayWriteTool = (email: string, toolPath: string) => Promise<boolean>;

/**
 * The ONLY core route that returns secret VALUES.
 *
 * Everywhere else a credential is resolved in-process at tool-call time and
 * never crosses the wire — `resolve()` has one caller, the UTCP variable
 * loader. One runtime outside this process legitimately needs values anyway:
 * the LOCAL MCP server, which executes a `remote: false` `.tool` on the user's
 * own machine and has to expand that manual's `${VAR}` refs there.
 *
 * The discipline that makes this safe, and the reason it is a narrow route
 * rather than a generic "resolve these keys" endpoint: **the caller never names
 * the variables**. It names a knowledge-base file; the server re-reads that
 * file from the DEFAULT branch and resolves exactly what the file declares.
 * The knowledge base is the allowlist, it is reviewable as a diff, and no
 * caller — however privileged its connection key — can widen it.
 *
 * Five further constraints hold here:
 *
 * 1. **Only the local runtime's own sign-in is answered.** The credential must
 *    be the token `/api/mcp/local-token` mints for the local server's browser
 *    sign-in (`ToolAuth.localRuntime`). A connection key is the credential an
 *    AGENT holds (pasted into its config, handed to pipelines), so it is
 *    refused, as are an in-process agent's token, a hosted loopback token and
 *    a browser session. The refusal comes before the manual is looked up, so
 *    it says nothing about which tools exist. A local server run with `--key`
 *    takes its tools' values from its own environment instead.
 * 2. **A shared value is released only to who may set it.** An `admin`-scope
 *    variable is one workspace value every reader's calls use; it is handed
 *    out only to a writer of the `.tool` (the people the Secrets page lets
 *    set it) and reported as `withheld` to anyone else. A `user`-scope value
 *    is the caller's own.
 * 3. **Read access is required.** A caller that cannot read the declaring file
 *    gets a 404, not an empty object: whether a manual exists is itself
 *    information.
 * 4. **Only local manuals.** A remote-capable `.tool`'s credentials are used
 *    server-side; handing them to a local caller would egress a secret that had
 *    no reason to leave.
 * 5. **Values are never logged, only names.** Every resolve emits one audit
 *    line naming the caller, the file and the variable names — enough to
 *    reconstruct who was handed what, and never the what itself.
 *
 * Responses are `no-store`: a secret must not sit in an intermediary cache.
 *
 * An overlay that ships its own kind of declaring file adds its own route in
 * this same shape rather than widening this one. The allowlist has to be a file
 * the server itself reads, and a route that understood several file kinds would
 * be one refactor away from taking the list from the caller.
 */
export function createDeclaredVariableRoutes(
  toolManualService: IToolManualService,
  secretsVault: ISecretsVaultService,
  manualAuth: RequestHandler,
  resolveUserEmail: ResolveUserEmail,
  /**
   * Whether this person may write the `.tool` at this path on the released
   * branch: the verdict that lets them set its shared values on the Secrets
   * page, and so the one that lets them be handed those values here.
   */
  mayWriteTool: MayWriteTool,
  /**
   * Resolves the scope of a connection made as an agent configuration: such a
   * connection is handed only the variables of a connector the file loads.
   * Absent, a narrowed connection is handed none.
   */
  agentScope?: Pick<IAgentScopeResolver, 'resolve'>,
): express.Router {
  const router = express.Router();

  /**
   * Whether the credential is the local runtime's own sign-in, and nothing
   * else (constraint 1).
   *
   * `manualAuth` admits more than that, which is right for the rest of the
   * agent surface: a connection key, every internal token and a browser
   * session may all list manuals. None of them may read values. A connection
   * key and an agent's internal token are what an agent holds, and the
   * Secrets page is deliberately write-only for a browser: a field starts
   * empty even when a value exists, and saving replaces rather than reveals.
   */
  function isLocalRuntime(req: Request): req is Request & { toolAuth: { userId: string } } {
    const auth = req.toolAuth;
    return Boolean(auth?.userId) && auth?.source === 'external' && auth.localRuntime === true;
  }

  /**
   * Resolve one variable set, and report which names came back empty.
   *
   * A missing secret is NOT an error here. The runtime that asked is better
   * placed to decide — a local tool may have an optional token, and the
   * execution layer wants to fail the step with the variable's name in the
   * message rather than receive a 500 it can only call "infra". So the value
   * map carries what resolved and `missing` carries the rest.
   */
  async function resolveAll(
    userId: string,
    entries: { name: string; key: string }[],
  ): Promise<{ values: Record<string, string>; missing: string[] }> {
    // Null-prototype: a manual may legitimately declare a variable named
    // `__proto__` (the name grammar is `[A-Za-z0-9_]+`), and on a plain object
    // that assignment silently sets the prototype instead of a property — the
    // secret resolves and then vanishes from the response.
    const values: Record<string, string> = Object.create(null) as Record<string, string>;
    const missing: string[] = [];
    const resolved = await Promise.all(
      entries.map(async (e) => ({ name: e.name, value: await secretsVault.resolve(userId, e.key) })),
    );
    for (const r of resolved) {
      if (typeof r.value === 'string' && r.value.length > 0) values[r.name] = r.value;
      else missing.push(r.name);
    }
    return { values, missing };
  }

  /**
   * The variables a LOCAL `.tool` declares, for the local MCP server to expand
   * into a tool invocation there. The manual is re-read server-side; the caller
   * sends nothing but the slug.
   */
  router.post('/agent/local-tools/:slug/variables', manualAuth, async (req, res) => {
    if (!isLocalRuntime(req)) {
      return void res.status(403).json({
        error:
          'Secret values are released only to the local MCP server signed in through your browser ' +
          '(hexis-mcp started without --key). A connection key, a browser session and an agent never receive them. ' +
          'To run a local tool with a connection key, set its variables in the MCP client config that starts hexis-mcp.',
      });
    }
    const userId = req.toolAuth.userId;
    const slug = String(req.params.slug);
    try {
      const email = await resolveUserEmail(userId);
      if (!email) return void res.status(404).json({ error: 'Not found' });
      // `listAccessible` already applies the per-file read verdict, so an
      // unreadable manual is simply absent — same fail-closed read model the
      // catalog uses.
      const found = (await toolManualService.listAccessible(email)).find((m) => m.slug === slug);
      // A connection made as an agent configuration is handed only the variables of
      // a connector it loads; another is as absent as an unreadable one.
      const scope = found ? await resolveConnectionScope(agentScope, email, req.toolAuth.agentPath) : null;
      const manual = found && scope?.allowsConnector(found.path) ? found : undefined;
      if (!manual) return void res.status(404).json({ error: 'Not found' });
      if (manual.remote !== false) {
        return void res.status(409).json({
          error:
            'This tool runs on the platform, so its credentials are resolved there and never released. ' +
            'Only a `remote: false` tool resolves its variables locally.',
        });
      }
      const declared = manual.variables ?? [];
      // Asked only when there is a shared value to release: the verdict
      // decides which names are resolved at all (constraint 2).
      const releasesShared = declared.some((v) => v.scope !== 'user') && (await mayWriteTool(email, manual.path));
      const withheld = declared.filter((v) => v.scope !== 'user' && !releasesShared).map((v) => v.name);
      const entries = declared
        .filter((v) => v.scope === 'user' || releasesShared)
        .map((v) => ({ name: v.name, key: utcpNamespacedKey(manual.name, v.name) }));
      const { values, missing } = await resolveAll(userId, entries);
      log.info(
        `local tool "${manual.path}" resolved for user=${userId}: ` +
          `provided=[${Object.keys(values).join(',')}] missing=[${missing.join(',')}] withheld=[${withheld.join(',')}]`,
      );
      res.set('Cache-Control', 'no-store').json({ name: manual.name, variables: values, missing, withheld });
    } catch (err) {
      log.error('local tool resolve failed:', { err });
      res.status(500).json({ error: 'Failed to resolve variables' });
    }
  });

  return router;
}
