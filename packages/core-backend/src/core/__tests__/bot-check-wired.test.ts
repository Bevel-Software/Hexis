import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Three services decide something for a bot by asking which addresses are
 * bots': access (a bot is not part of everyone, holds no role and is no
 * admin), version control (a bot merges a change request only where it may
 * write every file it changes) and auth (nobody signs in, is invited or is
 * made at a bot's address). A service that is not handed the check treats
 * every bot as a person, so each construction must pass the real one, and the
 * real one is the address book the bot service fills.
 *
 * Auth takes its check with no default, so the compiler holds it. Access and
 * version control take theirs last, behind defaulted parameters that a great
 * many fixtures rely on; they keep a no-bots default for those fixtures, and
 * this test holds the composition root to passing the real check. Read off the
 * source, as `erasure-slices-wired-once.test.ts` reads it: the root cannot be
 * built in a unit test (it wants a database, a git host and a disk).
 */

const compositionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../create-core-services.ts');

/** The text of the one `new <name>(…)` call in the root, up to its closing `);`. */
function constructionOf(source: string, name: string): string {
  const constructions = source.match(new RegExp(`new ${name}\\(`, 'g')) ?? [];
  expect(constructions, `${name} is constructed once in the root`).toHaveLength(1);
  const call = source.slice(source.indexOf(`new ${name}(`));
  return call.slice(0, call.indexOf('\n  );') + 5);
}

/** The last argument of a construction, comments and a trailing comma left out. */
function lastArgument(construction: string): string {
  const body = construction
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .replace(/,?\s*\);$/, '');
  return body.slice(body.lastIndexOf(',') + 1).trim();
}

describe('the bot check the composition root wires', () => {
  it('hands the bot service’s address book to access, version control and auth, as each one’s last argument', async () => {
    const source = await fs.readFile(compositionRoot, 'utf8');

    expect(lastArgument(constructionOf(source, 'AccessControlService'))).toBe('botAddresses');
    expect(lastArgument(constructionOf(source, 'AuthService'))).toBe('botAddresses');
    // Version control asks the access module, which holds the same book.
    expect(lastArgument(constructionOf(source, 'VersionControlService'))).toBe('(email) => accessControl.isBot(email)');

    // The book is made once, and it is the very book the bot service keeps
    // current: a bot service given a book of its own (its parameter has a
    // default) would fill that one, and access and auth would never see a bot.
    expect(source.match(/const botAddresses\b/g) ?? []).toHaveLength(1);
    expect(source.match(/new BotService\(/g) ?? [], 'BotService is constructed once in the root').toHaveLength(1);
    expect(source).toMatch(/new BotService\(\s*db,\s*settings,\s*botDirectory,\s*botAddresses,/);
  });
});
