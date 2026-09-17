import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  FILE_TRACE_STORAGE_KEY,
  isFileTraceEnabled,
  syncFileTraceFlag,
  traceFiles,
} from '../file-trace';

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('file trace flag', () => {
  it('is off by default and logs nothing', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    expect(syncFileTraceFlag('')).toBe(false);
    traceFiles('hydrate:start', { branchFromUrl: 'main' });
    expect(info).not.toHaveBeenCalled();
  });

  it('turns on from ?trace=files and stays on for URLs without the query, as a tree click produces', () => {
    expect(syncFileTraceFlag('?trace=files')).toBe(true);
    expect(sessionStorage.getItem(FILE_TRACE_STORAGE_KEY)).toBe('1');
    expect(syncFileTraceFlag('')).toBe(true);
    expect(isFileTraceEnabled()).toBe(true);
  });

  it('turns off from ?trace=off', () => {
    syncFileTraceFlag('?trace=files');
    expect(syncFileTraceFlag('?trace=off')).toBe(false);
    expect(isFileTraceEnabled()).toBe(false);
  });

  it('ignores other trace values', () => {
    expect(syncFileTraceFlag('?trace=everything')).toBe(false);
  });

  it('logs the event and its fields under one prefix when on', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    syncFileTraceFlag('?trace=files');
    traceFiles('wait:branch-mismatch', { branchFromUrl: 'main', gitStatusBranch: 'alice/draft' });
    expect(info).toHaveBeenCalledTimes(1);
    const [prefix, event, fields] = info.mock.calls[0];
    expect(prefix).toBe('[trace:files]');
    expect(event).toBe('wait:branch-mismatch');
    expect(fields).toMatchObject({ branchFromUrl: 'main', gitStatusBranch: 'alice/draft' });
    expect(typeof (fields as { at: unknown }).at).toBe('number');
  });
});
