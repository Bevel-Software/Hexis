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

  /**
   * The environment, the setup screen and a tenant record must mean the same
   * domains by the same value. A shipped file that names the allow-list either
   * reads it through `parseEmailDomainList` or only hands on the list another
   * file already parsed; a new reader that does neither fails here, however
   * its own parsing is written.
   */
  it('is how every file that names an allow-list reads it', async () => {
    const HANDS_ON_A_PARSED_LIST = ['core/create-core-services.ts', 'modules/auth/auth.service.ts'];
    const readersWithoutParser: string[] = [];
    for (const file of await shippedSources(SRC)) {
      const name = relative(SRC, file);
      if (name === 'shared/email-domains.ts' || HANDS_ON_A_PARSED_LIST.includes(name)) continue;
      const text = await readFile(file, 'utf8');
      if (/ALLOWED_EMAIL_DOMAINS|allowedEmailDomains/.test(text) && !text.includes('parseEmailDomainList')) {
        readersWithoutParser.push(name);
      }
    }
    expect(readersWithoutParser).toEqual([]);
  });
});
