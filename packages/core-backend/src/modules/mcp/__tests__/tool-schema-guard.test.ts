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

/** One caller's load: the manuals on their surface, each with the tools it advertised. */
const load = (groups: Record<string, readonly ScreenedTool[]>) => new Map(Object.entries(groups));

describe('ToolSchemaGuard', () => {
  it('names the tool, the place and the reason, and leaves its siblings alone', () => {
    const guard = new ToolSchemaGuard();
    const hidden = guard.screen('u1', load({ notion: [tool('a', VALID), tool('bad', INVALID), tool('b', VALID)] }));

    expect([...hidden.keys()]).toEqual(['notion.srv.bad']);
    // The UTCP name rides on what the LOAD gets back: the proxy takes the tool
    // out of its repository by that name and records it in the audit trail by
    // it, so a multi-segment `<manual>.<server>.<tool>` stays intact.
    expect(hidden.get('notion.srv.bad')?.utcpName).toBe('notion.srv.bad');
    // What the owner reads is about the tool by the name an agent calls it.
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
    guard.screen('u1', load({ notion: [tool('a', VALID)] }));
    expect(guard.hiddenFor('notion')).toEqual([]);
    expect(guard.hiddenFor('hubspot')).toEqual([]);
  });

  it('forgets the finding when the server sends a corrected schema', () => {
    const guard = new ToolSchemaGuard();
    guard.screen('u1', load({ notion: [tool('bad', INVALID)] }));
    expect(guard.hiddenFor('notion')).toHaveLength(1);

    guard.screen('u1', load({ notion: [tool('bad', VALID)] }));
    expect(guard.hiddenFor('notion')).toEqual([]);
  });

  /**
   * A load with NO tools for a manual is the load that clears it, and there are
   * two ways to get one: the server removed the offending tool, or the manual
   * could not be attached at all and its tools were never loaded. Either way
   * nothing should still be claiming a tool is hidden for a schema this process
   * can no longer see.
   */
  it('forgets the finding when the server advertises nothing at all', () => {
    const guard = new ToolSchemaGuard();
    guard.screen('u1', load({ notion: [tool('bad', INVALID)] }));
    guard.screen('u1', load({ notion: [] }));
    expect(guard.hiddenFor('notion')).toEqual([]);
  });

  it('forgets the finding when the manual leaves the surface entirely', () => {
    const guard = new ToolSchemaGuard();
    guard.screen('u1', load({ notion: [tool('bad', INVALID)], hubspot: [tool('fine', VALID)] }));
    expect(guard.hiddenFor('notion')).toHaveLength(1);

    guard.screen('u1', load({ hubspot: [tool('fine', VALID)] }));
    expect(guard.hiddenFor('notion')).toEqual([]);
  });

  it('keeps each server to itself', () => {
    const guard = new ToolSchemaGuard();
    guard.screen('u1', load({ notion: [tool('bad', INVALID)], hubspot: [tool('fine', VALID)] }));
    expect(guard.hiddenFor('notion')).toHaveLength(1);
    expect(guard.hiddenFor('hubspot')).toEqual([]);
  });

  /**
   * Discovery runs on the REQUESTING user's own connection, so two callers can
   * be shown different tools by one server. A finding is about the server, and
   * the person who can fix it is not necessarily the person whose connection
   * saw it — so one caller's load must never erase another's finding, and the
   * owner-facing surfaces read the union.
   */
  describe('with more than one caller', () => {
    it('does not let one caller\'s load erase another\'s finding', () => {
      const guard = new ToolSchemaGuard();
      guard.screen('u1', load({ notion: [tool('bad', INVALID)] }));
      // u2's connection is shown a different, healthy subset of the same server.
      guard.screen('u2', load({ notion: [tool('a', VALID)] }));
      expect(guard.hiddenFor('notion').map((t) => t.name)).toEqual(['notion_srv_bad']);
    });

    it('reports a finding once, however many callers were shown it', () => {
      const guard = new ToolSchemaGuard();
      guard.screen('u1', load({ notion: [tool('bad', INVALID)] }));
      guard.screen('u2', load({ notion: [tool('bad', INVALID)] }));
      expect(guard.hiddenFor('notion')).toHaveLength(1);
    });

    it('reports two different defects of one server together', () => {
      const guard = new ToolSchemaGuard();
      guard.screen('u1', load({ notion: [tool('bad', INVALID)] }));
      guard.screen('u2', load({ notion: [tool('other', { type: 'object', properties: { x: { anyOf: {} } } })] }));
      expect(guard.hiddenFor('notion').map((t) => t.name).sort()).toEqual([
        'notion_srv_bad',
        'notion_srv_other',
      ]);
    });
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

    for (let i = 0; i < 10; i += 1) guard.screen('u1', load({ notion: tools }));
    expect(check).toHaveBeenCalledTimes(2);

    // A CHANGED schema is a schema this process has not checked, so it is.
    guard.screen('u1', load({ notion: [tool('a', { type: 'object', properties: { other: { type: 'number' } } })] }));
    expect(check).toHaveBeenCalledTimes(3);
  });

  it('checks two tools that share one schema once', () => {
    const check = vi.fn(inputSchemaDefect);
    const guard = new ToolSchemaGuard(check);
    guard.screen('u1', load({ notion: [tool('a', VALID), tool('b', { ...VALID })] }));
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('checks a schema once across callers, too — the verdict is the schema\'s', () => {
    const check = vi.fn(inputSchemaDefect);
    const guard = new ToolSchemaGuard(check);
    guard.screen('u1', load({ notion: [tool('bad', INVALID)] }));
    guard.screen('u2', load({ notion: [tool('bad', INVALID)] }));
    expect(check).toHaveBeenCalledTimes(1);
  });
});
