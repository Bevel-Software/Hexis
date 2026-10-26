import type { Server as HttpServer } from 'node:http';
import fsp, { mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import AdmZip from 'adm-zip';
import express from 'express';
import * as XLSX from 'xlsx';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalFilesystem } from '@mastra/core/workspace';
import { DEFAULT_KB_LAYOUT } from '@bevel-software/platform-shared';
import { testKbContext, TEST_BRANCH_MODEL } from '../../../__tests__/kb-context.js';
import { newWorkspaceService } from '../../../__tests__/workspace-service.js';
import { ToolRegistry } from '../../tool-registry/tool-registry.js';
import { createToolHandlerFactory } from '../../tool-helpers/tool-handler.js';
import type { ToolContext } from '../../tool-helpers/tool.contract.js';
import type { ToolAuth } from '../../tool-auth/tool-auth.middleware.js';
import type { IAccessControl } from '../../access/access-control.interface.js';
import { NodeFs } from '../../kb-fs/node-fs.js';
import { sharedFileRules, sharedFileRulesSection } from '../../agent-instructions/shared-file-rules.js';
import { agentGuideSections, WORKING_WITH_FILES_SECTION_ID } from '../../agent-guide/agent-guide.js';
import { PathNotFoundError } from '../../../shared/domain-errors.js';
import { registerWorkspaceTools } from '../workspace.tools.js';
import { RipgrepPatternMatcher } from '../ripgrep-search.js';
import { RoutineWritePolicyService } from '../routine-write-policy.js';
import { WorkflowHooks } from '../../workflow/workflow-hooks.js';
import { ToolDescriptionNotes } from '../agent-access.gate.js';
import { SpillStore } from '../spill-store.js';
import { DocExtractService } from '../file-readers/doc-extract.service.js';
import { WorkerDocumentExtractor } from '../file-readers/extract-in-worker.js';
import type { WorkspaceService } from '../workspace.service.js';
import { sweepTmpFolder, TMP_MAX_AGE_MS, TmpSweeper } from '../workspace-tmp.js';

/**
 * The reserved `__tmp__/` ref, end to end: the REAL tool routes, the REAL
 * readers and extraction worker, and the REAL `WorkspaceService` resolver on
 * a real workspaces root — a workspace directory holding its checkout and,
 * beside it, the `tmp/` folder the ref reaches. Nothing about the folder is
 * stubbed; only the git side of the service (cloning, locking, committing) is
 * left out, as the other tool suites leave it out.
 */

const KB_DIR = 'knowledge-base';
/** A draft: writes are not gated. */
const DRAFT = 'main';
/** A protected branch of the test branch model: writes are judged. */
const PROTECTED = TEST_BRANCH_MODEL.defaultBranch;

// ── fixtures: real bytes, built by the real libraries ────────────────────

function xlsxBytes(sheets: Record<string, unknown[][]>): Buffer {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

function docxBytes(...paragraphs: string[]): Buffer {
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'));
  zip.addFile(
    'word/document.xml',
    Buffer.from(
      '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
        paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join('') +
        '</w:body></w:document>',
    ),
  );
  return zip.toBuffer();
}

function pptxBytes(slides: string[][]): Buffer {
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'));
  slides.forEach((paragraphs, i) => {
    zip.addFile(
      `ppt/slides/slide${i + 1}.xml`,
      Buffer.from(
        '<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:txBody>' +
          paragraphs.map((p) => `<a:p><a:r><a:t>${p}</a:t></a:r></a:p>`).join('') +
          '</p:txBody></p:sld>',
      ),
    );
  });
  return zip.toBuffer();
}

/** Minimal valid one-page PDF with `text` as its text layer. */
function pdfBytes(text: string): Buffer {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefStart = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const EML = Buffer.from(
  [
    'From: Ana <ana@example.com>',
    'To: Bo <bo@example.com>',
    'Subject: Quarterly plan',
    'Date: Mon, 26 Oct 2026 09:00:00 +0000',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'The plan is attached in the drive.',
    '',
  ].join('\r\n'),
);

/** REAL `.msg` bytes: a CFB container carrying a subject and a plain body, as Outlook writes them. */
function msgBytes(subject: string, body: string): Buffer {
  const cfb = XLSX.CFB.utils.cfb_new();
  XLSX.CFB.utils.cfb_add(cfb, '/__substg1.0_0037001F', Buffer.from(subject, 'utf16le'));
  XLSX.CFB.utils.cfb_add(cfb, '/__substg1.0_1000001F', Buffer.from(body, 'utf16le'));
  return XLSX.CFB.write(cfb, { type: 'buffer' }) as Buffer;
}

/** A real, complete 1×1 transparent PNG. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

const SPREADSHEET = xlsxBytes({ Plan: [['Quarter', 'Revenue'], ['Q1', 100]], Notes: [['risk', 'supply chain']] });

// ── harness ───────────────────────────────────────────────────────────────

/** Allow-all access, except that writes under `Locked/` are refused on a protected branch. */
const access = {
  canRead: async () => true,
  canReadBatch: async (_w: string, _u: string, paths: string[]) => new Map(paths.map((p) => [p, true])),
  canWrite: async () => true,
  canWriteBatch: async (_w: string, _u: string, paths: string[]) => new Map(paths.map((p) => [p, true])),
  canDownload: async () => true,
  canOwner: async () => true,
  canWriteBatchAtRef: async (_w: string, _r: string, _u: string, paths: string[]) =>
    new Map(paths.map((p) => [p, !p.startsWith('Locked/')])),
  eligibleWritersAtRef: async () => ({ roles: [], users: [] }),
  // Records what each preview was asked, so a dry run can be checked for the
  // staged text it hands over; the real reading is the access service's own
  // test (`access-control.preview-relocation.test.ts`).
  previewAccessAfterRelocation: async (...asked: unknown[]) => {
    previews.push(asked);
    return { read: true, write: true, download: true, owner: true };
  },
} as unknown as IAccessControl;
const previews: unknown[][] = [];

let httpServer: HttpServer | undefined;
let root = '';
let docCacheDir = '';
let matcher: RipgrepPatternMatcher | undefined;
let extractor: WorkerDocumentExtractor | undefined;
let service: WorkspaceService;

/** The directory of `branch`'s workspace: its checkout and its `tmp/` folder side by side. */
const workspaceDir = (branch: string): string => join(root, encodeURIComponent(branch));
/** Stage `bytes` at `rel` in `branch`'s tmp folder, as the chat or the SharePoint reader does. */
async function stage(rel: string, bytes: Buffer | string, branch = DRAFT): Promise<string> {
  const abs = join(workspaceDir(branch), 'tmp', rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, bytes);
  return abs;
}
/** Put `bytes` at a repository path of `branch`, straight on disk. */
async function commitFixture(rel: string, bytes: Buffer | string, branch = DRAFT): Promise<void> {
  const abs = join(workspaceDir(branch), KB_DIR, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, bytes);
}

async function start(): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'ws-tmp-ref-'));
  docCacheDir = await mkdtemp(join(tmpdir(), 'ws-tmp-ref-cache-'));
  for (const branch of [DRAFT, PROTECTED]) await mkdir(join(workspaceDir(branch), KB_DIR), { recursive: true });
  service = newWorkspaceService(root, 'https://example.invalid/kb.git', testKbContext(), new NodeFs());
  matcher = new RipgrepPatternMatcher();
  extractor = new WorkerDocumentExtractor();
  const filesystems = new Map<string, LocalFilesystem>();
  const resolve = async (auth: ToolAuth, signal: AbortSignal, sessionId?: string): Promise<ToolContext> => ({
    user: { id: 'u', email: 'e@x', name: 'N' },
    scope: auth.scope,
    source: auth.source,
    sessionId,
    abortSignal: signal,
    // The tmp side is the real service's; the clone side is the workspace
    // directory as it already stands on disk.
    workspaceService: {
      readFileBinary: (id: string, p: string) => service.readFileBinary(id, p),
      statTmpFile: (id: string, ref: string) => service.statTmpFile(id, ref),
      getWorkspacePath: async (id: string) => join(root, id),
      hasBootstrappedWorkspace: async () => false,
    } as never,
    workflowService: {} as never,
    events: {} as never,
    getFilesystem: async (branch: string) => {
      let fs = filesystems.get(branch);
      if (!fs) {
        fs = new LocalFilesystem({ basePath: workspaceDir(branch), contained: true });
        filesystems.set(branch, fs);
      }
      return fs;
    },
  });
  const app = express();
  app.use(express.json());
  const router = express.Router();
  const auth = (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.toolAuth = { source: 'external', userId: 'u', scope: 'write' };
    next();
  };
  registerWorkspaceTools(
    new ToolRegistry(),
    router,
    auth,
    createToolHandlerFactory(resolve),
    new SpillStore(join(tmpdir(), 'bevel-test-spills')),
    new DocExtractService(docCacheDir, extractor),
    access,
    testKbContext({ kbDirName: KB_DIR }),
    { recoveryBotEmail: 'bot@x', hooks: new WorkflowHooks(), notes: new ToolDescriptionNotes() },
    new RoutineWritePolicyService(),
    {} as never,
    undefined,
    undefined,
    // The upload store: enough of it that the upload tools are mounted, so
    // their refusal of a ref is asserted rather than assumed.
    { maxBytes: 1, issue: async () => { throw new Error('not reached'); } } as never,
    undefined,
    // The download store, for the same reason: `request_file_download` is
    // mounted, and its `paths` list is refused a ref like any other input.
    { assertCanIssue: () => { throw new Error('not reached'); } } as never,
    undefined,
    undefined,
    matcher,
  );
  app.use('/api', router);
  httpServer = await new Promise<HttpServer>((r) => {
    const s = app.listen(0, () => r(s));
  });
  return `http://127.0.0.1:${(httpServer.address() as { port: number }).port}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a JSON body read field by field
type Body = Record<string, any>;
async function call(base: string, tool: string, body: Record<string, unknown>): Promise<{ status: number; body: Body }> {
  const res = await fetch(`${base}/api/agent/tools/${tool}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer x' },
    body: JSON.stringify({ branch: DRAFT, ...body }),
  });
  return { status: res.status, body: (await res.json()) as Body };
}

afterEach(async () => {
  if (httpServer) await new Promise<void>((r) => httpServer!.close(() => r()));
  httpServer = undefined;
  await matcher?.close();
  await extractor?.close();
  matcher = undefined;
  extractor = undefined;
  for (const dir of [root, docCacheDir]) if (dir) await rm(dir, { recursive: true, force: true });
  root = '';
  docCacheDir = '';
});

// ── read_file ─────────────────────────────────────────────────────────────

describe('read_file on a tmp ref answers exactly as the same file under a repository path', () => {
  const CASES: Array<[string, Buffer, RegExp]> = [
    ['plan-a1b2c3d4e5f6.xlsx', SPREADSHEET, /\[sheet: Plan\][\s\S]*Q1[\s\S]*\[sheet: Notes\][\s\S]*supply chain/],
    ['brief.pdf', pdfBytes('Hello from the brief'), /\[page 1\][\s\S]*Hello from the brief/],
    ['deck.pptx', pptxBytes([['First slide'], ['Second slide']]), /\[slide 1\][\s\S]*First slide[\s\S]*\[slide 2\][\s\S]*Second slide/],
    ['memo.docx', docxBytes('A memo paragraph'), /A memo paragraph/],
    ['mail.eml', EML, /\[subject\] Quarterly plan[\s\S]*The plan is attached/],
    ['mail.msg', msgBytes('Outlook subject', 'Outlook body text'), /\[subject\] Outlook subject[\s\S]*Outlook body text/],
    ['notes.txt', Buffer.from('plain notes\n'), /^plain notes\n$/],
    ['page.md', Buffer.from('# Page\n\nbody\n'), /^# Page\n\nbody\n$/],
  ];

  it.each(CASES)('%s', async (name, bytes, expected) => {
    const base = await start();
    await stage(`chat-uploads/${name}`, bytes);
    await commitFixture(`KnowledgeBase/${name}`, bytes);
    const ref = `__tmp__/chat-uploads/${name}`;
    const repo = `${KB_DIR}/KnowledgeBase/${name}`;

    const fromTmp = await call(base, 'read_file', { path: ref });
    const fromRepo = await call(base, 'read_file', { path: repo });

    expect(fromTmp.status).toBe(200);
    expect(fromTmp.body.path).toBe(ref);
    expect(fromTmp.body.content).toMatch(expected);
    // The same reader and the same extraction: only the name it is shown under differs.
    expect(fromTmp.body.content).toBe(fromRepo.body.content.replaceAll(repo, ref));
    expect(fromTmp.body.canWrite).toBe(false);
  });

  it('a .png answers as the image itself, as a repository image does', async () => {
    const base = await start();
    await stage('chat-uploads/logo.png', PNG_1X1);
    await commitFixture('KnowledgeBase/logo.png', PNG_1X1);

    const fromTmp = await call(base, 'read_file', { path: '__tmp__/chat-uploads/logo.png' });
    const fromRepo = await call(base, 'read_file', { path: `${KB_DIR}/KnowledgeBase/logo.png` });

    expect(fromTmp.status).toBe(200);
    expect(fromTmp.body).toMatchObject({ kind: 'bevel/mcp-image@v1', mimeType: 'image/png', data: PNG_1X1.toString('base64') });
    expect(fromTmp.body.note).toContain('__tmp__/chat-uploads/logo.png');
    expect(fromTmp.body.note).toContain('canWrite: false');
    expect(fromTmp.body.data).toBe(fromRepo.body.data);
  });

  it('offset/limit slice a tmp file as they slice any other', async () => {
    const base = await start();
    await stage('notes.txt', 'abcdefghij');
    expect((await call(base, 'read_file', { path: '__tmp__/notes.txt', offset: 2, limit: 3 })).body.content).toBe('cde');
  });

  it('reads the workspace of the branch the call names, and no other', async () => {
    const base = await start();
    await stage('only-here.txt', 'protected copy', PROTECTED);
    expect((await call(base, 'read_file', { branch: PROTECTED, path: '__tmp__/only-here.txt' })).body.content).toBe('protected copy');
    expect((await call(base, 'read_file', { branch: DRAFT, path: '__tmp__/only-here.txt' })).status).toBe(404);
  });
});

// ── the ref names one file ───────────────────────────────────────────────

describe('a tmp ref names one file inside the workspace\'s tmp folder', () => {
  it('refuses the bare prefix, a folder, `..`, an absolute path and a control character, naming the rule', async () => {
    const base = await start();
    await stage('chat-uploads/plan.xlsx', SPREADSHEET);
    await commitFixture('x', 'repository file');
    const refused: Array<[string, RegExp]> = [
      ['__tmp__/', /names the tmp folder itself/],
      ['__tmp__', /names the tmp folder itself/],
      ['__tmp__/chat-uploads', /names a folder/],
      ['__tmp__/chat-uploads/', /names a folder/],
      [`__tmp__/../${KB_DIR}/x`, /`\.\.` segment/],
      ['__tmp__/chat-uploads/../chat-uploads/plan.xlsx', /`\.\.` segment/],
      ['__tmp__//etc/passwd', /absolute/],
      ['__tmp__/C:/Windows/win.ini', /absolute/],
      ['__tmp__/a\\..\\b', /backslash/],
      ['__tmp__/chat-uploads/plan.xlsx\nzzz', /control character/],
    ];
    for (const [ref, rule] of refused) {
      const { status, body } = await call(base, 'read_file', { path: ref });
      expect(status, ref).toBe(400);
      expect(body.kind, ref).toBe('tmp-ref-invalid');
      expect(body.error, ref).toMatch(/is not a valid tmp ref/);
      expect(body.error, ref).toMatch(rule);
      // Nothing of the repository file — or of anything else — came back.
      expect(JSON.stringify(body), ref).not.toContain('repository file');
    }
  });

  it('never follows a link out of the folder', async () => {
    const base = await start();
    await commitFixture('secret.md', 'repository secret');
    await mkdir(join(workspaceDir(DRAFT), 'tmp'), { recursive: true });
    await symlink(join(workspaceDir(DRAFT), KB_DIR), join(workspaceDir(DRAFT), 'tmp', 'kb'));
    await symlink(join(workspaceDir(DRAFT), KB_DIR, 'secret.md'), join(workspaceDir(DRAFT), 'tmp', 'secret.md'));
    for (const ref of ['__tmp__/kb/secret.md', '__tmp__/secret.md']) {
      const { status, body } = await call(base, 'read_file', { path: ref });
      expect(status, ref).toBe(400);
      expect(body.error, ref).toMatch(/link that leads out of the workspace's tmp folder/);
      expect(JSON.stringify(body), ref).not.toContain('repository secret');
    }
  });

  it('a file that does not exist is the ordinary not-found, naming the ref and never a disk path', async () => {
    const base = await start();
    await stage('other.txt', 'x');
    for (const ref of ['__tmp__/chat-uploads/gone.xlsx', '__tmp__/other.txt/below']) {
      const { status, body } = await call(base, 'read_file', { path: ref });
      expect(status, ref).toBe(404);
      expect(body.kind, ref).toBe('not_found');
      expect(body.path, ref).toBe(ref);
      expect(body.error, ref).toContain(`"${ref}"`);
      expect(JSON.stringify(body), ref).not.toContain(root);
    }
    // A workspace with no tmp folder at all answers the same.
    const none = await call(base, 'read_file', { branch: PROTECTED, path: '__tmp__/x.txt' });
    expect(none.status).toBe(404);
    expect(none.body.path).toBe('__tmp__/x.txt');
  });

  it('a loop of links is refused by the link rule, naming the ref and never a disk path', async () => {
    const base = await start();
    await mkdir(join(workspaceDir(DRAFT), 'tmp'), { recursive: true });
    await symlink(join(workspaceDir(DRAFT), 'tmp', 'loop'), join(workspaceDir(DRAFT), 'tmp', 'loop'));
    const { status, body } = await call(base, 'read_file', { path: '__tmp__/loop' });
    expect(status).toBe(400);
    expect(body.kind).toBe('tmp-ref-invalid');
    expect(body.error).toMatch(/link that cannot be followed/);
    expect(JSON.stringify(body)).not.toContain(root);
  });

  it('a file the disk will not let it read answers a 500 naming the ref alone, in all four tools', async () => {
    const base = await start();
    await stage('chat-uploads/locked.txt', 'x');
    const realpath = fsp.realpath.bind(fsp);
    // A permission failure carries the path on disk in its message, as the
    // filesystem raises it.
    const spy = vi.spyOn(fsp, 'realpath').mockImplementation((async (p: string, ...rest: unknown[]) => {
      if (String(p).endsWith('locked.txt')) {
        throw Object.assign(new Error(`EACCES: permission denied, realpath '${String(p)}'`), { code: 'EACCES' });
      }
      return (realpath as (...a: unknown[]) => Promise<string>)(p, ...rest);
    }) as typeof fsp.realpath);
    try {
      const ref = '__tmp__/chat-uploads/locked.txt';
      const calls: Array<[string, Record<string, unknown>]> = [
        ['read_file', { path: ref }],
        ['file_stat', { path: ref }],
        ['grep', { path: ref, pattern: 'x' }],
        ['copy_file', { src: ref, dest: 'locked.txt' }],
      ];
      for (const [tool, args] of calls) {
        const { status, body } = await call(base, tool, args);
        expect(status, tool).toBe(500);
        expect(body.kind, tool).toBe('tmp-ref-unreadable');
        expect(body.path, tool).toBe(ref);
        expect(body.error, tool).toContain(`"${ref}" could not be read`);
        expect(JSON.stringify(body), tool).not.toContain(root);
        expect(JSON.stringify(body), tool).not.toContain('EACCES');
      }
    } finally {
      spy.mockRestore();
    }
  });

  it('a repository folder spelled like the ref stays a repository path', async () => {
    const base = await start();
    await commitFixture('__tmp__/kept.md', 'in the repository');
    await stage('kept.md', 'in tmp');
    expect((await call(base, 'read_file', { path: `${KB_DIR}/__tmp__/kept.md` })).body.content).toBe('in the repository');
    expect((await call(base, 'read_file', { path: '__tmp__/kept.md' })).body.content).toBe('in tmp');
  });
});

// ── file_stat, grep ──────────────────────────────────────────────────────

describe('file_stat and grep on a tmp ref', () => {
  it('file_stat answers a repository file\'s shape, with canWrite false', async () => {
    const base = await start();
    await stage('chat-uploads/plan.xlsx', SPREADSHEET);
    await commitFixture('KnowledgeBase/plan.xlsx', SPREADSHEET);
    const tmp = (await call(base, 'file_stat', { path: '__tmp__/chat-uploads/plan.xlsx' })).body;
    const repo = (await call(base, 'file_stat', { path: `${KB_DIR}/KnowledgeBase/plan.xlsx` })).body;
    for (const key of ['name', 'type', 'size', 'contentMode', 'kind', 'mime', 'mimeSource']) {
      expect(tmp[key], key).toEqual(repo[key]);
    }
    expect(tmp).toMatchObject({ size: SPREADSHEET.length, contentMode: 'document', kind: 'document', canWrite: false, textEditable: false, movable: false, deletable: false });
    expect(tmp.access).toEqual({ read: true, write: false, download: false, owner: false });
    expect(typeof tmp.modifiedAt).toBe('string');
    expect(JSON.stringify(tmp)).not.toContain(root);
  });

  it('file_stat on a text, an image and a missing ref', async () => {
    const base = await start();
    await stage('notes.md', '# notes\n');
    await stage('logo.png', PNG_1X1);
    expect((await call(base, 'file_stat', { path: '__tmp__/notes.md' })).body).toMatchObject({ contentMode: 'text', kind: 'text', textEditable: false });
    expect((await call(base, 'file_stat', { path: '__tmp__/logo.png' })).body).toMatchObject({ kind: 'image', mime: 'image/png' });
    const missing = await call(base, 'file_stat', { path: '__tmp__/nope.md' });
    expect(missing.status).toBe(404);
    expect(missing.body.path).toBe('__tmp__/nope.md');
    expect((await call(base, 'file_stat', { path: '__tmp__/' })).status).toBe(400);
  });

  it('grep with path set to a ref searches that one file, through its extraction', async () => {
    const base = await start();
    await stage('chat-uploads/plan.xlsx', SPREADSHEET);
    await stage('chat-uploads/other.txt', 'supply chain in another file\n');
    await commitFixture('KnowledgeBase/also.md', 'supply chain in the repository\n');
    const { status, body } = await call(base, 'grep', { path: '__tmp__/chat-uploads/plan.xlsx', pattern: 'supply chain' });
    expect(status).toBe(200);
    expect(body.matches).toHaveLength(1);
    expect(body.matches[0]).toMatchObject({ path: '__tmp__/chat-uploads/plan.xlsx' });
    expect(body.matches[0].text).toContain('supply chain');
    // The line number is the one read_file's extraction gives the line.
    const read = (await call(base, 'read_file', { path: '__tmp__/chat-uploads/plan.xlsx' })).body.content as string;
    expect(read.split('\n')[body.matches[0].line - 1]).toBe(body.matches[0].text);
  });

  it('grep on a folder ref or a missing ref is refused, never an empty result', async () => {
    const base = await start();
    await stage('chat-uploads/a.txt', 'x');
    expect((await call(base, 'grep', { path: '__tmp__/chat-uploads', pattern: 'x' })).status).toBe(400);
    const missing = await call(base, 'grep', { path: '__tmp__/chat-uploads/b.txt', pattern: 'x' });
    expect(missing.status).toBe(404);
    expect(missing.body.path).toBe('__tmp__/chat-uploads/b.txt');
  });
});

// ── copy_file out of tmp ─────────────────────────────────────────────────

describe('copy_file from a tmp ref to a repository path', () => {
  it('places the bytes in the repository, a normal repository file from then on', async () => {
    const base = await start();
    await stage('chat-uploads/plan-a1b2c3d4e5f6.xlsx', SPREADSHEET);
    const ref = '__tmp__/chat-uploads/plan-a1b2c3d4e5f6.xlsx';
    const dest = 'KnowledgeBase/Sales/Plan.xlsx';

    const dry = await call(base, 'copy_file', { src: ref, dest, dryRun: true });
    expect(dry.body).toMatchObject({ kind: 'file', descendants: 1, allowed: true, dryRun: true, copied: false });

    const { status, body } = await call(base, 'copy_file', { src: ref, dest });
    expect(status).toBe(200);
    expect(body).toMatchObject({ src: ref, dest: `${KB_DIR}/${dest}`, copied: true });
    expect(await readFile(join(workspaceDir(DRAFT), KB_DIR, dest))).toEqual(SPREADSHEET);

    // Read back at the repository path: the same extraction, now writable,
    // and the staged file is where it was.
    const repoRead = (await call(base, 'read_file', { path: dest })).body;
    const tmpRead = (await call(base, 'read_file', { path: ref })).body;
    expect(repoRead.content).toBe((tmpRead.content as string).replaceAll(ref, `${KB_DIR}/${dest}`));
    expect(repoRead.canWrite).toBe(true);
    expect((await call(base, 'file_stat', { path: dest })).body).toMatchObject({ managed: false, movable: true, deletable: true, textEditable: false });
    expect(await readFile(join(workspaceDir(DRAFT), 'tmp', 'chat-uploads/plan-a1b2c3d4e5f6.xlsx'))).toEqual(SPREADSHEET);
  });

  it('the dry run previews the access the staged file carries in, as a repository copy does', async () => {
    const base = await start();
    const staged = '---\nread:\n  - deny everyone\n---\n# Staged\n';
    await stage('a.md', staged);
    previews.length = 0;

    const dry = await call(base, 'copy_file', { src: '__tmp__/a.md', dest: 'KnowledgeBase/a.md', dryRun: true });

    expect(dry.status).toBe(200);
    // The ref as the source, its text as what travels: the same relocation
    // reading a repository source gets, never "nothing travels".
    expect(previews).toEqual([
      [expect.any(String), 'e@x', '__tmp__/a.md', 'KnowledgeBase/a.md', { sourceRemains: true, sourceContent: staged }],
    ]);
    expect(dry.body.access.after).toEqual({ read: true, write: true, download: true, owner: true });
  });

  it('never replaces what is at the destination', async () => {
    const base = await start();
    await stage('a.md', 'staged');
    await commitFixture('KnowledgeBase/a.md', 'existing');
    const { status, body } = await call(base, 'copy_file', { src: '__tmp__/a.md', dest: 'KnowledgeBase/a.md' });
    expect(status).toBe(409);
    expect(body.error).toContain('already exists');
    expect(await readFile(join(workspaceDir(DRAFT), KB_DIR, 'KnowledgeBase/a.md'), 'utf8')).toBe('existing');
  });

  it('to a path the caller may not write: the refusal any repository write gives, and nothing lands', async () => {
    const base = await start();
    await stage('a.md', 'staged', PROTECTED);
    await commitFixture('KnowledgeBase/a.md', 'repository', PROTECTED);
    const fromTmp = await call(base, 'copy_file', { branch: PROTECTED, src: '__tmp__/a.md', dest: 'Locked/a.md' });
    const fromRepo = await call(base, 'copy_file', { branch: PROTECTED, src: 'KnowledgeBase/a.md', dest: 'Locked/a.md' });
    expect(fromTmp.status).toBe(403);
    expect(fromTmp.status).toBe(fromRepo.status);
    expect(fromTmp.body.kind).toBe('write-denied');
    expect(fromTmp.body.error).toBe(fromRepo.body.error);
    // Asked before the source is: a missing staged file is refused the same way.
    const missing = await call(base, 'copy_file', { branch: PROTECTED, src: '__tmp__/gone.md', dest: 'Locked/a.md' });
    expect(missing.body.error).toBe(fromRepo.body.error);
    await expect(stat(join(workspaceDir(PROTECTED), KB_DIR, 'Locked/a.md'))).rejects.toThrow();
  });

  it('a missing staged file is not-found naming the ref', async () => {
    const base = await start();
    const { status, body } = await call(base, 'copy_file', { src: '__tmp__/gone.xlsx', dest: 'KnowledgeBase/x.xlsx' });
    expect(status).toBe(404);
    expect(body.path).toBe('__tmp__/gone.xlsx');
    expect(JSON.stringify(body)).not.toContain(root);
  });
});

// ── read-only through the ref ────────────────────────────────────────────

describe('every writing tool refuses a tmp ref', () => {
  const REF = '__tmp__/chat-uploads/plan.xlsx';
  const CALLS: Array<[string, Record<string, unknown>]> = [
    ['write_file', { path: REF, content: 'x' }],
    ['write_files', { files: [{ path: REF, content: 'x' }] }],
    ['edit_file', { path: REF, old_string: 'a', new_string: 'b' }],
    ['move_file', { src: REF, dest: 'KnowledgeBase/moved.xlsx' }],
    ['move_file', { src: 'KnowledgeBase/a.md', dest: REF }],
    ['copy_file', { src: 'KnowledgeBase/a.md', dest: REF }],
    ['delete_file', { path: REF }],
    ['delete_folder', { path: '__tmp__/chat-uploads', confirm: true }],
    ['mkdir', { path: '__tmp__/new' }],
    ['unzip', { path: '__tmp__/archive.zip' }],
    ['apply_file_upload', { token: 'x', destination: '__tmp__/chat-uploads' }],
    ['list_files', { path: '__tmp__/chat-uploads' }],
    ['request_file_download', { paths: ['KnowledgeBase/a.md', REF] }],
  ];

  it.each(CALLS)('%s %j', async (tool, args) => {
    const base = await start();
    const staged = await stage('chat-uploads/plan.xlsx', SPREADSHEET);
    await commitFixture('KnowledgeBase/a.md', 'a');
    const { status, body } = await call(base, tool, args);
    expect(status).toBe(400);
    expect(body.kind).toBe('tmp-ref-read-only');
    expect(body.error).toContain('read-only through the ref');
    expect(body.error).toContain('copy_file');
    expect(body.error).toContain(tool);
    // Untouched, and nothing appeared in the repository under the ref's name.
    expect(await readFile(staged)).toEqual(SPREADSHEET);
    await expect(stat(join(workspaceDir(DRAFT), KB_DIR, '__tmp__'))).rejects.toThrow();
    expect(await readFile(join(workspaceDir(DRAFT), KB_DIR, 'KnowledgeBase/a.md'), 'utf8')).toBe('a');
  });

  it('request_file_upload takes no path, so it has no ref to refuse', async () => {
    const base = await start();
    expect((await call(base, 'request_file_upload', { path: REF })).status).toBe(400);
  });
});

// ── WorkspaceService.readFileBinary ──────────────────────────────────────

describe('WorkspaceService.readFileBinary accepts a tmp ref', () => {
  it('answers the staged bytes, under the same rules', async () => {
    await start();
    await stage('chat-uploads/plan.xlsx', SPREADSHEET);
    const id = encodeURIComponent(DRAFT);
    expect(await service.readFileBinary(id, '__tmp__/chat-uploads/plan.xlsx')).toEqual(SPREADSHEET);
    await expect(service.readFileBinary(id, '__tmp__/chat-uploads')).rejects.toThrow(/names a folder/);
    await expect(service.readFileBinary(id, `__tmp__/../${KB_DIR}/x`)).rejects.toThrow(/`\.\.` segment/);
    const missing = service.readFileBinary(id, '__tmp__/gone.xlsx');
    await expect(missing).rejects.toBeInstanceOf(PathNotFoundError);
    await expect(service.readFileBinary(id, '__tmp__/gone.xlsx')).rejects.toMatchObject({ path: '__tmp__/gone.xlsx' });
    // A workspace id that names no single workspace directory reaches nothing.
    for (const bad of ['..', '.', '']) {
      await expect(service.readFileBinary(bad, '__tmp__/chat-uploads/plan.xlsx')).rejects.toThrow();
    }
  });
});

// ── the seven-day sweep ──────────────────────────────────────────────────

describe('the periodic sweep of every workspace\'s tmp folder', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const age = async (abs: string, days: number) => {
    const when = new Date(Date.now() - days * DAY);
    await utimes(abs, when, when);
  };

  it('removes an entry last modified eight days ago and keeps one modified yesterday, in every workspace', async () => {
    await start();
    const old = await stage('chat-uploads/old.xlsx', SPREADSHEET);
    const fresh = await stage('chat-uploads/fresh.xlsx', SPREADSHEET);
    const oldFolder = await stage('sharepoint/abc/doc.docx', docxBytes('x'), PROTECTED);
    await age(old, 8);
    await age(fresh, 1);
    await age(oldFolder, 8);
    await age(dirname(oldFolder), 8);
    await age(join(workspaceDir(PROTECTED), 'tmp', 'sharepoint'), 8);
    // `chat-uploads/` itself is young (an upload landed in it yesterday): the
    // old file in it goes all the same, judged on its own.
    const { removed } = await service.sweepTmp();
    await expect(stat(old)).rejects.toThrow();
    expect(await readFile(fresh)).toEqual(SPREADSHEET);
    await expect(stat(join(workspaceDir(PROTECTED), 'tmp', 'sharepoint'))).rejects.toThrow();
    // The old file, then the folders it emptied that were old themselves.
    expect(removed[encodeURIComponent(PROTECTED)]).toBe(3);
    expect((await stat(join(workspaceDir(DRAFT), 'tmp', 'chat-uploads'))).isDirectory()).toBe(true);
  });

  it('keeps the tmp folder itself, however old, and an old folder that still holds a young file', async () => {
    await start();
    const file = await stage('a.txt', 'x');
    const young = await stage('old-folder/young.txt', 'y');
    await age(file, 8);
    await age(young, 1);
    await age(dirname(young), 8);
    await age(join(workspaceDir(DRAFT), 'tmp'), 8);
    await service.sweepTmp();
    await expect(stat(file)).rejects.toThrow();
    expect(await readFile(young, 'utf8')).toBe('y');
    expect((await stat(join(workspaceDir(DRAFT), 'tmp'))).isDirectory()).toBe(true);
  });

  it('removes a stale link as the link, never what it points at', async () => {
    await start();
    await commitFixture('keep.md', 'kept');
    await mkdir(join(workspaceDir(DRAFT), 'tmp'), { recursive: true });
    const link = join(workspaceDir(DRAFT), 'tmp', 'kb');
    await symlink(join(workspaceDir(DRAFT), KB_DIR), link);
    const when = new Date(Date.now() - 8 * DAY);
    const { lutimes } = await import('node:fs/promises');
    await lutimes(link, when, when);
    await service.sweepTmp();
    await expect(stat(link)).rejects.toThrow();
    expect(await readFile(join(workspaceDir(DRAFT), KB_DIR, 'keep.md'), 'utf8')).toBe('kept');
  });

  it('is what the platform runs on its timer: at start, then every interval, until stopped', async () => {
    let sweeps = 0;
    const sweeper = new TmpSweeper(async () => {
      sweeps += 1;
    });
    sweeper.startSweeping(20);
    sweeper.startSweeping(20); // idempotent
    await sweeper.drainSweep();
    expect(sweeps).toBe(1);
    await new Promise((r) => setTimeout(r, 70));
    sweeper.stopSweeping();
    await sweeper.drainSweep();
    const stopped = sweeps;
    expect(stopped).toBeGreaterThanOrEqual(2);
    await new Promise((r) => setTimeout(r, 60));
    expect(sweeps).toBe(stopped);
  });

  it('stopping cancels the sweep in flight: it removes nothing more, and the drain waits for it to end', async () => {
    await start();
    const files: string[] = [];
    for (const ws of [DRAFT, PROTECTED]) {
      for (let i = 0; i < 3; i += 1) {
        const abs = await stage(`old-${i}.txt`, 'x', ws);
        await age(abs, 8);
        files.push(abs);
      }
    }
    const signals: AbortSignal[] = [];
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const sweeper = new TmpSweeper(async (signal) => {
      signals.push(signal);
      // Stopped before the sweep gets to look at anything.
      await held;
      return service.sweepTmp(undefined, undefined, signal);
    });
    sweeper.startSweeping(60_000);
    sweeper.stopSweeping();
    expect(signals[0]!.aborted).toBe(true);
    release();
    await sweeper.drainSweep();
    for (const abs of files) expect(await readFile(abs, 'utf8')).toBe('x');
    // Not cancelled, the same sweep removes them all.
    await service.sweepTmp();
    for (const abs of files) await expect(stat(abs)).rejects.toThrow();
  });

  it('a stop that comes while an entry is being looked at removes nothing more, that entry included', async () => {
    await start();
    const abs = await stage('old.txt', 'x');
    await age(abs, 8);
    const stop = new AbortController();
    const lstat = fsp.lstat.bind(fsp);
    // The stop lands DURING the look at the old file, after the abort check
    // that came before it.
    const spy = vi.spyOn(fsp, 'lstat').mockImplementation((async (p: string, ...rest: unknown[]) => {
      const stat = await (lstat as (...a: unknown[]) => Promise<unknown>)(p, ...rest);
      if (String(p) === abs) stop.abort();
      return stat;
    }) as typeof fsp.lstat);
    try {
      const removed = await sweepTmpFolder(new NodeFs(), workspaceDir(DRAFT), TMP_MAX_AGE_MS, Date.now(), stop.signal);
      expect(stop.signal.aborted).toBe(true);
      expect(removed).toEqual([]);
    } finally {
      spy.mockRestore();
    }
    expect(await readFile(abs, 'utf8')).toBe('x');
  });

  it('sweeps at seven days', () => {
    expect(TMP_MAX_AGE_MS).toBe(7 * DAY);
  });
});

// ── the agent guide ──────────────────────────────────────────────────────

describe('the agent guide\'s file-tools section describes the ref', () => {
  it('states the ref, what it reaches, that it is read-only, copy_file to keep, and the seven-day sweep', async () => {
    const rule = sharedFileRules(DEFAULT_KB_LAYOUT).find((r) => r.id === 'workspace-tmp')!.body;
    expect(rule).toContain('`__tmp__/<path>`');
    expect(rule).toContain('`tmp/` folder');
    expect(rule).toContain('read-only');
    expect(rule).toContain('copy_file it to a repository path');
    expect(rule).toContain('seven days');
    for (const tool of ['read_file', 'file_stat', 'grep', 'copy_file']) expect(rule).toContain(tool);
    expect(sharedFileRulesSection(DEFAULT_KB_LAYOUT)).toContain(rule);
    const sections = await agentGuideSections(DEFAULT_KB_LAYOUT);
    const files = sections.find((s) => s.id === WORKING_WITH_FILES_SECTION_ID)!;
    expect(files.body).toContain(rule);
  });
});
