import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import type { FileTreeEntry, IWorkspaceService } from '@bevel-software/platform-shared';
import {
  KbReferenceScanner,
  findRoleRefsInText,
  rewriteRoleTokensInText,
  UNSHOWN_REFERENCE_REFUSAL,
  translateRewriteWriteRefusal,
  type PathVisibility,
} from '../reference-scan.js';
import type { ITreeWalker } from '../../../shared/fs.contract.js';
import { NodeFs } from '../../kb-fs/node-fs.js';
import { AccessDeniedError } from '../../access-model/access-errors.js';

/** A renaming person who may read every path. */
const ALL_VISIBLE: PathVisibility = async (paths) => new Map(paths.map((p) => [p, true]));
/** A renaming person who may read none of them. */
const NONE_VISIBLE: PathVisibility = async (paths) => new Map(paths.map((p) => [p, false]));

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

describe('findRoleRefsInText / rewriteRoleTokensInText — indented ROOT mappings are live rules', () => {
  // The resolver's YAML-subset parser accepts a root mapping at ANY indent
  // (its root frame sits at indent -1), so `  read:` at column 2 with nothing
  // enclosing it is a rule the resolver ENFORCES. A column-zero-only scanner
  // would skip it — and a rename would strand the live grant.
  const md = ['---', '  read:', '    - Sales', '---', ''].join('\n');

  it('scan sees a uniformly-indented root verb key', () => {
    expect(findRoleRefsInText(md)).toEqual([{ role: 'sales', verb: 'read' }]);
  });

  it('rename rewrites the indented root rule, preserving indentation', () => {
    const out = rewriteRoleTokensInText(md, 'sales', 'Revenue');
    expect(out.split('\n')).toContain('    - Revenue');
    expect(out).not.toContain('Sales');
  });

  it('an indented root inline scalar matches and rewrites', () => {
    const scalar = '---\n  owner: Sales # team\n---\n';
    expect(findRoleRefsInText(scalar)).toEqual([{ role: 'sales', verb: 'owner' }]);
    expect(rewriteRoleTokensInText(scalar, 'sales', 'Revenue')).toContain(
      '  owner: Revenue # team',
    );
  });

  it('a verb key nested under an INDENTED root mapping is still not a rule', () => {
    // `config:` owns the root at indent 2; `read:` at indent 4 is ITS nested
    // key, not a root verb — the resolver never parses it as a rule.
    const nested = ['---', '  config:', '    read:', '      - Sales', '---', ''].join('\n');
    expect(findRoleRefsInText(nested)).toEqual([]);
    expect(rewriteRoleTokensInText(nested, 'sales', 'Revenue')).toBe(nested);
  });

  it('a structurally-broken region (the resolver rejects it) yields no refs and no rewrites', () => {
    // `- Sales` at the SAME indent as its key is a parse error to the subset
    // parser ("list item with no enclosing list") — the resolver enforces
    // nothing from this file, so the scan must not report a live grant.
    const broken = '---\nread:\n- Sales\n---\n';
    expect(findRoleRefsInText(broken)).toEqual([]);
    expect(rewriteRoleTokensInText(broken, 'sales', 'Revenue')).toBe(broken);
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

describe('translateRewriteWriteRefusal — the lock scope still sees what a failed restore left', () => {
  function refusal(unrestored?: Set<string>): AccessDeniedError {
    const err = new AccessDeniedError({ path: 'Hidden/secret.md', eligibleRoles: [], eligibleUsers: [] });
    if (unrestored) (err as { unrestoredPaths?: Set<string> }).unrestoredPaths = unrestored;
    return err;
  }

  it('a refusal on a hidden file carries unrestoredPaths onto the generic refusal', async () => {
    const unrestored = new Set(['KnowledgeBase/Hidden/secret.md']);
    const out = await translateRewriteWriteRefusal(refusal(unrestored), NONE_VISIBLE, (m) => new Error(m));
    expect((out as Error).message).toBe(UNSHOWN_REFERENCE_REFUSAL);
    expect((out as { unrestoredPaths?: Set<string> }).unrestoredPaths).toBe(unrestored);
  });

  it('a refusal with every file restored adds no unrestoredPaths', async () => {
    const out = await translateRewriteWriteRefusal(refusal(), NONE_VISIBLE, (m) => new Error(m));
    expect((out as { unrestoredPaths?: Set<string> }).unrestoredPaths).toBeUndefined();
  });

  it('a refusal on a readable file comes back as it was', async () => {
    const err = refusal(new Set(['x']));
    expect(await translateRewriteWriteRefusal(err, ALL_VISIBLE, (m) => new Error(m))).toBe(err);
  });
});

describe('KbReferenceScanner — .tool frontmatter is scanned and rewritten like .md', () => {
  it('finds a .tool frontmatter grant and a rename rewrites it (body untouched)', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-refscan-'));
    try {
      const repo = path.join(root, KB);
      const toolBody = 'name: crm\ntype: mcp\n# not frontmatter below\n';
      await write(repo, 'Plugins/GTM/crm.tool', `---\nread:\n  - GTM Team\n---\n${toolBody}`);
      await write(repo, 'Plugins/GTM/notes.md', '---\nowner: GTM Team\n---\n# notes\n');
      const scanner = new KbReferenceScanner(stubWorkspace(root), new NodeFs(), KB);

      const byToken = await scanner.scan('ws-1');
      const hits = (byToken.get('gtm team') ?? []).map((h) => h.path).sort();
      expect(hits).toEqual(['Plugins/GTM/crm.tool', 'Plugins/GTM/notes.md']);

      const writes = await scanner.rewriteReferences('ws-1', 'gtm team', 'Go To Market', (m) => new Error(m), ALL_VISIBLE);
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

describe('KbReferenceScanner — candidates are the resolver\'s walk, not the explorer\'s', () => {
  it('scans and rewrites an access.md that .bevelignore hides from the explorer', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-refscan-ignore-'));
    try {
      const repo = path.join(root, KB);
      await write(repo, '.bevelignore', 'Archive/\n');
      // The resolver walks past .bevelignore, so this rule is ENFORCED.
      await write(repo, 'Archive/access.md', '---\nwrite:\n  - Admin\n---\n');
      // The explorer's listing, as the real one answers: what .bevelignore
      // hides is not in it. A scan built on it would miss Archive/access.md.
      const base = stubWorkspace(root);
      const ws = {
        ...base,
        listFiles: async (id: string) => {
          const tree = await base.listFiles(id);
          const prune = (n: FileTreeEntry): FileTreeEntry => ({
            ...n,
            children: n.children
              ?.filter((c) => c.relativePath !== `${KB}/Archive`)
              .map(prune),
          });
          return prune(tree);
        },
      } as unknown as IWorkspaceService;
      const scanner = new KbReferenceScanner(ws, new NodeFs(), KB);

      expect((await scanner.scan('ws-1')).get('admin')).toEqual([{ path: 'Archive/access.md', verb: 'write' }]);
      const writes = await scanner.rewriteReferences('ws-1', 'admin', 'Admins', (m) => new Error(m), ALL_VISIBLE);
      expect(writes.map((w) => w.repoRelativePath)).toEqual(['Archive/access.md']);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('KbReferenceScanner — references are what the resolver parses', () => {
  // A body-governed access.md: the body is the folder's rules, the
  // frontmatter the file's own — here a FLOW sequence, which only the
  // resolver's full-YAML fallback reads. And a node whose owner is QUOTED.
  const FLOW_ACCESS_MD = '---\nread: ["Admin"]\n---\nwrite:\n  - Admin\n';
  const QUOTED_NODE = "---\nowner: 'Admin'\n---\n# Doc\n";

  it('the scan reports quoted and flow-YAML rules the resolver enforces', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-refscan-yaml-'));
    try {
      const repo = path.join(root, KB);
      await write(repo, 'Team/access.md', FLOW_ACCESS_MD);
      await write(repo, 'Team/Doc.md', QUOTED_NODE);
      const scanner = new KbReferenceScanner(stubWorkspace(root), new NodeFs(), KB);

      const hits = (await scanner.scan('ws-1')).get('admin') ?? [];
      expect(hits).toEqual(
        expect.arrayContaining([
          { path: 'Team/access.md', verb: 'write' },
          { path: 'Team/access.md', verb: 'read' },
          { path: 'Team/Doc.md', verb: 'owner' },
        ]),
      );
      expect(hits).toHaveLength(3);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('an access.md the resolver drops as broken references nothing', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-refscan-broken-'));
    try {
      // A scalar where the verb needs a list: a hard parse error, so the
      // resolver ignores the whole file.
      await write(path.join(root, KB), 'Team/access.md', '---\nread: Admin\nwrite:\n  - Admin\n---\n');
      const scanner = new KbReferenceScanner(stubWorkspace(root), new NodeFs(), KB);
      expect((await scanner.scan('ws-1')).get('admin')).toBeUndefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('a rename rewrites quoted and flow-YAML references in place, quoting and comments kept', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-refscan-structural-'));
    try {
      const repo = path.join(root, KB);
      await write(repo, 'Team/access.md', FLOW_ACCESS_MD);
      await write(repo, 'Team/Doc.md', "---\nnodeType: Doc # kept\nowner: 'Admin'\nread: [Sales, \"deny Admin\"]\n---\n# Doc\n");
      const scanner = new KbReferenceScanner(stubWorkspace(root), new NodeFs(), KB);
      const writes = await scanner.rewriteReferences('ws-1', 'admin', 'Admins', (m) => new Error(m), ALL_VISIBLE);
      const byPath = new Map(writes.map((w) => [w.repoRelativePath, w.content]));
      expect(byPath.get('Team/access.md')).toBe('---\nread: ["Admins"]\n---\nwrite:\n  - Admins\n');
      expect(byPath.get('Team/Doc.md')).toBe(
        "---\nnodeType: Doc # kept\nowner: 'Admins'\nread: [Sales, \"deny Admins\"]\n---\n# Doc\n",
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('an alias under a verb key is rewritten without touching the anchor it points at', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-refscan-alias-'));
    try {
      const repo = path.join(root, KB);
      await write(repo, 'Team/Doc.md', '---\nteam: &t Admin\nread: [*t]\n---\n');
      const scanner = new KbReferenceScanner(stubWorkspace(root), new NodeFs(), KB);
      const [w] = await scanner.rewriteReferences('ws-1', 'admin', 'Admins', (m) => new Error(m), ALL_VISIBLE);
      expect(w.content).toBe('---\nteam: &t Admin\nread: [Admins]\n---\n');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  // A Guard's Answer Is a Disclosure, and Widening a Primitive Traces Its
  // Consequences: a file the renaming person cannot read (another person's
  // private plugin) neither blocks the rename nor changes its answer —
  // whatever it holds, the rename completes and the file is rewritten like
  // any other, so no reference to the old name is stranded there.
  it.each([
    ['no reference', '---\nread:\n  - Sales\n---\n', null],
    ['a block-list reference', '---\nread:\n  - Admin\n---\n', '---\nread:\n  - Admins\n---\n'],
    ['a flow-YAML reference', FLOW_ACCESS_MD, '---\nread: ["Admins"]\n---\nwrite:\n  - Admins\n'],
  ])('a file the renaming person cannot read never blocks the rename (%s)', async (_label, secret, expected) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-refscan-hidden-'));
    try {
      const repo = path.join(root, KB);
      await write(repo, 'Team/access.md', '---\nread:\n  - Admin\n---\n');
      await write(repo, 'Secret/access.md', secret);
      const scanner = new KbReferenceScanner(stubWorkspace(root), new NodeFs(), KB);
      const onlyTeam: PathVisibility = async (paths) => new Map(paths.map((p) => [p, p.startsWith('Team/')]));
      const writes = await scanner.rewriteReferences('ws-1', 'admin', 'Admins', (m) => new Error(m), onlyTeam);
      const byPath = new Map(writes.map((w) => [w.repoRelativePath, w.content]));
      expect(byPath.get('Team/access.md')).toBe('---\nread:\n  - Admins\n---\n');
      expect(byPath.get('Secret/access.md') ?? null).toBe(expected);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('a rename by someone who can read nothing still completes', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-refscan-none-visible-'));
    try {
      await write(path.join(root, KB), 'Team/access.md', FLOW_ACCESS_MD);
      const scanner = new KbReferenceScanner(stubWorkspace(root), new NodeFs(), KB);
      const writes = await scanner.rewriteReferences('ws-1', 'admin', 'Admins', (m) => new Error(m), NONE_VISIBLE);
      expect(writes.map((w) => w.repoRelativePath)).toEqual(['Team/access.md']);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('KbReferenceScanner — a folder the walk cannot list', () => {
  /** The real walk, reporting `Locked` as a folder it could not list. */
  function walkerWithHole(hole = 'Locked'): ITreeWalker & { walks: number } {
    const disk = new NodeFs();
    const walker = {
      walks: 0,
      walk: (r: string, o: Parameters<NodeFs['walk']>[1], l: Parameters<NodeFs['walk']>[2]) => disk.walk(r, o, l),
      walkFiles: (r: string, m: (b: string) => boolean, o?: { strict?: boolean }) => disk.walkFiles(r, m, o),
      walkKb: async (r: string, l: Parameters<NodeFs['walkKb']>[1], o?: Parameters<NodeFs['walkKb']>[2]) => {
        walker.walks++;
        const result = await disk.walkKb(r, l, o);
        return { holes: [...result.holes, hole] };
      },
    };
    return walker;
  }

  it('a rename refuses with nothing written: the folder may hold references', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-refscan-hole-'));
    try {
      await write(path.join(root, KB), 'team/access.md', '---\nread:\n  - Sales\n---\n');
      const scanner = new KbReferenceScanner(stubWorkspace(root), walkerWithHole(), KB);
      await expect(
        scanner.rewriteReferences('ws-1', 'sales', 'Revenue', (m) => new Error(m), ALL_VISIBLE),
      ).rejects.toThrow(UNSHOWN_REFERENCE_REFUSAL);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  // The folder's own access.md may be as unreadable as its listing, so the
  // visibility check cannot see the rules that close it: never named.
  it('the refusal neither names nor counts the folder, even to someone who could read every path', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-refscan-hole-hidden-'));
    try {
      await write(path.join(root, KB), 'team/access.md', '---\nread:\n  - Sales\n---\n');
      const scanner = new KbReferenceScanner(stubWorkspace(root), walkerWithHole(), KB);
      const err = await scanner
        .rewriteReferences('ws-1', 'sales', 'Revenue', (m) => new Error(m), ALL_VISIBLE)
        .catch((e: Error) => e);
      expect((err as Error).message).toBe(UNSHOWN_REFERENCE_REFUSAL);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('a folder name with a line break cannot forge a second line in the refusal', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-refscan-hole3-'));
    try {
      await write(path.join(root, KB), 'team/access.md', '---\nread:\n  - Sales\n---\n');
      const scanner = new KbReferenceScanner(stubWorkspace(root), walkerWithHole('Lo\nFAKE: line'), KB);
      const err = await scanner
        .rewriteReferences('ws-1', 'sales', 'Revenue', (m) => new Error(m), ALL_VISIBLE)
        .catch((e: Error) => e);
      expect((err as Error).message).not.toContain('\n');
      expect((err as Error).message).not.toContain('FAKE');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('a file the rewrite cannot read is neither named nor counted, and its fs cause stays out of the error', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-refscan-unreadable-'));
    try {
      const repo = path.join(root, KB);
      await write(repo, 'team/access.md', '---\nread:\n  - Sales\n---\n');
      // The walk lists team/Ghost.md, but there is no file to read.
      const disk = new NodeFs();
      const walker: ITreeWalker = {
        walk: (r, o, l) => disk.walk(r, o, l),
        walkFiles: (r, m, o) => disk.walkFiles(r, m, o),
        walkKb: async (r, l, o) => {
          const result = await disk.walkKb(r, l, o);
          for (const listener of l) listener.onFile?.('team', 'Ghost.md');
          return result;
        },
      };
      const scanner = new KbReferenceScanner(stubWorkspace(root), walker, KB);
      const causes: (string | undefined)[] = [];
      const err = await scanner
        .rewriteReferences(
          'ws-1',
          'sales',
          'Revenue',
          (m, cause) => {
            causes.push(cause);
            return new Error(m);
          },
          ALL_VISIBLE,
        )
        .catch((e: Error) => e);
      expect((err as Error).message).toBe(UNSHOWN_REFERENCE_REFUSAL);
      expect(causes).toEqual([undefined]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('the advisory scan still answers what it read, but never caches an incomplete result', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-refscan-hole2-'));
    try {
      await write(path.join(root, KB), 'team/access.md', '---\nread:\n  - Sales\n---\n');
      const walker = walkerWithHole();
      const scanner = new KbReferenceScanner(stubWorkspace(root), walker, KB);
      expect((await scanner.scan('ws-1')).get('sales')).toHaveLength(1);
      await scanner.scan('ws-1');
      // Not served from cache: the second scan retried the listing.
      expect(walker.walks).toBe(2);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('a scan that could not read a candidate file is not cached', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-refscan-unread-'));
    try {
      await write(path.join(root, KB), 'team/access.md', '---\nread:\n  - Sales\n---\n');
      // The walk lists team/Ghost.md, but there is no file to read.
      const disk = new NodeFs();
      let walks = 0;
      const walker: ITreeWalker = {
        walk: (r, o, l) => disk.walk(r, o, l),
        walkFiles: (r, m, o) => disk.walkFiles(r, m, o),
        walkKb: async (r, l, o) => {
          walks++;
          const result = await disk.walkKb(r, l, o);
          for (const listener of l) listener.onFile?.('team', 'Ghost.md');
          return result;
        },
      };
      const scanner = new KbReferenceScanner(stubWorkspace(root), walker, KB);
      expect((await scanner.scan('ws-1')).get('sales')).toHaveLength(1);
      await scanner.scan('ws-1');
      // Not served from cache: the second scan walked and read again.
      expect(walks).toBe(2);
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
      const scanner = new KbReferenceScanner(stubWorkspace(root), new NodeFs(), KB, bus);

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

  it('an invalidation landing MID-SCAN keeps the stale snapshot out of the cache', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-refscan-race-'));
    try {
      const repo = path.join(root, KB);
      await write(repo, 'team/access.md', '---\nread:\n  - Sales\n---\n');
      // The walker invalidates DURING the first scan's tree listing —
      // modelling a write that lands after the scan started reading.
      const disk = new NodeFs();
      let armed = true;
      const walker: ITreeWalker = {
        walk: (r, o, l) => disk.walk(r, o, l),
        walkFiles: (r, m, o) => disk.walkFiles(r, m, o),
        walkKb: async (r, l, o) => {
          const result = await disk.walkKb(r, l, o);
          if (armed) {
            armed = false;
            scanner.invalidate('ws-1');
          }
          return result;
        },
      };
      const scanner = new KbReferenceScanner(stubWorkspace(root), walker, KB);

      // The caller still gets the snapshot it asked for...
      expect((await scanner.scan('ws-1')).get('sales')).toHaveLength(1);
      // ...but the snapshot must not have STUCK in the cache: the write the
      // invalidation announced is visible on the very next scan, well inside
      // the TTL and with no further events.
      await write(repo, 'team/access.md', '---\nread:\n  - Sales\n  - Support\n---\n');
      expect((await scanner.scan('ws-1')).get('support')).toHaveLength(1);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('ignores a scanned-extension change OUTSIDE the KB directory', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-refscan-bus3-'));
    try {
      const repo = path.join(root, KB);
      await write(repo, 'team/access.md', '---\nread:\n  - Sales\n---\n');
      const listeners: ((e: { kind: string; workspaceId?: string; path?: string }) => void)[] = [];
      const bus = { onEmit: (l: (typeof listeners)[number]) => (listeners.push(l), () => undefined) };
      const scanner = new KbReferenceScanner(stubWorkspace(root), new NodeFs(), KB, bus);

      const first = await scanner.scan('ws-1');
      for (const l of listeners) {
        // Right extension, wrong tree: not scan material.
        l({ kind: 'file-changed', workspaceId: 'ws-1', path: 'scratch/notes.md' });
      }
      expect(await scanner.scan('ws-1')).toBe(first);
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
      const scanner = new KbReferenceScanner(stubWorkspace(root), new NodeFs(), KB, bus);

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
