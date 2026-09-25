import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { coreMigrationsDir } from '../../../assets.js';

/**
 * A knowledge base hosted beside others lives in a schema of its own, found
 * through `search_path`. A migration that spells `public.` runs against the
 * wrong schema there — creating the table in `public`, or guarding on a
 * constraint that lives elsewhere — and the tenant that runs it is the first
 * to find out. So no migration may name a schema: this reads every file the
 * runner would, so the rule cannot be forgotten by the next one.
 */
describe('core migrations', () => {
  it('never qualify a table with a schema', async () => {
    const dir = coreMigrationsDir();
    const files = (await fs.readdir(dir)).filter((name) => name.endsWith('.sql')).sort();
    expect(files.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const name of files) {
      const text = await fs.readFile(path.join(dir, name), 'utf8');
      text.split('\n').forEach((line, i) => {
        // Bare (`public.users`) and quoted (`"public"."users"`) alike: the
        // quoted spelling is what drizzle generates, and it is what a live
        // two-tenant run found still pointing every tenant's foreign keys at
        // a `public.users` that does not exist there.
        if (/\bpublic"?\./.test(line)) offenders.push(`${name}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
