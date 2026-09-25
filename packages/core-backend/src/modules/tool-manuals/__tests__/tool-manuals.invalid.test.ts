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
import { testKbContext } from '../../../__tests__/kb-context.js';

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
    new ToolManualService(
      workspaceService,
      access,
      testKbContext({ kbDirName: KB_DIR }),
      disk,
      new KbPluginSource(disk, testKbContext({ kbDirName: KB_DIR })),
      () => clock,
    );

  /**
   * The refused half of the catalog. There is no way to ask for it alone: both
   * halves come out of one scan and one access pass, so they always describe
   * the same snapshot — see `listAccessibleCatalog`.
   */
  const invalidOf = async (service: ToolManualService, email: string) =>
    (await service.listAccessibleCatalog(email)).invalid;

  /**
   * The real disk, counting the one call that walks the `.tool` tree.
   * `Object.create` rather than a spread: `NodeFs`'s methods live on its
   * prototype, and a spread would hand back an object with none of them.
   */
  const countingWalks = (onWalk: () => void): NodeFs =>
    Object.assign(Object.create(disk) as NodeFs, {
      walkFiles: (...args: Parameters<NodeFs['walkFiles']>) => {
        onWalk();
        return disk.walkFiles(...args);
      },
    });

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

      const invalid = await invalidOf(svc(), 'user@x.eu');
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
      expect(await invalidOf(service, 'user@x.eu')).toHaveLength(1);

      // The same long-lived service object — nothing restarted, no cache
      // dropped by hand, just the next call after the scan's TTL.
      await write('broken.tool', JSON.stringify({ name: 'fixed', type: 'http', url: 'https://api.example.com/u' }));
      nextListing();

      expect((await service.listAccessible('user@x.eu')).map((m) => m.name).sort()).toEqual([
        'billing',
        'fixed',
        'weather',
      ]);
      expect(await invalidOf(service, 'user@x.eu')).toEqual([]);
    });

    test('DISABLING the file — deleting it — clears the report just as well', async () => {
      await write('broken.tool', content);
      const service = svc();
      expect(await invalidOf(service, 'user@x.eu')).toHaveLength(1);

      await unlink(join(pluginsDir(), 'broken.tool'));
      nextListing();

      expect(await invalidOf(service, 'user@x.eu')).toEqual([]);
      expect((await service.listAccessible('user@x.eu')).map((m) => m.name).sort()).toEqual(['billing', 'weather']);
    });
  });

  test('all three at once still leave every valid tool listed, each fault named', async () => {
    await write('bad-yaml.tool', MALFORMED.yaml);
    await write('bad-schema.tool', MALFORMED.schema);
    await write('bad-reserved.tool', MALFORMED.reserved);
    const service = svc();

    expect((await service.listAccessible('user@x.eu')).map((m) => m.name).sort()).toEqual(['billing', 'weather']);
    const invalid = await invalidOf(service, 'user@x.eu');
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
    const token = 'pasted-credential-0000-not-a-real-key';
    await write(
      'broken.tool',
      `---\nid: broken\ntype: http\nurl: https://api.example.com/x\nheaders:\n  Authorization: "Bearer ${token}\n---\n`,
    );

    const invalid = await invalidOf(svc(), 'user@x.eu');
    expect(invalid).toHaveLength(1);
    expect(invalid[0].reason).not.toContain(token);
    expect(invalid[0].reason).not.toContain('pasted-credential');
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
    expect(await invalidOf(service, 'stranger@x.eu')).toEqual([]);
    expect((await service.listAccessible('stranger@x.eu')).map((m) => m.name).sort()).toEqual(['billing', 'weather']);

    expect((await invalidOf(service, 'owner@x.eu')).map((i) => i.path)).toEqual(['Plugins/broken.tool']);
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
    const invalid = await invalidOf(service, 'user@x.eu');
    // One of the pair is served; the other is named, not silently gone.
    expect(listed.filter((n) => n === 'payments')).toHaveLength(1);
    expect(invalid).toHaveLength(1);
    expect(['Plugins/a.tool', 'Plugins/b.tool']).toContain(invalid[0].path);
    expect(invalid[0].reason).toContain('namespace');
  });

  // Root ignores the mode bits, so the file it is meant to fail on opens fine —
  // the case is only meaningful where it doesn't. Declared as a SKIP rather
  // than an early `return`, so a container that runs the suite as root (the
  // normal case in CI) reports the coverage it did not get instead of a green
  // test that asserted nothing.
  test.skipIf(process.getuid?.() === 0)('a `.tool` the walk found but the read could not open is reported too', async () => {
    const unreadable = join(pluginsDir(), 'locked.tool');
    await write('locked.tool', BILLING.replace('billing', 'locked'));
    await chmod(unreadable, 0o000);

    const invalid = await invalidOf(svc(), 'user@x.eu');
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

  test('a filename that tries to forge a log line cannot', async () => {
    // A KB filename is author-written, and a newline is a legal character in
    // one. Written raw into a warning it would start a second line — an
    // operator log entry the process never wrote.
    const lines: string[] = [];
    const capture: ILogger = {
      debug: () => {},
      info: () => {},
      warn: (m: string) => void lines.push(m),
      error: () => {},
      child: () => capture,
    };
    const restore = setLogger(capture);
    try {
      await write('oops\n[tool-manuals] catalog is empty.tool', MALFORMED.yaml);
      await svc().listAccessible('user@x.eu');

      const warned = lines.filter((l) => l.includes('oops'));
      expect(warned).toHaveLength(1);
      expect(warned[0]).not.toContain('\n');
      expect(warned[0]).toContain('\\n');
    } finally {
      setLogger(restore);
    }
  });

  test('a healthy workspace reports nothing invalid at all', async () => {
    const service = svc();
    expect(await invalidOf(service, 'user@x.eu')).toEqual([]);
    expect((await service.listAccessible('user@x.eu')).map((m) => m.name).sort()).toEqual(['billing', 'weather']);
  });

  describe('the reason never carries what the file wrote', () => {
    // The redaction that matters is the one that cannot be applied afterwards.
    // `redactSecret` knows this process's env tokens and the shape of a URL; it
    // cannot know that a token an author pasted into `id:` is a credential. So the
    // rule is upstream: a refusal names the FIELD and the RULE, never the
    // value — and these are the fields an author can write anything into.
    const token = 'pasted-credential-0000-not-a-real-key';

    test.each([
      ['id', `---\nid: ${token}\ntype: http\nurl: https://api.example.com/x\n---\n`],
      ['type', `---\nname: broken\ntype: ${token}\nurl: https://api.example.com/x\n---\n`],
      [
        'a variable name',
        `---\nname: broken\ntype: http\nurl: https://api.example.com/x\nvariables:\n  - name: "${token}"\n---\n`,
      ],
      [
        'a variable scope',
        `---\nname: broken\ntype: http\nurl: https://api.example.com/x\nvariables:\n  - name: KEY\n    scope: ${token}\n---\n`,
      ],
    ])('a credential written as %s is refused without being quoted back', async (_field, content) => {
      await write('broken.tool', content);

      const invalid = await invalidOf(svc(), 'user@x.eu');
      expect(invalid).toHaveLength(1);
      expect(invalid[0].reason).not.toContain(token);
      expect(invalid[0].reason).not.toContain('pasted-credential');
      // Still actionable: the file is named by `path`, and the reason says
      // which field broke which rule.
      expect(invalid[0].path).toBe('Plugins/broken.tool');
      expect(invalid[0].reason.length).toBeGreaterThan(0);
      // …and the valid tools are untouched by any of it.
      expect((await svc().listAccessible('user@x.eu')).map((m) => m.name).sort()).toEqual(['billing', 'weather']);
    });

    test('a bad variable entry is located by index, since its name cannot be trusted yet', async () => {
      await write(
        'broken.tool',
        `---\nname: broken\ntype: http\nurl: https://api.example.com/x\nvariables:\n  - name: FIRST\n  - name: "${token}"\n---\n`,
      );

      const invalid = await invalidOf(svc(), 'user@x.eu');
      expect(invalid[0].reason).toContain('variables[1].name');
      expect(invalid[0].reason).not.toContain(token);
    });

    /**
     * The harder half, and the reason the rule is "repeats NOTHING the file
     * said" rather than "does not repeat rejected values".
     *
     * A token spelled with underscores is a legal identifier: it passes
     * `[A-Za-z0-9_]+`, so it becomes a usable `name` — and it used to be quoted
     * back by every message downstream of that check (an invalid `scope`, a
     * malformed `oauth`, a duplicate). Passing a grammar test makes a string
     * legal, not repeatable. The same goes for a manual `name`, a header key,
     * and a namespace: each is author text, transformed at most.
     */
    const idToken = 'PASTED_CREDENTIAL_0000_not_a_real_key';
    const CLI_TOOL = {
      name: 'x',
      description: 'runs a command',
      inputs: { type: 'object', properties: {} },
      outputs: { type: 'object', properties: {} },
      tool_call_template: { call_template_type: 'cli', command_name: 'ls' },
    };

    test.each([
      [
        'a variable that IS a legal identifier, with a bad scope',
        `---\nname: broken\ntype: http\nurl: https://api.example.com/x\nvariables:\n  - name: ${idToken}\n    scope: nonsense\n---\n`,
        'variables[0].scope',
      ],
      [
        'a legal-identifier variable whose oauth is not an object',
        `---\nname: broken\ntype: http\nurl: https://api.example.com/x\nvariables:\n  - name: ${idToken}\n    scope: user\n    oauth: "yes"\n---\n`,
        'variables[0].oauth',
      ],
      [
        'a legal-identifier variable declared twice',
        `---\nname: broken\ntype: http\nurl: https://api.example.com/x\nvariables:\n  - name: ${idToken}\n  - name: ${idToken}\n---\n`,
        'variables[1].name',
      ],
      [
        'a manual name that is a token, in a file referencing a reserved variable',
        `---\nname: ${idToken}\ntype: http\nurl: "https://api.example.com/\${API_URL}"\n---\n`,
        'API_URL',
      ],
      [
        'a manual name that is a token, on a shell tool declared remote',
        JSON.stringify({ name: idToken, type: 'inline', remote: true, tools: [CLI_TOOL] }),
        'cli',
      ],
      [
        'a header key that is a token, with a non-string value',
        JSON.stringify({
          name: 'broken',
          type: 'http',
          url: 'https://api.example.com/x',
          headers: { [idToken]: 1234 },
          healthCheck: { url: 'https://api.example.com/ping' },
        }),
        'entry 1 of 1',
      ],
    ])('%s is refused without repeating it', async (_case, content, located) => {
      await write('broken.tool', content);

      const invalid = await invalidOf(svc(), 'user@x.eu');
      expect(invalid).toHaveLength(1);
      expect(invalid[0].path).toBe('Plugins/broken.tool');
      expect(invalid[0].reason).not.toContain(idToken);
      expect(invalid[0].reason).not.toContain('PASTED_CREDENTIAL');
      // The fault is still located — by a field name we chose or an ordinal.
      expect(invalid[0].reason).toContain(located);
      expect((await svc().listAccessible('user@x.eu')).map((m) => m.name).sort()).toEqual(['billing', 'weather']);
    });

    test('a namespace collision names neither manual nor the namespace they share', async () => {
      // Both sanitize to one manual name, so one of the pair is refused — and
      // the name they collided on is as much the author's text as any other.
      await write('a.tool', JSON.stringify({ name: `${idToken}-1`, type: 'http', url: 'https://a.example/u' }));
      await write('b.tool', JSON.stringify({ name: `${idToken} 1`, type: 'http', url: 'https://b.example/u' }));

      const invalid = await invalidOf(svc(), 'user@x.eu');
      expect(invalid).toHaveLength(1);
      expect(invalid[0].reason).not.toContain(idToken);
      expect(invalid[0].reason).not.toContain('PASTED_CREDENTIAL');
      // Sanitization strips the underscores, so check the stripped spelling too.
      expect(invalid[0].reason.toLowerCase()).not.toContain('pastedcredential');
      expect(invalid[0].reason).toContain('namespace');
    });
  });

  test('one cold listing is ONE scan, however many readers arrive during it', async () => {
    // The TTL cache only holds a value once the walk RETURNS, so everyone who
    // asks while it runs used to start a walk of their own — and the surfaces
    // that report refusals ask twice by construction. They share it now.
    let walks = 0;
    let aclBatches = 0;
    const countingDisk = countingWalks(() => {
      walks += 1;
    });
    const countingAccess: IAccessControl = {
      canRead: async () => true,
      canReadBatch: async (_w: string, _e: string, paths: string[]) => {
        aclBatches += 1;
        return new Map(paths.map((p) => [p, true]));
      },
    } as unknown as IAccessControl;

    const service = new ToolManualService(
      workspaceService,
      countingAccess,
      testKbContext({ kbDirName: KB_DIR }),
      countingDisk,
      new KbPluginSource(countingDisk, testKbContext({ kbDirName: KB_DIR })),
      () => clock,
    );

    const [a, b, c] = await Promise.all([
      service.listAccessibleCatalog('user@x.eu'),
      service.listAccessibleCatalog('user@x.eu'),
      service.listAccessible('user@x.eu'),
    ]);
    expect(walks).toBe(1);
    // One access pass per CALLER — the ACL answer is per-user, so it is not
    // shared — but never two per response half.
    expect(aclBatches).toBe(3);
    // Every reader saw the same snapshot.
    expect(a).toEqual(b);
    expect(a.tools).toEqual(c);

    // And the shared promise is released when it settles: the next listing past
    // the TTL scans again rather than serving the first one forever.
    nextListing();
    await service.listAccessibleCatalog('user@x.eu');
    expect(walks).toBe(2);
  });

  test('an invalidate() mid-scan is not served the tree it replaced', async () => {
    let walks = 0;
    const countingDisk = countingWalks(() => {
      walks += 1;
    });
    const service = new ToolManualService(
      workspaceService,
      allowAll,
      testKbContext({ kbDirName: KB_DIR }),
      countingDisk,
      new KbPluginSource(countingDisk, testKbContext({ kbDirName: KB_DIR })),
      () => clock,
    );

    // A merge lands while a scan is in flight. The caller that arrives AFTER it
    // must not be handed the in-flight read of the tree the merge replaced —
    // the same rule `TtlCache`'s generation token keeps for the cached value.
    const first = service.listAccessibleCatalog('user@x.eu');
    service.invalidate();
    await write('added.tool', JSON.stringify({ name: 'added', type: 'http', url: 'https://c.example/u' }));
    const second = await service.listAccessibleCatalog('user@x.eu');

    expect(walks).toBe(2);
    expect(second.tools.map((m) => m.name).sort()).toEqual(['added', 'billing', 'weather']);

    // …and the stale scan is still out there. When it lands it must not POISON
    // what the fresh one cached — the failure `TtlCache`'s generation token
    // exists to prevent, and one this test would sleep through if it stopped at
    // the assertions above. So: settle it, then read again with no invalidate
    // and no clock advance. A third walk would mean the cache was emptied; the
    // pre-merge catalog coming back would mean it was overwritten.
    await first;
    const third = await service.listAccessibleCatalog('user@x.eu');
    expect(walks).toBe(2);
    expect(third.tools.map((m) => m.name).sort()).toEqual(['added', 'billing', 'weather']);
  });
});
