import { describe, expect, it } from 'vitest';
import type { Tool as UtcpTool } from '@utcp/sdk';
import {
  codeModeMetaTools,
  flattenDiscoveredTool,
  flattenManualTool,
  META_TOOL_READ_ONLY,
  READ_ONLY_TAG,
  toListedTool,
  withReadOnlyOverride,
} from '../index.js';

/**
 * The read-only hint MCP clients gate tool approval on (`annotations.readOnlyHint`).
 *
 * The deployment marks each platform tool whose built-in hint is true with
 * the `read-only` tag on its manual; these pin that both servers' one mapping
 * from a discovered tool to a listing entry turns that tag — and only for the
 * platform's own manual — into the hint, and leaves everything else about the
 * entry as it was.
 */

const KB = 'KNOWLEDGE_BASE';

function utcpTool(name: string, tags: string[]): UtcpTool {
  return {
    name,
    description: `the ${name} tool`,
    inputs: { type: 'object', properties: { path: { type: 'string' } } },
    outputs: { type: 'object', properties: {} },
    tags,
    tool_call_template: { call_template_type: 'http' } as never,
  } as UtcpTool;
}

describe('a platform tool lists its read-only hint', () => {
  it('lists `readOnlyHint: true` for a tool the manual tags read-only', () => {
    const entry = toListedTool(flattenManualTool(utcpTool(`${KB}.read_file`, ['workspace', READ_ONLY_TAG]), KB));
    expect(entry?.annotations).toEqual({ readOnlyHint: true });
  });

  it('lists `readOnlyHint: false` for a platform tool without the tag (a writer)', () => {
    const entry = toListedTool(flattenManualTool(utcpTool(`${KB}.write_file`, ['workspace', 'write']), KB));
    expect(entry?.annotations).toEqual({ readOnlyHint: false });
  });

  it('changes nothing else about the entry: name, description and schema are what they were without a hint', () => {
    const tagged = toListedTool(flattenManualTool(utcpTool(`${KB}.read_file`, [READ_ONLY_TAG]), KB))!;
    const untagged = toListedTool({ ...flattenManualTool(utcpTool(`${KB}.read_file`, []), KB), readOnly: undefined })!;
    const { annotations, ...rest } = tagged;
    expect(annotations).toEqual({ readOnlyHint: true });
    expect(rest).toEqual(untagged);
    expect(untagged).not.toHaveProperty('annotations');
  });
});

describe('a tool from anywhere else lists no annotation, as before', () => {
  it('leaves a `.tool` manual tool unannotated, even one whose author tagged it read-only', () => {
    const entry = toListedTool(flattenManualTool(utcpTool('serper.search', [READ_ONLY_TAG]), KB));
    expect(entry?.name).toBe('serper_search');
    expect(entry).not.toHaveProperty('annotations');
  });

  it('leaves a directly discovered tool unannotated', () => {
    const entry = toListedTool(flattenDiscoveredTool('github.', utcpTool('github.list_repos', [READ_ONLY_TAG])));
    expect(entry).not.toHaveProperty('annotations');
  });
});

describe('the code-mode meta-tools carry the hint', () => {
  const hintsOf = (tools: ReturnType<typeof codeModeMetaTools>) =>
    Object.fromEntries(tools.map((t) => [t.name, t.annotations]));

  it('lists `list_tools` and `tools_info` read-only and `call_tool_chain` not, by default', () => {
    expect(hintsOf(codeModeMetaTools(KB))).toEqual({
      list_tools: { readOnlyHint: true },
      tools_info: { readOnlyHint: true },
      call_tool_chain: { readOnlyHint: false },
    });
    expect(META_TOOL_READ_ONLY).toEqual({ list_tools: true, tools_info: true, call_tool_chain: false });
  });

  it("applies the deployment's override, and only to the tool it names", () => {
    expect(hintsOf(codeModeMetaTools(KB, [], { readOnly: { call_tool_chain: true, read_file: false } }))).toEqual({
      list_tools: { readOnlyHint: true },
      tools_info: { readOnlyHint: true },
      call_tool_chain: { readOnlyHint: true },
    });
    expect(hintsOf(codeModeMetaTools(KB, [], { readOnly: { list_tools: false } })).list_tools).toEqual({
      readOnlyHint: false,
    });
  });

  it('changes nothing but the annotation: same names, descriptions and schemas with or without an override', () => {
    const strip = (tools: ReturnType<typeof codeModeMetaTools>) => tools.map((t) => ({ ...t, annotations: undefined }));
    expect(strip(codeModeMetaTools(KB, [], { readOnly: { call_tool_chain: true } }))).toEqual(
      strip(codeModeMetaTools(KB)),
    );
  });
});

describe("the deployment's override, joined on at listing time", () => {
  const hintOf = (tool: ReturnType<typeof flattenManualTool>) => toListedTool(tool)?.annotations;

  it('replaces the built-in hint of the platform tool it names, in either direction', () => {
    const reader = flattenManualTool(utcpTool(`${KB}.read_file`, [READ_ONLY_TAG]), KB);
    const writer = flattenManualTool(utcpTool(`${KB}.write_file`, ['write']), KB);
    const overrides = { read_file: false, write_file: true };
    expect(hintOf(withReadOnlyOverride(reader, overrides))).toEqual({ readOnlyHint: false });
    expect(hintOf(withReadOnlyOverride(writer, overrides))).toEqual({ readOnlyHint: true });
  });

  it('leaves a tool it does not name, or none at all, on its built-in hint', () => {
    const reader = flattenManualTool(utcpTool(`${KB}.read_file`, [READ_ONLY_TAG]), KB);
    expect(hintOf(withReadOnlyOverride(reader, { write_file: true }))).toEqual({ readOnlyHint: true });
    expect(hintOf(withReadOnlyOverride(reader, undefined))).toEqual({ readOnlyHint: true });
    // An inherited key is no override.
    expect(hintOf(withReadOnlyOverride(flattenManualTool(utcpTool(`${KB}.toString`, []), KB), {}))).toEqual({
      readOnlyHint: false,
    });
  });

  it('never annotates a tool from another manual, whatever its name', () => {
    const plugin = flattenManualTool(utcpTool('notion.read_file', [READ_ONLY_TAG]), KB);
    expect(toListedTool(withReadOnlyOverride(plugin, { notion_read_file: true, read_file: true }))).not.toHaveProperty(
      'annotations',
    );
  });
});
