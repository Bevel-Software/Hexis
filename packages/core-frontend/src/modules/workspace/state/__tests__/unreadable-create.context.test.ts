import { describe, it, expect, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useUnreadableCreateGateState } from '../unreadable-create.context';

/**
 * The gate's promise is what an upload is WAITING ON. Every way the question
 * can stop being answerable therefore has to answer it anyway: a promise left
 * pending is a batch that is neither created nor cancelled, and the user is
 * given no sign either way.
 *
 * Cancel-shaped (false) is the answer in all of them — the batch was never
 * confirmed, and creating on a question nobody read is the one outcome the
 * ticket forbids.
 */

/** A `canRead` the test releases by hand, so the in-flight window is a place. */
function heldCanRead() {
  let release: (canRead: boolean) => void = () => {};
  const canRead = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        release = resolve;
      }),
  );
  return { canRead, release: (v: boolean) => release(v) };
}

const options = (identity: string | null, canRead: () => Promise<boolean>) => ({
  identity,
  toRepoRelative: (folder: string) => folder,
  canRead,
});

describe('the read gate before a create nobody could see', () => {
  it('answers a question whose tree went away while the read was in flight', async () => {
    const held = heldCanRead();
    const { result, unmount } = renderHook(() =>
      useUnreadableCreateGateState(options('ws-main', held.canRead)),
    );

    let answered: boolean | null = null;
    void result.current.gate('Data', ['sheet.xlsx']).then((ok) => {
      answered = ok;
    });
    await act(async () => {});
    unmount();
    // The verdict lands after the tree is gone: no dialog can be shown for it.
    await act(async () => {
      held.release(false);
      await Promise.resolve();
    });

    expect(answered).toBe(false);
  });

  it('answers a question the workspace changed under, and opens no dialog', async () => {
    const held = heldCanRead();
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useUnreadableCreateGateState(options(id, held.canRead)),
      { initialProps: { id: 'ws-main' } },
    );

    let answered: boolean | null = null;
    void result.current.gate('Data', ['sheet.xlsx']).then((ok) => {
      answered = ok;
    });
    await act(async () => {});
    rerender({ id: 'ws-suggestions' });
    await act(async () => {
      held.release(false);
      await Promise.resolve();
    });

    expect(answered).toBe(false);
    expect(result.current.pending).toBeNull();
  });

  it('drops a dialog already open when the tree switches branch', async () => {
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useUnreadableCreateGateState(options(id, async () => false)),
      { initialProps: { id: 'ws-main' } },
    );

    let answered: boolean | null = null;
    await act(async () => {
      void result.current.gate('Data', ['sheet.xlsx']).then((ok) => {
        answered = ok;
      });
    });
    expect(result.current.pending).toMatchObject({ names: ['sheet.xlsx'], folder: 'Data' });

    rerender({ id: 'ws-suggestions' });
    await act(async () => {});

    // The folder, the read verdict and the upload all belonged to the old
    // tree; Continue there would upload into a tree nobody is looking at.
    expect(answered).toBe(false);
    expect(result.current.pending).toBeNull();
  });

  it('supersedes an open question instead of stranding it', async () => {
    const { result } = renderHook(() =>
      useUnreadableCreateGateState(options('ws-main', async () => false)),
    );

    let first: boolean | null = null;
    let second: boolean | null = null;
    await act(async () => {
      void result.current.gate('Data', ['first.xlsx']).then((ok) => {
        first = ok;
      });
    });
    await act(async () => {
      void result.current.gate('Data', ['second.xlsx']).then((ok) => {
        second = ok;
      });
    });

    // The second question is the one on screen; the first creates nothing
    // rather than waiting forever on a dialog it lost.
    expect(first).toBe(false);
    expect(result.current.pending).toMatchObject({ names: ['second.xlsx'] });
    expect(second).toBeNull();

    await act(async () => {
      result.current.answer(true);
    });
    expect(second).toBe(true);
  });

  it('still never blocks a creation the server would have taken', async () => {
    const { result } = renderHook(() =>
      useUnreadableCreateGateState({
        identity: 'ws-main',
        toRepoRelative: (folder) => (folder === 'outside' ? null : folder),
        canRead: async (folder) => {
          if (folder === 'boom') throw new Error('offline');
          return folder === 'Shared';
        },
      }),
    );

    await expect(result.current.gate('outside', ['a.xlsx'])).resolves.toBe(true);
    await expect(result.current.gate('Shared', ['a.xlsx'])).resolves.toBe(true);
    await expect(result.current.gate('boom', ['a.xlsx'])).resolves.toBe(true);
    await expect(result.current.gate('Data', [])).resolves.toBe(true);
    expect(result.current.pending).toBeNull();
  });
});
