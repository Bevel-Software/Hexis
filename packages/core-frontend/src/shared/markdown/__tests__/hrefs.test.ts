import { describe, it, expect } from 'vitest';
import {
  isExternalHref,
  isOpenableExternalHref,
  isPageLinkExternalHref,
  normalizeHref,
} from '../hrefs';

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

  // The asymmetry the two lists are written around, pinned from BOTH sides.
  // A protocol-relative address resolves against the page's own scheme: for
  // the app, always http(s), so the opener takes it; for a sandboxed page,
  // `about:srcdoc`, where there is nothing sensible to inherit, so the
  // sanitizer drops it. Rejecting it in one place only is the point.
  it('lets the opener follow a protocol-relative address the markup may not keep', () => {
    expect(isOpenableExternalHref('//cdn.example.com/x.js')).toBe(true);
    expect(isOpenableExternalHref('  //cdn.example.com/x.js')).toBe(true);
    expect(isPageLinkExternalHref('//cdn.example.com/x.js')).toBe(false);
  });
});

// Every reader of an href runs the same rule, so the string a check judges is
// the string the app then follows.
describe('normalizeHref', () => {
  it('drops the padding a browser drops', () => {
    expect(normalizeHref('\n      https://example.com/docs\n    ')).toBe(
      'https://example.com/docs',
    );
    expect(normalizeHref('  Board.html  ')).toBe('Board.html');
    expect(normalizeHref('  #goal  ')).toBe('#goal');
  });

  it('removes a tab, line feed or carriage return from inside', () => {
    expect(normalizeHref('java\tscript:alert(1)')).toBe('javascript:alert(1)');
    expect(normalizeHref('java\nscript:alert(1)')).toBe('javascript:alert(1)');
    expect(normalizeHref('java\rscript:alert(1)')).toBe('javascript:alert(1)');
  });

  it('leaves an ordinary href alone, spaces inside a name included', () => {
    expect(normalizeHref('Knowledge/Notes today.md#goal')).toBe('Knowledge/Notes today.md#goal');
    expect(normalizeHref('')).toBe('');
  });
});
