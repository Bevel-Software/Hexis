import { createHash } from 'node:crypto';
import express, { type Request, type RequestHandler } from 'express';
import { logger } from '../shared/logging.js';
import type { ISkillService, SkillSummary } from '../modules/skills/skills.contract.js';
import type { IToolManualService } from '../modules/tool-manuals/tool-manuals.contract.js';
import '../modules/tool-auth/tool-auth.middleware.js'; // Express Request augmentation (req.toolAuth)

const log = logger('catalog-revision');

/**
 * A fingerprint of ONE caller's released catalog — every tool manual and every
 * skill the default branch serves them, right now.
 *
 * It exists for a client that holds a long-lived connection and cannot be told
 * anything: the local `hexis-mcp` server. The hosted endpoint is stateless, so
 * every request there already rebuilds its surface from the live registry
 * (`mcp.routes.stateless.test.ts` pins that). A process on someone's laptop
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
 * A skill's line: everything `list_skills` shows about it on an AGENT
 * surface. Not `plugins`, which only the browser route decorates onto the
 * catalog — a field no agent-facing listing carries cannot be a change one
 * owes a refresh for.
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
): string {
  const lines = [
    ...[...manuals].sort(),
    '\u0001', // separates the two lists, so a line can never migrate between them
    ...skills.map(skillFingerprint).sort(),
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
  /** Connection-key/internal-token user id → email, for the per-caller ACL. */
  resolveUserEmail: (userId: string) => Promise<string | undefined>;
}): express.Router {
  const router = express.Router();

  router.get('/agent/catalog-revision', deps.manualAuth, async (req: Request, res) => {
    try {
      const userId = req.toolAuth?.userId;
      const email = userId ? await deps.resolveUserEmail(userId).catch(() => undefined) : undefined;
      // No resolvable caller is an EMPTY catalog, not a failure: that is what
      // both list surfaces answer such a caller, so the fingerprint agrees
      // with them rather than inventing a third verdict.
      const [manuals, skills] = email
        ? await Promise.all([deps.toolManuals.catalogFingerprints(email), deps.skills.listSkills(email)])
        : [[], []];
      res.json({
        revision: catalogRevision(manuals, skills),
        tools: manuals.length,
        skills: skills.length,
      });
    } catch (err) {
      log.error('catalog-revision failed:', { err });
      res.status(500).json({ error: 'Failed to read the catalog' });
    }
  });

  return router;
}
