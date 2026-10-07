import { describe, expect, it } from 'vitest';
import { EMBED_EXPIRED, EMBED_OPEN_MESSAGE, resolveToAppUrl } from '../embed-host';

const KB = { kbDirName: 'knowledge-base', branch: 'main' };
const ORIGIN = window.location.origin;
/**
 * The file a link sits in, WORKSPACE-relative — which is the form the
 * renderers pass (`FileRendererProps.filePath`, and the embed's
 * `view.workspacePath`) and the form `resolveKbHref` resolves against.
 */
const BASE = 'knowledge-base/Data/Thing.md';
const DEEP_BASE = 'knowledge-base/Data/Deep/Thing.md';

/**
 * Where a link clicked inside the embedded view goes. The embed never
 * navigates itself — it is one page deep by decision, and a token is minted
 * for one file — so every destination becomes an absolute address the HOST
 * opens in a new tab.
 */
describe('resolveToAppUrl', () => {
  it.each([
    ['a sibling page', 'Other.md', BASE, `${ORIGIN}/workspace/main/knowledge-base/Data/Other.md`],
    ['a page one level up', '../Top.md', DEEP_BASE, `${ORIGIN}/workspace/main/knowledge-base/Data/Top.md`],
    [
      'a heading in another page',
      'Other.md#goal',
      BASE,
      `${ORIGIN}/workspace/main/knowledge-base/Data/Other.md#goal`,
    ],
    [
      'a percent-encoded name',
      'Some%20Page.md',
      BASE,
      `${ORIGIN}/workspace/main/knowledge-base/Data/Some%20Page.md`,
    ],
  ])('turns %s into the app address', (_label, href, basePath, expected) => {
    expect(resolveToAppUrl(href, basePath, KB)).toBe(expected);
  });

  it('keeps the branch an absolute app link named, rather than the embed own', () => {
    expect(resolveToAppUrl('/workspace/a-draft/knowledge-base/Data/X.md', BASE, KB)).toBe(
      `${ORIGIN}/workspace/a-draft/knowledge-base/Data/X.md`,
    );
  });

  /** External links leave the same way — a new tab, through the host. */
  it.each([
    ['an https address', 'https://example.test/docs'],
    ['an http address', 'http://example.test/docs'],
    ['a mailto: address', 'mailto:someone@example.test'],
  ])('passes %s to the host', (_label, href) => {
    expect(resolveToAppUrl(href, BASE, KB)).toBe(href);
  });

  /**
   * The embed asks its HOST to open whatever it hands over, and a host
   * obliges — so a scheme the app would never call `window.open` on must not
   * reach it either. The pages these links come from may have been written by
   * an agent.
   */
  it.each([
    ['javascript:', 'javascript:alert(1)'],
    ['a data: document', 'data:text/html,<script>alert(1)</script>'],
    ['a vbscript: address', 'vbscript:msgbox(1)'],
    ['javascript: with padding the normaliser strips', ' java\tscript:alert(1)'],
  ])('refuses %s', (_label, href) => {
    expect(resolveToAppUrl(href, BASE, KB)).toBeNull();
  });

  it('still makes an absolute address out of an app path with no page loaded yet', () => {
    expect(resolveToAppUrl('/change-requests/7', '', null)).toBe(`${ORIGIN}/change-requests/7`);
  });
});

describe('what the embed says when it has nothing to show', () => {
  /**
   * The acceptance criterion in words. One sentence, and the one thing the
   * reader can act on — asking again — because only the agent can mint a
   * fresh token.
   */
  it('is one plain sentence that says it expired and that the agent can open it again', () => {
    expect(EMBED_EXPIRED).toBe('This view has expired. Ask the agent to open the page again.');
    expect(EMBED_EXPIRED).toMatch(/expired/i);
    expect(EMBED_EXPIRED).toMatch(/again/i);
  });
});

describe('the relay message', () => {
  it('has the name the view and the MCP App page agree on', () => {
    // The HTML view in `core-backend/mcp-app/page.html` listens for exactly
    // this and answers it with `ui/open-link`; the Forge panel answers it
    // with `router.open`. One string, two hosts.
    expect(EMBED_OPEN_MESSAGE).toBe('bevel-embed-open');
  });
});
