import { describe, expect, it } from 'vitest';
import { FILE_PATH_FORMAT, FileBodyError, fileBodyField, fileBodyReader, installFileBodies } from '../index.js';
import { PathNotFoundError } from '../../../shared/domain-errors.js';

/**
 * A tool whose body is declared a file path goes out with the file's bytes in
 * that field; every other call passes through as the agent made it. The
 * declaration is the tool's own schema, so the same mechanism serves any API
 * that takes a file.
 */
const upload = {
  name: 'drive.upload_file',
  inputs: { type: 'object', properties: { name: { type: 'string' }, body: { type: 'string', format: FILE_PATH_FORMAT } }, required: ['name', 'body'] },
  tool_call_template: { call_template_type: 'http', http_method: 'PUT', url: 'https://api.example/files/{name}', content_type: 'application/octet-stream' },
};
const namedField = {
  ...upload,
  name: 'drive.put',
  inputs: { type: 'object', properties: { file: { type: 'string', format: FILE_PATH_FORMAT } } },
  tool_call_template: { ...upload.tool_call_template, body_field: 'file' },
};
const plain = {
  name: 'desk.create_ticket',
  inputs: { type: 'object', properties: { body: { type: 'object' } } },
  tool_call_template: { call_template_type: 'http', http_method: 'POST', url: 'https://api.example/tickets', content_type: 'application/json' },
};
const mcp = { name: 'notion.search', inputs: { type: 'object', properties: { body: { type: 'string', format: FILE_PATH_FORMAT } } }, tool_call_template: { call_template_type: 'mcp' } };

type FakeTool = { name: string; inputs?: unknown; tool_call_template?: unknown };

function fakeClient(tools: FakeTool[], read: (ref: string) => Promise<Uint8Array>) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client = {
    config: { tool_repository: { getTool: async (name: string) => tools.find((t) => t.name === name) ?? null } },
    callTool: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return 'ok';
    },
    callToolStreaming: async function* (name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      yield 'chunk';
    },
  };
  installFileBodies(client, read);
  return { client, calls };
}

describe('fileBodyField', () => {
  it('is the body field of an http tool whose body property is declared a file path, under its own name or the default', () => {
    expect(fileBodyField(upload)).toBe('body');
    expect(fileBodyField(namedField)).toBe('file');
  });

  it('is null for a tool that sends JSON, a tool of another protocol, or no tool', () => {
    expect(fileBodyField(plain)).toBeNull();
    expect(fileBodyField(mcp)).toBeNull();
    expect(fileBodyField(null)).toBeNull();
  });
});

describe('installFileBodies', () => {
  it('sends the file the call names as its bytes, in the body field, with the other arguments untouched', async () => {
    const reads: string[] = [];
    const { client, calls } = fakeClient([upload], async (ref) => {
      reads.push(ref);
      return new TextEncoder().encode(`bytes of ${ref}`);
    });
    expect(await client.callTool('drive.upload_file', { name: 'a.png', body: ' __tmp__/teams/a_1/m1/a.png ' })).toBe('ok');
    expect(reads).toEqual(['__tmp__/teams/a_1/m1/a.png']);
    expect(calls[0]!.args.name).toBe('a.png');
    expect(Buffer.isBuffer(calls[0]!.args.body)).toBe(true);
    expect((calls[0]!.args.body as Buffer).toString()).toBe('bytes of __tmp__/teams/a_1/m1/a.png');
  });

  it('does the same on the streaming path, under the field the template names', async () => {
    const { client, calls } = fakeClient([namedField], async () => Uint8Array.from([1, 2, 3]));
    const chunks: unknown[] = [];
    for await (const c of client.callToolStreaming('drive.put', { file: 'Sales/Price list.pdf' })) chunks.push(c);
    expect(chunks).toEqual(['chunk']);
    expect([...(calls[0]!.args.file as Buffer)]).toEqual([1, 2, 3]);
  });

  it('leaves a JSON tool, an unknown tool and a call with no path alone', async () => {
    let reads = 0;
    const { client, calls } = fakeClient([plain, upload], async () => {
      reads += 1;
      return new Uint8Array();
    });
    await client.callTool('desk.create_ticket', { body: { subject: 'x' } });
    await client.callTool('nobody.knows', { body: 'Sales/x.pdf' });
    await client.callTool('drive.upload_file', { name: 'a.png' });
    expect(reads).toBe(0);
    expect(calls.map((c) => c.args)).toEqual([{ body: { subject: 'x' } }, { body: 'Sales/x.pdf' }, { name: 'a.png' }]);
  });

  it('refuses the call with the reason when the file cannot be read, and sends nothing', async () => {
    const { client, calls } = fakeClient([upload], async (ref) => {
      throw new FileBodyError(`"${ref}" is not a file you can read, so it cannot be sent`);
    });
    await expect(client.callTool('drive.upload_file', { name: 'a.png', body: 'Finance/Payroll.xlsx' })).rejects.toMatchObject({
      status: 400,
      kind: 'file-body',
      data: { error: '"Finance/Payroll.xlsx" is not a file you can read, so it cannot be sent' },
    });
    // Any other failure may name a place on the server: the agent gets the plain reason, never the error's text.
    const { client: other, calls: otherCalls } = fakeClient([upload], async () => {
      throw new Error("EACCES: permission denied, open '/srv/kb/main/tmp/u1/x'");
    });
    const refusal = await other.callTool('drive.upload_file', { name: 'a.png', body: '__tmp__/x' }).catch((err: unknown) => err as Error);
    expect(refusal).toBeInstanceOf(FileBodyError);
    expect((refusal as Error).message).toBe('"__tmp__/x" could not be read as the file to send. Try again, or send another file.');
    expect(calls).toEqual([]);
    expect(otherCalls).toEqual([]);
  });

  it('installs once', async () => {
    const { client, calls } = fakeClient([upload], async () => new Uint8Array([7]));
    installFileBodies(client, async () => new Uint8Array([9]));
    await client.callTool('drive.upload_file', { name: 'a', body: 'x' });
    expect([...(calls[0]!.args.body as Buffer)]).toEqual([7]);
  });
});

describe('fileBodyReader', () => {
  const owner = { id: 'u1', email: 'reader@example.com' };
  const enoent = () => Object.assign(new Error('ENOENT: no such file or directory, open \'/srv/kb/main/knowledge-base/Sales/gone.pdf\''), { code: 'ENOENT' });
  /**
   * A gate that judges the path it is given as written: `Private/` is closed to the reader by its own folder
   * rule, and every other path falls under the root's grant. `gone.pdf` is readable but not there.
   */
  function reader() {
    const asked: string[] = [];
    const read: string[] = [];
    const staged: string[] = [];
    const r = fileBodyReader({
      workspaces: {
        readFileBinary: async (_ws, wsPath) => {
          read.push(wsPath);
          if (wsPath.endsWith('gone.pdf')) throw enoent();
          return Buffer.from(`bytes of ${wsPath}`);
        },
        readTmpFile: async (_ws, ownerId, ref) => {
          staged.push(`${ownerId}:${ref}`);
          if (ref.endsWith('gone.png')) throw new PathNotFoundError(ref);
          return Buffer.from('staged');
        },
      },
      access: {
        canRead: async (_ws, _email, path) => {
          asked.push(path);
          return path.split('/')[0] !== 'Private';
        },
      },
      workspaceId: () => 'main',
      kbDirName: 'knowledge-base',
    });
    return { r, asked, read, staged };
  }

  it('checks and reads one path, so no spelling of a closed file passes on the root grant', async () => {
    const { r, asked, read } = reader();
    for (const ref of ['Private/report.pdf', './Private/report.pdf', 'Private//report.pdf', 'knowledge-base/Private/report.pdf', '/knowledge-base/Private/report.pdf']) {
      await expect(r.read(owner, ref)).rejects.toThrow(`"${ref}" is not a file you can read, so it cannot be sent`);
    }
    expect(asked).toEqual(Array(5).fill('Private/report.pdf'));
    expect(read).toEqual([]);
    expect(Buffer.from(await r.read(owner, './Sales/Price list.pdf')).toString()).toBe('bytes of knowledge-base/Sales/Price list.pdf');
    expect(asked.at(-1)).toBe('Sales/Price list.pdf');
  });

  it('answers a file that is not there as one it cannot read, never with the path on disk', async () => {
    const { r } = reader();
    const refusal = await r.read(owner, 'Sales/gone.pdf').catch((err: unknown) => err);
    expect(refusal).toBeInstanceOf(FileBodyError);
    expect((refusal as Error).message).toBe('"Sales/gone.pdf" is not a file you can read, so it cannot be sent');
    await expect(r.read(owner, '__tmp__/teams/gone.png')).rejects.toThrow('"__tmp__/teams/gone.png" is not a file you can read, so it cannot be sent');
  });

  it('reads nothing for a caller whose account is gone', async () => {
    const { r, asked, read, staged } = reader();
    await expect(r.read(null, 'Sales/Price list.pdf')).rejects.toThrow('"Sales/Price list.pdf" is not a file you can read, so it cannot be sent');
    expect([...asked, ...read, ...staged]).toEqual([]);
  });

  it("reads a staged file from the person's own folder without asking the gate, and refuses a path that climbs out", async () => {
    const { r, asked, read, staged } = reader();
    expect(Buffer.from(await r.read(owner, '__tmp__/teams/a.png')).toString()).toBe('staged');
    expect(staged).toEqual(['u1:__tmp__/teams/a.png']);
    await expect(r.read(owner, 'Sales/../Private/report.pdf')).rejects.toThrow(/outside the knowledge base repository/);
    expect(asked).toEqual([]);
    expect(read).toEqual([]);
  });
});
