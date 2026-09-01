import { describe, expect, it } from 'vitest';
import { formatRelativeTime } from '../utils';

/**
 * One relative-time formatter for the whole app, so the same instant cannot
 * render as "2h ago" in one place and "2 hr ago" in another. These pin the
 * parts the callers rely on: the input shapes they actually hold, and the ''
 * that lets each surface supply its own word for "no timestamp" ("never" for an
 * unused API key, "just now" for a connection verdict) without forking the
 * dialect for every timestamp that DOES exist.
 */
describe('formatRelativeTime', () => {
  const agoMs = (ms: number) => Date.now() - ms;

  it.each([
    [30_000, 'just now'],
    [5 * 60_000, '5m ago'],
    [3 * 3_600_000, '3h ago'],
    [2 * 86_400_000, '2d ago'],
    [10 * 86_400_000, '1w ago'],
  ])('formats %i ms ago as %s', (ms, expected) => {
    expect(formatRelativeTime(agoMs(ms))).toBe(expected);
  });

  it('accepts an ISO string, epoch milliseconds and a Date alike', () => {
    const then = new Date(agoMs(5 * 60_000));
    expect(formatRelativeTime(then.toISOString())).toBe('5m ago');
    expect(formatRelativeTime(then.getTime())).toBe('5m ago');
    expect(formatRelativeTime(then)).toBe('5m ago');
  });

  it.each([[null], [undefined], [''], ['not-a-date'], [Number.NaN]])(
    'formats %j as the empty string, leaving the word to the caller',
    (value) => {
      expect(formatRelativeTime(value as string | number | null | undefined)).toBe('');
    },
  );

  it('falls back to an absolute date past ~a month', () => {
    const old = new Date(agoMs(200 * 86_400_000));
    expect(formatRelativeTime(old)).toBe(old.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }));
  });
});
