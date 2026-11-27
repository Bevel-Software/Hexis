import express, { type Request, type RequestHandler } from 'express';
import { UtcpManualSerializer } from '@utcp/sdk';
import { declaresWrite, type IToolRegistry, type ToolManualContext, type UtcpTool } from './tool.contract.js';
import { createCallerScope, requireInternalSource, type ReadCaller } from '../tool-auth/index.js';
import type { IAgentScopeResolver } from '../agent-scope/index.js';
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
/** Builds the per-caller context a `ToolProvider` words its def from. */
function contextBuilder(resolveUserEmail?: ResolveUserEmail, agentScope?: Pick<IAgentScopeResolver, 'resolve'>) {
  // Resolve the caller's email so a `ToolProvider` (e.g. the skill tools) can
  // tailor its def to who's asking. Best-effort — a failure just yields a
  // context without one.
  const callerScope = createCallerScope({ resolveUserEmail: resolveUserEmail ?? (async () => undefined), agentScope });
  return async function context(caller: ReadCaller): Promise<ToolManualContext> {
    const userId = caller.userId;
    if (!userId) return {};
    const { email: userEmail, scope } = await callerScope(caller);
    // Everything adds nothing to the context, so its providers are asked
    // exactly what they were asked before connections could be narrowed.
    return {
      userId,
      ...(userEmail !== undefined ? { userEmail } : {}),
      ...(caller.agentPath ? { connectionScope: scope } : {}),
    };
  };
}

/**
 * Reads one caller's external manual: the platform's own tools as
 * `GET /agent/utcp` serves them. The composition root builds one and hands it
 * to the route below and to the hosted MCP endpoint, which calls it directly
 * (`McpProxyOptions.readPlatformManual`) when it discovers the platform's
 * tools for a caller's surface: one reader, so the two cannot answer
 * differently.
 *
 * Called directly, and not over HTTP, for the reason the catalog revision is
 * (`core/catalog-revision.ts`): the endpoint and this code are one process, and
 * a request the server sends itself waits on the event loop it is already
 * running on, behind a limit of its own.
 */
export function createExternalManualReader(
  registry: IToolRegistry,
  resolveUserEmail?: ResolveUserEmail,
  readOnlyHints?: Pick<IToolReadOnlyHints, 'apply'>,
  agentScope?: Pick<IAgentScopeResolver, 'resolve'>,
): (caller: ReadCaller) => Promise<ReturnType<typeof toManual>> {
  const context = contextBuilder(resolveUserEmail, agentScope);
  return async (caller) => {
    const ctx = await context(caller);
    const tools = await registry.listExternal(ctx);
    // A connection made as an agent configuration is offered only the platform
    // tools that file loads; a call to another is refused at its route.
    const scope = ctx.connectionScope;
    const offered = scope ? tools.filter((t) => scope.allowsPlatformTool(t.name)) : tools;
    return toManual(readOnlyHints ? readOnlyHints.apply(offered) : offered);
  };
}

export function createManualRoutes(
  registry: IToolRegistry,
  manualAuth: RequestHandler,
  resolveUserEmail?: ResolveUserEmail,
  /**
   * The read-only hints (`read-only-hints.ts`), put on the AGENT manual's tools
   * as the `read-only` tag the hosted MCP endpoint turns into
   * `annotations.readOnlyHint` — the built-in value; the endpoint joins an
   * admin's override on at listing time. Read only by the reader the route
   * makes when it is handed none (`readExternalManual`): absent then, the
   * manual carries the tools' own tags only. A reader handed in applies its own.
   */
  readOnlyHints?: Pick<IToolReadOnlyHints, 'apply'>,
  /**
   * Resolves the scope of a connection made as an agent configuration: the
   * providers word their descriptions for it, and the reader the route makes
   * when it is handed none lists only the platform tools it loads
   * (`modules/agent-scope`). A reader handed in narrows by its own.
   */
  agentScope?: Pick<IAgentScopeResolver, 'resolve'>,
  /**
   * The reader `GET /agent/utcp` answers with. The composition root passes the
   * one it also hands the MCP endpoint, so the route and the endpoint cannot
   * answer differently. Absent, the route reads through the services above.
   */
  readExternalManual: ReturnType<typeof createExternalManualReader> = createExternalManualReader(
    registry,
    resolveUserEmail,
    readOnlyHints,
    agentScope,
  ),
): express.Router {
  const router = express.Router();

  // The per-caller context, built once per request.
  const contextOf = contextBuilder(resolveUserEmail, agentScope);
  const context = (req: Request): Promise<ToolManualContext> =>
    contextOf({ userId: req.toolAuth?.userId, agentPath: req.toolAuth?.agentPath });

  router.get('/agent/utcp', manualAuth, async (req, res) => {
    res.json(await readExternalManual({ userId: req.toolAuth?.userId, agentPath: req.toolAuth?.agentPath }));
  });
  router.get('/agent/internal/utcp', manualAuth, requireInternalSource, async (req, res) => {
    const internal = await registry.listInternal(await context(req));
    const tools = req.toolAuth?.scope === 'read' ? internal.filter((t) => !declaresWrite(t)) : internal;
    res.json(toManual(tools));
  });

  return router;
}
