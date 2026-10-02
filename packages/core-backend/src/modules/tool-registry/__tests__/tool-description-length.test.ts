import express from 'express';
import { describe, expect, it } from 'vitest';
import { CODE_MODE_META_TOOLS } from '@bevel-software/platform-mcp-core';
import { testKbContext } from '../../../__tests__/kb-context.js';
import { ToolRegistry } from '../tool-registry.js';
import type { UtcpTool } from '../tool.contract.js';
import { createToolHandlerFactory } from '../../tool-helpers/tool-handler.js';
import type { ToolAuth } from '../../tool-auth/tool-auth.middleware.js';
import { registerWorkspaceTools } from '../../workspace/workspace.tools.js';
import { registerWorkflowTools } from '../../workflow/agent-tools/workflow.tools.js';
import { registerPluginsTools } from '../../plugins/plugins.tools.js';
import { registerSkillsTools } from '../../skills/skills.tools.js';
import { registerToolManualsTools } from '../../tool-manuals/tool-manuals.tools.js';
import { ToolDescriptionNotes } from '../../workspace/agent-access.gate.js';
import { WorkflowHooks } from '../../workflow/workflow-hooks.js';
import { UuidSessionSink } from '../../workspace/session-sink.js';
import { RoutineWritePolicyService } from '../../workspace/routine-write-policy.js';
import { TOOL_DESCRIPTION_CAP, clientVisibleLength } from '../description-length.js';
import { TOOL_PREFIX_CAP, sharedRulesPointer } from '../../agent-instructions/index.js';

/**
 * The cap exists because clients cut a long tool description, and they cut it
 * from the END — where the text specific to the tool sits. Agents reported
 * `file_stat`, `read_file`, `write_file` and `write_files` arriving as
 * "[truncated]". So this measures what a client is actually handed, and fails
 * NAMING the tool: the next paragraph someone appends to a description has to
 * answer to this test rather than to an agent's truncated catalog.
 *
 * Every registrar Hexis owns is mounted here, on stand-ins, because the
 * descriptions are the only thing under test: a stand-in that is never called
 * is honest about that. Tools PROXIED from connected MCP servers are not
 * measured — their text is the other server's.
 */

/** Dependencies the registrars take but never touch while they are only building defs. */
const unused = <T,>(): T => ({}) as T;

/** A `.tool` catalog with nothing in it: the shortest honest answer for a listing. */
const emptyManuals = {
  listLocalOnly: async () => [],
  listAll: async () => [],
  list: async () => [],
  listInvalid: async () => [],
} as unknown as Parameters<typeof registerToolManualsTools>[4];

/** A skill catalog with nothing in it — the per-user skill line is then one fixed sentence. */
const emptySkills = { listSkills: async () => [] } as unknown as Parameters<typeof registerSkillsTools>[4];

/** Every tool Hexis itself registers, on both surfaces, deduplicated by name. */
async function hexisTools(): Promise<UtcpTool[]> {
  const registry = new ToolRegistry();
  const router = express.Router();
  const toolAuth = ((_req, _res, next) => next()) as unknown as ToolAuth;
  const toolHandler = createToolHandlerFactory(unused());
  const kb = testKbContext();
  const gate = { recoveryBotEmail: 'bot@x', hooks: new WorkflowHooks(), notes: new ToolDescriptionNotes() };

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
  );
  registerWorkflowTools(registry, router, toolAuth, toolHandler, kb);
  registerPluginsTools(registry);
  registerSkillsTools(registry, router, toolAuth, toolHandler, emptySkills);
  registerToolManualsTools(registry, router, toolAuth, toolHandler, emptyManuals, {
    accessControl: unused(),
    variableStatus: unused(),
    kb,
  });

  const byName = new Map<string, UtcpTool>();
  for (const tool of [...(await registry.listInternal()), ...(await registry.listExternal()), ...CODE_MODE_META_TOOLS]) {
    byName.set(tool.name, tool as UtcpTool);
  }
  return [...byName.values()];
}

describe('no Hexis tool description is long enough to be cut', () => {
  it(`keeps every description a client is handed within ${TOOL_DESCRIPTION_CAP} characters`, async () => {
    const over = (await hexisTools())
      .map((t) => ({ tool: t.name, chars: clientVisibleLength(t) }))
      .filter((m) => m.chars > TOOL_DESCRIPTION_CAP)
      .sort((a, b) => b.chars - a.chars);
    // The message names the tool and its length, because "a description is too
    // long" sends the next reader back to measuring them by hand.
    expect(
      over,
      over.map((m) => `${m.tool}: ${m.chars} characters (cap ${TOOL_DESCRIPTION_CAP})`).join('\n'),
    ).toEqual([]);
  });

  it('measures a prefixed tool with the prefix a client sees, not without it', async () => {
    // The four knowledge-base tools carry the deployment's tool prefix ahead of
    // their description on the MCP surface — up to `TOOL_PREFIX_CAP` characters
    // the admin writes. A cap applied to the bare description would pass while
    // the catalog the agent reads was over it by 300.
    const read = (await hexisTools()).find((t) => t.name === 'read_file');
    expect(read).toBeDefined();
    expect(clientVisibleLength(read!)).toBe(read!.description!.length + TOOL_PREFIX_CAP + 2);
    expect(read!.description!.length + TOOL_PREFIX_CAP + 2).toBeLessThanOrEqual(TOOL_DESCRIPTION_CAP);
  });

  it('fails, naming the tool, when a paragraph takes a description over the cap', () => {
    const padded = { name: 'write_file', description: 'x'.repeat(TOOL_DESCRIPTION_CAP + 1) } as UtcpTool;
    expect(clientVisibleLength(padded)).toBeGreaterThan(TOOL_DESCRIPTION_CAP);
    // A tool with no description at all is not over the cap.
    expect(clientVisibleLength({ name: 'nothing' } as UtcpTool)).toBe(0);
  });

  it('measures the catalog, which is what a client lists — and says what is outside it', async () => {
    // The cap is about `tools/list`: a client cuts what it was sent. The ONE
    // long description this repository still writes is the in-process Mastra
    // `call_tool_chain`, which no client lists — the in-process agent is handed
    // it directly — and which OPENS with `@utcp/code-mode`'s own 2,500-character
    // usage guide, text this repository does not own. It is left as it is, on
    // purpose, and this assertion is what keeps that a stated fact rather than
    // an oversight: if it ever reaches the catalog, the cap test above measures
    // it like everything else.
    const { createCallToolChainTool } = await import('../../code-mode/code-mode.tool.js');
    const mastraTool = createCallToolChainTool(unused(), unused()) as unknown as { description: string };
    expect(mastraTool.description).toContain('UTCP CodeMode Tool Usage Guide');
    expect(mastraTool.description.length).toBeGreaterThan(TOOL_DESCRIPTION_CAP);
    expect((await hexisTools()).some((t) => t.description === mastraTool.description)).toBe(false);
  });
});

describe('every file tool ends with the pointer and carries no shared paragraph', () => {
  /** The tools that used to carry the shared paragraphs — every `mount`ed one. */
  const FILE_TOOLS = [
    'read_file',
    'list_files',
    'file_stat',
    'grep',
    'write_file',
    'write_files',
    'edit_file',
    'delete_file',
    'delete_folder',
    'mkdir',
    'move_file',
    'copy_file',
    'unzip',
    'execute_command',
  ];

  it('ends each description with the one sentence naming the shared rules', async () => {
    const tools = await hexisTools();
    const pointer = sharedRulesPointer(testKbContext().layout);
    for (const name of FILE_TOOLS) {
      const def = tools.find((t) => t.name === name);
      expect(def, name).toBeDefined();
      expect(def!.description!.endsWith(pointer), `${name} must end with: ${pointer}`).toBe(true);
      // Ends with a full sentence, so nothing reads as cut off mid-thought.
      expect(def!.description!.trimEnd().endsWith('.'), name).toBe(true);
    }
  });

  it('no longer repeats a shared paragraph inside a description', async () => {
    const tools = await hexisTools();
    // One recognisable fragment per rule that moved out. Searched across EVERY
    // Hexis description, not only the file tools: a rule that came back by
    // being pasted into a neighbouring tool is the same regression.
    const moved = [
      'Content rule (the same on every file tool)',
      'they refuse documents, images, archives and other binary files',
      '`mode` decides what may happen at a path and DEFAULTS TO',
      'Images: keep them in an `assets/` folder',
      'Escape sequences: some clients decode them in arguments',
      'If this is refused for permissions',
      'Before your first read or change in a workspace',
      'Do NOT set `confirm: true` on your first call',
    ];
    for (const fragment of moved) {
      const carriers = tools.filter((t) => (t.description ?? '').includes(fragment)).map((t) => t.name);
      expect(carriers, `"${fragment}" is a shared rule and belongs in the shared places only`).toEqual([]);
    }
  });
});
