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
  vi.useRealTimers();
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
  /**
   * The counter, not a boolean: `setCopied(true)` on an already-true boolean
   * bails out of the render, so the second copy's checkmark used to inherit
   * the FIRST copy's deadline and could vanish almost immediately.
   */
  it('restarts the 1500ms window when a second copy lands inside the first one’s', async () => {
    vi.useFakeTimers();
    stubClipboard({ writeText: vi.fn().mockResolvedValue(undefined) });
    const { result } = renderHook(() => useCopyFeedback());

    await act(async () => result.current.copy('first'));
    expect(result.current.copied).toBe(true);

    act(() => vi.advanceTimersByTime(1000));
    await act(async () => result.current.copy('second'));

    // 1400ms after the second copy — past the first copy's old deadline, but
    // inside the second's fresh window.
    act(() => vi.advanceTimersByTime(1400));
    expect(result.current.copied).toBe(true);

    act(() => vi.advanceTimersByTime(200));
    expect(result.current.copied).toBe(false);
  });

  /** A refusal is an answer the reader must act on: it does not fade like a success. */
  it('keeps a refusal said until the next try', async () => {
    vi.useFakeTimers();
    stubClipboard({ writeText: vi.fn().mockRejectedValue(new Error('denied')) });
    const { result } = renderHook(() => useCopyFeedback());
    let answer: string | undefined;
    await act(async () => {
      answer = await result.current.copy('hello');
    });
    expect(answer).toBe('failed');
    expect(result.current.status).toBe('failed');
    act(() => vi.advanceTimersByTime(5000));
    expect(result.current.status).toBe('failed');
  });

  /** Each copy starts from idle, so a live region reading the status changes, and says it again. */
  it('goes back to idle while a repeat copy is on its way', async () => {
    let land!: () => void;
    const writeText = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockReturnValueOnce(new Promise<void>((resolve) => (land = resolve)));
    stubClipboard({ writeText });
    const { result } = renderHook(() => useCopyFeedback());
    await act(async () => result.current.copy('first'));
    expect(result.current.status).toBe('copied');
    let second!: Promise<string>;
    act(() => {
      second = result.current.copy('second');
    });
    expect(result.current.status).toBe('idle');
    await act(async () => {
      land();
      await second;
    });
    expect(result.current.status).toBe('copied');
  });

  /** Only the latest copy speaks: a slow refusal from an earlier click cannot overwrite a later "Copied". */
  it('drops an earlier copy’s answer that arrives after a later copy started', async () => {
    vi.useFakeTimers();
    let refuseFirst!: (error: Error) => void;
    const writeText = vi
      .fn()
      .mockReturnValueOnce(new Promise<void>((_, reject) => (refuseFirst = reject)))
      .mockResolvedValueOnce(undefined);
    stubClipboard({ writeText });
    const { result } = renderHook(() => useCopyFeedback());

    let first!: Promise<string>;
    act(() => {
      first = result.current.copy('first');
    });
    await act(async () => result.current.copy('second'));
    expect(result.current.status).toBe('copied');

    let firstAnswer: string | undefined;
    await act(async () => {
      refuseFirst(new Error('denied'));
      firstAnswer = await first;
    });
    expect(firstAnswer).toBe('idle');
    expect(result.current.status).toBe('copied');

    // The later copy's fade still runs on its own clock.
    act(() => vi.advanceTimersByTime(1500));
    expect(result.current.status).toBe('idle');
  });

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
