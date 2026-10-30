import { describe, it, expect } from 'vitest';

import { CHANGE_REQUEST_URL_NOTE, changeRequestLink, changeRequestLinkBase } from '../change-request-link.js';

/**
 * The link an agent hands a person for a change request: absolute under the
 * configured public frontend address, else the relative in-app path with a note.
 */
describe('changeRequestLink', () => {
  it('is absolute under a configured address, keeping the number in its own field', () => {
    const base = changeRequestLinkBase('https://bevel.example.com');
    expect(changeRequestLink(12, base)).toEqual({ url: 'https://bevel.example.com/change-requests/12' });
  });

  it('keeps the path prefix of a proxied deployment', () => {
    for (const configured of ['https://example.com/hexis', 'https://example.com/hexis/']) {
      const base = changeRequestLinkBase(configured);
      expect(changeRequestLink(3, base).url, configured).toBe('https://example.com/hexis/change-requests/3');
    }
  });

  it('stays the relative path with a note when no address is configured', () => {
    for (const configured of [null, undefined, '', '   ']) {
      expect(changeRequestLink(5, changeRequestLinkBase(configured))).toEqual({
        url: '/change-requests/5',
        urlNote: CHANGE_REQUEST_URL_NOTE,
      });
    }
    expect(CHANGE_REQUEST_URL_NOTE).toBe('Set PUBLIC_FRONTEND_URL to get absolute links.');
  });

  it('never carries credentials, a query or a fragment from the configured address', () => {
    const base = changeRequestLinkBase('https://user:s3cret-token@bevel.example.com/app/?token=abc#frag');
    const { url } = changeRequestLink(9, base);
    expect(url).toBe('https://bevel.example.com/app/change-requests/9');
    expect(url).not.toMatch(/s3cret|token|user|frag/);
  });

  it('treats an unparseable or non-web address as unconfigured', () => {
    expect(changeRequestLinkBase('not a url')).toBeNull();
    expect(changeRequestLinkBase('javascript:alert(1)')).toBeNull();
  });
});
