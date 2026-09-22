import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the shared auth fetch so we can drive arbitrary responses without a
// real network call. The module under test binds to this import at load.
vi.mock('../../../../lib/api', () => ({
  authFetch: vi.fn(),
}));

import { uploadFile, createDirectory, moveEntry, rawFileUrl, writeFile, WorkspaceApiError } from '../workspace.api';
import { authFetch } from '../../../../lib/api';

const mockedFetch = vi.mocked(authFetch);

/** Build a minimal `Response`-shaped stub for the not-OK paths. */
function notOk(status: number, body: unknown): Response {
  return {
    ok: false,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('workspace.api write surface error handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uploadFile surfaces the backend error body on 403, not a bare HTTP code', async () => {
    mockedFetch.mockResolvedValueOnce(
      notOk(403, { error: 'You don\'t have permission to write to "GTM/foo.pdf". Eligible: Admin.' }),
    );
    const file = new File(['hi'], 'foo.pdf');
    await expect(uploadFile('target-company-state', 'foo.pdf', file)).rejects.toMatchObject({
      status: 403,
      message: 'You don\'t have permission to write to "GTM/foo.pdf". Eligible: Admin.',
    });
  });

  it('uploadFile throws a WorkspaceApiError instance carrying the status', async () => {
    mockedFetch.mockResolvedValueOnce(notOk(413, { error: 'File exceeds 52428800 byte limit' }));
    const file = new File(['hi'], 'big.bin');
    const err = await uploadFile('ws-1', 'big.bin', file).catch((e) => e);
    expect(err).toBeInstanceOf(WorkspaceApiError);
    expect(err.status).toBe(413);
    expect(err.message).toBe('File exceeds 52428800 byte limit');
  });

  it('uploadFile falls back to the HTTP status when the body is not JSON', async () => {
    mockedFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error('not json');
      },
    } as unknown as Response);
    const file = new File(['hi'], 'x.md');
    await expect(uploadFile('ws-1', 'x.md', file)).rejects.toMatchObject({
      status: 500,
      message: 'HTTP 500',
    });
  });

  it('createDirectory also surfaces the backend error body on 403', async () => {
    mockedFetch.mockResolvedValueOnce(
      notOk(403, { error: 'You don\'t have permission to write to "GTM/sub". Eligible: Admin.' }),
    );
    await expect(createDirectory('target-company-state', 'sub')).rejects.toMatchObject({
      status: 403,
      message: 'You don\'t have permission to write to "GTM/sub". Eligible: Admin.',
    });
  });
});

/** The one builder every raw-route consumer shares, so its shape is pinned once. */
describe('rawFileUrl', () => {
  it('encodes the path as one query value, so spaces, # and ? in a name round-trip', () => {
    expect(rawFileUrl('ws-1', 'Knowledge/Some File #1?.png')).toBe(
      '/api/workspace/ws-1/file/raw?path=Knowledge%2FSome%20File%20%231%3F.png',
    );
  });

  it('uses the workspace id verbatim: it is already the encoded branch', () => {
    expect(rawFileUrl('alice%2Fdraft', 'a.png')).toBe('/api/workspace/alice%2Fdraft/file/raw?path=a.png');
  });

  it('adds the download flag on request', () => {
    expect(rawFileUrl('ws-1', 'a.png', { download: true })).toBe(
      '/api/workspace/ws-1/file/raw?path=a.png&download=1',
    );
  });

  it('adds a version only once there is one, so an unchanged file keeps a cacheable URL', () => {
    expect(rawFileUrl('ws-1', 'a.png', { version: 0 })).toBe('/api/workspace/ws-1/file/raw?path=a.png');
    expect(rawFileUrl('ws-1', 'a.png', { version: 3 })).toBe('/api/workspace/ws-1/file/raw?path=a.png&v=3');
  });
});

describe('writeFile', () => {
  beforeEach(() => mockedFetch.mockReset());

  it('hands back the save-time skill warnings, and nothing when there are none', async () => {
    const warning = { entry: 'hubspot.serch', message: 'not a tool', suggestion: 'hubspot.search' };
    mockedFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ status: 'written', warnings: [warning] }),
    } as unknown as Response);
    await expect(writeFile('ws', 'kb/Plugins/a/SKILL.md', 'x')).resolves.toEqual({ warnings: [warning] });

    // The usual answer: a body with no `warnings` key at all.
    mockedFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ status: 'written' }),
    } as unknown as Response);
    await expect(writeFile('ws', 'kb/Plugins/a/SKILL.md', 'x')).resolves.toEqual({});

    // A backend built before the check existed answers with no body worth reading.
    mockedFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('no body');
      },
    } as unknown as Response);
    await expect(writeFile('ws', 'kb/notes.md', 'x')).resolves.toEqual({});
  });
});

/**
 * The refusal a rename or a drag shows is the SERVER's sentence, and this is
 * the layer it has to survive to reach the sidebar intact.
 *
 * The explorer renders whatever `moveEntry` rejects with — the rename box puts
 * it under the name you typed, a refused drop puts it under the row. Those
 * components are tested against a stubbed `moveEntry`, so nothing there can
 * tell whether a real 409 becomes that message or becomes "HTTP 409". This
 * closes that half: the body the backend actually sends, through the real
 * client, out as the message the UI renders.
 */
describe('moveEntry carries the destination-taken refusal through unchanged', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const SENTENCE = 'A file named Notes.md already exists in Sales.';

  it('rejects with the sentence itself, not with the HTTP status', async () => {
    mockedFetch.mockResolvedValueOnce(
      // Exactly what `EntryExistsError` puts on the wire (see the backend's
      // `domainErrorBody`): the sentence under `error`, beside the
      // discriminator a client may switch on instead of reading prose.
      notOk(409, { error: SENTENCE, kind: 'entry-exists', entryKind: 'file' }),
    );

    const err = await moveEntry('ws-1', 'kb/Sales/Report.docx', 'kb/Sales/Notes.md').catch((e) => e);

    expect(err).toBeInstanceOf(WorkspaceApiError);
    expect(err.status).toBe(409);
    expect(err.message).toBe(SENTENCE);
  });

  it('says so for a folder in the way too, and sends the move as a PATCH of both paths', async () => {
    const folder = 'A folder named Q4 already exists in Sales.';
    mockedFetch.mockResolvedValueOnce(notOk(409, { error: folder, kind: 'entry-exists', entryKind: 'folder' }));

    await expect(moveEntry('ws-1', 'kb/Archive/Q4', 'kb/Sales/Q4')).rejects.toMatchObject({
      status: 409,
      message: folder,
    });

    const [url, init] = mockedFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/workspace/ws-1/file');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(String(init.body))).toEqual({
      oldPath: 'kb/Archive/Q4',
      newPath: 'kb/Sales/Q4',
    });
  });

  it('resolves silently when the move lands, so the explorer closes its box', async () => {
    mockedFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ status: 'moved' }),
    } as unknown as Response);

    await expect(moveEntry('ws-1', 'kb/a.md', 'kb/b.md')).resolves.toBeUndefined();
  });
});
