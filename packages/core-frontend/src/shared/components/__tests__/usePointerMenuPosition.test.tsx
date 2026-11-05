import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { usePointerMenuPosition } from '../usePointerMenuPosition';

/**
 * The hook measures the panel and places it relative to the pointer, keeping
 * an 8px margin from every window edge. jsdom lays nothing out, so the panel
 * is a stub with a fixed size.
 */
function panel(w: number, h: number) {
  const el = document.createElement('div');
  Object.defineProperty(el, 'offsetWidth', { value: w });
  Object.defineProperty(el, 'offsetHeight', { value: h });
  return { current: el };
}

describe('usePointerMenuPosition', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { value: 1000, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 600, configurable: true });
  });

  it('opens at the pointer when the menu fits below it', () => {
    const { result } = renderHook(() => usePointerMenuPosition(panel(200, 100), 300, 200));
    expect(result.current).toEqual({ left: 300, top: 200 });
  });

  it('keeps the top margin when the pointer is in the first pixels of the window', () => {
    // Fits below, so the downward branch places it — but never above the
    // margin every other placement keeps from the window edge.
    const { result } = renderHook(() => usePointerMenuPosition(panel(200, 100), 300, 2));
    expect(result.current.top).toBe(8);
  });

  it('flips above the pointer when it does not fit below', () => {
    const { result } = renderHook(() => usePointerMenuPosition(panel(200, 100), 300, 560));
    expect(result.current.top).toBe(560 - 4 - 100);
  });

  it('pins to the bottom margin when it fits neither below nor above', () => {
    const { result } = renderHook(() => usePointerMenuPosition(panel(200, 700), 300, 100));
    expect(result.current.top).toBe(8);
    expect(result.current.left).toBe(300);
  });

  it('keeps the right margin', () => {
    const { result } = renderHook(() => usePointerMenuPosition(panel(200, 100), 950, 200));
    expect(result.current.left).toBe(1000 - 200 - 8);
  });
});
