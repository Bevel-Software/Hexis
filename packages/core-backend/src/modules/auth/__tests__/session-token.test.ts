import { describe, expect, it } from 'vitest';
import type { Request } from 'express';
import { sessionTokenOf } from '../index.js';
import { AUTH_COOKIE_NAME } from '../session-token.js';

/**
 * `sessionTokenOf`, the rule offered on auth's entry for a route mounted before
 * the session middleware: it reads a request the way the middleware does
 * (`auth.middleware.test.ts` pins the middleware on the same cases), so such a
 * route and the middleware never disagree on which token a request carries.
 */

const request = (headers: Record<string, string>) => ({ headers }) as unknown as Request;

describe('sessionTokenOf', () => {
  it('reads the Bearer header', () => {
    expect(sessionTokenOf(request({ authorization: 'Bearer abc' }))).toBe('abc');
  });

  it('reads the auth cookie when there is no Bearer header (a link clicked in a chat app)', () => {
    expect(sessionTokenOf(request({ cookie: `theme=dark; ${AUTH_COOKIE_NAME}=from%20cookie` }))).toBe('from cookie');
  });

  it('prefers the Bearer header when both are present', () => {
    expect(sessionTokenOf(request({ authorization: 'Bearer abc', cookie: `${AUTH_COOKIE_NAME}=xyz` }))).toBe('abc');
  });

  it('falls back to the cookie when the Bearer header is empty', () => {
    expect(sessionTokenOf(request({ authorization: 'Bearer   ', cookie: `${AUTH_COOKIE_NAME}=xyz` }))).toBe('xyz');
  });

  it('answers null for a request with neither, or with an empty cookie', () => {
    expect(sessionTokenOf(request({}))).toBeNull();
    expect(sessionTokenOf(request({ cookie: `${AUTH_COOKIE_NAME}=` }))).toBeNull();
    expect(sessionTokenOf(request({ authorization: 'Basic abc' }))).toBeNull();
  });
});
