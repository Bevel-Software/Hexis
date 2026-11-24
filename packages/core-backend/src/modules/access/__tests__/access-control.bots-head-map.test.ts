import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { realDisk } from '../../../__tests__/real-disk.js';
import { botAddressBook } from '../../../__tests__/bot-address-book.js';
import { NodeGitRunner } from '../../version-control/index.js';
import type { WorkspaceService } from '../../workspace/index.js';
import { AccessControlService, type AccessModel } from '../access-control.service.js';
import { HEAD_MAP_LIMITS, HeadMaps } from '../head-access-map.js';
import { TreeIndexer } from '../tree-index.js';

const execFileAsync = promisify(execFile);

/**
 * A branch's reads are answered from the map of the commit its checkout
 * stands on (`HeadMaps`), not only from the checkout. The bot rules must hold
 * there too: a bot is not part of `everyone`, holds no role (a role that
 * folds one of its groups in included) and is never admin, not even when it
 * is listed as the deployment's admin. A map is keyed by commit and holds the
 * rules of that commit, never a person's verdict, so the bot is told apart
 * where every check is answered: by the one address book the model carries.
 *
 * Each case runs through the public gates over a real repository, with every
 * file the service opens from the checkout recorded: none is, so it is the
 * map that answered.
 */

const KB = 'knowledge-base';
const BOT = 'release-helper@agent.hexis';
const REF = `Release helper <${BOT}>`;
const rules = (body: string) => `---\n${body}---\n`;

const FILES: Record<string, string> = {
  'roles.yaml': `roles:\n  Admin:\n    - admin@x.io\n    - ${BOT}\n  Engineer:\n    - eng@x.io\n    - ${BOT}\n  Leads:\n    - group:Releasers\n`,
  'groups.yaml': `groups:\n  Releasers:\n    - ${BOT}\n`,
  'access.md': rules('write:\n  - Admin\n'),
  'Public/access.md': rules('read:\n  - everyone\n'),
  'Public/page.md': '# public\n',
  'Granted/access.md': rules(`read:\n  - ${REF}\n`),
  'Granted/notes.md': '# notes\n',
  'Group/access.md': rules('read:\n  - Releasers\nwrite:\n  - Releasers\n'),
  'Group/page.md': '# group\n',
  'Own.md': rules(`read:\n  - ${REF}\n`) + '# own\n',
  'Engineering/access.md': rules('read:\n  - Engineer\nwrite:\n  - Engineer\n'),
  'Engineering/page.md': '# eng\n',
  'ByLeads/access.md': rules('read:\n  - Leads\n'),
  'ByLeads/page.md': '# leads\n',
  'Top.md': '# top\n',
};

describe('a bot on the head map’s path', () => {
  let root: string;
  let repo: string;
  let opened: string[];
  let access: AccessControlService;

  const git = (...args: string[]) => execFileAsync('git', ['-C', repo, ...args], { encoding: 'utf-8' });

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-bots-head-map-'));
    repo = path.join(root, 'ws', KB);
    await fs.mkdir(repo, { recursive: true });
    await execFileAsync('git', ['init', '-q', '-b', 'main', repo]);
    await git('config', 'user.email', 'test@example.com');
    await git('config', 'user.name', 'Test');
    for (const [rel, text] of Object.entries(FILES)) {
      await fs.mkdir(path.dirname(path.join(repo, rel)), { recursive: true });
      await fs.writeFile(path.join(repo, rel), text);
    }
    await git('add', '-A');
    await git('commit', '-qm', 'seed');

    const stub = {
      getWorkspacePath: async (id: string) => path.join(root, id),
      ensureRemotesFetched: async () => undefined,
    } as unknown as WorkspaceService;
    const runner = new NodeGitRunner();
    const book = botAddressBook();
    book.replace(['release-helper']);
    // As the composition root makes it: the head maps, then the bots' book;
    // and the bot's address is the environment's admin as well.
    access = new AccessControlService(
      stub,
      KB,
      realDisk(),
      ['admin@x.io', BOT],
      runner,
      undefined,
      {},
      undefined,
      undefined,
      new HeadMaps<AccessModel>(runner, new TreeIndexer(), HEAD_MAP_LIMITS),
      book,
    );

    opened = [];
    const realOpen = fs.open.bind(fs);
    const realReadFile = fs.readFile.bind(fs);
    const note = (target: unknown) => {
      const file = String(target);
      if (file.startsWith(repo) && !file.includes(`${path.sep}.git${path.sep}`)) opened.push(path.relative(repo, file));
    };
    vi.spyOn(fs, 'open').mockImplementation(((file: unknown, ...rest: unknown[]) => {
      note(file);
      return (realOpen as (...a: unknown[]) => unknown)(file, ...rest);
    }) as typeof fs.open);
    vi.spyOn(fs, 'readFile').mockImplementation(((file: unknown, ...rest: unknown[]) => {
      note(file);
      return (realReadFile as (...a: unknown[]) => unknown)(file, ...rest);
    }) as typeof fs.readFile);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  const PATHS = ['Public', 'Public/page.md', 'Granted/notes.md', 'Group/page.md', 'Own.md', 'Engineering/page.md', 'ByLeads/page.md', 'Top.md'];

  it('refuses a folder granted only to everyone, and allows what its address and its group grant', async () => {
    const read = await access.canReadBatch('ws', BOT, PATHS);
    const write = await access.canWriteBatch('ws', BOT, PATHS);

    // Everyone reads Public; the bot is not part of everyone.
    expect(await access.canReadAsEveryoneBatch('ws', ['Public', 'Public/page.md'])).toEqual(
      new Map([['Public', true], ['Public/page.md', true]]),
    );
    expect(read.get('Public')).toBe(false);
    expect(read.get('Public/page.md')).toBe(false);
    // By its address (a folder's rules and a file's own) and through its group.
    expect(read.get('Granted/notes.md')).toBe(true);
    expect(read.get('Own.md')).toBe(true);
    expect(read.get('Group/page.md')).toBe(true);
    expect(write.get('Group/page.md')).toBe(true);
    // It was the map that answered: nothing was opened from the checkout.
    expect(opened).toEqual([]);
  });

  it('gets nothing from a role that lists it or folds its group in, nor from being listed as the admin', async () => {
    const read = await access.canReadBatch('ws', BOT, PATHS);
    const write = await access.canWriteBatch('ws', BOT, PATHS);

    // Engineer lists it; Leads folds its group in.
    expect(read.get('Engineering/page.md')).toBe(false);
    expect(write.get('Engineering/page.md')).toBe(false);
    expect(read.get('ByLeads/page.md')).toBe(false);
    // Admin lists it, and it is named as the environment's admin: the root's
    // Admin write floor is not its, nor is any admin standing.
    expect(write.get('Top.md')).toBe(false);
    expect(await access.holdsAdminRootWrite('ws', BOT)).toBe(false);
    expect(await access.adminEmails('ws')).toEqual(['admin@x.io']);
    expect(opened).toEqual([]);

    // A person in the same places holds them, on the same map.
    expect((await access.canReadBatch('ws', 'eng@x.io', ['Engineering/page.md'])).get('Engineering/page.md')).toBe(true);
    expect((await access.canWriteBatch('ws', 'admin@x.io', ['Top.md'])).get('Top.md')).toBe(true);
    expect((await access.canReadBatch('ws', 'nobody@x.io', ['Public/page.md'])).get('Public/page.md')).toBe(true);
  });

  it('answers the single gates as the batch gates do', async () => {
    expect(await access.canRead('ws', BOT, 'Public/page.md')).toBe(false);
    expect(await access.canRead('ws', BOT, 'Granted/notes.md')).toBe(true);
    expect(await access.canWrite('ws', BOT, 'Group/page.md')).toBe(true);
    expect(await access.canWrite('ws', BOT, 'Engineering/page.md')).toBe(false);
    expect(await access.canWrite('ws', BOT, 'Top.md')).toBe(false);
  });
});
