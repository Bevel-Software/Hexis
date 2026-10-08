import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { coreMigrationsDir } from '../../../assets.js';

const MIGRATION = '0017_atlassian_account_links.sql';

async function sql(): Promise<string> {
  return fs.readFile(path.join(coreMigrationsDir(), MIGRATION), 'utf8');
}

/**
 * The account-link table already EXISTS on an enterprise database: the Bevel
 * Platform's own migration history created it, under this exact name and
 * shape, while the embed lived there. Such a database must be ADOPTED as it
 * stands, so every Atlassian link it holds keeps working and nobody re-links
 * after the upgrade.
 *
 * That property lives in how this one file is WRITTEN, and the thing most
 * likely to break it is regenerating it: `drizzle-kit generate` emits a bare
 * `CREATE TABLE` and a bare `ADD CONSTRAINT`, either of which fails on a
 * database that already has them — and a failed migration crash-loops the
 * boot. So the guards are pinned here.
 */
describe('the account-link migration adopts a database that already has the table', () => {
  it('creates the table only if it is absent', async () => {
    expect(await sql()).toMatch(/CREATE TABLE IF NOT EXISTS "atlassian_account_links"/i);
  });

  it('adds the foreign key behind an existence guard, under the name the enterprise used', async () => {
    const text = await sql();
    // The NAME is what the guard recognises. A different one would add a
    // second, duplicate constraint to an upgraded database.
    const name = 'atlassian_account_links_user_id_users_id_fk';
    // The guard looks for THIS name, as a foreign key with the cascade, and
    // the constraint it adds when the guard finds nothing carries the same
    // one — tied together, so a guard naming anything else fails here.
    const guard = /IF NOT EXISTS\s*\(\s*SELECT 1 FROM pg_constraint\s+WHERE([\s\S]*?)\)\s*THEN/i.exec(text);
    expect(guard).not.toBeNull();
    expect(guard![1]).toContain(`conname = '${name}'`);
    expect(guard![1]).toMatch(/contype = 'f'/);
    expect(guard![1]).toMatch(/confdeltype = 'c'/);
    expect(text).toContain(`ADD CONSTRAINT "${name}"`);
    // Links die with the user: an erasure request must never be blocked by a
    // leftover embed link.
    expect(text).toMatch(/ON DELETE cascade/i);
  });

  it('creates the by-user index only if it is absent', async () => {
    expect(await sql()).toMatch(/CREATE INDEX IF NOT EXISTS "atlassian_account_links_by_user"/i);
  });

  /**
   * Nothing here may remove or rewrite a row or a column somebody is using.
   *
   * Matched on STATEMENTS rather than on words: `ON DELETE cascade` and `ON
   * UPDATE no action` are referential actions on the key being added, not
   * destructive statements, and a word-level rule would forbid the very
   * clause that makes an erasure request work.
   */
  it('is purely additive — it drops nothing and rewrites nothing', async () => {
    const statements = (await sql())
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n')
      .split(';');
    // The VERB a statement opens with is what says whether it destroys
    // anything. `ON DELETE cascade` and `ON UPDATE no action` sit mid-clause
    // on the key being added and are the referential actions an erasure
    // request depends on; `ALTER COLUMN` is a rewrite wherever it appears.
    const destructive = statements.filter((statement) => {
      const body = statement.trim();
      // A statement opens a segment — or opens a block's body: inside a
      // `DO $$ BEGIN … IF … THEN … END IF; END $$` the first statement shares
      // its segment with the block's opening, so the verbs are looked for
      // after BEGIN / THEN / ELSE / LOOP as well.
      return (
        /(^|\b(BEGIN|THEN|ELSE|LOOP)\s+)(DROP|DELETE|TRUNCATE|UPDATE)\b/i.test(body) ||
        /ALTER\s+COLUMN/i.test(body)
      );
    });
    expect(destructive).toEqual([]);
  });

  it('is registered in the journal the runner reads, exactly once', async () => {
    const journal = JSON.parse(
      await fs.readFile(path.join(coreMigrationsDir(), 'meta', '_journal.json'), 'utf8'),
    ) as { entries: Array<{ tag: string; idx: number }> };
    const mine = journal.entries.filter((e) => e.tag === MIGRATION.replace(/\.sql$/, ''));
    expect(mine).toHaveLength(1);
    // The runner applies entries in ARRAY order, so the array order is the
    // ledger: every entry sits at the position its idx names, and this one
    // after every migration numbered before it.
    expect(journal.entries.map((e) => e.idx)).toEqual(journal.entries.map((_, i) => i));
    expect(journal.entries.findIndex((e) => e.tag === mine[0].tag)).toBe(mine[0].idx);
    expect(mine[0].tag.startsWith(String(mine[0].idx).padStart(4, '0'))).toBe(true);
  });
});
