import express from 'express';
import { describe, expect, it } from 'vitest';
import {
  CALL_TOOL_CHAIN_NAME,
  CHAIN_FAILURES_RULE,
  CHAIN_LARGE_RESULTS_RULE,
  codeModeMetaTools,
} from '@bevel-software/platform-mcp-core';
import { testKbContext } from '../../../__tests__/kb-context.js';
import { EXTERNAL_KB_MANUAL_NAME } from '../../tool-manuals/tool-manuals.contract.js';
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
import { CLIENT_SHORT_CUT, TOOL_DESCRIPTION_CAP, clientVisibleLength, firstSentenceEnd } from '../description-length.js';
import {
  TOOL_PREFIX_CAP,
  sharedFileRules,
} from '../../agent-instructions/index.js';
import { isPlatformFile, platformFilesByDepth } from '@bevel-software/platform-shared';
import { GET_AGENT_GUIDE_TOOL, GUIDE_FIRST_SENTENCE, guideFirstDescription } from '../guide-first.js';
import { registerAgentGuideTool } from '../../agent-guide/agent-guide.tools.js';
import { agentGuideSections } from '../../agent-guide/agent-guide.js';

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

/**
 * The meta-tools as the hosted endpoint builds them (`mcp.service.ts`):
 * examples written against the namespace it registers the knowledge-base tools
 * under and against the catalog it serves, and the chain without the rules it
 * states only in the shared places. So the chain description measured here
 * carries the worked call a client is really sent, which is its longest form.
 */
function servedMetaTools(external: readonly UtcpTool[]) {
  return codeModeMetaTools(
    EXTERNAL_KB_MANUAL_NAME,
    external.map((t) => ({ utcpName: `${EXTERNAL_KB_MANUAL_NAME}.${t.name}`, inputSchema: t.inputs })),
    { sharedRulesPointer: '' },
    // As the hosted endpoint serves them: opening with the guide-first
    // sentence, through the one helper the endpoint itself uses.
  ).map((t) => ({ ...t, description: guideFirstDescription(t.description) }));
}

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
    undefined,
    undefined,
    // The two upload tools are mounted only when a store is supplied, and
    // every real composition supplies one: without it they would be the two
    // descriptions this suite never measured.
    unused(),
  );
  registerWorkflowTools(registry, router, toolAuth, toolHandler, kb);
  registerPluginsTools(registry, kb);
  registerSkillsTools(registry, router, toolAuth, toolHandler, emptySkills);
  registerToolManualsTools(registry, router, toolAuth, toolHandler, emptyManuals, {
    accessControl: unused(),
    variableStatus: unused(),
    kb,
  });
  // The guide's own tool, with the platform's sections: the one description
  // that lists the sections is measured with the list it really carries.
  registerAgentGuideTool(registry, router, toolAuth, toolHandler, () => agentGuideSections(kb.layout));

  const byName = new Map<string, UtcpTool>();
  // The meta-tools as a client is served them (`mcp.service.ts` opens each
  // with the guide-first sentence at the mount), so the catalog measured here
  // is the catalog that goes out rather than the bare constant.
  const external = (await registry.listExternal()) as UtcpTool[];
  const metaTools = servedMetaTools(external);
  for (const tool of [...(await registry.listInternal()), ...external, ...metaTools]) {
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

  it(`leaves the tool's own first sentence inside the shorter ${CLIENT_SHORT_CUT}-character cut`, async () => {
    // The cap does not answer the ~500-character cut; the ORDER of the text
    // does, and this is where that claim is checked rather than asserted in a
    // comment. A client that stops at 500 must still have the sentence saying
    // what the tool does — what it loses is the tail, and the shared rules are
    // stated in the handshake instructions and in the guide anyway. Lowering
    // the cap to 500 would not buy this; only order does.
    const late = (await hexisTools())
      .map((t) => ({ tool: t.name, endsAt: firstSentenceEnd(t) }))
      .filter((m) => m.endsAt > CLIENT_SHORT_CUT)
      .sort((a, b) => b.endsAt - a.endsAt);
    expect(
      late,
      late
        .map((m) => `${m.tool}: first sentence ends at ${m.endsAt} (cut ${CLIENT_SHORT_CUT}) — lead with what it does`)
        .join('\n'),
    ).toEqual([]);
  });

  it('opens every tool but the guide\'s own with the guide-first sentence, and fits with it', async () => {
    // The sentence is in the description the registry lists, so the catalog
    // measured here is the catalog a client gets, sentence included.
    const tools = await hexisTools();
    // ONE predicate for both halves, so no description falls between them: a
    // tool whose own description is empty is served the sentence alone, and
    // one with text after it has whitespace between — not `here.Read`.
    const opensWithGuide = (t: UtcpTool): boolean => {
      const description = t.description ?? '';
      if (description === GUIDE_FIRST_SENTENCE) return true;
      return description.startsWith(GUIDE_FIRST_SENTENCE) && /^\s/.test(description.slice(GUIDE_FIRST_SENTENCE.length));
    };
    const opened = tools.filter(opensWithGuide);
    expect(opened.length).toBeGreaterThan(0);
    // The guide's own tool is the one exception: it is what the sentence
    // points at, and it is in the catalog measured here so the cap holds on
    // it too (see the first test).
    expect(tools.filter((t) => !opensWithGuide(t)).map((t) => t.name)).toEqual([GET_AGENT_GUIDE_TOOL]);
    for (const tool of opened) {
      expect(clientVisibleLength(tool), tool.name).toBeLessThanOrEqual(TOOL_DESCRIPTION_CAP);
    }
  });

  it('measures a prefixed tool with the prefix a client sees, not without it', async () => {
    // The four knowledge-base tools carry the deployment's tool prefix ahead of
    // their description on the MCP surface — up to `TOOL_PREFIX_CAP` characters
    // the admin writes. A cap applied to the bare description would pass while
    // the catalog the agent reads was over it by 300.
    const read = (await hexisTools()).find((t) => t.name === 'read_file');
    expect(read).toBeDefined();
    // Its own text (the guide-first sentence included), plus the prefix at
    // ITS cap and the blank line between.
    const own = read!.description!.length;
    expect(clientVisibleLength(read!)).toBe(own + TOOL_PREFIX_CAP + 2);
    expect(own + TOOL_PREFIX_CAP + 2).toBeLessThanOrEqual(TOOL_DESCRIPTION_CAP);
  });

  it('fails, naming the tool, when a paragraph takes a description over the cap', () => {
    const padded = { name: 'write_file', description: 'x'.repeat(TOOL_DESCRIPTION_CAP + 1) } as UtcpTool;
    expect(clientVisibleLength(padded)).toBeGreaterThan(TOOL_DESCRIPTION_CAP);
    // A tool with no description at all is not over the cap.
    expect(clientVisibleLength({ name: 'nothing' } as UtcpTool)).toBe(0);
    // Unless it is a PREFIXED one: the prefix is sent on its own then (no
    // description, so no blank line either), and that text is what the client
    // was handed. Measuring it as nothing would hide the only thing it got.
    expect(clientVisibleLength({ name: 'read_file' } as UtcpTool)).toBe(TOOL_PREFIX_CAP);
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
    const mastraTool = createCallToolChainTool(unused(), unused(), EXTERNAL_KB_MANUAL_NAME) as unknown as {
      description: string;
    };
    expect(mastraTool.description).toContain('UTCP CodeMode Tool Usage Guide');
    expect(mastraTool.description.length).toBeGreaterThan(TOOL_DESCRIPTION_CAP);
    expect((await hexisTools()).some((t) => t.description === mastraTool.description)).toBe(false);
  });
});

describe('every file tool opens with the guide-first sentence and carries no shared paragraph', () => {
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
    'apply_file_upload',
  ];

  it('opens each description with the sentence sending the agent to the guide, and ends it as a sentence', async () => {
    const tools = await hexisTools();
    for (const name of FILE_TOOLS) {
      const def = tools.find((t) => t.name === name);
      expect(def, name).toBeDefined();
      expect(def!.description!.startsWith(`${GUIDE_FIRST_SENTENCE} `), `${name} must open with: ${GUIDE_FIRST_SENTENCE}`).toBe(true);
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

describe('the shared rules describe the tools they name', () => {
  it('opens the chain description with the guide-first sentence too, under the cap', async () => {
    // What a chain does with a failure, a large result or an image is true of
    // every call, so it is stated in the shared rules — and the clients that
    // drop the handshake `instructions` see only descriptions, so the chain
    // opens with the same sentence every tool of the platform's own opens
    // with, and ends with no second pointer: the one at the front is the way
    // to the rules. Composed at the mount, because `mcp-core` builds the
    // constant without knowing where this deployment states them.
    const served = (await hexisTools()).find((t) => t.name === CALL_TOOL_CHAIN_NAME)!;
    expect(served.description!.startsWith(`${GUIDE_FIRST_SENTENCE} `)).toBe(true);
    expect(served.description!.split(GUIDE_FIRST_SENTENCE)).toHaveLength(2);
    expect(served.description!.trimEnd().endsWith('.')).toBe(true);
    expect(clientVisibleLength(served)).toBeLessThanOrEqual(TOOL_DESCRIPTION_CAP);
    // The other two open the same way: the guide comes before the registry too.
    for (const tool of servedMetaTools([]).filter((t) => t.name !== CALL_TOOL_CHAIN_NAME)) {
      expect(tool.description!.startsWith(`${GUIDE_FIRST_SENTENCE} `), tool.name).toBe(true);
    }
  });

  it('states what a chain does in the shared rules, and not a second time on the chain', async () => {
    // The opener is only honest if the rules it points at are THERE. These
    // two were paragraphs of the chain's description; they moved, whole, and a
    // description that kept them as well would be the long one a client cuts.
    const rule = sharedFileRules(testKbContext().layout).find((r) => r.id === 'tool-chain')!;
    expect(rule.body).toContain(CHAIN_FAILURES_RULE);
    expect(rule.body).toContain(CHAIN_LARGE_RESULTS_RULE);
    const served = (await hexisTools()).find((t) => t.name === CALL_TOOL_CHAIN_NAME)!;
    expect(served.description).not.toContain(CHAIN_FAILURES_RULE);
    expect(served.description).not.toContain(CHAIN_LARGE_RESULTS_RULE);
    // What a chained read does to an image was already one of the shared rules.
    const content = sharedFileRules(testKbContext().layout).find((r) => r.id === 'content-kinds')!;
    expect(content.body).toContain('image_omitted');
  });

  it('keeps the rules on the chain itself where no shared rules are served', () => {
    // The standalone bridge proxies a deployment whose guide it cannot name, so
    // it passes no pointer at all — and an agent there must still be told what a chain
    // that timed out, or answered too much, or read an image, does.
    const [chain] = codeModeMetaTools('hexis', []).filter((t) => t.name === CALL_TOOL_CHAIN_NAME);
    expect(chain.description).toContain(CHAIN_FAILURES_RULE);
    expect(chain.description).toContain(CHAIN_LARGE_RESULTS_RULE);
    expect(chain.description).toContain('image_omitted');
  });

  it('names a dry run only on the tools that take one', async () => {
    // A rule is worse than no rule when it promises an argument the tool
    // rejects: `delete_file` has no `dryRun`, so an agent told to preflight a
    // single-file delete gets a validation error on the safe call and learns to
    // skip it. Read off the schemas rather than asserted by hand.
    const rule = sharedFileRules(testKbContext().layout).find((r) => r.id === 'dry-run-confirm')!;
    const tools = await hexisTools();
    // `toolDef` wraps a tool's own inputs under `body`, which is the schema a
    // client validates against — so that is where the argument either is or is not.
    const takesDryRun = (name: string): boolean => {
      const inputs = tools.find((t) => t.name === name)?.inputs as
        | { properties?: { body?: { properties?: Record<string, unknown> } } }
        | undefined;
      return inputs?.properties?.body?.properties?.dryRun !== undefined;
    };
    expect(takesDryRun('move_file')).toBe(true);
    expect(takesDryRun('delete_folder')).toBe(true);
    expect(takesDryRun('delete_file')).toBe(false);
    // Every tool that takes one, read off the catalog rather than listed here —
    // a hand-written list is what let `copy_file` gain a `dryRun` on dev while
    // the rule still named two tools, so an agent reading the guide was told
    // the copy had no preflight it could run.
    const withDryRun = tools.filter((t) => takesDryRun(t.name)).map((t) => t.name);
    expect(withDryRun.length, 'no tool takes a dryRun — the rule would be vacuous').toBeGreaterThan(1);
    for (const name of withDryRun) {
      expect(rule.body, name).toContain(name);
    }
    // Named, but as the tool that has none — never as one that takes one.
    expect(rule.body).toContain('delete_file takes neither');
    expect(rule.body).not.toContain('move_file, delete_file and delete_folder take');
  });

  it('gives each platform file the depth it actually counts at', () => {
    const rule = sharedFileRules(testKbContext().layout).find((r) => r.id === 'managed-items')!;
    const { anyDepth, rootOnly } = platformFilesByDepth(testKbContext().layout);
    // The split is the half of the rule a list of names leaves out, and
    // `isPlatformFile` is the predicate the prose has to match.
    expect(rule.body).toContain(`${anyDepth.map((n) => `\`${n}\``).join(' or ')} in any folder`);
    expect(rule.body).toContain(`${rootOnly.map((n) => `\`${n}\``).join(' or ')} at the repository root`);
    for (const name of anyDepth) expect(isPlatformFile(`Deep/Folder/${name}`, testKbContext().layout), name).toBe(true);
    for (const name of rootOnly) expect(isPlatformFile(`Deep/Folder/${name}`, testKbContext().layout), name).toBe(false);
  });

  it('says what unzip extracts, rather than that it takes any bytes', () => {
    const rule = sharedFileRules(testKbContext().layout).find((r) => r.id === 'content-kinds')!;
    // `unzip` refuses anything but a `.zip` (`workspace.service.ts`: "Only .zip
    // files can be extracted"), so the byte-tool clause must not sweep it in.
    expect(rule.body).toContain('unzip extracts the entries of a `.zip`');
    expect(rule.body).not.toContain('and unzip act on bytes of any kind');
  });
});
