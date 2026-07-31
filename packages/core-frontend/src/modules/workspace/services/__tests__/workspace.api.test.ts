import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the shared auth fetch so we can drive arbitrary responses without a
// real network call. The module under test binds to this import at load.
vi.mock('../../../../lib/api', () => ({
  authFetch: vi.fn(),
}));

import { uploadFile, createDirectory, WorkspaceApiError } from '../workspace.api';
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
