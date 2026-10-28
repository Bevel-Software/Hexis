import { describe, expect, it } from 'vitest';
import { ConnectionScope, NOT_AVAILABLE_TO_CONNECTION } from '../index.js';

/**
 * The one policy for a platform-tool call by a connection: what every route
 * that is a platform tool answers, hosted by `toolHandler` or mounted on its
 * own. Pinned here so the two kinds of route cannot answer differently.
 */

const AGENT = { path: 'Agents/ops.agent', name: 'ops' };
const narrowedTo = (platformTools: string[] | null) =>
  ConnectionScope.narrowed(AGENT, { skills: [], connectors: [], platformTools }, 'fp');

describe('ConnectionScope.platformToolRefusal', () => {
  it('lets Everything call anything', () => {
    expect(ConnectionScope.everything().platformToolRefusal('create_plugin')).toBeNull();
  });

  it('lets a narrowed connection call the tools its configuration lists, and refuses the rest by name and agent', () => {
    const scope = narrowedTo(['read_file']);
    expect(scope.platformToolRefusal('read_file')).toBeNull();
    expect(scope.platformToolRefusal('create_plugin')).toEqual({
      error:
        'The tool "create_plugin" is not available to this connection: it is connected as the agent "ops" (`Agents/ops.agent`), which does not load it.',
      code: NOT_AVAILABLE_TO_CONNECTION,
    });
    // A configuration that names no platform tools loads them all.
    expect(narrowedTo(null).platformToolRefusal('create_plugin')).toBeNull();
  });

  it('answers a discovery read to a narrowed connection whatever tools it is offered, never to one that loads nothing', () => {
    expect(narrowedTo(['read_file']).platformToolRefusal('list_skills', { discovery: true })).toBeNull();
    expect(narrowedTo(['read_file']).platformToolRefusal('list_skills')).not.toBeNull();
    const gone = ConnectionScope.gone('Agents/gone.agent');
    expect(gone.platformToolRefusal('list_skills', { discovery: true })).toEqual({
      error: gone.refusal('list_skills'),
      code: NOT_AVAILABLE_TO_CONNECTION,
    });
  });

  it('refuses every tool to a connection whose configuration cannot be used, with the sentence that says why', () => {
    const refusal = ConnectionScope.gone('Agents/gone.agent').platformToolRefusal('read_file');
    expect(refusal?.code).toBe(NOT_AVAILABLE_TO_CONNECTION);
    expect(refusal?.error).toMatch(/no longer exists or which you can no longer read/);
  });
});
