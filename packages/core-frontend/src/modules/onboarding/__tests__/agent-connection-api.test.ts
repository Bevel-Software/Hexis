import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchAgentConnection } from '../services/agent-connection.api';

/**
 * `GET /api/onboarding/agent-connection`, read field by field: the two
 * documented shapes come through, and anything else is a failure — never a
 * quiet "not connected", and never a stray value steering the first-page
 * step's links.
 */

const { authFetchMock } = vi.hoisted(() => ({ authFetchMock: vi.fn() }));
vi.mock('../../../lib/api', () => ({ authFetch: authFetchMock }));

function answer(body: unknown, status = 200) {
  authFetchMock.mockResolvedValueOnce({ ok: status < 400, status, json: async () => body } as Response);
}

beforeEach(() => {
  authFetchMock.mockReset();
});

describe('fetchAgentConnection', () => {
  it('reads "not yet"', async () => {
    answer({ connected: false });
    await expect(fetchAgentConnection()).resolves.toEqual({ connected: false });
  });

  it('reads "connected", with when, as what and through which kind of credential', async () => {
    answer({ connected: true, at: '2026-10-07T12:00:00.000Z', client: 'Claude', kind: 'agent' });
    await expect(fetchAgentConnection()).resolves.toEqual({
      connected: true,
      at: '2026-10-07T12:00:00.000Z',
      client: 'Claude',
      kind: 'agent',
    });
  });

  it('throws on a refusal', async () => {
    answer({ error: 'nope' }, 401);
    await expect(fetchAgentConnection()).rejects.toThrow('agent-connection: 401');
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['no connected flag', { client: 'Claude' }],
    ['a connected flag that is not a boolean', { connected: 'yes' }],
    ['a non-string time', { connected: true, at: 1700000000000 }],
    ['a non-string client', { connected: true, client: { name: 'Claude' } }],
    ['an unknown kind', { connected: true, client: 'Claude', kind: 'oauth' }],
  ])('throws on a malformed body: %s', async (_label, body) => {
    answer(body);
    await expect(fetchAgentConnection()).rejects.toThrow('agent-connection: malformed body');
  });
});
