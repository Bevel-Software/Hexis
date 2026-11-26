import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { frontmatterHead, frontmatterHeadOfWholeFile } from '../frontmatter-head.js';

/**
 * `frontmatterHeadOfWholeFile` reads a file to its end in one pass: the head it answers is the one
 * `frontmatterHead` answers, and every byte goes to the caller in order, so the caller can hash the file.
 */
describe('frontmatterHeadOfWholeFile', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-whole-head-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const CASES: Record<string, string | Buffer> = {
    'no frontmatter': '# A page\nwith a body\n',
    'a closed frontmatter': '---\nread:\n  - deny everyone\n---\n# body\n',
    'an opening fence never closed': '---\nread:\n  - deny everyone\n',
    'CRLF and padding around the fences': '--- \r\nread: [Sales]\r\n---\t\r\nbody\r\n',
    'empty': '',
    'a frontmatter, then more than one read of body': `---\nread: [Sales]\n---\n${'é line of body\n'.repeat(200_000)}`,
    'a frontmatter longer than one read': `---\nread:\n${'  - Sales\n'.repeat(20_000)}---\nbody\n`,
    'binary bytes': Buffer.from(Array.from({ length: 3_000_000 }, (_, i) => (i * 31) % 256)),
  };

  for (const [name, content] of Object.entries(CASES)) {
    it(`answers the head frontmatterHead answers and hands over every byte: ${name}`, async () => {
      const file = path.join(dir, 'f');
      await fs.writeFile(file, content);
      const chunks: Buffer[] = [];
      const head = await frontmatterHeadOfWholeFile(file, (chunk) => chunks.push(Buffer.from(chunk)));
      expect(head).toBe(await frontmatterHead(file));
      expect(Buffer.concat(chunks).equals(await fs.readFile(file))).toBe(true);
    });
  }
});
