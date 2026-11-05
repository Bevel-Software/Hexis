import { describe, expect, it } from 'vitest';
import type { FilesChange } from '@bevel-software/platform-shared';
import { FileChangeNotifier } from '../../kb-fs/index.js';
import { VersionControlService } from '../version-control.service.js';

/**
 * `announceCommitted` is the one emitter the file-change reactors hear, so the
 * contract's shape — paths sorted, no path twice — is made there, whatever a
 * caller passed. Built with the notifier alone: the method touches nothing
 * else of the service.
 */
const none = {} as never;
/** The one collaborator the constructor insists on; `announceCommitted` never calls it. */
const gate = { assertMayChange: async () => undefined } as never;

function serviceWith(notifier?: FileChangeNotifier): VersionControlService {
  return new VersionControlService(none, none, none, none, none, none, none, none, none, gate, undefined, notifier);
}

const USER = { id: 'u-1', email: 'ada@example.com', name: 'Ada' } as never;

describe('VersionControlService.announceCommitted', () => {
  it('hands the reactors the paths sorted and without repeats, whatever order the caller had them in', () => {
    const notifier = new FileChangeNotifier();
    const heard: FilesChange[] = [];
    notifier.onFilesChanged((change) => heard.push(change));

    serviceWith(notifier).announceCommitted({
      workspaceId: 'ws',
      branch: 'main',
      paths: ['knowledge-base/b.md', 'knowledge-base/a/access.md', 'knowledge-base/b.md', 'knowledge-base/A.md'],
      byUser: USER,
    });

    expect(heard).toEqual([
      {
        workspaceId: 'ws',
        branch: 'main',
        paths: ['knowledge-base/A.md', 'knowledge-base/a/access.md', 'knowledge-base/b.md'],
        byUser: USER,
      },
    ]);
  });

  it('is a no-op without a notifier', () => {
    expect(() => serviceWith().announceCommitted({ workspaceId: 'ws', branch: 'main', paths: ['x'], byUser: USER })).not.toThrow();
  });
});
