import { resolveConnectionScope, type ConnectionScope, type IAgentScopeResolver } from '../agent-scope/index.js';

/** Who a read is made for: what a request's credential resolved to (a `ToolAuth`'s user and agent). */
export interface ReadCaller {
  userId?: string | null;
  /** The agent configuration the credential connects as; absent or null for Everything. */
  agentPath?: string | null;
}

/** What {@link createCallerScope} is built from. */
export interface CallerScopeSources {
  /** The caller's user id → their email. */
  resolveUserEmail: (userId: string) => Promise<string | undefined>;
  /** Resolves the scope of a connection made as an agent configuration (`modules/agent-scope`). */
  agentScope?: Pick<IAgentScopeResolver, 'resolve'>;
}

/**
 * A caller's email and the scope their connection is narrowed to, for the
 * readers of a caller's manuals (the manual list, the platform manual, an
 * inline manual), so each derives them the same way. The email is resolved
 * from the user id, and is undefined when there is no user id or it cannot be
 * resolved. The scope is `resolveConnectionScope`'s for that email and the
 * credential's agent: Everything when the credential names no agent.
 */
export function createCallerScope(
  deps: CallerScopeSources,
): (caller: ReadCaller) => Promise<{ email: string | undefined; scope: ConnectionScope }> {
  return async (caller) => {
    let email: string | undefined;
    if (caller.userId) {
      try {
        email = await deps.resolveUserEmail(caller.userId);
      } catch {
        email = undefined;
      }
    }
    return { email, scope: await resolveConnectionScope(deps.agentScope, email, caller.agentPath) };
  };
}
