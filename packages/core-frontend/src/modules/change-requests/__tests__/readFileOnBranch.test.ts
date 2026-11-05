import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * `readFileOnBranch` is two reads: open the branch's workspace, then read the
 * file in it. Both can answer 404, for opposite reasons — "there is no branch
 * named X" and "this branch has no such file" — and the callers that treat a
 * file-read 404 as a deletion (the change-request pane, the diff boxes) must
 * never be handed the branch's 404 in that shape. The branch failure is told
 * apart as its own error, status kept.
 */

const wsMock = vi.hoisted(() => ({ getOrCreateWorkspace: vi.fn(), readFile: vi.fn() }));
vi.mock('../../workspace/services/workspace.api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../workspace/services/workspace.api')>()),
  getOrCreateWorkspace: wsMock.getOrCreateWorkspace,
  readFile: wsMock.readFile,
}));

import { readFileOnBranch } from '../services/change-requests.api';
import { WorkspaceApiError } from '../../workspace/services/workspace.api';
import { BranchUnavailableError, failureReason, isDenial, statusOf } from '../utils/readFailure';

beforeEach(() => {
  wsMock.getOrCreateWorkspace.mockReset();
  wsMock.readFile.mockReset();
  wsMock.getOrCreateWorkspace.mockResolvedValue({
    workspace: { id: 'ws-7', kbDirName: 'knowledge-base' },
    fileTree: null,
  });
});

describe('readFileOnBranch', () => {
  it('reads the file inside the branch workspace, under its knowledge-base folder', async () => {
    wsMock.readFile.mockResolvedValue('bands:\n');
    await expect(readFileOnBranch('ali/payroll', 'Finance/bands.yaml')).resolves.toBe('bands:\n');
    expect(wsMock.getOrCreateWorkspace).toHaveBeenCalledWith('ali/payroll');
    expect(wsMock.readFile).toHaveBeenCalledWith('ws-7', 'knowledge-base/Finance/bands.yaml');
  });

  it("passes the FILE read's 404 through as it is — that is the branch saying it has no such file", async () => {
    wsMock.readFile.mockRejectedValue(new WorkspaceApiError(404));
    const err = await readFileOnBranch('ali/payroll', 'Finance/bands.yaml').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkspaceApiError);
    expect(err).not.toBeInstanceOf(BranchUnavailableError);
    expect(statusOf(err)).toBe(404);
  });

  it("answers a branch that could not be opened apart from the file's own errors", async () => {
    wsMock.getOrCreateWorkspace.mockRejectedValue(
      new WorkspaceApiError(404, 'There is no branch named ali/payroll.'),
    );
    const err = await readFileOnBranch('ali/payroll', 'Finance/bands.yaml').catch((e: unknown) => e);
    // Not the shape a deletion is read from.
    expect(err).toBeInstanceOf(BranchUnavailableError);
    expect(err).not.toBeInstanceOf(WorkspaceApiError);
    expect((err as BranchUnavailableError).branch).toBe('ali/payroll');
    // The reason the retryable sentence prints names the branch and the cause.
    expect(failureReason(err)).toBe(
      "the branch ali/payroll couldn't be opened (There is no branch named ali/payroll.)",
    );
    // The file was never asked for.
    expect(wsMock.readFile).not.toHaveBeenCalled();
  });

  it('keeps the status of a refused branch, so a refusal still reads as one', async () => {
    wsMock.getOrCreateWorkspace.mockRejectedValue(new WorkspaceApiError(403));
    const err = await readFileOnBranch('ali/payroll', 'Finance/bands.yaml').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BranchUnavailableError);
    expect(isDenial(err)).toBe(true);
  });

  it('carries no status for a branch open that never completed', async () => {
    wsMock.getOrCreateWorkspace.mockRejectedValue(new TypeError('Failed to fetch'));
    const err = await readFileOnBranch('ali/payroll', 'Finance/bands.yaml').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BranchUnavailableError);
    expect(statusOf(err)).toBeNull();
    expect(isDenial(err)).toBe(false);
  });
});
