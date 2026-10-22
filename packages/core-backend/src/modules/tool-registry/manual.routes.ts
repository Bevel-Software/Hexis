import express, { type Request, type RequestHandler } from 'express';
import { UtcpManualSerializer } from '@utcp/sdk';
import { declaresWrite, type IToolRegistry, type ToolManualContext, type UtcpTool } from './tool.contract.js';
import { requireInternalSource } from '../tool-auth/index.js';
import type { IToolReadOnlyHints } from './read-only-hints.contract.js';

/** Resolve a connection-key/internal-token user id to its email (for per-caller provider defs). */
export type ResolveUserEmail = (userId: string) => Promise<string | undefined>;

const manualSerializer = new UtcpManualSerializer();

/**
 * Serialize a catalog slice into a UTCP manual. The manual is the registry's
 * exposure format, so the version pins (`utcp_version` / `manual_version`) live
 * right here at the endpoint — bump them when the served spec format changes.
 * Each tool already carries its own `tool_call_template`, so this is otherwise a
 * thin wrapper.
 */
function toManual(tools: UtcpTool[]) {
  return manualSerializer.validateDict({
    utcp_version: '1.1.0',
    manual_version: '1.0.0',
    tools,
  });
}

/**
 * The two discovery endpoints — dynamically-built UTCP specs over the catalog:
 *   GET /agent/utcp           — external tools (pipeline-agent, MCP proxy)
 *   GET /agent/internal/utcp  — internal tools (our agent's code-mode client)
 *
 * Both are gated by `manualAuth` — a read-only superset of `toolAuth` that also
 * accepts a browser JWT (`source: 'session'`) so a logged-in user can browse the
 * catalog with their session; tool EXECUTION routes keep the strict `toolAuth`,
 * so a JWT can read the manual but never invoke a tool. The internal catalog
 * additionally requires `requireInternalSource`, so neither an external
 * connection key nor a browser session can enumerate the internal tool surface.
 * Both must mount BEFORE the JWT-protected `/api` mounts (Express fires the outer
 * JWT middleware before route matching otherwise). The catalog is resolved **per
 * request** (`registry.list*` awaits any `ToolProvider`s), so a tool whose def is
 * built lazily — e.g. the skill tools, whose description names the current skills
 * — stays current without a restart. Static tools resolve to the same def every
 * time, so this is cheap.
 *
 * The internal catalog is ALSO scope-filtered: a read-scoped caller (e.g. a
 * consumer persona's internal token) is served only the tools it can actually
 * invoke — write-tagged tools are dropped so its `list_tools`/manual never
 * advertises a tool that would 403 at call time. The call-time write-scope
 * refusal in `toolHandler` stays as the enforcement; this is least-information
 * on top of it. (External callers are always write-scoped, so the external
 * manual needs no variant.)
 */
export function createManualRoutes(
  registry: IToolRegistry,
  manualAuth: RequestHandler,
  resolveUserEmail?: ResolveUserEmail,
  /**
   * The read-only hints (`read-only-hints.ts`), put on the AGENT manual's tools
   * as the `read-only` tag the hosted MCP endpoint turns into
   * `annotations.readOnlyHint` — the built-in value; the endpoint joins an
   * admin's override on at listing time.
   * Absent, the manual carries the tools' own tags only.
   */
  readOnlyHints?: Pick<IToolReadOnlyHints, 'apply'>,
): express.Router {
  const router = express.Router();

  // Build the per-caller context once per request: resolve the caller's email
  // so a `ToolProvider` (e.g. the skill tools) can tailor its def to who's
  // asking. Best-effort — a failure just yields an empty (global) context.
  async function context(req: Request): Promise<ToolManualContext> {
    const userId = req.toolAuth?.userId;
    if (!userId) return {};
    if (!resolveUserEmail) return { userId };
    try {
      return { userId, userEmail: await resolveUserEmail(userId) };
    } catch {
      return { userId };
    }
  }

  router.get('/agent/utcp', manualAuth, async (req, res) => {
    const tools = await registry.listExternal(await context(req));
    res.json(toManual(readOnlyHints ? readOnlyHints.apply(tools) : tools));
  });
  router.get('/agent/internal/utcp', manualAuth, requireInternalSource, async (req, res) => {
    const internal = await registry.listInternal(await context(req));
    const tools = req.toolAuth?.scope === 'read' ? internal.filter((t) => !declaresWrite(t)) : internal;
    res.json(toManual(tools));
  });

  return router;
}
