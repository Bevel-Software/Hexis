import { describe, it, expect, vi } from 'vitest';
import type { AuthUser } from '@bevel-software/shared';
import { FileChangeNotifier, type FilesChange } from '../file-change-notifier.js';

const USER: AuthUser = { id: 'u1', email: 'alice@example.com', name: 'Alice' };

const change = (paths: string[]): FilesChange => ({
  workspaceId: 'ws',
  branch: 'feat',
  paths,
  byUser: USER,
});

describe('FileChangeNotifier', () => {
  it('fans one batched change out to every listener', () => {
    const notifier = new FileChangeNotifier();
    const a = vi.fn();
    const b = vi.fn();
    notifier.onFilesChanged(a);
    notifier.onFilesChanged(b);
    const c = change(['x/Tools/a.tool', 'x/Knowledge/B.md']);
    notifier.emit(c);
    expect(a).toHaveBeenCalledTimes(1);
    expect(a).toHaveBeenCalledWith(c);
    expect(b).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledWith(c);
  });

  it('a throwing listener never blocks the others (commit isolation)', () => {
    const notifier = new FileChangeNotifier();
    const boom = vi.fn(() => {
      throw new Error('boom');
    });
    const after = vi.fn();
    notifier.onFilesChanged(boom);
    notifier.onFilesChanged(after);
    expect(() => notifier.emit(change(['x/A.md']))).not.toThrow();
    expect(after).toHaveBeenCalledOnce();
  });

  it('an empty path list emits nothing; unsubscribe stops delivery', () => {
    const notifier = new FileChangeNotifier();
    const listener = vi.fn();
    const unsubscribe = notifier.onFilesChanged(listener);
    notifier.emit(change([]));
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
    notifier.emit(change(['x/A.md']));
    expect(listener).not.toHaveBeenCalled();
  });
});
