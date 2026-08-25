import express, { type Request, type RequestHandler } from 'express';
import { utcpNamespacedKey } from '../../shared/utcp-namespace.js';
import type { IToolManualService } from '../tool-manuals/tool-manuals.contract.js';
import type { ISecretsVaultService } from '../secrets-vault/secrets-vault.contract.js';

type ResolveUserEmail = (userId: string) => Promise<string | undefined>;

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
 * Three further constraints hold here:
 *
 * 1. **Read access is required.** A caller that cannot read the declaring file
 *    gets a 404, not an empty object: whether a manual exists is itself
 *    information.
 * 2. **Only local manuals.** A remote-capable `.tool`'s credentials are used
 *    server-side; handing them to a local caller would egress a secret that had
 *    no reason to leave.
 * 3. **Values are never logged, only names.** Every resolve emits one audit
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
): express.Router {
  const router = express.Router();

  async function caller(req: Request): Promise<{ userId: string; email: string } | null> {
    const userId = req.toolAuth?.userId;
    if (!userId) return null;
    try {
      const email = await resolveUserEmail(userId);
      return email ? { userId, email } : null;
    } catch {
      return null;
    }
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
    const values: Record<string, string> = {};
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
    const who = await caller(req);
    if (!who) return void res.status(403).json({ error: 'Forbidden' });
    const slug = String(req.params.slug);
    try {
      // `listAccessible` already applies the per-file read verdict, so an
      // unreadable manual is simply absent — same fail-closed read model the
      // catalog uses.
      const manual = (await toolManualService.listAccessible(who.email)).find((m) => m.slug === slug);
      if (!manual) return void res.status(404).json({ error: 'Not found' });
      if (manual.remote !== false) {
        return void res.status(409).json({
          error:
            'This tool runs on the platform, so its credentials are resolved there and never released. ' +
            'Only a `remote: false` tool resolves its variables locally.',
        });
      }
      const entries = (manual.variables ?? []).map((v) => ({
        name: v.name,
        key: utcpNamespacedKey(manual.name, v.name),
      }));
      const { values, missing } = await resolveAll(who.userId, entries);
      console.info(
        `[declared-variables] local tool "${manual.path}" resolved for user=${who.userId}: ` +
          `provided=[${Object.keys(values).join(',')}] missing=[${missing.join(',')}]`,
      );
      res.set('Cache-Control', 'no-store').json({ name: manual.name, variables: values, missing });
    } catch (err) {
      console.error('[declared-variables] local tool resolve failed:', err instanceof Error ? err.message : err);
      res.status(500).json({ error: 'Failed to resolve variables' });
    }
  });

  return router;
}
