import { canonicalEmail } from './email-identity.js';

/**
 * The columns that record the person behind a BOT's action (`modules/bots`)
 * beside its author: the person who made the connection the bot acts
 * through. All null for a person's own action. ONE spelling, so every table
 * that keeps an author keeps the person behind a bot the same way.
 */
export function madeByColumns(madeBy: { name: string; email: string } | undefined): {
  madeByEmail: string | null;
  madeByEmailBidx: string | null;
  madeByName: string | null;
} {
  if (!madeBy) return { madeByEmail: null, madeByEmailBidx: null, madeByName: null };
  const email = canonicalEmail(madeBy.email);
  return { madeByEmail: email, madeByEmailBidx: email, madeByName: madeBy.name };
}

/** The git trailer a bot's commit carries, naming the person behind it; null for a person's own commit. */
export function madeByTrailer(madeBy: { name: string; email: string } | undefined): string | null {
  if (!madeBy) return null;
  // The same characters git's author parsing cannot take are dropped here.
  const clean = (s: string) => s.replace(/[\r\n<>]/g, '').trim();
  return `Made-by: ${clean(madeBy.name)} <${clean(canonicalEmail(madeBy.email))}>`;
}
