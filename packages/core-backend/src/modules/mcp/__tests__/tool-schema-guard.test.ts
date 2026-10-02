import { describe, expect, it, vi } from 'vitest';
import { inputSchemaDefect } from '@bevel-software/platform-mcp-core';
import { ToolSchemaGuard, type ScreenedTool } from '../tool-schema-guard.js';

const tool = (name: string, inputSchema: unknown): ScreenedTool => ({
  utcpName: `notion.srv.${name}`,
  mcpName: `notion_srv_${name}`,
  inputSchema,
});

const VALID = { type: 'object', properties: { text: { type: 'string' } } };
/** `required` holding a number, in an `anyOf` branch — the Notion refusal. */
const INVALID = { type: 'object', properties: { value: { anyOf: [{ type: 'object', required: [7] }] } } };

describe('ToolSchemaGuard', () => {
  it('names the tool, the place and the reason, and leaves its siblings alone', () => {
    const guard = new ToolSchemaGuard();
    const hidden = guard.screen('notion', [tool('a', VALID), tool('bad', INVALID), tool('b', VALID)]);

    expect([...hidden.keys()]).toEqual(['notion.srv.bad']);
    expect(guard.hiddenFor('notion')).toEqual([
      {
        manual: 'notion',
        name: 'notion_srv_bad',
        path: '/properties/value/anyOf/0/required/0',
        reason: 'must be a string',
        marker:
          'Hidden from agents: its schema is invalid at /properties/value/anyOf/0/required/0 (must be a string).',
      },
    ]);
  });

  it('holds nothing for a server whose tools are all valid, and nothing for one never loaded', () => {
    const guard = new ToolSchemaGuard();
    guard.screen('notion', [tool('a', VALID)]);
    expect(guard.hiddenFor('notion')).toEqual([]);
    expect(guard.hiddenFor('hubspot')).toEqual([]);
  });

  it('forgets the finding when the server sends a corrected schema', () => {
    const guard = new ToolSchemaGuard();
    guard.screen('notion', [tool('bad', INVALID)]);
    expect(guard.hiddenFor('notion')).toHaveLength(1);

    guard.screen('notion', [tool('bad', VALID)]);
    expect(guard.hiddenFor('notion')).toEqual([]);
    expect(guard.hiddenByAgentName('notion_srv_bad')).toBeUndefined();
  });

  it('keeps each server to itself', () => {
    const guard = new ToolSchemaGuard();
    guard.screen('notion', [tool('bad', INVALID)]);
    guard.screen('hubspot', [tool('fine', VALID)]);
    expect(guard.hiddenFor('notion')).toHaveLength(1);
    expect(guard.hiddenFor('hubspot')).toEqual([]);
  });

  it('answers for a hidden tool by the name an agent would have called it', () => {
    const guard = new ToolSchemaGuard();
    guard.screen('notion', [tool('bad', INVALID)]);
    expect(guard.hiddenByAgentName('notion_srv_bad')?.manual).toBe('notion');
    expect(guard.hiddenByAgentName('notion_srv_other')).toBeUndefined();
  });

  /**
   * The point of remembering. The MCP surface is rebuilt per request, so these
   * same schemas come past on every `tools/list` AND every `tools/call`; the
   * CHECK happens when a server's tools are loaded and when a refresh brings a
   * schema this process has not seen, and never again.
   */
  it('checks a schema once, however many times it is screened', () => {
    const check = vi.fn(inputSchemaDefect);
    const guard = new ToolSchemaGuard(check);
    const tools = [tool('a', VALID), tool('bad', INVALID)];

    for (let i = 0; i < 10; i += 1) guard.screen('notion', tools);
    expect(check).toHaveBeenCalledTimes(2);

    // A CHANGED schema is a schema this process has not checked, so it is.
    guard.screen('notion', [tool('a', { type: 'object', properties: { other: { type: 'number' } } })]);
    expect(check).toHaveBeenCalledTimes(3);
  });

  it('checks two tools that share one schema once', () => {
    const check = vi.fn(inputSchemaDefect);
    const guard = new ToolSchemaGuard(check);
    guard.screen('notion', [tool('a', VALID), tool('b', { ...VALID })]);
    expect(check).toHaveBeenCalledTimes(1);
  });
});
