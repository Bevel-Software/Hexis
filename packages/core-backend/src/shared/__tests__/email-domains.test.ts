import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseEmailDomainList } from '../email-domains.js';

const SRC = fileURLToPath(new URL('../..', import.meta.url));

async function shippedSources(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__' && entry.name !== 'node_modules') out.push(...(await shippedSources(full)));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('parseEmailDomainList', () => {
  it('reads commas and whitespace as separators, lower-cases, and drops a leading @ or .', () => {
    expect(parseEmailDomainList(' Email.COM , @example.org\n.eu.example.net,,')).toEqual([
      'email.com',
      'example.org',
      'eu.example.net',
    ]);
    expect(parseEmailDomainList('')).toEqual([]);
    expect(parseEmailDomainList(' , @ . ')).toEqual([]);
  });

  /** The environment, the setup screen and a tenant record must mean the same domains by the same value. */
  it('is the only place an allow-list is parsed', async () => {
    const copies: string[] = [];
    for (const file of await shippedSources(SRC)) {
      const text = await readFile(file, 'utf8');
      if (text.includes("replace(/^[@.]+/, '')")) copies.push(relative(SRC, file));
    }
    expect(copies).toEqual(['shared/email-domains.ts']);
  });
});
