import { describe, it, expect, vi } from 'vitest';
import type { AuthUser } from '@bevel-software/platform-shared';
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
    notifier.emit(change(['x/Tools/a.tool', 'x/Knowledge/B.md']));
    // Both hear the one change, shaped: paths sorted.
    const shaped = change(['x/Knowledge/B.md', 'x/Tools/a.tool']);
    expect(a).toHaveBeenCalledTimes(1);
    expect(a).toHaveBeenCalledWith(shaped);
    expect(b).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledWith(shaped);
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

  it('hands every listener the paths sorted and unique: the shape of the contract is made here, once', () => {
    const notifier = new FileChangeNotifier();
    const heard: FilesChange[] = [];
    notifier.onFilesChanged((c) => heard.push(c));
    notifier.emit(change(['x/B.md', 'x/A.md', 'x/B.md']));
    expect(heard).toEqual([change(['x/A.md', 'x/B.md'])]);
  });
});
