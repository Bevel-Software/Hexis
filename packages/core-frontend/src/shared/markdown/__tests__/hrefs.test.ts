import { describe, it, expect } from 'vitest';
import { isExternalHref, isOpenableExternalHref, isPageLinkExternalHref } from '../hrefs';

// Generated markup puts an href on its own line often enough that the padding
// has to be invisible to the scheme check — otherwise a perfectly ordinary
// external link reads as a workspace path and the app tries to open it as a
// file. A browser ignores the same characters, and because every list here is
// an ALLOWLIST, ignoring them can never let a new scheme through.
describe('leading whitespace before a scheme', () => {
  const padded = '\n      https://example.com/docs\n    ';

  it('does not hide a scheme from any of the three questions', () => {
    expect(isExternalHref(padded)).toBe(true);
    expect(isOpenableExternalHref(padded)).toBe(true);
    expect(isPageLinkExternalHref(padded)).toBe(true);
  });

  it('does not let a padded javascript: address through either', () => {
    expect(isOpenableExternalHref('  javascript:alert(1)')).toBe(false);
    expect(isPageLinkExternalHref('  javascript:alert(1)')).toBe(false);
    // …and it is still recognised as leaving the workspace, so nothing tries
    // to open it as a file.
    expect(isExternalHref('  javascript:alert(1)')).toBe(true);
  });

  it('leaves a padded workspace path a workspace path', () => {
    expect(isExternalHref('  Dashboards/Board.html')).toBe(false);
    expect(isPageLinkExternalHref('  Dashboards/Board.html')).toBe(false);
  });
});

describe('isPageLinkExternalHref', () => {
  it.each([
    'http://example.com/docs',
    'https://example.com/docs',
    'HTTPS://Example.com/Docs',
    'MailTo:team@example.com',
    'mailto:team@example.com',
  ])('accepts %s', (href) => {
    expect(isPageLinkExternalHref(href)).toBe(true);
  });

  it.each([
    // Openable when the app itself decided to follow one, but not an address
    // a generated page may put in front of a reader.
    'tel:+15551234',
    'sms:+15551234',
    'geo:51.5,-0.1',
    // Never openable anywhere.
    'javascript:alert(1)',
    'data:text/html,evil',
    'file:///etc/passwd',
    'vbscript:msgbox(1)',
    'x-devonthink-item:4F2A',
    // No scheme written down at all.
    '//cdn.example.com/x.js',
    'Dashboards/Board.html',
    '',
  ])('rejects %s', (href) => {
    expect(isPageLinkExternalHref(href)).toBe(false);
  });

  // A kept scheme the opener refuses would be a link that survives
  // sanitization and then does nothing when clicked. Containment, pinned.
  it('accepts nothing the external opener would refuse', () => {
    for (const href of ['http://example.com', 'https://example.com', 'mailto:a@b.com']) {
      expect(isPageLinkExternalHref(href)).toBe(true);
      expect(isOpenableExternalHref(href)).toBe(true);
      expect(isExternalHref(href)).toBe(true);
    }
  });
});
