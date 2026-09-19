import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, unlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_BRANCH } from '@bevel-software/platform-shared';
import { NodeFs } from '../../kb-fs/node-fs.js';
import { KbPluginSource } from '../../plugins/discovery/kb-plugin-source.js';
import { ToolManualService, describeManualFault } from '../tool-manuals.service.js';
import { workspaceIdForBranch } from '../../../shared/workspace-id.js';
import { setLogger } from '../../../shared/logging.js';
import type { ILogger } from '../../../shared/logger.contract.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import type { IAccessControl } from '../../access/access-control.interface.js';

/**
 * ONE BAD `.tool` COSTS ONE TOOL.
 *
 * The scan reads author-written content, and author-written content is wrong
 * sometimes — unparseable YAML, an id that breaks the namespace grammar, a
 * reference to a platform-seeded variable. What must never follow is a catalog
 * that comes back short (or empty) with nothing said: the tools that parse stay
 * listed and callable, and the file that did not is NAMED, with why and where.
 *
 * The three malformed shapes below are the ones the reproduction pinned down.
 * Each is asserted the same way: the valid manuals are all still there, and the
 * bad one appears exactly once in `invalid` with a reason that locates the
 * fault and carries no credential.
 */

const disk = new NodeFs();
const KB_DIR = 'knowledge-base';
const wsId = workspaceIdForBranch(DEFAULT_BRANCH);

const WEATHER = JSON.stringify({
  name: 'weather',
  type: 'inline',
  tools: [
    {
      name: 'forecast',
      description: 'Get the forecast.',
      inputs: { type: 'object', properties: {} },
      outputs: { type: 'object', properties: {} },
      tool_call_template: { call_template_type: 'http', http_method: 'GET', url: 'https://api.example.com/f' },
    },
  ],
});

const BILLING = JSON.stringify({
  name: 'billing',
  type: 'http',
  url: 'https://api.example.com/utcp',
  headers: { Authorization: 'Bearer ${BILLING_KEY}' },
});

/**
 * The three shapes, as an author would actually get them wrong.
 *
 * `yaml` — a nested mapping under a scalar key: the parser fails with a line
 * and column, and its message ends with the offending SOURCE, which is why the
 * reason has to be built rather than forwarded.
 * `schema` — a well-formed document the normalizer refuses: an `id` that is not
 * lowercase snake_case cannot be a UTCP namespace.
 * `reserved` — a reference to a platform-seeded variable, refused at the
 * producing boundary so a user tool can never carry platform credentials.
 */
const MALFORMED = {
  yaml: '---\nid: broken\ntype: http\nurl: https://api.example.com/x\n  headers: oops\n---\n',
  schema: '---\nid: "Not Snake Case"\ntype: http\nurl: https://api.example.com/x\n---\n',
  reserved: '---\nid: broken\ntype: http\nurl: https://api.example.com/x\nheaders:\n  Authorization: "Bearer ${API_URL}"\n---\n',
};

describe('a malformed `.tool` is isolated, named, and forgotten the moment it is fixed', () => {
  let root: string;
  let clock: number;

  const workspaceService = {
    getOrCreateForBranch: async () => ({ id: wsId }),
    getWorkspacePath: async (id: string) => join(root, id),
    hasBootstrappedWorkspace: async () => false,
  } as unknown as WorkspaceService;

  const allowAll: IAccessControl = {
    canRead: async () => true,
    canReadBatch: async (_w: string, _e: string, paths: string[]) => new Map(paths.map((p) => [p, true])),
  } as unknown as IAccessControl;

  /** Denies exactly one path — the broken file — to everyone but its owner. */
  const denyBroken: IAccessControl = {
    canRead: async (_w: string, email: string, p: string) => email === 'owner@x.eu' || !p.includes('broken'),
    canReadBatch: async (_w: string, email: string, paths: string[]) =>
      new Map(paths.map((p) => [p, email === 'owner@x.eu' || !p.includes('broken')])),
  } as unknown as IAccessControl;

  const svc = (access: IAccessControl = allowAll) =>
    new ToolManualService(workspaceService, access, KB_DIR, disk, new KbPluginSource(disk), () => clock);

  const pluginsDir = () => join(root, wsId, KB_DIR, 'Plugins');
  const write = (name: string, body: string) => writeFile(join(pluginsDir(), name), body);
  /** Past the scan's TTL: what "the next listing" means to a process nobody restarted. */
  const nextListing = () => {
    clock += 120_000;
  };

  beforeEach(async () => {
    clock = 1_000_000;
    root = await mkdtemp(join(tmpdir(), 'tools-invalid-'));
    await mkdir(pluginsDir(), { recursive: true });
    await write('weather.tool', WEATHER);
    await write('billing.tool', BILLING);
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  describe.each(Object.entries(MALFORMED))('with a %s fault in broken.tool', (shape, content) => {
    test('every valid tool is still listed, and only the bad file is missing', async () => {
      await write('broken.tool', content);
      const service = svc();

      const listed = await service.listAccessible('user@x.eu');
      expect(listed.map((m) => m.name).sort()).toEqual(['billing', 'weather']);
      // Not a degraded listing: the manuals are whole, not stubs.
      expect(listed.find((m) => m.name === 'billing')!.type).toBe('http');
      // The catalog-wide surface is isolated the same way, and so is the one
      // that registers call templates for a UTCP client.
      expect((await service.listAllSummaries()).map((m) => m.name).sort()).toEqual(['billing', 'weather']);
      expect(await service.toManualCallTemplates('user@x.eu')).toHaveLength(2);
    });

    test('the refused file is reported once, by path, with a usable reason', async () => {
      await write('broken.tool', content);

      const invalid = await svc().listInvalid('user@x.eu');
      expect(invalid).toHaveLength(1);
      expect(invalid[0].path).toBe('Plugins/broken.tool');
      expect(invalid[0].reason).toBeTruthy();
      // The location the shape can give: YAML fails at a line and column, the
      // other two name the field whose value is refused.
      if (shape === 'yaml') expect(invalid[0].reason).toMatch(/line \d+, column \d+/);
      if (shape === 'schema') expect(invalid[0].reason).toContain('snake_case');
      if (shape === 'reserved') expect(invalid[0].reason).toContain('API_URL');
    });

    test('fixing the file restores it on the next listing, with no reconnect', async () => {
      await write('broken.tool', content);
      const service = svc();

      expect((await service.listAccessible('user@x.eu')).map((m) => m.name)).not.toContain('fixed');
      expect(await service.listInvalid('user@x.eu')).toHaveLength(1);

      // The same long-lived service object — nothing restarted, no cache
      // dropped by hand, just the next call after the scan's TTL.
      await write('broken.tool', JSON.stringify({ name: 'fixed', type: 'http', url: 'https://api.example.com/u' }));
      nextListing();

      expect((await service.listAccessible('user@x.eu')).map((m) => m.name).sort()).toEqual([
        'billing',
        'fixed',
        'weather',
      ]);
      expect(await service.listInvalid('user@x.eu')).toEqual([]);
    });

    test('DISABLING the file — deleting it — clears the report just as well', async () => {
      await write('broken.tool', content);
      const service = svc();
      expect(await service.listInvalid('user@x.eu')).toHaveLength(1);

      await unlink(join(pluginsDir(), 'broken.tool'));
      nextListing();

      expect(await service.listInvalid('user@x.eu')).toEqual([]);
      expect((await service.listAccessible('user@x.eu')).map((m) => m.name).sort()).toEqual(['billing', 'weather']);
    });
  });

  test('all three at once still leave every valid tool listed, each fault named', async () => {
    await write('bad-yaml.tool', MALFORMED.yaml);
    await write('bad-schema.tool', MALFORMED.schema);
    await write('bad-reserved.tool', MALFORMED.reserved);
    const service = svc();

    expect((await service.listAccessible('user@x.eu')).map((m) => m.name).sort()).toEqual(['billing', 'weather']);
    const invalid = await service.listInvalid('user@x.eu');
    expect(invalid.map((i) => i.path)).toEqual([
      'Plugins/bad-reserved.tool',
      'Plugins/bad-schema.tool',
      'Plugins/bad-yaml.tool',
    ]);
    expect(invalid.every((i) => i.reason.length > 0)).toBe(true);
  });

  test('no credential the file happens to carry reaches the reason', async () => {
    // The worst case the redaction exists for: a literal token pasted into the
    // file, on the very line the parser chokes on. `yaml` quotes that line back
    // in its message — so what the listing reports must not be that message.
    const token = 'sk-live-51H8ffGGnotarealkeybutlooksLikeOne';
    await write(
      'broken.tool',
      `---\nid: broken\ntype: http\nurl: https://api.example.com/x\nheaders:\n  Authorization: "Bearer ${token}\n---\n`,
    );

    const invalid = await svc().listInvalid('user@x.eu');
    expect(invalid).toHaveLength(1);
    expect(invalid[0].reason).not.toContain(token);
    expect(invalid[0].reason).not.toContain('sk-live');
    // Still useful: it says where to look.
    expect(invalid[0].reason).toMatch(/line \d+, column \d+/);
  });

  test('a url credential in a refused message is scrubbed, not echoed', () => {
    // The normalizer quotes the url back when it refuses one (SSRF, bad
    // scheme). A url can carry userinfo or a presigned query, and the shared
    // scrub is what takes both out.
    const reason = describeManualFault(
      new Error('refused url "https://user:hunter2@internal.example/mcp?token=abcdefghijkl"'),
    );
    expect(reason).not.toContain('hunter2');
    expect(reason).not.toContain('abcdefghijkl');
  });

  test('a reason never grows past its cap, whatever the file put in it', () => {
    const reason = describeManualFault(new Error('x'.repeat(5_000)));
    expect(reason.length).toBeLessThanOrEqual(300);
    expect(reason.endsWith('…')).toBe(true);
  });

  test('a refused file is access-gated exactly like a listed one', async () => {
    await write('broken.tool', MALFORMED.yaml);
    const service = svc(denyBroken);

    // A path is a fact about the knowledge base: someone who may not read the
    // file may not learn from the listing that it is there and broken.
    expect(await service.listInvalid('stranger@x.eu')).toEqual([]);
    expect((await service.listAccessible('stranger@x.eu')).map((m) => m.name).sort()).toEqual(['billing', 'weather']);

    expect((await service.listInvalid('owner@x.eu')).map((i) => i.path)).toEqual(['Plugins/broken.tool']);
  });

  test('two manuals sharing one secret namespace: the dropped one says so', async () => {
    // Refused for a different reason — a collision, not a parse error — but the
    // consequence is identical (a manual missing from every surface), so it is
    // reported through the same channel rather than only to the log.
    // Both names sanitize to the one manual name `payments`, and so to the one
    // variable namespace — which is why the second is refused rather than
    // quietly bound to the first one's secrets.
    await write('a.tool', JSON.stringify({ name: 'pay-ments', type: 'http', url: 'https://a.example/u' }));
    await write('b.tool', JSON.stringify({ name: 'pay ments', type: 'http', url: 'https://b.example/u' }));

    const service = svc();
    const listed = (await service.listAccessible('user@x.eu')).map((m) => m.name);
    const invalid = await service.listInvalid('user@x.eu');
    // One of the pair is served; the other is named, not silently gone.
    expect(listed.filter((n) => n === 'payments')).toHaveLength(1);
    expect(invalid).toHaveLength(1);
    expect(['Plugins/a.tool', 'Plugins/b.tool']).toContain(invalid[0].path);
    expect(invalid[0].reason).toContain('namespace');
  });

  test('a `.tool` the walk found but the read could not open is reported too', async () => {
    const unreadable = join(pluginsDir(), 'locked.tool');
    await write('locked.tool', BILLING.replace('billing', 'locked'));
    await chmod(unreadable, 0o000);
    // Root ignores the mode bits; the case is only meaningful where it doesn't.
    if (process.getuid?.() === 0) return;

    const invalid = await svc().listInvalid('user@x.eu');
    expect(invalid.map((i) => i.path)).toEqual(['Plugins/locked.tool']);
    expect(invalid[0].reason).toContain('could not be read');
    expect(invalid[0].reason).toContain('EACCES');
    // The KB path, never this server's disk: an fs error quotes the absolute
    // path it tried, and that is not the knowledge base's business.
    expect(invalid[0].reason).not.toContain(root);
    await chmod(unreadable, 0o644);
  });

  test('the same fault is logged once, and the fix is logged once', async () => {
    const lines: string[] = [];
    const capture: ILogger = {
      debug: () => {},
      info: (m: string) => void lines.push(`info ${m}`),
      warn: (m: string) => void lines.push(`warn ${m}`),
      error: () => {},
      child: () => capture,
    };
    const restore = setLogger(capture);
    try {
      await write('broken.tool', MALFORMED.yaml);
      const service = svc();

      // A broken file stays broken; the catalog is re-scanned every minute on
      // every surface. Saying so once is a finding, saying so forever buries
      // the scan where something actually moved.
      await service.listAccessible('user@x.eu');
      nextListing();
      await service.listAccessible('user@x.eu');
      nextListing();
      await service.listAccessible('user@x.eu');
      expect(lines.filter((l) => l.includes('Plugins/broken.tool'))).toHaveLength(1);

      await unlink(join(pluginsDir(), 'broken.tool'));
      nextListing();
      await service.listAccessible('user@x.eu');
      expect(lines.filter((l) => l.startsWith('info') && l.includes('parses again'))).toHaveLength(1);
    } finally {
      setLogger(restore);
    }
  });

  test('a healthy workspace reports nothing invalid at all', async () => {
    const service = svc();
    expect(await service.listInvalid('user@x.eu')).toEqual([]);
    expect((await service.listAccessible('user@x.eu')).map((m) => m.name).sort()).toEqual(['billing', 'weather']);
  });
});
