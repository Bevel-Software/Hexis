import { describe, expect, it, vi } from 'vitest';
import { describeConnectionChoices } from '../index.js';

/**
 * What a list of connections shows for each: Myself, a bot by name, or a bot
 * it stopped acting as. One look at the bots for the whole list, and a list
 * that cannot judge its bots still loads, each such row shown as not checked.
 */

const DANA = { id: 'u-dana', email: 'dana@acme.com' };
const MYSELF = { botUserId: null, agentPath: null };
const AS_OPS = { botUserId: 'u-ops', agentPath: null };

describe('describeConnectionChoices', () => {
  it('asks the bots once for the whole list, and answers each row in order', async () => {
    const resolveConnections = vi.fn(async (items: readonly unknown[]) =>
      items.map((_, i) =>
        i === 0
          ? ({ kind: 'myself' } as const)
          : i === 1
            ? ({ kind: 'bot', actor: { id: 'u-ops', email: 'ops@agent.hexis' }, madeBy: DANA, bot: { id: 'ops', name: 'Ops' }, platformTools: null } as const)
            : ({ kind: 'unavailable', bot: { id: 'ops', name: 'Ops' }, sentence: 's', reason: 'you may no longer edit this bot' } as const),
      ),
    );
    const out = await describeConnectionChoices({ resolveConnections }, [
      { maker: DANA, choice: MYSELF },
      { maker: DANA, choice: AS_OPS },
      { maker: DANA, choice: AS_OPS },
    ]);
    expect(resolveConnections).toHaveBeenCalledTimes(1);
    expect(out).toEqual([
      { kind: 'myself' },
      { kind: 'bot', name: 'Ops', stopped: null },
      { kind: 'bot', name: 'Ops', stopped: 'you may no longer edit this bot' },
    ]);
  });

  it('asks nothing for a list of Myself connections', async () => {
    const resolveConnections = vi.fn();
    expect(await describeConnectionChoices({ resolveConnections }, [{ maker: DANA, choice: MYSELF }])).toEqual([{ kind: 'myself' }]);
    expect(resolveConnections).not.toHaveBeenCalled();
  });

  it('still loads when the bots cannot be listed: each bot row is shown as not checked', async () => {
    const out = await describeConnectionChoices(
      { resolveConnections: async () => Promise.reject(new Error('repo down')) },
      [
        { maker: DANA, choice: MYSELF },
        { maker: DANA, choice: AS_OPS },
      ],
    );
    expect(out).toEqual([{ kind: 'myself' }, { kind: 'bot', name: 'a bot', stopped: 'could not be checked' }]);
  });
});
