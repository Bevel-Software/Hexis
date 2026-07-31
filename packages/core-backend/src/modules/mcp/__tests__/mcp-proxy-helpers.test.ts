import { describe, expect, it } from 'vitest';
import type { Tool as UtcpTool } from '@utcp/sdk';
import {
  sanitizeInputSchema,
  describeToolFailure,
  flattenDiscoveredTool,
  toCallToolResult,
  toListedTool,
} from '../mcp.service.js';
import type { ProxiedTool } from '../mcp.service.js';

function utcpTool(name: string, bodyProps: Record<string, unknown>, required: string[] = []): UtcpTool {
  return {
    name,
    description: `the ${name} tool`,
    inputs: {
      type: 'object',
      properties: { body: { type: 'object', properties: bodyProps, required } },
      required: ['body'],
    },
    outputs: { type: 'object', properties: {} },
    tags: [],
    tool_call_template: { call_template_type: 'http' } as never,
  } as UtcpTool;
}

describe('flattenDiscoveredTool', () => {
  it('strips the manual prefix and keeps the {body} envelope verbatim', () => {
    const tool = utcpTool(
      'KNOWLEDGE_BASE.ask',
      { prompt: { type: 'string' }, sessionId: { type: 'string' } },
      ['prompt'],
    );
    const flat = flattenDiscoveredTool('KNOWLEDGE_BASE.', tool);

    expect(flat.mcpName).toBe('ask');
    expect(flat.utcpName).toBe('KNOWLEDGE_BASE.ask');
    // The schema passes through untouched — callers see the same `{body}`
    // envelope UTCP dispatches on (and that `call_tool_chain` documents).
    expect(flat.inputSchema).toEqual(tool.inputs);
  });

  it('keeps a remote MCP tool schema (no envelope) verbatim too', () => {
    const tool = {
      name: 'notion.search',
      description: 'search',
      inputs: {
        type: 'object',
        properties: { query: { type: 'string' } },
      },
      outputs: { type: 'object', properties: {} },
      tags: [],
      tool_call_template: { call_template_type: 'mcp' } as never,
    } as UtcpTool;
    const flat = flattenDiscoveredTool('notion.', tool);
    expect(flat.mcpName).toBe('search');
    expect(flat.inputSchema).toEqual(tool.inputs);
  });
});

describe('toListedTool', () => {
  const proxied = (over: Partial<ProxiedTool>): ProxiedTool => ({
    utcpName: 'm.t',
    mcpName: 'm_t',
    description: 'a tool',
    inputSchema: { type: 'object', properties: {} },
    manualName: 'm',
    ...over,
  });

  it('passes a conforming tool through', () => {
    const listed = toListedTool(proxied({ mcpName: 'gmail_send_email' }));
    expect(listed).toEqual({
      name: 'gmail_send_email',
      description: 'a tool',
      inputSchema: { type: 'object', properties: {} },
    });
  });

  it('drops a tool whose name is too long or has illegal chars (so it cannot blank the whole list)', () => {
    expect(toListedTool(proxied({ mcpName: 'has spaces' }))).toBeNull();
    expect(toListedTool(proxied({ mcpName: 'a'.repeat(129) }))).toBeNull();
    expect(toListedTool(proxied({ mcpName: '' }))).toBeNull();
  });

  it('inlines $defs/$ref (Google-MCP style) so no downstream layer sees them', () => {
    // Shape of Google's gmail `create_draft` schema: $defs + $ref in a property.
    const googleStyle = {
      type: 'object',
      $defs: {
        Recipient: {
          type: 'object',
          properties: { email: { type: 'string' } },
          required: ['email'],
        },
      },
      properties: {
        to: { type: 'array', items: { $ref: '#/$defs/Recipient' } },
        subject: { type: 'string' },
      },
      required: ['to'],
    };
    const listed = toListedTool(proxied({ inputSchema: googleStyle as never }))!;
    const json = JSON.stringify(listed.inputSchema);
    expect(json).not.toContain('$ref');
    expect(json).not.toContain('$defs');
    // The reference target was inlined, not dropped.
    expect(listed.inputSchema).toMatchObject({
      properties: {
        to: {
          items: { type: 'object', properties: { email: { type: 'string' } }, required: ['email'] },
        },
      },
    });
  });

  it('forces top-level type "object" + properties even when the remote declared otherwise', () => {
    // A remote server that put type: "string" (or a union) at the top would
    // otherwise fail the client's `type: "object"` check for the whole list.
    const listed = toListedTool(proxied({ inputSchema: { type: 'string', description: 'oops' } as never }))!;
    expect(listed.inputSchema).toMatchObject({ type: 'object', properties: {}, description: 'oops' });
    const union = toListedTool(proxied({ inputSchema: { type: ['object', 'null'], properties: { a: {} } } as never }))!;
    expect((union.inputSchema as { type: unknown }).type).toBe('object');
  });

  it('normalizes an odd inputSchema to a valid object schema, keeping declared properties', () => {
    // Missing `type` → added; existing properties preserved.
    const noType = toListedTool(proxied({ inputSchema: { properties: { q: { type: 'string' } } } as never }));
    expect(noType!.inputSchema).toEqual({ type: 'object', properties: { q: { type: 'string' } } });

    // Non-object schema (null / array) → replaced with an empty object schema.
    expect(toListedTool(proxied({ inputSchema: null as never }))!.inputSchema).toEqual({
      type: 'object',
      properties: {},
    });
    expect(toListedTool(proxied({ inputSchema: [] as never }))!.inputSchema).toEqual({
      type: 'object',
      properties: {},
    });
  });
});

describe('sanitizeInputSchema', () => {
  it('resolves nested and repeated refs', () => {
    const schema = {
      type: 'object',
      $defs: {
        A: { type: 'string' },
        B: { type: 'object', properties: { a: { $ref: '#/$defs/A' } } },
      },
      properties: { x: { $ref: '#/$defs/B' }, y: { $ref: '#/$defs/A' } },
    };
    expect(sanitizeInputSchema(schema)).toEqual({
      type: 'object',
      properties: {
        x: { type: 'object', properties: { a: { type: 'string' } } },
        y: { type: 'string' },
      },
    });
  });

  it('degrades a recursive schema to a permissive node instead of hanging', () => {
    const schema = {
      type: 'object',
      $defs: { Node: { type: 'object', properties: { child: { $ref: '#/$defs/Node' } } } },
      properties: { root: { $ref: '#/$defs/Node' } },
    };
    const out = sanitizeInputSchema(schema) as Record<string, unknown>;
    expect(JSON.stringify(out)).not.toContain('$ref');
    expect(out.type).toBe('object'); // finished, didn't hang
  });

  it('degrades unresolvable and external refs without dropping siblings', () => {
    const out = sanitizeInputSchema({
      type: 'object',
      properties: {
        a: { $ref: '#/$defs/missing', description: 'kept' },
        b: { $ref: 'https://elsewhere.example/schema.json' },
      },
    }) as never;
    expect(JSON.stringify(out)).not.toContain('$ref');
    expect(out).toMatchObject({ properties: { a: { description: 'kept' } } });
  });

  it('drops non-standard `format` (OpenAPI int32/byte) but keeps standard ones', () => {
    // Google's gmail/calendar schemas carry format: int32 / byte, which the
    // Anthropic tool validator rejects — poisoning the whole tools/list.
    const out = sanitizeInputSchema({
      type: 'object',
      properties: {
        pageSize: { type: 'integer', format: 'int32' },
        content: { type: 'string', format: 'byte' },
        when: { type: 'string', format: 'date-time' }, // standard — kept
        who: { type: 'string', format: 'email' }, // standard — kept
      },
    }) as { properties: Record<string, unknown> };
    expect(out.properties.pageSize).toEqual({ type: 'integer' });
    expect(out.properties.content).toEqual({ type: 'string' });
    expect(out.properties.when).toEqual({ type: 'string', format: 'date-time' });
    expect(out.properties.who).toEqual({ type: 'string', format: 'email' });
  });
});

describe('describeToolFailure', () => {
  it('surfaces the REST endpoint error body over the bare axios status message', () => {
    const axiosLike = Object.assign(new Error('Request failed with status code 500'), {
      response: { data: { error: 'kaboom' } },
    });
    expect(describeToolFailure(axiosLike)).toBe('kaboom');
  });

  it('uses a string response body when there is one', () => {
    const err = Object.assign(new Error('boom'), { response: { data: 'plain text error' } });
    expect(describeToolFailure(err)).toBe('plain text error');
  });

  it('falls back to the error message when no response body is present', () => {
    expect(describeToolFailure(new Error('socket hang up'))).toBe('socket hang up');
  });
});

describe('toCallToolResult', () => {
  it('uses a bare string as the text', () => {
    expect(toCallToolResult('hello')).toEqual({ content: [{ type: 'text', text: 'hello' }] });
  });

  it('passes a tool that already returns MCP agentic content through unchanged', () => {
    const agentic = { content: [{ type: 'text', text: 'already formatted' }], isError: false };
    expect(toCallToolResult(agentic)).toBe(agentic);
  });

  it('JSON-stringifies a structured object so every field survives (ask poll contract)', () => {
    // No collapsing to `text`: the whole object is stringified, so status and the
    // sessionId the caller must echo back to poll both reach the client.
    const result = toCallToolResult({ text: 'Still working…', status: 'running', sessionId: 'abc-123' });
    const out = (result.content[0] as { type: string; text: string });
    expect(out.type).toBe('text');
    expect(JSON.parse(out.text)).toEqual({ text: 'Still working…', status: 'running', sessionId: 'abc-123' });
  });

  it('JSON-stringifies any object (including one with a text field)', () => {
    expect(toCallToolResult({ text: 'answer' })).toEqual({
      content: [{ type: 'text', text: '{"text":"answer"}' }],
    });
    expect(toCallToolResult({ hits: [1] })).toEqual({
      content: [{ type: 'text', text: '{"hits":[1]}' }],
    });
  });

  it('falls back to a placeholder for empty output', () => {
    expect((toCallToolResult('').content[0] as { text: string }).text).toBe('(tool produced no output)');
  });
});
