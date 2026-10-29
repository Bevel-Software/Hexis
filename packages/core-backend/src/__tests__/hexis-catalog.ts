import express from 'express';
import { codeModeMetaTools } from '@bevel-software/platform-mcp-core';
import { testKbContext } from './kb-context.js';
import { EXTERNAL_KB_MANUAL_NAME } from '../modules/tool-manuals/tool-manuals.contract.js';
import { ToolRegistry } from '../modules/tool-registry/tool-registry.js';
import type { UtcpTool } from '../modules/tool-registry/tool.contract.js';
import { createToolHandlerFactory } from '../modules/tool-helpers/tool-handler.js';
import type { ToolAuth } from '../modules/tool-auth/tool-auth.middleware.js';
import { registerWorkspaceTools } from '../modules/workspace/workspace.tools.js';
import { RipgrepPatternMatcher } from '../modules/workspace/index.js';
import { registerVersionControlTools } from '../modules/version-control/agent-tools/version-control.tools.js';
import { registerPluginsTools } from '../modules/plugins/plugins.tools.js';
import { registerSkillsTools } from '../modules/skills/skills.tools.js';
import { registerToolManualsTools } from '../modules/tool-manuals/tool-manuals.tools.js';
import { ToolDescriptionNotes } from '../modules/workspace/agent-access.gate.js';
import { VersionControlHooks } from '../modules/version-control/version-control-hooks.js';
import { UuidSessionSink } from '../modules/workspace/session-sink.js';
import { RoutineWritePolicyService } from '../modules/workspace/routine-write-policy.js';
import { guideFirstDescription } from '../modules/tool-registry/guide-first.js';
import { registerAgentGuideTool } from '../modules/agent-guide/agent-guide.tools.js';
import { agentGuideSections } from '../modules/agent-guide/agent-guide.js';

/**
 * The tool catalog Hexis itself registers, built on stand-ins for the tests
 * that read what an agent is TOLD: the description caps, the guide checks and
 * the guide's budgets. Every registrar Hexis owns is mounted, because the
 * definitions are the only thing under test: a stand-in that is never called
 * is honest about that. Tools PROXIED from connected MCP servers are not here:
 * their text is the other server's.
 */

/** Dependencies the registrars take but never touch while they are only building defs. */
export const unused = <T,>(): T => ({}) as T;

/** A `.tool` catalog with nothing in it: the shortest honest answer for a listing. */
const emptyManuals = {
  listLocalOnly: async () => [],
  listAll: async () => [],
  list: async () => [],
  listInvalid: async () => [],
} as unknown as Parameters<typeof registerToolManualsTools>[4];

/** A skill catalog with nothing in it — the per-user skill line is then one fixed sentence. */
export const emptySkills = { listSkills: async () => [] } as unknown as Parameters<typeof registerSkillsTools>[4];

/**
 * The meta-tools as the hosted endpoint builds them (`mcp.service.ts`):
 * examples written against the namespace it registers the knowledge-base tools
 * under and against the catalog it serves, and the chain without the rules it
 * states only in the shared places. So the chain description measured here
 * carries the worked call a client is really sent, which is its longest form.
 */
export function servedMetaTools(external: readonly UtcpTool[]) {
  return codeModeMetaTools(
    EXTERNAL_KB_MANUAL_NAME,
    external.map((t) => ({ utcpName: `${EXTERNAL_KB_MANUAL_NAME}.${t.name}`, inputSchema: t.inputs })),
    { sharedRulesPointer: '' },
    // As the hosted endpoint serves them: opening with the guide-first
    // sentence, through the one helper the endpoint itself uses.
  ).map((t) => ({ ...t, description: guideFirstDescription(t.description) }));
}

/**
 * Every tool Hexis itself registers, by surface: what the in-process agent is
 * handed, what the hosted endpoint lists to an MCP client, and the three
 * meta-tools it lists beside them.
 */
export async function hexisCatalog(
  skills: Parameters<typeof registerSkillsTools>[4] = emptySkills,
): Promise<{ internal: UtcpTool[]; external: UtcpTool[]; metaTools: ReturnType<typeof servedMetaTools> }> {
  const registry = new ToolRegistry();
  const router = express.Router();
  const toolAuth = ((_req, _res, next) => next()) as unknown as ToolAuth;
  const toolHandler = createToolHandlerFactory(unused());
  const kb = testKbContext();
  const gate = { recoveryBotEmail: 'bot@x', hooks: new VersionControlHooks(), notes: new ToolDescriptionNotes() };

  registerWorkspaceTools(
    registry,
    router,
    toolAuth,
    toolHandler,
    unused(),
    unused(),
    unused(),
    kb,
    gate,
    new RoutineWritePolicyService(),
    new UuidSessionSink(),
    undefined,
    undefined,
    // The two upload tools are mounted only when a store is supplied, and
    // every real composition supplies one: without it they would be the two
    // descriptions this suite never measured.
    unused(),
    // The guide reader, not needed to build defs; then the download store,
    // mounted on the same terms as the upload one.
    undefined,
    unused(),
    // Starter packs and the tree walk, not needed; then the grep matcher,
    // mounted on the same terms (it spawns no worker until a search runs).
    undefined,
    undefined,
    new RipgrepPatternMatcher(),
  );
  registerVersionControlTools(registry, router, toolAuth, toolHandler, kb, async () => true, { canRead: async () => true, canReadAtRef: async () => true, canReadBatch: async () => new Map(), canReadBatchAtRef: async () => new Map(), canWrite: async () => true } as never, { recoveryBotEmail: 'recovery@x', hooks: { runAgentRead: async () => undefined }, notes: { onChange: () => undefined } } as never);
  registerPluginsTools(registry, kb);
  registerSkillsTools(registry, router, toolAuth, toolHandler, skills);
  registerToolManualsTools(registry, router, toolAuth, toolHandler, emptyManuals, {
    accessControl: unused(),
    variableStatus: unused(),
    kb,
  });
  // The guide's own tool, with the platform's sections: the one description
  // that lists the sections is measured with the list it really carries.
  registerAgentGuideTool(registry, router, toolAuth, toolHandler, () => agentGuideSections(kb.layout));

  // The meta-tools as a client is served them (`mcp.service.ts` opens each
  // with the guide-first sentence at the mount), so the catalog measured here
  // is the catalog that goes out rather than the bare constant.
  const external = (await registry.listExternal()) as UtcpTool[];
  return { internal: (await registry.listInternal()) as UtcpTool[], external, metaTools: servedMetaTools(external) };
}

/** Every tool Hexis itself registers, on both surfaces, deduplicated by name. */
export async function hexisTools(skills: Parameters<typeof registerSkillsTools>[4] = emptySkills): Promise<UtcpTool[]> {
  const { internal, external, metaTools } = await hexisCatalog(skills);
  const byName = new Map<string, UtcpTool>();
  for (const tool of [...internal, ...external, ...metaTools]) byName.set(tool.name, tool as UtcpTool);
  return [...byName.values()];
}
