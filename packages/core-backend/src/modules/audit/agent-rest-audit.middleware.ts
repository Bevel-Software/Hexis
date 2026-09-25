import type { RequestHandler } from 'express';
import { logger } from '../../shared/logging.js';
import type { IAgentEventRecorder } from './audit.contract.js';
import { classifyToolCall, skillReadPath, type SkillFolder } from './event-classifier.js';
import '../tool-auth/tool-auth.middleware.js'; // Express Request augmentation (req.toolAuth)

const log = logger('audit');

export interface AgentRestAuditDeps {
  recorder: IAgentEventRecorder;
  /** The registered name of the platform's own manual (`KNOWLEDGE_BASE`). */
  kbManualName: string;
  /** The caller's skill catalog, for telling a skill read from a file read; fetched only when a read names a path. */
  skillFolders: (userId: string) => Promise<readonly SkillFolder[]>;
}

/**
 * Records the REST tool calls the LOCAL server makes directly — the ones that
 * never pass through the hosted MCP endpoint, where every other call an agent
 * makes is recorded.
 *
 * hexis-mcp reaches the deployment two ways. Tool calls go through the
 * hosted `/api/mcp` as its remote manual, and the proxy records them there.
 * But the skill catalog and a skill's body are read straight off the REST
 * surface (`list_skills`, `get_skill`, `list_local_tools`, …) with the
 * internal token the server exchanged its grant for — so a person loading a
 * skill as a slash command in Claude Code through the local server left no
 * `skill` event, while the same read through the hosted endpoint did.
 *
 * WHICH calls are recorded here is decided by the credential, not the route:
 * only an `externalProxy` token that names an agent connection — the
 * exchanged grant — is recorded. The hosted proxy's own loopback tokens name
 * none, so a call the proxy has already recorded is never counted twice;
 * and a connection key reaching REST directly is indistinguishable from the
 * proxy passing that same key through, so keys stay recorded at the proxy
 * alone. The rule is the credential's shape, which no caller chooses.
 *
 * Mounted in front of every `/agent/tools/:name` route and judging on
 * `finish`, when the route's own auth has run and the status is known: a 2xx
 * is `ok`, anything else `error`. Never on the tool's critical path — the
 * classification (and the skill catalog it may need) runs after the answer
 * has gone out.
 */
export function createAgentRestAuditMiddleware(deps: AgentRestAuditDeps): RequestHandler {
  return (req, res, next) => {
    const started = performance.now();
    // Read NOW: `req.params` is rewritten for each layer Express matches, and
    // by `finish` it is the route's own (empty) set, not this mount's.
    const name = String(req.params.name ?? '');
    res.on('finish', () => {
      const auth = req.toolAuth;
      if (!auth || auth.source !== 'external' || !auth.connectionId) return;
      if (!name) return;
      const durationMs = Math.max(0, Math.round(performance.now() - started));
      const outcome = res.statusCode < 400 ? 'ok' : 'error';
      const args = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
      const utcpName = `${deps.kbManualName}.${name}`;
      const ctx = { kbManualName: deps.kbManualName, catalogNames: new Map<string, string>() };
      const record = (skills: readonly SkillFolder[] | null) => {
        try {
          deps.recorder.record({
            userId: auth.userId,
            principal: { kind: 'agent', id: auth.connectionId! },
            ...classifyToolCall(utcpName, args, ctx, skills),
            outcome,
            durationMs,
          });
        } catch (err) {
          log.warn('recording a REST agent event failed:', { err });
        }
      };
      if (skillReadPath(utcpName, args, deps.kbManualName) === null) {
        record(null);
        return;
      }
      deps.skillFolders(auth.userId).then(record, (err) => {
        log.warn('skill catalog unavailable for audit classification:', { err });
        record(null);
      });
    });
    next();
  };
}
