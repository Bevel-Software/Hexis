import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import type { FileTreeEntry, IWorkspaceService } from '@bevel-software/platform-shared';
import {
  KbReferenceScanner,
  findRoleRefsInText,
  rewriteRoleTokensInText,
} from '../reference-scan.js';

/**
 * Unit tests for the shared reference scanner's parse rules (comments,
 * nested-mapping verb keys) and its candidate/freshness machinery (`.tool`
 * frontmatter coverage, event-bus cache invalidation).
 */

describe('findRoleRefsInText / rewriteRoleTokensInText — comment handling', () => {
  it('a trailing comment is stripped for MATCHING (the resolver’s rule)', () => {
    const md = '---\nread:\n  - GTM Team  # sales folks\n---\n';
    // The token is `gtm team`, never `gtm team # sales folks`.
    expect(findRoleRefsInText(md)).toEqual([{ role: 'gtm team', verb: 'read' }]);
  });

  it('a trailing comment is PRESERVED by the rewrite', () => {
    const md = '---\nread:\n  - GTM Team  # sales folks\nwrite:\n  - deny GTM Team # blocked\n---\n';
    const out = rewriteRoleTokensInText(md, 'gtm team', 'Go To Market');
    expect(out).toContain('  - Go To Market  # sales folks');
    expect(out).toContain('  - deny Go To Market # blocked');
  });

  it('an inline scalar with a trailing comment matches and rewrites (comment kept)', () => {
    const md = '---\nowner: Sales # the owning team\n---\n';
    expect(findRoleRefsInText(md)).toEqual([{ role: 'sales', verb: 'owner' }]);
    const out = rewriteRoleTokensInText(md, 'sales', 'Revenue');
    expect(out).toContain('owner: Revenue # the owning team');
  });

  it('a full-line comment inside a block neither ends the block nor is an entry', () => {
    const md = '---\nread:\n  - Sales\n  # a note between items\n  - Support\n---\n';
    expect(findRoleRefsInText(md)).toEqual([
      { role: 'sales', verb: 'read' },
      { role: 'support', verb: 'read' },
    ]);
  });

  it('a verb key whose value is only a comment is not a reference', () => {
    const md = '---\nread:  # to be filled in\n  - Sales\n---\n';
    expect(findRoleRefsInText(md)).toEqual([{ role: 'sales', verb: 'read' }]);
  });
});

describe('findRoleRefsInText / rewriteRoleTokensInText — nested-mapping verb keys are not rules', () => {
  // The resolver only parses verbs at the rule mapping's ROOT (indent 0) —
  // an indented `read:` inside some unrelated config mapping must never be
  // scanned as a rule or rewritten during a rename.
  const md = [
    '---',
    'read:',
    '  - Sales',
    'someConfig:',
    '  nested:',
    '    read:',
    '      - Sales',
    '---',
    '',
  ].join('\n');

  it('scan skips the nested verb-looking key’s items', () => {
    expect(findRoleRefsInText(md)).toEqual([{ role: 'sales', verb: 'read' }]);
  });

  it('rename rewrites only the root-level rule, never the nested config', () => {
    const out = rewriteRoleTokensInText(md, 'sales', 'Revenue');
    const lines = out.split('\n');
    expect(lines).toContain('  - Revenue'); // the real rule, rewritten
    expect(lines).toContain('      - Sales'); // the nested config, untouched
  });
});

// ---------------------------------------------------------------------------
// KbReferenceScanner — candidates + freshness
// ---------------------------------------------------------------------------

const KB = 'knowledge-base';

function stubWorkspace(workspaceDir: string): IWorkspaceService {
  const buildTree = async (absDir: string): Promise<FileTreeEntry> => {
    const rel = path.relative(workspaceDir, absDir).replace(/\\/g, '/');
    const children: FileTreeEntry[] = [];
    for (const e of await fs.readdir(absDir, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const childAbs = path.join(absDir, e.name);
      if (e.isDirectory()) children.push(await buildTree(childAbs));
      else if (e.isFile()) {
        children.push({
          name: e.name,
          relativePath: path.relative(workspaceDir, childAbs).replace(/\\/g, '/'),
          type: 'file',
        });
      }
    }
    return { name: path.basename(absDir), relativePath: rel || '.', type: 'directory', children };
  };
  return {
    getWorkspacePath: async () => workspaceDir,
    listFiles: async () => buildTree(workspaceDir),
  } as unknown as IWorkspaceService;
}

async function write(repo: string, rel: string, contents: string): Promise<void> {
  const abs = path.join(repo, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, contents);
}

describe('KbReferenceScanner — .tool frontmatter is scanned and rewritten like .md', () => {
  it('finds a .tool frontmatter grant and a rename rewrites it (body untouched)', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-refscan-'));
    try {
      const repo = path.join(root, KB);
      const toolBody = 'name: crm\ntype: mcp\n# not frontmatter below\n';
      await write(repo, 'Plugins/GTM/crm.tool', `---\nread:\n  - GTM Team\n---\n${toolBody}`);
      await write(repo, 'Plugins/GTM/notes.md', '---\nowner: GTM Team\n---\n# notes\n');
      const scanner = new KbReferenceScanner(stubWorkspace(root), KB);

      const byToken = await scanner.scan('ws-1');
      const hits = (byToken.get('gtm team') ?? []).map((h) => h.path).sort();
      expect(hits).toEqual(['Plugins/GTM/crm.tool', 'Plugins/GTM/notes.md']);

      const writes = await scanner.rewriteReferences('ws-1', 'gtm team', 'Go To Market', (m) => new Error(m));
      const toolWrite = writes.find((w) => w.repoRelativePath === 'Plugins/GTM/crm.tool')!;
      expect(toolWrite.content).toContain('  - Go To Market');
      // The .tool body below the frontmatter is byte-for-byte intact.
      expect(toolWrite.content).toContain(toolBody);
      expect(writes.some((w) => w.repoRelativePath === 'Plugins/GTM/notes.md')).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('KbReferenceScanner — event-bus cache invalidation', () => {
  it('drops the cached scan when a scanned-extension file changes in the workspace', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-refscan-bus-'));
    try {
      const repo = path.join(root, KB);
      await write(repo, 'team/access.md', '---\nread:\n  - Sales\n---\n');
      const listeners: ((e: { kind: string; workspaceId?: string; path?: string }) => void)[] = [];
      const bus = { onEmit: (l: (typeof listeners)[number]) => (listeners.push(l), () => undefined) };
      const scanner = new KbReferenceScanner(stubWorkspace(root), KB, bus);

      expect((await scanner.scan('ws-1')).get('sales')).toHaveLength(1);

      // A grant lands through the share dialog (outside the admin services):
      // the write itself, then its file-changed event.
      await write(repo, 'team/access.md', '---\nread:\n  - Sales\n  - Support\n---\n');
      // Without invalidation the cached scan (30s TTL) would still miss Support.
      expect((await scanner.scan('ws-1')).get('support')).toBeUndefined();

      for (const l of listeners) {
        l({ kind: 'file-changed', workspaceId: 'ws-1', path: `${KB}/team/access.md` });
      }
      expect((await scanner.scan('ws-1')).get('support')).toHaveLength(1);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('ignores events for non-scanned extensions and other kinds', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-refscan-bus2-'));
    try {
      const repo = path.join(root, KB);
      await write(repo, 'team/access.md', '---\nread:\n  - Sales\n---\n');
      const listeners: ((e: { kind: string; workspaceId?: string; path?: string }) => void)[] = [];
      const bus = { onEmit: (l: (typeof listeners)[number]) => (listeners.push(l), () => undefined) };
      const scanner = new KbReferenceScanner(stubWorkspace(root), KB, bus);

      const first = await scanner.scan('ws-1');
      for (const l of listeners) {
        l({ kind: 'file-changed', workspaceId: 'ws-1', path: `${KB}/roles.yaml` });
        l({ kind: 'fs-tree-changed', workspaceId: 'ws-1' });
      }
      // Cache retained — same map instance served.
      expect(await scanner.scan('ws-1')).toBe(first);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
