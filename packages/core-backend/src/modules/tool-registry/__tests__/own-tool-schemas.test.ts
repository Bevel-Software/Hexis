import express from 'express';
import { describe, expect, it } from 'vitest';
import { inputSchemaDefect } from '@bevel-software/platform-mcp-core';
import { ToolRegistry } from '../tool-registry.js';
import { registerWorkflowTools } from '../../workflow/agent-tools/workflow.tools.js';
import { registerWorkspaceTools } from '../../workspace/workspace.tools.js';
import { registerSkillsTools } from '../../skills/skills.tools.js';
import { registerPluginsTools } from '../../plugins/plugins.tools.js';
import { registerToolManualsTools } from '../../tool-manuals/tool-manuals.tools.js';
import { ToolDescriptionNotes } from '../../workspace/agent-access.gate.js';
import { testKbContext } from '../../../__tests__/kb-context.js';

/**
 * Every tool Hexis declares itself, checked against the same JSON Schema rules
 * a connected server's tool is checked against.
 *
 * Hexis hides a connected tool whose input schema is invalid, because an AI
 * client would otherwise drop it in silence. The platform's own tools go to
 * those same clients through those same surfaces, so a mistake in one of these
 * schemas costs the tool just as quietly — and it would be Hexis's mistake.
 * This test is the thing that makes shipping one impossible.
 *
 * It registers the DEFS as `create-core-server` does, with stubs for the
 * services (no def-building path touches one: the lazy providers are resolved
 * with no caller context, which is their static form). Add a tool module to
 * the server and add it here; a missing one shows up as a tool count that
 * stopped growing.
 */

/**
 * A stub service: every method answers with an empty list. The def-building
 * paths that do reach a service only ask it what exists (which skills, which
 * local-only tools) to name them in a description, and "none" is a valid
 * answer that keeps the SCHEMAS — what this test is about — untouched.
 * `then` is excluded so the stub is never mistaken for a promise.
 */
const nothing = new Proxy(
  {},
  {
    get: (_target, key) => (key === 'then' ? undefined : async () => []),
  },
) as never;

async function allOwnTools() {
  const registry = new ToolRegistry();
  const router = express.Router();
  const pass: express.RequestHandler = (_req, _res, next) => next();
  const handler = (() => pass) as never;
  const kb = testKbContext();

  registerWorkflowTools(registry, router, pass, handler, kb);
  registerWorkspaceTools(
    registry,
    router,
    pass,
    handler,
    nothing,
    nothing,
    nothing,
    kb,
    { recoveryBotEmail: 'recovery@bevel.software', hooks: nothing, notes: new ToolDescriptionNotes() },
    nothing,
    nothing,
  );
  registerSkillsTools(registry, router, pass, handler, nothing);
  registerPluginsTools(registry);
  registerToolManualsTools(registry, router, pass, handler, nothing, {
    accessControl: nothing,
    variableStatus: nothing,
    kb,
  });

  // Both surfaces: the external one is what reaches a connected AI client, the
  // internal one is what the in-app agent calls. Either can carry a bad schema.
  return [...(await registry.listExternal()), ...(await registry.listInternal())];
}

describe("Hexis's own tool schemas", () => {
  it('declares valid JSON Schema for every tool, on both surfaces', async () => {
    const tools = await allOwnTools();
    // A guard on the harness itself: an empty list would pass every assertion
    // below and prove nothing.
    expect(tools.length).toBeGreaterThan(20);
    const defects = tools
      .map((tool) => ({ tool: tool.name, defect: inputSchemaDefect(tool.inputs) }))
      .filter((entry) => entry.defect !== null);
    // Named, not counted: a failure has to say WHICH tool and WHERE.
    expect(defects).toEqual([]);
  });

  it('declares an object schema for every tool, as MCP requires of an input schema', async () => {
    const notObjects = (await allOwnTools())
      .filter((tool) => (tool.inputs as { type?: unknown }).type !== 'object')
      .map((tool) => tool.name);
    expect(notObjects).toEqual([]);
  });
});
