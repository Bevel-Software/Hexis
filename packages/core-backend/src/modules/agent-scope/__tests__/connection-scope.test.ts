import { describe, expect, it } from 'vitest';
import { ConnectionScope, NOT_AVAILABLE_TO_CONNECTION } from '../index.js';

/**
 * The one policy for a platform-tool call by a connection: what every route
 * that is a platform tool answers, hosted by `toolHandler` or mounted on its
 * own. Pinned here so the two kinds of route cannot answer differently.
 */

const BOT = { path: 'ops@agent.hexis', name: 'ops' };

describe('ConnectionScope', () => {
  it('lets Myself call anything and describes nothing new', () => {
    const scope = ConnectionScope.myself();
    expect(scope.platformToolRefusal('create_plugin')).toBeNull();
    expect(scope.describe()).toBeNull();
    expect(scope.toWire()).toBeUndefined();
    expect(scope.fingerprint()).toBeNull();
  });

  it('lets a bot call the platform tools it is offered, and refuses the rest by name and bot', () => {
    const scope = ConnectionScope.asBot(BOT, ['read_file'], 'fp');
    expect(scope.platformToolRefusal('read_file')).toBeNull();
    expect(scope.platformToolRefusal('create_plugin')).toEqual({
      error: 'The tool "create_plugin" is not available to this connection: it acts as the bot "ops" (ops@agent.hexis), which is not offered it.',
      code: NOT_AVAILABLE_TO_CONNECTION,
    });
    // A discovery read is answered whatever tools the bot is offered.
    expect(scope.platformToolRefusal('list_skills', { discovery: true })).toBeNull();
    // Skills and connectors are not narrowed: the bot's own access already decided them.
    expect(scope.allowsSkill('Skills/Anything')).toBe(true);
    expect(scope.connectorFilter()).toBeUndefined();
    expect(scope.describe()).toMatch(/acts as the bot "ops" \(ops@agent\.hexis\), not as the person who made it/);
  });

  it('a bot offered every tool is refused none', () => {
    expect(ConnectionScope.asBot(BOT, null, 'fp').platformToolRefusal('create_plugin')).toBeNull();
  });

  it('a connection that loads nothing refuses everything, discovery included, with its sentence', () => {
    const scope = ConnectionScope.unavailable(BOT, 'It loads nothing.', 'fp');
    expect(scope.platformToolRefusal('read_file')).toEqual({ error: 'It loads nothing.', code: NOT_AVAILABLE_TO_CONNECTION });
    expect(scope.platformToolRefusal('list_skills', { discovery: true })).not.toBeNull();
    expect(scope.allowsSkill('Skills/x')).toBe(false);
    expect(scope.skillFilter()?.('Skills/x')).toBe(false);
    expect(scope.describe()).toBe('It loads nothing.');
  });
});
