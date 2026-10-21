import { createHash } from 'node:crypto';
import express, { type Request, type RequestHandler } from 'express';
import { logger } from '../shared/logging.js';
import type { ISkillService, SkillSummary } from '../modules/skills/skills.contract.js';
import type { IToolManualService } from '../modules/tool-manuals/tool-manuals.contract.js';
import '../modules/tool-auth/tool-auth.middleware.js'; // Express Request augmentation (req.toolAuth)
import { resolveConnectionScope, type IAgentScopeResolver } from '../modules/agent-scope/index.js';

const log = logger('catalog-revision');

/**
 * A fingerprint of ONE caller's released catalog — every tool manual and every
 * skill the default branch serves them, right now.
 *
 * It exists for a client that holds a long-lived connection and cannot be told
 * anything: the local `hexis-mcp` server. The hosted endpoint reads it too, on
 * every request, to pick the caller's cached tool client: a new revision is a
 * new build (`mcp.surface-cache.test.ts` pins that). A process on someone's laptop
 * registered the deployment's manual ONCE, at startup, and would otherwise
 * serve that startup's toolset until it is restarted. Polling this tells it —
 * cheaply, and without a second way for the catalogs to be read — exactly when
 * that toolset stopped being the current one.
 *
 * Why a fingerprint and not a counter: the caches are dropped by any
 * default-branch write (`catalog-cache-invalidation.ts` sees `fs-tree-changed`,
 * which carries no paths), so a bump-per-invalidation would have every note
 * anyone saves re-registering an MCP session on every connected laptop. This
 * changes when the CATALOG changed, and a poller that re-registers on it is
 * doing work that was actually owed.
 */

/**
 * A skill's line: what `list_skills` shows about the skill ITSELF on an AGENT
 * surface. Not `plugins`, which only the browser route decorates onto the
 * catalog — a field no agent-facing listing carries cannot be a change one
 * owes a refresh for. Not `canWrite` either: it is a verdict about the caller,
 * judged per call by the tool, not part of the skill, and it is never on the
 * summaries this digest reads.
 */
function skillFingerprint(s: SkillSummary): string {
  return [s.name, s.path, s.version ?? '', s.description].join('\u0000');
}

/**
 * The revision of a caller's catalog: a hex digest over the two lists.
 *
 * The manual half arrives already reduced to one opaque line per manual
 * (`IToolManualService.catalogFingerprints`), because what makes a manual
 * "the same manual" includes the bytes of the file it was parsed from — a
 * `.tool` that keeps its name and description while changing its `url`, its
 * headers or an inline manual's embedded tools is a DIFFERENT callable thing,
 * and a client holding the old one has to be told. That digest is the tool
 * catalog's own business, so it is computed there rather than reconstructed
 * from a summary here.
 *
 * SORTED before hashing, so a reordering is not a change — the scans sort
 * already, but a dedupe or an access filter could reshuffle what survives, and
 * "the same set in another order" is not something a client owes a refresh for.
 */
export function catalogRevision(
  manuals: readonly string[],
  skills: readonly SkillSummary[],
  /**
   * The MCP App views this deployment serves, by their bytes: a release that
   * changes a view and nothing else must still move the revision, or a local
   * server already running keeps serving the view it read at startup.
   */
  views: readonly { uri: string; text: string }[] = [],
  /**
   * The connection's agent file — its path and the digest of its bytes, or
   * why it cannot be used (`ConnectionScope.fingerprint`) — so an edit of
   * the file is a new revision even when it changes nothing listed (a new
   * skill entry that names nothing yet still moves it). Absent for
   * Everything, whose revision is exactly what it was before agents existed.
   */
  agent: string | null = null,
): string {
  const lines = [
    ...[...manuals].sort(),
    '\u0001', // separates the lists, so a line can never migrate between them
    ...skills.map(skillFingerprint).sort(),
    '\u0001',
    ...views.map((v) => `${v.uri}\u0000${createHash('sha256').update(v.text).digest('hex')}`).sort(),
    ...(agent !== null ? ['\u0001', agent] : []),
  ];
  return createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 32);
}

/**
 * `GET /agent/catalog-revision` — the caller's catalog fingerprint, plus the
 * two counts behind it so an operator reading a log can tell a shrinking
 * catalog from a growing one.
 *
 * Mounted on the tools router behind the same `manualAuth` as `/agent/all-tools`,
 * and it tells the caller nothing that route does not already: it is a digest
 * of what they may read, per-caller, ACL-filtered by the two services
 * themselves.
 */
export function createCatalogRevisionRoutes(deps: {
  toolManuals: Pick<IToolManualService, 'catalogFingerprints'>;
  skills: Pick<ISkillService, 'listSkills'>;
  manualAuth: RequestHandler;
  /** Resolves the scope of a connection made as an `.agent` file (`modules/agent-scope`). */
  agentScope?: Pick<IAgentScopeResolver, 'resolve'>;
  /** Connection-key/internal-token user id → email, for the per-caller ACL. */
  resolveUserEmail: (userId: string) => Promise<string | undefined>;
  /** The MCP App views served; absent on a deployment that serves none. */
  mcpApps?: { manifest(): Promise<{ resources: readonly { uri: string; text: string }[] }> };
}): express.Router {
  const router = express.Router();

  router.get('/agent/catalog-revision', deps.manualAuth, async (req: Request, res) => {
    try {
      const userId = req.toolAuth?.userId;
      const email = userId ? await deps.resolveUserEmail(userId).catch(() => undefined) : undefined;
      // No resolvable caller is an EMPTY catalog, not a failure: that is what
      // both list surfaces answer such a caller, so the fingerprint agrees
      // with them rather than inventing a third verdict.
      // A connection made as an `.agent` file is fingerprinted over what IT
      // loads, plus the file itself; Everything asks exactly what it always did.
      const scope = await resolveConnectionScope(deps.agentScope, email, req.toolAuth?.agentPath);
      const connectors = scope.connectorFilter();
      const within = scope.skillFilter();
      const [manuals, skills] = email
        ? await Promise.all([
            connectors ? deps.toolManuals.catalogFingerprints(email, connectors) : deps.toolManuals.catalogFingerprints(email),
            within ? deps.skills.listSkills(email, { within }) : deps.skills.listSkills(email),
          ])
        : [[], []];
      // A manifest that cannot be read counts as no views, which is also what
      // the MCP endpoint serves in that state.
      const views = deps.mcpApps ? ((await deps.mcpApps.manifest().catch(() => null))?.resources ?? []) : [];
      const connection = scope.toWire();
      res.json({
        revision: catalogRevision(manuals, skills, views, scope.fingerprint()),
        tools: manuals.length,
        skills: skills.length,
        ...(connection ? { connection } : {}),
      });
    } catch (err) {
      log.error('catalog-revision failed:', { err });
      res.status(500).json({ error: 'Failed to read the catalog' });
    }
  });

  return router;
}
