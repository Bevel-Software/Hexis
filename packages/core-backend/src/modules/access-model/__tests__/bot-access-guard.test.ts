import { describe, expect, it } from 'vitest';
import { BotChangesAccessError, changesOwnAccessLines, isAccessFile, makeBotAccessWriteValidator } from '../index.js';

/**
 * A bot never changes access: the one definition of which files decide
 * access and when a write changes a file's own access lines, and the agent's
 * pre-disk check built on it.
 */

describe('isAccessFile', () => {
  it('names roles.yaml, every access.md and the group files, and nothing else', () => {
    for (const p of ['roles.yaml', 'access.md', 'Team/access.md', 'a/b/c/access.md', 'groups.yaml', 'synced-groups.yaml']) {
      expect(isAccessFile(p)).toBe(true);
    }
    for (const p of ['Team/notes.md', 'Team/roles.yaml', 'access.md.bak', 'Team/my-access.md']) {
      expect(isAccessFile(p)).toBe(false);
    }
  });
});

describe('changesOwnAccessLines', () => {
  const page = (fm: string, body = '# page\n') => `---\n${fm}---\n${body}`;
  it('sees a changed, added or removed access line', () => {
    expect(changesOwnAccessLines(page('nodeType: x\n'), page('nodeType: x\nread:\n  - everyone\n'))).toBe(true);
    expect(changesOwnAccessLines(page('read:\n  - everyone\n'), page('read:\n  - Engineer\n'))).toBe(true);
    expect(changesOwnAccessLines(page('read:\n  - everyone\n'), '# no frontmatter\n')).toBe(true);
    expect(changesOwnAccessLines(null, page('owner: Ada <ada@x.io>\n'))).toBe(true);
  });
  it('lets the body and the other frontmatter keys change freely', () => {
    expect(changesOwnAccessLines(page('nodeType: x\nread:\n  - everyone\n'), page('nodeType: y\nread:\n  - everyone\n', '# changed\n'))).toBe(false);
    expect(changesOwnAccessLines(null, '# a new page with no access lines\n')).toBe(false);
  });
  it('reads an entry as what it grants: a renamed person, a respelled role or a reflowed list is no change', () => {
    const before = page('read:\n  - Ada <ada@x.io>\n  - Engineer\n');
    expect(changesOwnAccessLines(before, page('read: ["Ada Lovelace <ADA@x.io>", "engineer"]\n'))).toBe(false);
    expect(changesOwnAccessLines(before, page('read:\n  - Ada <ada@x.io>\n  - "!Engineer"\n'))).toBe(true);
    expect(changesOwnAccessLines(before, page('read:\n  - Ada <bob@x.io>\n  - Engineer\n'))).toBe(true);
  });
});

describe('the bot\'s pre-disk write check', () => {
  const files = new Map<string, string>([['knowledge-base/Team/page.md', '---\nread:\n  - Engineer\n---\n# page\n']]);
  const validate = makeBotAccessWriteValidator('knowledge-base', async (p) => files.get(p) ?? null);

  it('refuses an access file outright, naming it', async () => {
    await expect(validate('knowledge-base/Team/access.md', 'read:\n  - everyone\n')).rejects.toBeInstanceOf(BotChangesAccessError);
    await expect(validate('knowledge-base/roles.yaml', 'roles: {}\n')).rejects.toThrow(/"roles\.yaml" decides who may reach what/);
  });

  it('refuses a write that changes a file\'s own access lines, and lets the rest of it through', async () => {
    await expect(validate('knowledge-base/Team/page.md', '---\nread:\n  - everyone\n---\n# page\n')).rejects.toThrow(
      /access lines \(read, write, download, owner\) of "Team\/page\.md"/,
    );
    await expect(validate('knowledge-base/Team/page.md', '---\nread:\n  - Engineer\n---\n# page, edited\n')).resolves.toBeUndefined();
  });

  it('judges content that arrives as bytes exactly as text', async () => {
    const changed = new TextEncoder().encode('---\nread:\n  - everyone\n---\n# page\n');
    await expect(validate('knowledge-base/Team/page.md', changed)).rejects.toBeInstanceOf(BotChangesAccessError);
    await expect(validate('knowledge-base/Team/page.md', Buffer.from(changed))).rejects.toBeInstanceOf(BotChangesAccessError);
    const same = new TextEncoder().encode('---\nread:\n  - Engineer\n---\n# page, edited\n');
    await expect(validate('knowledge-base/Team/page.md', same)).resolves.toBeUndefined();
  });

  it('leaves a path outside the knowledge base alone, and claims every path inside it', async () => {
    await expect(validate('elsewhere/access.md', 'x')).resolves.toBeUndefined();
    expect(validate.appliesTo('knowledge-base/x.md')).toBe(true);
    expect(validate.appliesTo('tmp/x.md')).toBe(false);
  });
});
