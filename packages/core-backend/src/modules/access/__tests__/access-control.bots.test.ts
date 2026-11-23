import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { realDisk } from '../../../__tests__/real-disk.js';
import type { WorkspaceService } from '../../workspace/index.js';
import { AccessControlService } from '../access-control.service.js';
import { BotAddressBook } from '../../bots/index.js';

/**
 * A bot's access, through the public resolver over a real on-disk tree: it is
 * granted by its address and through the groups it is in, and by nothing
 * else — not `everyone`, not a role (a role that folds its group in
 * included), not Admin. It writes an access file where it is granted to, as
 * a person does, and roles.yaml never, as no one but an admin. A bare name is
 * a role or a group, never a bot.
 */

const KB_DIR = 'knowledge-base';
const BOT = 'release-helper@agent.hexis';
const rules = (body: string) => `---\n${body}---\n`;
/** How an access rule names a bot: by its address, as it names a person. */
const REF = `Release helper <${BOT}>`;

const ROLES_YAML = `roles:
  Admin:
    - admin@x.io
    - ${BOT}
  Engineer:
    - eng@x.io
    - ${BOT}
  Leads:
    - group:Releasers
`;

const GROUPS_YAML = `groups:
  Releasers:
    - ${BOT}
  release-helper:
    - eve@x.io
`;

const TREE: Record<string, string> = {
  'roles.yaml': ROLES_YAML,
  'groups.yaml': GROUPS_YAML,
  'access.md': rules('write:\n  - Admin\n'),
  'Granted/access.md': rules(`read:\n  - ${REF}\n`),
  'Granted/notes.md': '# notes\n',
  'Public/access.md': rules('read:\n  - everyone\n'),
  'Public/page.md': '# public\n',
  'Group/access.md': rules('read:\n  - everyone\nwrite:\n  - Releasers\n'),
  'Group/page.md': '# group\n',
  'Engineering/access.md': rules('read:\n  - Engineer\nwrite:\n  - Engineer\n'),
  'Engineering/page.md': '# eng\n',
  'ByLeads/access.md': rules('read:\n  - Leads\n'),
  'ByLeads/page.md': '# leads\n',
  'BareName/access.md': rules('read:\n  - release-helper\n'),
  'BareName/page.md': '# bare\n',
  'Old/access.md': rules('read:\n  - Release helper <release-helper@old.example>\n'),
  'Old/page.md': '# old\n',
  'Own.md': rules(`read:\n  - ${REF}\n`) + '# own\n',
  'Denied/access.md': rules(`read:\n  - Releasers\n  - deny ${REF}\n`),
  'Denied/page.md': '# denied\n',
};

describe('a bot in the access model', () => {
  let root: string;
  const workspaceId = 'ws-bots-1';
  let book: BotAddressBook;
  let access: AccessControlService;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-bots-access-'));
    const workspaceDir = path.join(root, workspaceId);
    for (const [rel, contents] of Object.entries(TREE)) {
      const abs = path.join(workspaceDir, KB_DIR, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, contents);
    }
    const workspaceService = {
      getWorkspacePath: async () => workspaceDir,
      ensureRemotesFetched: async () => undefined,
    } as unknown as WorkspaceService;
    book = new BotAddressBook();
    book.replace({ domain: 'agent.hexis', botIds: ['release-helper'], previousDomain: null });
    access = new AccessControlService(workspaceService, KB_DIR, realDisk(), [BOT], undefined, undefined, {}, undefined, undefined, book);
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('is granted by its address: a folder granting it read is readable to it, and not to a person with no grant', async () => {
    expect(await access.canRead(workspaceId, BOT, 'Granted/notes.md')).toBe(true);
    expect(await access.canRead(workspaceId, 'nobody@x.io', 'Granted/notes.md')).toBe(false);
    expect(await access.canRead(workspaceId, BOT, 'Own.md')).toBe(true);
  });

  it('is not part of everyone: a folder readable by everyone that names it nowhere is not readable to it', async () => {
    expect(await access.canRead(workspaceId, 'nobody@x.io', 'Public/page.md')).toBe(true);
    expect(await access.canRead(workspaceId, BOT, 'Public/page.md')).toBe(false);
    expect(await access.canReadBatch(workspaceId, BOT, ['Public/page.md', 'Granted/notes.md'])).toEqual(
      new Map([
        ['Public/page.md', false],
        ['Granted/notes.md', true],
      ]),
    );
  });

  it('is granted through a group it is a member of', async () => {
    expect(await access.canWrite(workspaceId, BOT, 'Group/page.md')).toBe(true);
    // The group grants write, which implies read; `everyone` adds nothing for it.
    expect(await access.canRead(workspaceId, BOT, 'Group/page.md')).toBe(true);
  });

  it('holds no role, a role that folds its group in included', async () => {
    expect(await access.canRead(workspaceId, 'eng@x.io', 'Engineering/page.md')).toBe(true);
    expect(await access.canRead(workspaceId, BOT, 'Engineering/page.md')).toBe(false);
    expect(await access.canRead(workspaceId, BOT, 'ByLeads/page.md')).toBe(false);
  });

  it('is never an admin, though roles.yaml and the deployment owners list name it', async () => {
    expect(await access.holdsAdminRootWrite(workspaceId, BOT)).toBe(false);
    expect(await access.canWrite(workspaceId, BOT, 'Anything.md')).toBe(false);
    expect(await access.canWrite(workspaceId, 'admin@x.io', 'Anything.md')).toBe(true);
  });

  it('writes an access file where its grants let it, and roles.yaml never, as a person who is not an admin', async () => {
    expect(await access.canWrite(workspaceId, BOT, 'Group/access.md')).toBe(true);
    expect(await access.canWrite(workspaceId, BOT, 'Group/page.md')).toBe(true);
    expect(await access.canWrite(workspaceId, BOT, 'Engineering/access.md')).toBe(false);
    expect(await access.canWrite(workspaceId, BOT, 'roles.yaml')).toBe(false);
    expect(await access.canWrite(workspaceId, 'eng@x.io', 'roles.yaml')).toBe(false);
  });

  it('is never named by a bare name: that is the role or group of that name', async () => {
    expect(await access.canRead(workspaceId, BOT, 'BareName/page.md')).toBe(false);
    expect(await access.canRead(workspaceId, 'eve@x.io', 'BareName/page.md')).toBe(true);
  });

  it('is denied by its address, over a grant to its group', async () => {
    expect(await access.canRead(workspaceId, BOT, 'Denied/page.md')).toBe(false);
  });

  it('after a domain change, is granted at its new address, and at the previous one while that still counts', async () => {
    book.replace({ domain: 'agent.hexis', botIds: ['release-helper'], previousDomain: 'old.example' });
    access.invalidate(workspaceId);
    expect(await access.canRead(workspaceId, BOT, 'Old/page.md')).toBe(true);
    expect(await access.canRead(workspaceId, BOT, 'Granted/notes.md')).toBe(true);
    // Once the rewrite is merged the previous spelling stops counting.
    book.replace({ domain: 'agent.hexis', botIds: ['release-helper'], previousDomain: null });
    expect(await access.canRead(workspaceId, BOT, 'Old/page.md')).toBe(false);
  });

  it('says whether an address is a bot\'s', () => {
    expect(access.isBot('Release-Helper@Agent.Hexis')).toBe(true);
    expect(access.isBot('eng@x.io')).toBe(false);
  });
});
