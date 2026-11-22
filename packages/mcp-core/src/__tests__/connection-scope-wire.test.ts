import { describe, expect, it } from 'vitest';
import { unlistedToolAnswer } from '../index.js';

/**
 * What both MCP servers answer for a tool their surface does not list. A tool
 * offered only to a connection made as a bot, called on a Myself connection,
 * is refused by why — never "unknown", which would send the agent looking for
 * it elsewhere — and so is any tool on a connection made as a bot.
 */
describe('unlistedToolAnswer', () => {
  it('refuses a bot-only tool on a Myself connection by why, pointing at the person', () => {
    for (const name of ['approve_change_request', 'apply_change_request']) {
      expect(unlistedToolAnswer(name, undefined)).toBe(
        `The tool "${name}" is offered only to a connection made as a bot. A change request you propose is reviewed and applied by a person in the app: ask the user to do it there.`,
      );
    }
  });

  it('answers unknown for any other tool on a Myself connection', () => {
    expect(unlistedToolAnswer('no_such_tool', undefined)).toBe('Unknown tool "no_such_tool".');
  });

  it("refuses by the bot's name on a connection made as a bot, and with the sentence for one that cannot be used", () => {
    const asOps = { agent: { path: 'ops@agent.hexis', name: 'Ops' } };
    expect(unlistedToolAnswer('read_file', asOps)).toMatch(/acts as the bot "Ops" \(ops@agent\.hexis\)/);
    expect(unlistedToolAnswer('read_file', { ...asOps, unavailable: 'It loads nothing.' })).toBe('It loads nothing.');
  });
});
