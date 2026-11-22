/**
 * Whose secrets and sign-ins the Secrets and Connect tools pages show: the
 * signed-in person's, or a bot's when the page was opened by a link that
 * names one (`?bot=<id>`), or — on the consent step — when the connection is
 * being made as a bot. The ONE place the bot is named for the requests: every
 * secrets-vault API call passes its path through {@link secretsPath}, so a
 * page opened for a bot cannot read one list as the bot and save a value as
 * the person.
 *
 * Only those two pages set it, while they are mounted, and they clear it when
 * they leave: no other page changes whom it acts for, and the server checks
 * on every request that the person may act as the bot.
 */
let current: { bot: string; token: symbol } | null = null;

/** Act for `bot` (null: the person) until the returned release is called. */
export function actForBot(bot: string | null): () => void {
  if (!bot) {
    current = null;
    return () => {};
  }
  const token = Symbol(bot);
  current = { bot, token };
  return () => {
    // Only the page that set it clears it: a page mounted after this one
    // keeps its own.
    if (current?.token === token) current = null;
  };
}

/** The bot the secrets pages act for now, or null. */
export function actingForBot(): string | null {
  return current?.bot ?? null;
}

/** `path` for the current page: with `bot=<id>` added when it acts for a bot. */
export function secretsPath(path: string): string {
  const bot = actingForBot();
  if (!bot) return path;
  return `${path}${path.includes('?') ? '&' : '?'}bot=${encodeURIComponent(bot)}`;
}

/** The bot a page was opened for, from its link (`?bot=<id>`); null when it names none. */
export function botFromLocation(search: string = window.location.search): string | null {
  const bot = new URLSearchParams(search).get('bot');
  return bot && bot.trim() ? bot.trim() : null;
}
