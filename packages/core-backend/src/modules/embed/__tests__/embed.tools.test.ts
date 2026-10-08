import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../../tool-registry/tool-registry.js';
import { createToolHandlerFactory } from '../../tool-helpers/tool-handler.js';
import { ToolError, type ToolContext } from '../../tool-helpers/tool.contract.js';
import type { ReadForTool } from '../../workspace/workspace.tools.js';
import { testKbContext, TEST_BRANCH_MODEL } from '../../../__tests__/kb-context.js';
import {
  HTTP_DEPLOYMENT_NOTE,
  OPEN_PAGE_TOOL,
  registerEmbedTools,
  toRepoRelative,
} from '../embed.tools.js';

const KB = 'knowledge-base';
const BRANCH = TEST_BRANCH_MODEL.defaultBranch;
const PAGE = '# Thing\n\nWhat it is.\n';

let server: Server | null = null;
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

interface Opts {
  /** What `read_file`'s own read answers — or throws. */
  read?: ReadForTool;
  canBeFramed?: boolean;
  /** The caller the tool auth resolves to: a signed-in session, or a connection key's owner. */
  caller?: { id: string; email: string; name: string; tokenId?: string };
}

async function serve(opts: Opts = {}) {
  const caller = opts.caller ?? { id: 'u-1', email: 'alice@bevel.software', name: 'Alice' };
  const registry = new ToolRegistry();
  const router = express.Router();
  const auth: express.RequestHandler = (req, _res, next) => {
    req.toolAuth = {
      source: 'external',
      userId: caller.id,
      scope: 'write',
      ...(caller.tokenId ? { tokenId: caller.tokenId } : {}),
    } as never;
    next();
  };
  const resolve = async (): Promise<ToolContext> =>
    ({
      user: { id: caller.id, email: caller.email, name: caller.name },
      scope: 'write',
      source: 'external',
      ...(caller.tokenId ? { tokenId: caller.tokenId } : {}),
      abortSignal: new AbortController().signal,
      workspaceService: {} as never,
      workflowService: {} as never,
      events: {} as never,
      getFilesystem: async () => {
        throw new Error('open_page reads through readForTool, not the filesystem');
      },
    }) as unknown as ToolContext;

  const mints: Array<{ userId: string; reference: string }> = [];
  const embedService = {
    mintForUser: vi.fn(async (input: { userId: string; reference: string }) => {
      mints.push(input);
      return { token: 'tok', embedUrl: `https://hexis.example/embed?token=tok` };
    }),
  };
  const readForTool: ReadForTool =
    opts.read ?? (async () => ({ kind: 'text', text: PAGE }));

  registerEmbedTools(registry, router, auth, createToolHandlerFactory(resolve), {
    embedService: embedService as never,
    kb: testKbContext({ kbDirName: KB }),
    readForTool,
    canBeFramed: () => opts.canBeFramed ?? true,
    appUrlFor: (repoRelative, slug) =>
      `https://hexis.example/workspace/${encodeURIComponent(BRANCH)}/${KB}/${repoRelative}` +
      (slug ? `#${slug}` : ''),
  });

  const app = express();
  app.use(express.json());
  app.use('/api', router);
  server = app.listen(0);
  await new Promise<void>((r) => server!.once('listening', () => r()));
  const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;

  const call = async (body: unknown) => {
    const res = await fetch(`${base}/api/agent/tools/${OPEN_PAGE_TOOL}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  return { call, registry, embedService, mints };
}

describe('open_page: the listing', () => {
  it('is advertised to an external agent, and is not an in-app tool', async () => {
    const { registry } = await serve();
    const external = (await registry.listExternal()).map((t) => t.name);
    const internal = (await registry.listInternal()).map((t) => t.name);
    expect(external).toContain(OPEN_PAGE_TOOL);
    // The in-app reader is already looking at the app, where every page is a
    // click away; an iframe of the page they are standing on cannot help.
    expect(internal).not.toContain(OPEN_PAGE_TOOL);
  });

  it('takes a path and an optional heading, and no branch at all', async () => {
    const { registry } = await serve();
    const def = (await registry.listExternal()).find((t) => t.name === OPEN_PAGE_TOOL)!;
    const body = (def.inputs as { properties: { body: { properties: Record<string, unknown>; required: string[] } } })
      .properties.body;
    expect(Object.keys(body.properties).sort()).toEqual(['heading', 'path']);
    expect(body.required).toEqual(['path']);
    // The embedded view is editable, and an editable embed targets the
    // default branch only — so there is nothing for a caller to choose.
    expect(body.properties).not.toHaveProperty('branch');
  });
});

describe('open_page: the answer', () => {
  it('answers the page, the embed address, the app address, the path and the branch', async () => {
    const { call } = await serve();
    const { status, body } = await call({ path: `${KB}/Data/Thing.md` });
    expect(status).toBe(200);
    expect(body).toEqual({
      path: `${KB}/Data/Thing.md`,
      content: PAGE,
      embedUrl: 'https://hexis.example/embed?token=tok',
      appUrl: `https://hexis.example/workspace/${encodeURIComponent(BRANCH)}/${KB}/Data/Thing.md`,
      branch: BRANCH,
    });
  });

  it('mints for the caller identity — which under a connection key is the key owner', async () => {
    const { call, mints } = await serve({
      caller: { id: 'owner-9', email: 'owner@bevel.software', name: 'Owner', tokenId: 'tok-1' },
    });
    await call({ path: 'Data/Thing.md' });
    expect(mints).toEqual([{ userId: 'owner-9', reference: 'Data/Thing.md' }]);
  });

  it('passes the heading through to the mint and into the app address', async () => {
    const { call, mints } = await serve();
    const { body } = await call({ path: 'Data/Thing.md', heading: 'what-it-is' });
    expect(mints[0].reference).toBe('Data/Thing.md#what-it-is');
    expect(body.appUrl).toContain('#what-it-is');
  });

  it('accepts a path with or without the knowledge-base prefix, as read_file documents', async () => {
    const { call, mints } = await serve();
    await call({ path: 'Data/Thing.md' });
    await call({ path: `/${KB}/Data/Thing.md` });
    expect(mints.map((m) => m.reference)).toEqual(['Data/Thing.md', 'Data/Thing.md']);
  });

  it('answers an image with the reader own note, and still shows the picture in the view', async () => {
    const { call } = await serve({
      read: async () => ({ kind: 'image', data: 'AAA', mimeType: 'image/png', note: '[image Shots/x.png]' }),
    });
    const { body } = await call({ path: 'Shots/x.png' });
    expect(body.content).toBe('[image Shots/x.png]');
    expect(body.embedUrl).toBe('https://hexis.example/embed?token=tok');
  });

  it('answers a refusal the reader gives as the file text, as read_file does', async () => {
    const { call } = await serve({
      read: async () => ({ kind: 'refusal', message: 'This .zip cannot be read as text.' }),
    });
    const { body } = await call({ path: 'Archive/x.zip' });
    expect(body.content).toBe('This .zip cannot be read as text.');
  });
});

describe('open_page: refusals', () => {
  /**
   * The read comes FIRST and it is `read_file`'s own, so the refusal is the
   * one `read_file` gives — and no token is minted, because the mint is below
   * that line.
   */
  it('refuses a path the caller may not read, in read_file own words, and mints nothing', async () => {
    const { call, embedService } = await serve({
      read: async () => {
        throw new ToolError(`You don't have permission to read "${KB}/Secret.md".`, 403);
      },
    });
    const { status, body } = await call({ path: `${KB}/Secret.md` });
    expect(status).toBe(403);
    expect(body.error).toBe(`You don't have permission to read "${KB}/Secret.md".`);
    expect(embedService.mintForUser).not.toHaveBeenCalled();
  });

  it('refuses a path that does not exist, in read_file own words, and mints nothing', async () => {
    const { call, embedService } = await serve({
      read: async () => {
        throw new ToolError(`"${KB}/Gone.md" does not exist.`, 404);
      },
    });
    const { status, body } = await call({ path: `${KB}/Gone.md` });
    expect(status).toBe(404);
    expect(body.error).toBe(`"${KB}/Gone.md" does not exist.`);
    expect(embedService.mintForUser).not.toHaveBeenCalled();
  });

  it('refuses a path outside the knowledge base, and a missing one', async () => {
    const { call, embedService } = await serve();
    expect((await call({ path: '' })).status).toBe(400);
    expect((await call({ path: '../../etc/passwd' })).status).toBe(400);
    expect((await call({})).status).toBe(400);
    expect(embedService.mintForUser).not.toHaveBeenCalled();
  });
});

describe('open_page: a deployment that cannot be framed', () => {
  /**
   * A host runs an app view in a sandboxed https iframe, and no browser lets
   * an https document frame a plain-http one. So the tool still answers the
   * text and the app address, says why there is no view, and mints nothing —
   * a token nobody can open is only a token in a transcript.
   */
  it('answers the text and the app address, and says the view needs https', async () => {
    const { call, embedService } = await serve({ canBeFramed: false });
    const { status, body } = await call({ path: 'Data/Thing.md' });
    expect(status).toBe(200);
    expect(body.content).toBe(PAGE);
    expect(body.appUrl).toContain('/workspace/');
    expect(body.branch).toBe(BRANCH);
    expect(body).not.toHaveProperty('embedUrl');
    expect(body.note).toBe(HTTP_DEPLOYMENT_NOTE);
    expect(String(body.note)).toContain('https');
    expect(embedService.mintForUser).not.toHaveBeenCalled();
  });
});

describe('toRepoRelative', () => {
  it.each([
    ['a bare path', 'Data/Thing.md', 'Data/Thing.md'],
    ['the kb prefix', `${KB}/Data/Thing.md`, 'Data/Thing.md'],
    ['a leading slash', `/${KB}/Data/Thing.md`, 'Data/Thing.md'],
    ['a dot-slash', './Data/Thing.md', 'Data/Thing.md'],
    ['a trailing slash', 'Data/Thing.md/', 'Data/Thing.md'],
    ['backslashes', 'Data\\Thing.md', 'Data/Thing.md'],
  ])('reads %s', (_label, input, expected) => {
    expect(toRepoRelative(input, KB)).toBe(expected);
  });

  it.each([['empty', ''], ['the folder itself', KB], ['traversal', 'Data/../../x'], ['a newline', 'a\nb']])(
    'refuses %s',
    (_label, input) => {
      expect(toRepoRelative(input, KB)).toBeNull();
    },
  );
});
