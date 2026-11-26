import { describe, expect, it } from 'vitest';
import { createCallerScope } from '../caller-scope.js';
import { ConnectionScope, type IAgentScopeResolver } from '../../agent-scope/index.js';

/**
 * The manual readers derive a caller's email and connection scope through
 * `createCallerScope`. Asserted with a resolver that records what it is asked
 * and answers as a distribution's does: Everything for no agent, the agent's
 * scope for one it knows, and a scope that loads nothing for any other.
 */
const AGENT = 'Agents/reader.agent';

function sources(emails: Record<string, string>, failing = new Set<string>()) {
  const asked: Array<{ email: string | undefined; agentPath: string | null | undefined }> = [];
  const agentScope: Pick<IAgentScopeResolver, 'resolve'> = {
    async resolve(email, agentPath) {
      asked.push({ email, agentPath });
      if (!agentPath) return ConnectionScope.everything();
      if (agentPath !== AGENT) return ConnectionScope.gone(agentPath);
      return ConnectionScope.narrowed({ path: AGENT, name: 'reader' }, { skills: [], connectors: [], platformTools: ['read_file'] }, 'v1');
    },
  };
  const resolveUserEmail = async (userId: string) => {
    if (failing.has(userId)) throw new Error('the database is down');
    return emails[userId];
  };
  return { asked, deps: { resolveUserEmail, agentScope } };
}

describe('createCallerScope', () => {
  it("answers the caller's email and Everything, without asking the resolver, for a credential with no agent", async () => {
    const { asked, deps } = sources({ ada: 'ada@example.com' });
    const { email, scope } = await createCallerScope(deps)({ userId: 'ada', agentPath: null });
    expect(email).toBe('ada@example.com');
    expect(scope.toWire()).toBeUndefined();
    expect(scope.allowsPlatformTool('anything')).toBe(true);
    expect(asked).toEqual([]);
  });

  it('asks the resolver for the agent the credential names, with the email', async () => {
    const { asked, deps } = sources({ ada: 'ada@example.com' });
    const { scope } = await createCallerScope(deps)({ userId: 'ada', agentPath: AGENT });
    expect(asked).toEqual([{ email: 'ada@example.com', agentPath: AGENT }]);
    expect(scope.toWire()?.agent.path).toBe(AGENT);
    expect(scope.allowsPlatformTool('read_file')).toBe(true);
    expect(scope.allowsPlatformTool('write_file')).toBe(false);
  });

  it('answers no email for no user id, or one whose email cannot be resolved, and still resolves the agent', async () => {
    const { asked, deps } = sources({}, new Set(['bob']));
    const callerScope = createCallerScope(deps);
    expect((await callerScope({ userId: null })).email).toBeUndefined();
    const failed = await callerScope({ userId: 'bob', agentPath: AGENT });
    expect(failed.email).toBeUndefined();
    expect(asked).toEqual([{ email: undefined, agentPath: AGENT }]);
  });

  it('answers a scope that loads nothing for an agent with no resolver to read it', async () => {
    const { scope } = await createCallerScope({ resolveUserEmail: async () => 'ada@example.com' })({
      userId: 'ada',
      agentPath: AGENT,
    });
    expect(scope.allowsPlatformTool('read_file')).toBe(false);
    expect(scope.toWire()?.unavailable).toEqual(expect.any(String));
  });
});
