import { createContext, useContext } from 'react';

/**
 * Whose secrets and sign-ins a request reads or writes: a bot's id, or null
 * for the signed-in person.
 *
 * Only the Secrets and Connect tools pages ever act for a bot: opened by a
 * link that names one (`?bot=<id>`), or — on the consent step — while the
 * connection is being made as one. They PROVIDE {@link ActingForBot} to
 * what they render, and every secrets-vault API call takes the bot as an
 * explicit argument. Nothing is kept anywhere else: a request made by any
 * other part of the app (the Skills & Tools lists, the search palette, a
 * tool page) is the person's, even while one of those pages is open, so no
 * answer about a bot can be cached and shown as the person's after they
 * leave. The server checks on every request that the person may act as the
 * bot.
 */
export type ActingFor = string | null;

/** The bot the enclosing Secrets or Connect tools page acts for; null (the default) everywhere else. */
export const ActingForBot = createContext<ActingFor>(null);

/** The bot the enclosing page acts for, or null: the person. */
export function useActingForBot(): ActingFor {
  return useContext(ActingForBot);
}

/** `path` with `bot=<id>` added when the request acts for a bot; unchanged for the person. */
export function secretsPath(path: string, bot: ActingFor): string {
  if (!bot) return path;
  return `${path}${path.includes('?') ? '&' : '?'}bot=${encodeURIComponent(bot)}`;
}

/** The bot a page was opened for, from its link (`?bot=<id>`); null when it names none. */
export function botFromLocation(search: string = window.location.search): string | null {
  const bot = new URLSearchParams(search).get('bot');
  return bot && bot.trim() ? bot.trim() : null;
}
