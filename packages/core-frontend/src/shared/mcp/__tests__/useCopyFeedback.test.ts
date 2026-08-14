import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useCopyFeedback } from '../useCopyFeedback';

/**
 * The copy affordance has to be honest in the two states nobody demos: no
 * clipboard at all, and a write that fails. Both happen in the deployment this
 * app ships as — plain http on localhost is an insecure context, where
 * `navigator.clipboard` is simply absent.
 */

let restore: (() => void) | null = null;

/** Install `value` as `navigator.clipboard`, restorable. `undefined` removes it. */
function stubClipboard(value: unknown) {
  const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', { value, configurable: true });
  restore = () => {
    if (original) Object.defineProperty(navigator, 'clipboard', original);
    else Reflect.deleteProperty(navigator, 'clipboard');
  };
}

afterEach(() => {
  restore?.();
  restore = null;
});

describe('useCopyFeedback', () => {
  it('reports a successful copy', async () => {
    stubClipboard({ writeText: vi.fn().mockResolvedValue(undefined) });
    const { result } = renderHook(() => useCopyFeedback());
    await act(async () => result.current.copy('hello'));
    expect(result.current.copied).toBe(true);
  });

  /**
   * The regression: reaching for `.writeText` on an absent clipboard throws a
   * TypeError SYNCHRONOUSLY, before any promise exists — so `void` swallows
   * nothing and the click errors out instead of failing quietly.
   */
  it('does not throw when there is no clipboard at all', async () => {
    stubClipboard(undefined);
    const { result } = renderHook(() => useCopyFeedback());
    await act(async () => {
      expect(() => result.current.copy('hello')).not.toThrow();
    });
    expect(result.current.copied).toBe(false);
  });

  it('does not throw when the clipboard has no writeText', async () => {
    stubClipboard({});
    const { result } = renderHook(() => useCopyFeedback());
    await act(async () => {
      expect(() => result.current.copy('hello')).not.toThrow();
    });
    expect(result.current.copied).toBe(false);
  });

  it('claims nothing when the write is rejected', async () => {
    stubClipboard({ writeText: vi.fn().mockRejectedValue(new Error('denied')) });
    const { result } = renderHook(() => useCopyFeedback());
    await act(async () => result.current.copy('hello'));
    expect(result.current.copied).toBe(false);
  });

  /**
   * The one that actually misleads someone: a failure inside the 1500ms window
   * of an earlier success used to leave the checkmark up, so the UI reported
   * that THIS copy worked when it did not.
   */
  it('clears the checkmark when a copy fails right after one succeeded', async () => {
    const writeText = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('denied'));
    stubClipboard({ writeText });
    const { result } = renderHook(() => useCopyFeedback());

    await act(async () => result.current.copy('first'));
    expect(result.current.copied).toBe(true);

    await act(async () => result.current.copy('second'));
    expect(result.current.copied).toBe(false);
  });
});
