import { describe, it, expect } from 'vitest';
import { parseDocument } from 'yaml';
import { extractFrontmatter } from '@bevel-software/platform-shared';
import { newSkillMarkdown } from '../services/library.api';

/**
 * The scaffold a new skill starts from, read back with the same YAML parser
 * the catalog uses. A folder name is free text short of `/` and `\`, so the
 * `name` line has to survive names YAML would otherwise read as something
 * else: a comment, a nested mapping, a number.
 */
function frontmatter(name: string): Record<string, unknown> {
  const fm = extractFrontmatter(newSkillMarkdown(name));
  if (!fm) throw new Error('no frontmatter fence');
  return parseDocument(fm.frontmatter).toJS() as Record<string, unknown>;
}

describe('newSkillMarkdown', () => {
  it('opens with name, an empty description and metadata.version 1.0.0', () => {
    expect(frontmatter('rfi')).toEqual({ name: 'rfi', description: null, metadata: { version: '1.0.0' } });
    expect(newSkillMarkdown('rfi').endsWith('---\n\n')).toBe(true);
  });

  it.each(['#draft', 'a: b', '2024', 'yes', '[x] done', 'he said "hi"', 'ünïcode'])(
    'reads the name back as itself for %j',
    (name) => {
      expect(frontmatter(name).name).toBe(name);
    },
  );
});
