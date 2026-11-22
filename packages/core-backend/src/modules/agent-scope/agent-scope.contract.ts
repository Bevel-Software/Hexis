import type { ConnectionChoice, IBots, Principal, ResolvedConnection } from '../bots/index.js';
import { ConnectionScope } from './connection-scope.js';

/**
 * Whom a call of a connection acts as: `actor` is the identity every check of
 * the call is judged for (the bot's row for a connection made as a bot, the
 * person otherwise), `madeBy` the person who made a bot's connection, and
 * `scope` what the connection may load.
 */
export interface ConnectionIdentity {
  actor: Principal;
  madeBy: Principal | null;
  scope: ConnectionScope;
}

/** The scope a resolved connection loads. */
export function scopeOf(resolved: ResolvedConnection): ConnectionScope {
  switch (resolved.kind) {
    case 'myself':
      return ConnectionScope.myself();
    case 'bot':
      return ConnectionScope.asBot(
        { path: resolved.actor.email, name: resolved.bot.name },
        resolved.platformTools,
        `bot\u0000${resolved.actor.id}\u0000${resolved.platformTools?.join(',') ?? '*'}`,
      );
    case 'unavailable':
      return ConnectionScope.unavailable(
        { path: resolved.bot.id, name: resolved.bot.name },
        resolved.sentence,
        `bot\u0000${resolved.bot.id}\u0000unavailable\u0000${resolved.sentence}`,
      );
  }
}

/**
 * THE way a credential becomes whom its call acts as — every credential
 * verifier asks this, on every call, with the person the credential belongs
 * to and the choice it records. No choice is Myself, without asking anything.
 * A choice of a bot is resolved through the bots mechanism NOW, so a bot that
 * stopped being usable, or a maker who may no longer act as it, stops the
 * very next call: the connection then loads nothing (`scope` says why) and is
 * never handed the person's access. A choice with no bots mechanism to read
 * it (a construction that wired none) loads nothing too.
 */
export async function resolveConnectionIdentity(
  bots: Pick<IBots, 'resolveConnection'> | undefined,
  maker: Principal,
  choice: ConnectionChoice,
): Promise<ConnectionIdentity> {
  if (!choice.botUserId && !choice.agentPath) return { actor: maker, madeBy: null, scope: ConnectionScope.myself() };
  const resolved: ResolvedConnection = bots
    ? await bots.resolveConnection(maker, choice)
    : {
        kind: 'unavailable',
        bot: { id: choice.botUserId ?? choice.agentPath ?? '', name: choice.agentPath ?? 'unknown' },
        sentence: 'This connection was made as a bot, and this deployment has no bots, so it loads nothing.',
        reason: 'this deployment has no bots',
      };
  if (resolved.kind === 'bot') return { actor: resolved.actor, madeBy: resolved.madeBy, scope: scopeOf(resolved) };
  // Myself (a mechanism that found no choice) or unavailable: the person stays
  // the identity, and an unavailable scope refuses every surface before it reads.
  return { actor: maker, madeBy: null, scope: scopeOf(resolved) };
}

/**
 * The scope of the call `auth` was verified for: what the verifier resolved,
 * or Myself for a caller with no connection to speak of (an internal caller,
 * a session). The one way a surface reads it.
 */
export function connectionOf(auth: { connection?: ConnectionScope } | undefined): ConnectionScope {
  return auth?.connection ?? ConnectionScope.myself();
}
