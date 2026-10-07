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

/**
 * One load, with its own ticket. Every call takes a fresh one, so the order the
 * tests screen in is the order the guard sees — which is what the two
 * out-of-order tests below then break on purpose.
 */
const screen = (guard: ToolSchemaGuard, userId: string, groups: ReadonlyMap<string, readonly ScreenedTool[]>) =>
  guard.screen(userId, guard.beginLoad(), groups);

describe('ToolSchemaGuard', () => {
  it('names the tool, the place and the reason, and leaves its siblings alone', () => {
    const guard = new ToolSchemaGuard();
    const hidden = screen(guard, 'u1', load({ notion: [tool('a', VALID), tool('bad', INVALID), tool('b', VALID)] }));

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
    screen(guard, 'u1', load({ notion: [tool('a', VALID)] }));
    expect(guard.hiddenFor('notion')).toEqual([]);
    expect(guard.hiddenFor('hubspot')).toEqual([]);
  });

  it('forgets the finding when the server sends a corrected schema', () => {
    const guard = new ToolSchemaGuard();
    screen(guard, 'u1', load({ notion: [tool('bad', INVALID)] }));
    expect(guard.hiddenFor('notion')).toHaveLength(1);

    screen(guard, 'u1', load({ notion: [tool('bad', VALID)] }));
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
    screen(guard, 'u1', load({ notion: [tool('bad', INVALID)] }));
    screen(guard, 'u1', load({ notion: [] }));
    expect(guard.hiddenFor('notion')).toEqual([]);
  });

  it('forgets the finding when the manual leaves the surface entirely', () => {
    const guard = new ToolSchemaGuard();
    screen(guard, 'u1', load({ notion: [tool('bad', INVALID)], hubspot: [tool('fine', VALID)] }));
    expect(guard.hiddenFor('notion')).toHaveLength(1);

    screen(guard, 'u1', load({ hubspot: [tool('fine', VALID)] }));
    expect(guard.hiddenFor('notion')).toEqual([]);
  });

  it('keeps each server to itself', () => {
    const guard = new ToolSchemaGuard();
    screen(guard, 'u1', load({ notion: [tool('bad', INVALID)], hubspot: [tool('fine', VALID)] }));
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
      screen(guard, 'u1', load({ notion: [tool('bad', INVALID)] }));
      // u2's connection is shown a different, healthy subset of the same server.
      screen(guard, 'u2', load({ notion: [tool('a', VALID)] }));
      expect(guard.hiddenFor('notion').map((t) => t.name)).toEqual(['notion_srv_bad']);
    });

    it('reports a finding once, however many callers were shown it', () => {
      const guard = new ToolSchemaGuard();
      screen(guard, 'u1', load({ notion: [tool('bad', INVALID)] }));
      screen(guard, 'u2', load({ notion: [tool('bad', INVALID)] }));
      expect(guard.hiddenFor('notion')).toHaveLength(1);
    });

    it('reports two different defects of one server together', () => {
      const guard = new ToolSchemaGuard();
      screen(guard, 'u1', load({ notion: [tool('bad', INVALID)] }));
      screen(guard, 'u2', load({ notion: [tool('other', { type: 'object', properties: { x: { anyOf: {} } } })] }));
      expect(guard.hiddenFor('notion').map((t) => t.name).sort()).toEqual([
        'notion_srv_bad',
        'notion_srv_other',
      ]);
    });
  });

  /**
   * Requests overlap — a caller's surface is rebuilt on every one of them, and
   * two can be dialling the same server at once. So the order loads LAND in is
   * not the order they READ in, and only the second one is evidence about the
   * server's current schemas.
   */
  describe('with loads that land out of order', () => {
    it('does not let a load that read the server earlier overwrite a newer one', () => {
      const guard = new ToolSchemaGuard();
      const stale = guard.beginLoad(); // request A starts, the schema still broken
      const fresh = guard.beginLoad(); // request B starts, after the vendor's fix
      guard.screen('u1', fresh, load({ notion: [tool('bad', VALID)] }));

      // A lands late, with what it saw. Its OWN request still keeps the tool off
      // its surface — it has judged that schema invalid and must not offer it …
      const found = guard.screen('u1', stale, load({ notion: [tool('bad', INVALID)] }));
      expect([...found.keys()]).toEqual(['notion.srv.bad']);
      // … but the marker everyone else reads is not put back on a tool that is
      // now fine, to sit there until some later request happened to clear it.
      expect(guard.hiddenFor('notion')).toEqual([]);
    });

    it('applies the newer load when the older one landed first', () => {
      const guard = new ToolSchemaGuard();
      const first = guard.beginLoad();
      const second = guard.beginLoad();
      guard.screen('u1', first, load({ notion: [tool('bad', INVALID)] }));
      expect(guard.hiddenFor('notion')).toHaveLength(1);

      guard.screen('u1', second, load({ notion: [tool('bad', VALID)] }));
      expect(guard.hiddenFor('notion')).toEqual([]);
    });

    it('orders each caller against itself, not against the others', () => {
      const guard = new ToolSchemaGuard();
      const early = guard.beginLoad();
      const late = guard.beginLoad();
      // u2's NEWER load lands first, and u1's older one after it. Ordering kept
      // globally rather than per caller would call u1's load stale on the
      // strength of a ticket belonging to someone else, and drop a finding
      // nothing else in this process has seen. The order matters: with u1's
      // load first, both readings pass and the test proves nothing.
      guard.screen('u2', late, load({ notion: [tool('a', VALID)] }));
      guard.screen('u1', early, load({ notion: [tool('bad', INVALID)] }));
      expect(guard.hiddenFor('notion').map((t) => t.name)).toEqual(['notion_srv_bad']);
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

    for (let i = 0; i < 10; i += 1) screen(guard, 'u1', load({ notion: tools }));
    expect(check).toHaveBeenCalledTimes(2);

    // A CHANGED schema is a schema this process has not checked, so it is.
    screen(guard, 'u1', load({ notion: [tool('a', { type: 'object', properties: { other: { type: 'number' } } })] }));
    expect(check).toHaveBeenCalledTimes(3);
  });

  it('checks two tools that share one schema once', () => {
    const check = vi.fn(inputSchemaDefect);
    const guard = new ToolSchemaGuard(check);
    screen(guard, 'u1', load({ notion: [tool('a', VALID), tool('b', { ...VALID })] }));
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('checks a schema once across callers, too — the verdict is the schema\'s', () => {
    const check = vi.fn(inputSchemaDefect);
    const guard = new ToolSchemaGuard(check);
    screen(guard, 'u1', load({ notion: [tool('bad', INVALID)] }));
    screen(guard, 'u2', load({ notion: [tool('bad', INVALID)] }));
    expect(check).toHaveBeenCalledTimes(1);
  });

  describe('with more callers than it remembers', () => {
    const MANY = 2000; // MAX_REMEMBERED_CALLERS

    it('evicts the caller longest unseen, and keeps every other caller\'s finding on the owner\'s page', () => {
      const guard = new ToolSchemaGuard();
      // The first caller's finding, then a crowd of callers with nothing to
      // report, then one more than fits.
      screen(guard, 'first', load({ notion: [tool('bad', INVALID)] }));
      for (let i = 1; i < MANY; i += 1) screen(guard, `u${i}`, load({ notion: [tool('a', VALID)] }));
      expect(guard.hiddenFor('notion')).toHaveLength(1);
      // `first` was seen again since — so it is not the longest unseen, and
      // its finding stays when the crowd overflows.
      screen(guard, 'first', load({ notion: [tool('bad', INVALID)] }));
      screen(guard, 'overflow', load({ notion: [tool('a', VALID)] }));
      expect(guard.hiddenFor('notion')).toHaveLength(1);
      // Overflow once more: now `u1` goes, then `u2` — never the whole table.
      screen(guard, 'overflow-2', load({ notion: [tool('a', VALID)] }));
      expect(guard.hiddenFor('notion')).toHaveLength(1);
    });

    it("keeps the order per caller: an evicted caller's next load is their newest, whichever began first", () => {
      const guard = new ToolSchemaGuard();
      for (let i = 0; i < MANY; i += 1) screen(guard, `u${i}`, load({ notion: [tool('a', VALID)] }));
      // `u0` is the longest unseen. Two loads of theirs begin, old then new —
      // and before either lands, the table overflows and `u0` is evicted,
      // watermark and all.
      const older = guard.beginLoad();
      const newer = guard.beginLoad();
      screen(guard, 'newcomer', load({ notion: [tool('a', VALID)] }));
      // Nothing of `u0` is held, so whichever lands first is the newest
      // picture this process has of them: the old load, with its finding.
      guard.screen('u0', older, load({ notion: [tool('bad', INVALID)] }));
      expect(guard.hiddenFor('notion')).toHaveLength(1);
      // The newer load then lands with the corrected schema and wins —
      // and the watermark it restores rejects anything older after it.
      guard.screen('u0', newer, load({ notion: [tool('a', VALID)] }));
      expect(guard.hiddenFor('notion')).toEqual([]);
      const own = guard.screen('u0', older, load({ notion: [tool('bad', INVALID)] }));
      expect([...own.keys()]).toEqual(['notion.srv.bad']);
      expect(guard.hiddenFor('notion')).toEqual([]);
    });

    it("does not rank one caller's load against another caller's eviction", () => {
      const guard = new ToolSchemaGuard();
      // `x` begins a load; the table then fills and overflows, evicting
      // callers whose tickets are newer than `x`'s.
      const x = guard.beginLoad();
      for (let i = 0; i < MANY; i += 1) screen(guard, `u${i}`, load({ notion: [tool('a', VALID)] }));
      screen(guard, 'overflow', load({ notion: [tool('a', VALID)] }));
      // `x`'s load is `x`'s newest, evictions elsewhere notwithstanding: its
      // finding reaches the owner's page.
      guard.screen('x', x, load({ notion: [tool('bad', INVALID)] }));
      expect(guard.hiddenFor('notion')).toHaveLength(1);
    });
  });
});
