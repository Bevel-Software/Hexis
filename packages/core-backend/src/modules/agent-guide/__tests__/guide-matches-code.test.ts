import fs from 'node:fs';
import {
  AGENTS_DIR,
  DATA_DIR,
  DEFAULT_KB_LAYOUT,
  FIXED_PLATFORM_FILE_NAMES,
  HEXIS_EXTENSION_NS,
  HEXIS_TOOLS_DIR,
  PERSONAL_PLUGIN_PREFIX,
  PIPELINES_DIR,
  PLUGIN_MANIFEST_FILE,
  PLUGIN_MCP_FILE,
  PLUGIN_SKILLS_DIR,
  PREAMBLE_FILE,
} from '@bevel-software/platform-shared';
import { describe, expect, it } from 'vitest';
import { hexisTools } from '../../../__tests__/hexis-catalog.js';
import { agentGuideDir } from '../../../assets.js';
import { GROUPS_YAML, SYNCED_GROUPS_YAML } from '../../access-model/index.js';
import { platformInstructions } from '../../agent-instructions/index.js';
import { BUNDLE_FILE } from '../../plugins/index.js';
import type { UtcpTool } from '../../tool-registry/index.js';
import {
  CORE_SECTION_IDS,
  START_HERE_SECTION_ID,
  WORKING_WITH_FILES_SECTION_ID,
  agentGuideSections,
  composeAgentGuide,
  coreAgentGuideSections,
} from '../agent-guide.js';

/**
 * The guide and the handshake instructions name tools, arguments, result
 * fields, folders and files. Each of those is a claim about the code, and the
 * code moves: a renamed tool or argument leaves the guide teaching a call that
 * is refused, which is exactly what an agent cannot tell from reading it. So
 * every name the text uses is checked against the tool registry Hexis builds
 * and against `kb-layout.ts`, and a mismatch fails here, naming the word and
 * the section, rather than in an agent's first call.
 *
 * What counts as a name is found by shape, in prose and inline code (fenced
 * blocks are examples of file formats and are left alone):
 *
 *  - a `snake_case` word must be a tool, or an argument or result field of one;
 *  - a `camelCase` word in inline code must be an argument or result field;
 *  - a call example, `tool({ … })` in inline code, must name a tool and only
 *    arguments it takes, with every required one.
 *
 * A word of that shape that is NOT the registry's (a YAML field of a `.tool`
 * file, an example id, a DOM API) is declared below with the reason. That list
 * is the price of catching the rest; an entry the text no longer uses fails
 * too, so it cannot outlive its reason.
 */
const NOT_THE_REGISTRYS: Readonly<Record<string, string>> = {
  // Refusal kinds and result stubs the content rule names; not schema fields.
  binary_not_writable: 'a refusal kind',
  image_omitted: 'the stub a chained image read yields',
  // Words about identifiers, and example identifiers in the manual format.
  snake_case: 'a naming style',
  serper_everyone: 'an example manual id',
  serper_finance: 'an example manual id',
  notion_search: 'an example of a connected server tool as a page calls it',
  // `.tool` and `plugin.json` fields: the file formats, not tool schemas.
  access_type: 'a Google sign-in parameter, in an `authParams` example',
  tool_call_template: 'a `.tool` field',
  call_template_type: 'a `.tool` field',
  mcpServers: 'a `plugin.json` / `mcp.json` key',
  clientId: 'an `oauth` block field',
  authorizationUrl: 'an `oauth` block field',
  tokenUrl: 'an `oauth` block field',
  authParams: 'an `oauth` block field',
  clientSecret: 'an `oauth` block field',
  // The page bridge and the DOM (checked against the renderer by
  // core-frontend's `htmlViewsGuide.test.ts`).
  openNode: '`window.bevel` member',
  requireTools: '`window.bevel` member',
  searchTools: '`window.bevel.tools` member',
  toolsInfo: '`window.bevel.tools` member',
  callTool: '`window.bevel.tools` member',
  callToolChain: '`window.bevel.tools` member',
  uploadFile: '`window.bevel.tools` member',
  getElementById: 'a DOM API',
  preventDefault: 'a DOM API',
  localStorage: 'a browser API',
  sessionStorage: 'a browser API',
};

/** Every property name a schema declares, at any depth. */
function propertyNames(schema: unknown, out = new Set<string>()): Set<string> {
  if (!schema || typeof schema !== 'object') return out;
  if (Array.isArray(schema)) {
    for (const s of schema) propertyNames(s, out);
    return out;
  }
  const s = schema as Record<string, unknown>;
  if (s.properties && typeof s.properties === 'object') {
    for (const [name, sub] of Object.entries(s.properties as Record<string, unknown>)) {
      out.add(name);
      propertyNames(sub, out);
    }
  }
  for (const key of ['items', 'anyOf', 'oneOf', 'allOf']) propertyNames(s[key], out);
  return out;
}

const inputsOf = (tool: UtcpTool): unknown => tool.inputs ?? (tool as { inputSchema?: unknown }).inputSchema;

/** Text without its fenced code blocks: those are examples of formats, not claims about tools. */
const prose = (markdown: string): string => markdown.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, '');

const inlineCode = (markdown: string): string[] => [...prose(markdown).matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!);

/** A call example's arguments, read as the JSON the inline code nearly is. */
function callArguments(text: string): Record<string, unknown> {
  return JSON.parse(text.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":')) as Record<string, unknown>;
}

async function texts(): Promise<Array<{ where: string; text: string }>> {
  const sections = await agentGuideSections(DEFAULT_KB_LAYOUT, undefined, { defaultBranch: 'main' });
  return [
    ...sections.map((s) => ({ where: `section "${s.id}"`, text: s.body })),
    { where: 'the handshake instructions', text: platformInstructions(DEFAULT_KB_LAYOUT) },
  ];
}

describe('the guide names only what the code has', () => {
  it('names tools, arguments and result fields that exist', async () => {
    const tools = await hexisTools();
    const known = new Set<string>(tools.map((t) => t.name));
    for (const tool of tools) {
      propertyNames(inputsOf(tool), known);
      propertyNames((tool as { outputs?: unknown }).outputs, known);
    }
    const unknown: string[] = [];
    const used = new Set<string>();
    for (const { where, text } of await texts()) {
      const words = [
        ...[...prose(text).matchAll(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g)].map((m) => m[0]),
        ...inlineCode(text).flatMap((code) => [...code.matchAll(/\b[a-z]+(?:[A-Z][a-z0-9]*)+\b/g)].map((m) => m[0])),
      ];
      for (const word of words) {
        if (word in NOT_THE_REGISTRYS) used.add(word);
        else if (!known.has(word)) unknown.push(`${where}: \`${word}\` is no tool, argument or result field`);
      }
    }
    expect([...new Set(unknown)], 'rename it in the text, or declare it in NOT_THE_REGISTRYS with why').toEqual([]);
    const stale = Object.keys(NOT_THE_REGISTRYS).filter((word) => !used.has(word));
    expect(stale, 'declared words the guide no longer uses').toEqual([]);
  });

  it('shows calls a tool would accept, with every required argument', async () => {
    const tools = new Map((await hexisTools()).map((t) => [t.name, t]));
    const problems: string[] = [];
    let examples = 0;
    for (const { where, text } of await texts()) {
      for (const code of inlineCode(text)) {
        const call = /^([a-z][a-z0-9_]*)\((\{.*\})\)$/.exec(code);
        if (!call) continue;
        examples += 1;
        const [, name, argsText] = call;
        const tool = tools.get(name!);
        if (!tool) {
          problems.push(`${where}: \`${code}\` calls \`${name}\`, which is no tool`);
          continue;
        }
        let args: Record<string, unknown>;
        try {
          args = callArguments(argsText!);
        } catch {
          problems.push(`${where}: \`${code}\` is not an argument object`);
          continue;
        }
        // A platform tool takes its arguments under `body`; check what the
        // example puts there against what the tool declares there.
        let schema = inputsOf(tool) as { properties?: Record<string, unknown>; required?: string[] } | undefined;
        let given = args;
        if (schema?.properties?.body) {
          schema = schema.properties.body as typeof schema;
          given = (args.body ?? {}) as Record<string, unknown>;
          if (!('body' in args)) problems.push(`${where}: \`${code}\` must put its arguments under \`body\``);
        }
        const declared = Object.keys(schema?.properties ?? {});
        for (const key of Object.keys(given)) {
          if (!declared.includes(key)) problems.push(`${where}: \`${code}\` passes \`${key}\`, which \`${name}\` does not take`);
        }
        for (const key of schema?.required ?? []) {
          if (!(key in given)) problems.push(`${where}: \`${code}\` leaves out \`${key}\`, which \`${name}\` requires`);
        }
      }
    }
    expect(problems).toEqual([]);
    expect(examples, 'the guide shows no call at all: the check would be vacuous').toBeGreaterThan(3);
  });
});

describe('the guide names the folders and files kb-layout.ts defines', () => {
  it('writes every root folder as its placeholder, never as the default name', async () => {
    const renamed = { knowledgeBaseDir: 'Docs', skillsDir: 'Abilities', pluginsDir: 'Extensions' };
    const guide = await composeAgentGuide(renamed, undefined, { kbDirName: 'repo', defaultBranch: 'production' });
    for (const name of [DEFAULT_KB_LAYOUT.knowledgeBaseDir, DEFAULT_KB_LAYOUT.skillsDir, DEFAULT_KB_LAYOUT.pluginsDir, 'knowledge-base']) {
      const hardCoded = [...guide.matchAll(new RegExp(`(^|[^\\w-])${name}/`, 'g'))].length;
      expect(hardCoded, `"${name}/" is written out where its placeholder belongs`).toBe(0);
    }
    expect(guide).not.toMatch(/\{\{\w+\}\}/);
    expect(guide).not.toContain('<the default branch>');
  });

  it('lays out a plugin with the names kb-layout.ts gives each part, and names every part', async () => {
    const raw = (await coreAgentGuideSections(DEFAULT_KB_LAYOUT)).map((s) => s.body).join('\n');
    const parts = new Set([PLUGIN_MANIFEST_FILE, PLUGIN_MCP_FILE, PLUGIN_SKILLS_DIR, HEXIS_EXTENSION_NS, 'access.md']);
    const named = [...raw.matchAll(/\{\{pluginsDir\}\}\/<Plugin>\/([^/\s`]+)/g)].map((m) => m[1]!);
    expect(named.filter((part) => !parts.has(part)), 'a plugin part kb-layout.ts does not define').toEqual([]);
    expect([...parts].filter((part) => !named.includes(part)), 'a plugin part the guide never lays out').toEqual([]);
    expect(raw).toContain(`<Plugin>/${HEXIS_TOOLS_DIR}/`);
    expect(raw).toContain(`{{pluginsDir}}/${PERSONAL_PLUGIN_PREFIX}<id>/`);
  });

  it('names the platform files and reserved folders by their defined names', async () => {
    const guide = (await agentGuideSections(DEFAULT_KB_LAYOUT)).map((s) => s.body).join('\n');
    for (const name of [...FIXED_PLATFORM_FILE_NAMES, GROUPS_YAML, SYNCED_GROUPS_YAML, PREAMBLE_FILE, BUNDLE_FILE, DATA_DIR, AGENTS_DIR, PIPELINES_DIR]) {
      expect(guide, name).toContain(name);
    }
    // A lowercase `.yaml` or `.json` file the guide names is one of the
    // platform's: a misspelt one (`group.yaml`) is a file nothing reads.
    const known = new Set([...FIXED_PLATFORM_FILE_NAMES, GROUPS_YAML, SYNCED_GROUPS_YAML, PLUGIN_MANIFEST_FILE, PLUGIN_MCP_FILE, BUNDLE_FILE]);
    const files = inlineCode(guide).flatMap((code) => [...code.matchAll(/(?:^|\/)([a-z][a-z.-]*\.(?:yaml|json))$/g)].map((m) => m[1]!));
    expect(files.filter((file) => !known.has(file))).toEqual([]);
  });
});

describe('the sections are the files, and the start section maps them', () => {
  it('has a file for every section id and a section id for every file', () => {
    const files = fs
      .readdirSync(agentGuideDir())
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.slice(0, -'.md'.length))
      .sort();
    expect(files).toEqual(CORE_SECTION_IDS.filter((id) => id !== WORKING_WITH_FILES_SECTION_ID).sort());
  });

  it('lists every section in the get_agent_guide description', async () => {
    const guideTool = (await hexisTools()).find((t) => t.name === 'get_agent_guide')!;
    for (const id of CORE_SECTION_IDS) expect(guideTool.description, id).toContain(`\`${id}\``);
  });

  it('routes a question to every other section, and only to sections that exist', async () => {
    const sections = await agentGuideSections(DEFAULT_KB_LAYOUT);
    const start = sections.find((s) => s.id === START_HERE_SECTION_ID)!.body;
    const routed = [...start.matchAll(/^\|[^|\n]+\|\s*`([a-z0-9-]+)`\s*\|$/gm)].map((m) => m[1]!);
    const others = CORE_SECTION_IDS.filter((id) => id !== START_HERE_SECTION_ID);
    expect(others.filter((id) => !routed.includes(id)), 'sections the start section never routes to').toEqual([]);
    expect(routed.filter((id) => !CORE_SECTION_IDS.includes(id)), 'routes to sections that do not exist').toEqual([]);
  });

  it('points "see `…`" at sections that exist', async () => {
    const sections = await agentGuideSections(DEFAULT_KB_LAYOUT);
    const pointers = sections.flatMap((s) =>
      [...s.body.matchAll(/\bsee `([a-z0-9-]+)`/g)].map((m) => ({ from: s.id, to: m[1]! })),
    );
    expect(pointers.length).toBeGreaterThan(0);
    expect(pointers.filter((p) => !CORE_SECTION_IDS.includes(p.to))).toEqual([]);
  });
});
