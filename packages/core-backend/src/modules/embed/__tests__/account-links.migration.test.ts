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
    expect(text).toContain('atlassian_account_links_user_id_users_id_fk');
    expect(text).toMatch(/IF NOT EXISTS\s*\(\s*SELECT 1 FROM pg_constraint/i);
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
      return /^(DROP|DELETE|TRUNCATE|UPDATE)\b/i.test(body) || /ALTER\s+COLUMN/i.test(body);
    });
    expect(destructive).toEqual([]);
  });

  it('is registered in the journal the runner reads, exactly once', async () => {
    const journal = JSON.parse(
      await fs.readFile(path.join(coreMigrationsDir(), 'meta', '_journal.json'), 'utf8'),
    ) as { entries: Array<{ tag: string; idx: number }> };
    const mine = journal.entries.filter((e) => e.tag === MIGRATION.replace(/\.sql$/, ''));
    expect(mine).toHaveLength(1);
    // After every migration that came before it, so the ledger stays ordered.
    expect(Math.max(...journal.entries.map((e) => e.idx))).toBe(mine[0].idx);
  });
});
