import { readFileSync } from 'node:fs';
import express from 'express';
import { describe, expect, it } from 'vitest';
import { inputSchemaDefect } from '@bevel-software/platform-mcp-core';
import { ToolRegistry } from '../tool-registry.js';
import { registerWorkflowTools } from '../../workflow/agent-tools/workflow.tools.js';
import { registerChangeRequestReadTools } from '../../workflow/agent-tools/change-request-read.tools.js';
import { registerWorkspaceTools } from '../../workspace/workspace.tools.js';
import { registerSkillsTools } from '../../skills/skills.tools.js';
import { registerPluginsTools } from '../../plugins/plugins.tools.js';
import { registerToolManualsTools } from '../../tool-manuals/tool-manuals.tools.js';
import { registerAgentGuideTool } from '../../agent-guide/agent-guide.tools.js';
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
 * with no caller context, which is their static form).
 *
 * Add a tool module to the server and this test FAILS until it is added here:
 * `covers every tool module the server registers` reads the server's own source
 * and compares the `register…Tools` calls in it with `MODULES` below. A test
 * that silently skipped a whole module's schemas would be worse than no test,
 * because it would read as if it had checked them.
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

const pass: express.RequestHandler = (_req, _res, next) => next();
const handler = (() => pass) as never;

/** Where the server registers its tool modules — read, not imported, see below. */
const CORE_SERVER_SOURCE = new URL('../../../core/create-core-server.ts', import.meta.url);

/** Every tool-registering module, by the name the server calls it under. */
const MODULES: ReadonlyArray<{ name: string; register: (registry: ToolRegistry) => void }> = [
  {
    name: 'registerWorkflowTools',
    register: (registry) => registerWorkflowTools(registry, express.Router(), pass, handler, testKbContext()),
  },
  {
    name: 'registerChangeRequestReadTools',
    register: (registry) =>
      registerChangeRequestReadTools(registry, express.Router(), pass, handler, nothing, testKbContext()),
  },
  {
    name: 'registerWorkspaceTools',
    register: (registry) =>
      registerWorkspaceTools(
        registry,
        express.Router(),
        pass,
        handler,
        nothing,
        nothing,
        nothing,
        testKbContext(),
        { recoveryBotEmail: 'recovery@bevel.software', hooks: nothing, notes: new ToolDescriptionNotes() },
        nothing,
        nothing,
        undefined,
        undefined,
        // The upload store: the two upload tools are mounted only when one is
        // supplied, and the server supplies one — so this harness does too,
        // or their schemas would be the two it silently never checked.
        nothing,
      ),
  },
  {
    name: 'registerSkillsTools',
    register: (registry) => registerSkillsTools(registry, express.Router(), pass, handler, nothing),
  },
  { name: 'registerPluginsTools', register: (registry) => registerPluginsTools(registry) },
  {
    name: 'registerToolManualsTools',
    register: (registry) =>
      registerToolManualsTools(registry, express.Router(), pass, handler, nothing, {
        accessControl: nothing,
        variableStatus: nothing,
        kb: testKbContext(),
      }),
  },
  {
    // The one module registering a single tool: a provider on both surfaces,
    // built from the sections the reader answers — none here, which still
    // builds the def.
    name: 'registerAgentGuideTool',
    register: (registry) => registerAgentGuideTool(registry, express.Router(), pass, handler, async () => []),
  },
];

async function toolsOf(modules: ReadonlyArray<(typeof MODULES)[number]>) {
  const registry = new ToolRegistry();
  for (const module of modules) module.register(registry);
  // Both surfaces: the external one is what reaches a connected AI client, the
  // internal one is what the in-app agent calls. Either can carry a bad schema.
  return [...(await registry.listExternal()), ...(await registry.listInternal())];
}

const allOwnTools = () => toolsOf(MODULES);

describe("Hexis's own tool schemas", () => {
  /**
   * The harness's own guard, and the reason it reads a source file: nothing in
   * the registry can tell this test about a module nobody registered. A count
   * cannot either — a new module leaves it larger either way. The server's call
   * list can, and it is the only place that knows the whole set.
   */
  it('covers every tool module the server registers', () => {
    const source = readFileSync(CORE_SERVER_SOURCE, 'utf8');
    // `register…Tools` and `register…Tool` alike: a module registering one
    // tool is a module whose schema this harness must check too.
    const registered = [...source.matchAll(/\b(register\w+Tools?)\s*\(/g)].map((m) => m[1]);
    expect([...new Set(registered)].sort()).toEqual(MODULES.map((m) => m.name).sort());
  });

  it.each(MODULES.map((m) => [m.name, m] as const))('%s contributes tools to check', async (_name, module) => {
    // A module that registers nothing — a renamed registry method, a provider
    // that threw away its defs — would otherwise pass every assertion below
    // while exercising nothing.
    expect(await toolsOf([module])).not.toEqual([]);
  });

  it('declares valid JSON Schema for every tool, on both surfaces', async () => {
    const defects = (await allOwnTools())
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
