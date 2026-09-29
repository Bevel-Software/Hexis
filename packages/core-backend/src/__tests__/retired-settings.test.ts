import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CoreConfig } from '../core-config.js';
import { PLATFORM_HEADER, TOOL_PREFIX_LINE } from '../modules/agent-instructions/compose.js';

/**
 * What a deployment is left holding after the per-conversation boundary moved
 * out of these packages: a variable nobody reads, a table nobody touches, and
 * no wording that names what Hexis no longer knows about.
 */

const REQUIRED = {
  KB_REPO_URL: 'https://example.com/org/kb.git',
  ADMIN_EMAIL: 'root@example.com',
  ADMIN_PASSWORD: 'sup3r-secret',
  JWT_SECRET: 'test-jwt-secret',
  SECRETS_ENC_KEY: 'kToAi8FXWDpDn3A6yQ/60O39bv05N7XzVOIu/0CJrFc=',
};

let saved: NodeJS.ProcessEnv;

beforeEach(() => {
  saved = { ...process.env };
  delete process.env.ONTOLOGY_SESSION_BLOCK;
  Object.assign(process.env, REQUIRED);
});

afterEach(() => {
  process.env = saved;
});

describe('ONTOLOGY_SESSION_BLOCK is retired', () => {
  it('is ignored: the config builds either way, with no such setting on it', () => {
    for (const value of ['false', 'true', 'nonsense']) {
      process.env.ONTOLOGY_SESSION_BLOCK = value;
      const config = new CoreConfig();
      expect(() => config.kbRepoUrl).not.toThrow();
      expect(config).not.toHaveProperty('ontologySessionBlock');
    }
  });

  it('a config built with it set is the same as one built without it', () => {
    const without = JSON.stringify(new CoreConfig());
    process.env.ONTOLOGY_SESSION_BLOCK = 'false';
    expect(JSON.stringify(new CoreConfig())).toBe(without);
  });

  it('no variable named for it is documented any more', async () => {
    const here = fileURLToPath(new URL('.', import.meta.url));
    const docs = await readFile(join(here, '../../../../docs/configuration.md'), 'utf8');
    expect(docs).not.toContain('ONTOLOGY_SESSION_BLOCK');
    expect(docs.toLowerCase()).not.toContain('ontolog');
  });
});

describe('what an agent or a person reads names no ontology', () => {
  it('the server instructions do not', () => {
    expect(PLATFORM_HEADER.toLowerCase()).not.toContain('ontolog');
    expect(TOOL_PREFIX_LINE.toLowerCase()).not.toContain('ontolog');
  });
});

/**
 * The table stays in this release so that no deployment runs a version in
 * which neither side has it — but nothing in this package may read or write it
 * any more. The schema file that declares it is the one and only mention.
 */
describe('session_ontology_touches is unused', () => {
  it('is named by the schema that declares it and by nothing else', async () => {
    const src = fileURLToPath(new URL('..', import.meta.url));
    const self = fileURLToPath(import.meta.url);
    const found: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(path);
          continue;
        }
        // This file names the table to look for it; it is not a use of it.
        if (!entry.name.endsWith('.ts') || path === self) continue;
        const text = await readFile(path, 'utf8');
        if (text.includes('sessionOntologyTouches') || text.includes('session_ontology_touches')) {
          found.push(path.slice(src.length));
        }
      }
    };
    await walk(src);
    expect(found).toEqual(['modules/database/core-schema.ts']);
  });
});
