import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { NodeFs } from '../../kb-fs/node-fs.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import { AccessControlService } from '../access-control.service.js';

const KB = 'knowledge-base';
const RULE = 'read:\n  - deny everyone\n  - Product Manager\n';
const ali = 'ali@bevel.software'; // no role
const felix = 'felix@example.com'; // Product Manager

/**
 * A file's own access rules live in its frontmatter, so the read checks read
 * a file only as far as its frontmatter reaches — a line, for a file with
 * none. That is what keeps a batch over a tree of large transcripts (grep's,
 * the explorer's) from reading the whole tree, and these pin that the head
 * answers exactly as the whole file would, fence rule and all.
 */
describe('AccessControlService — a file is read only as far as its frontmatter', () => {
  let root: string;
  let repo: string;
  let svc: AccessControlService;
  const workspaceId = 'ws-frontmatter-head';

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-fm-head-'));
    const workspaceDir = path.join(root, workspaceId);
    repo = path.join(workspaceDir, KB);
    await fs.mkdir(path.join(repo, 'Open'), { recursive: true });
    await fs.writeFile(path.join(repo, 'roles.yaml'), 'roles:\n  Admin:\n    - razvan@bevel.software\n  Product Manager:\n    - felix@example.com\n');
    await fs.writeFile(path.join(repo, 'Open', 'access.md'), '---\nread:\n  - everyone\n---\n');
    svc = new AccessControlService(
      { getWorkspacePath: async () => workspaceDir } as unknown as WorkspaceService,
      KB,
      new NodeFs(),
    );
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const put = (name: string, content: string | Buffer) => fs.writeFile(path.join(repo, 'Open', name), content);
  const verdicts = async (name: string) => {
    const rel = `Open/${name}`;
    const batch = await svc.canReadBatch(workspaceId, ali, [rel]);
    const felixBatch = await svc.canReadBatch(workspaceId, felix, [rel]);
    return {
      ali: batch.get(rel),
      felix: felixBatch.get(rel),
      single: await svc.canRead(workspaceId, ali, rel),
    };
  };

  it('honours the rules of a file far too large to read whole, at once', async () => {
    await put('huge.md', `---\n${RULE}---\n`);
    // 600 MB, sparse: more text than one string can hold, so a read of the
    // whole file could not even be decoded, and its rule would be missed.
    await fs.truncate(path.join(repo, 'Open', 'huge.md'), 600 * 1024 * 1024);
    expect(await verdicts('huge.md')).toEqual({ ali: false, felix: true, single: false });
  });

  it('reads a frontmatter longer than any one read through to its closing fence', async () => {
    await put('long-fm.md', `---\nsummary: "${'x'.repeat(200_000)}"\n${RULE}---\nbody\n`);
    expect(await verdicts('long-fm.md')).toEqual({ ali: false, felix: true, single: false });
  });

  it('scans a frontmatter line far longer than one read once, not again with every read', async () => {
    // A long line inside the frontmatter, then the rule; and a closing fence
    // padded with 3 MB of spaces, which stays a fence however long it runs.
    const longValue = (chars: number) =>
      `---\nsummary: "${'x'.repeat(chars)}"\n${RULE}${' '.repeat(3_000_000)}---${' '.repeat(3_000_000)}\nbody\n`;
    await put('long-value.md', longValue(32_000_000));
    expect(await verdicts('long-value.md')).toEqual({ ali: false, felix: true, single: false });
    // How the cost grows, not how long it takes on this machine: a line 16
    // times longer costs about 16 times as much scanned once, and far more
    // (about 60 times, measured) scanned again with every read. The slowest
    // short check against the fastest long one, so noise only helps a scan
    // that is linear pass.
    const timed = async (name: string, chars: number): Promise<number> => {
      await put(name, `---\nsummary: "${'x'.repeat(chars)}"\n${RULE}---\n`);
      const started = performance.now();
      await svc.canReadBatch(workspaceId, ali, [`Open/${name}`]);
      return performance.now() - started;
    };
    const short: number[] = [];
    const long: number[] = [];
    for (let i = 0; i < 3; i++) {
      short.push(await timed(`short-${i}.md`, 2_000_000));
      long.push(await timed(`long-${i}.md`, 32_000_000));
    }
    expect(Math.min(...long) / Math.max(...short)).toBeLessThan(32);
  }, 60_000);

  it('applies the fence rule as the whole-file scan does: CRLF, a BOM, padding around the fence', async () => {
    await put('crlf.md', `---\r\n${RULE.replace(/\n/g, '\r\n')}---\r\nbody\r\n`);
    await put('bom.md', `\uFEFF---\n${RULE}---\n`);
    await put('padded.md', `${' '.repeat(5_000)}---  \n${RULE}  ---\n`);
    for (const name of ['crlf.md', 'bom.md', 'padded.md']) {
      expect(await verdicts(name), name).toEqual({ ali: false, felix: true, single: false });
    }
  });

  it('finds no rules where the whole-file scan finds none', async () => {
    // A fenced block that is not at the top is body, not frontmatter.
    await put('later.md', `# title\n---\n${RULE}---\n`);
    // An opening fence never closed is no frontmatter either.
    await put('unclosed.md', `---\n${RULE}`);
    // A first line that is long, and no fence, ends the read at once.
    await put('long-line.md', `${'x'.repeat(3_000_000)}\n---\n${RULE}---\n`);
    await put('empty.md', '');
    for (const name of ['later.md', 'unclosed.md', 'long-line.md', 'empty.md']) {
      expect(await verdicts(name), name).toEqual({ ali: true, felix: true, single: true });
    }
  });
});
