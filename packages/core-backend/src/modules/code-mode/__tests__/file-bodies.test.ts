import { describe, expect, it } from 'vitest';
import { FILE_PATH_FORMAT, FileBodyError, fileBodyPlan, fileBodyReader, installFileBodies } from '../file-bodies.js';
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
/** An API that takes the file as one part of a form, beside a JSON part that describes it. */
const form = {
  name: 'board.add_document',
  inputs: {
    type: 'object',
    properties: {
      board_id: { type: 'string' },
      body: {
        type: 'object',
        properties: { resource: { type: 'string', format: FILE_PATH_FORMAT }, data: { type: 'object' }, note: { type: 'string' }, pages: { type: 'integer' } },
        required: ['resource'],
      },
    },
    required: ['board_id', 'body'],
  },
  tool_call_template: { call_template_type: 'http', http_method: 'POST', url: 'https://api.example/boards/{board_id}/documents', content_type: 'multipart/form-data' },
};
/** A form with no file part, and a JSON call whose body happens to hold a path: neither sends a file. */
const formWithoutFile = { ...form, name: 'board.add_note', inputs: { type: 'object', properties: { body: { type: 'object', properties: { note: { type: 'string' } } } } } };
const jsonWithPath = { ...form, name: 'board.link', tool_call_template: { ...form.tool_call_template, content_type: 'application/json' } };
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

describe('fileBodyPlan', () => {
  it('is the body field of an http tool whose body property is declared a file path, under its own name or the default', () => {
    expect(fileBodyPlan(upload)).toEqual({ field: 'body', kind: 'bytes' });
    expect(fileBodyPlan(namedField)).toEqual({ field: 'file', kind: 'bytes' });
  });

  it('is a form, with its file parts, for an http tool that says multipart/form-data and declares a file path inside its body object', () => {
    expect(fileBodyPlan(form)).toEqual({ field: 'body', kind: 'form', fileParts: ['resource'] });
    const spelled = { ...form, tool_call_template: { ...form.tool_call_template, content_type: ' Multipart/Form-Data; charset=utf-8' } };
    expect(fileBodyPlan(spelled)).toEqual({ field: 'body', kind: 'form', fileParts: ['resource'] });
  });

  it('is null for a tool that sends JSON, a form with no file part, a tool of another protocol, or no tool', () => {
    expect(fileBodyPlan(plain)).toBeNull();
    expect(fileBodyPlan(jsonWithPath)).toBeNull();
    expect(fileBodyPlan(formWithoutFile)).toBeNull();
    // Only the media type itself makes a form: a longer name that starts the same way is another type.
    expect(fileBodyPlan({ ...form, tool_call_template: { ...form.tool_call_template, content_type: 'multipart/form-data-like' } })).toBeNull();
    expect(fileBodyPlan({ ...form, tool_call_template: { ...form.tool_call_template, content_type: 'multipart/mixed' } })).toBeNull();
    expect(fileBodyPlan(mcp)).toBeNull();
    expect(fileBodyPlan(null)).toBeNull();
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

  it('sends a form: the file part as the file under its own name and type, text as written, anything else as JSON', async () => {
    const reads: string[] = [];
    const { client, calls } = fakeClient([form], async (ref) => {
      reads.push(ref);
      return new TextEncoder().encode(`bytes of ${ref}`);
    });
    const body = { resource: ' Reports/Q3 review.pdf ', data: { title: 'Q3', position: { x: 0, y: 0 } }, note: 'for Felix', pages: 4, skipped: null };
    expect(await client.callTool('board.add_document', { board_id: 'b1', body })).toBe('ok');
    expect(reads).toEqual(['Reports/Q3 review.pdf']);
    expect(calls[0]!.args.board_id).toBe('b1');
    const sent = calls[0]!.args.body as FormData;
    expect(sent).toBeInstanceOf(FormData);
    expect([...sent.keys()]).toEqual(['resource', 'data', 'note', 'pages']);
    const file = sent.get('resource') as File;
    expect(file.name).toBe('Q3 review.pdf');
    expect(file.type).toBe('application/pdf');
    expect(await file.text()).toBe('bytes of Reports/Q3 review.pdf');
    expect(sent.get('data')).toBe('{"title":"Q3","position":{"x":0,"y":0}}');
    expect(sent.get('note')).toBe('for Felix');
    expect(sent.get('pages')).toBe('4');
    // The call the agent made is not changed under it.
    expect(body.resource).toBe(' Reports/Q3 review.pdf ');
  });

  it('sends a form without its file part when the call leaves that part out or null, and leaves a body that is no object alone', async () => {
    let reads = 0;
    const { client, calls } = fakeClient([form], async () => {
      reads += 1;
      return new Uint8Array();
    });
    await client.callTool('board.add_document', { board_id: 'b1', body: { note: 'later' } });
    await client.callTool('board.add_document', { board_id: 'b1', body: { resource: null, note: 'later' } });
    await client.callTool('board.add_document', { board_id: 'b1', body: 'Reports/q3.pdf' });
    await client.callTool('board.add_document', { board_id: 'b1' });
    expect(reads).toBe(0);
    expect([...(calls[0]!.args.body as FormData).entries()]).toEqual([['note', 'later']]);
    expect([...(calls[1]!.args.body as FormData).entries()]).toEqual([['note', 'later']]);
    expect(calls.slice(2).map((c) => c.args)).toEqual([{ board_id: 'b1', body: 'Reports/q3.pdf' }, { board_id: 'b1' }]);
  });

  it('refuses a form whose file part is there but names no file, wherever it stands among the parts, and sends nothing', async () => {
    let reads = 0;
    const { client, calls } = fakeClient([form], async () => {
      reads += 1;
      return new Uint8Array();
    });
    for (const resource of ['', '   ', ['Reports/q3.pdf'], 7, { path: 'Reports/q3.pdf' }, false]) {
      await expect(client.callTool('board.add_document', { board_id: 'b1', body: { note: 'first', resource, data: { title: 'x' } } })).rejects.toMatchObject({
        status: 400,
        kind: 'file-body',
        data: { error: 'The form\'s "resource" part takes the path of one file to send, and the call gave it none. Give it a path, or leave "resource" out to send no file.' },
      });
    }
    expect(reads).toBe(0);
    expect(calls).toEqual([]);
  });

  it('refuses a form whose file cannot be read, and sends nothing', async () => {
    const { client, calls } = fakeClient([form], async (ref) => {
      throw new FileBodyError(`"${ref}" is not a file you can read, so it cannot be sent`);
    });
    await expect(client.callTool('board.add_document', { board_id: 'b1', body: { resource: 'Finance/Payroll.xlsx', note: 'x' } })).rejects.toMatchObject({
      status: 400,
      kind: 'file-body',
      data: { error: '"Finance/Payroll.xlsx" is not a file you can read, so it cannot be sent' },
    });
    expect(calls).toEqual([]);
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
