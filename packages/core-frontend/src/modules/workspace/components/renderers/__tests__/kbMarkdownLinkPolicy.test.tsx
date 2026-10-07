import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { KbMarkdownView } from '../KbMarkdownView';

/**
 * WHICH links a surface takes over, and which the browser keeps.
 *
 * The app renders in a tab, so an `http(s)` destination is best left to the
 * browser: `target="_blank"` opens a new tab and nothing needs intercepting.
 * A renderer surface — the embed, inside a chat host's iframe — cannot do
 * that: a host's sandbox has no `allow-popups`, so `target="_blank"` is
 * ignored and the plain anchor NAVIGATES THE FRAME. The reader loses the page
 * and has no way back, which is the one thing the embed must never do.
 *
 * Found on a real boot: an external link in an embedded page navigated the
 * frame away and no `bevel-embed-open` ever reached the host.
 */
function view(source: string, props: Partial<Parameters<typeof KbMarkdownView>[0]> = {}) {
  const onOpenFile = vi.fn();
  render(<KbMarkdownView source={source} onOpenFile={onOpenFile} {...props} />);
  return { onOpenFile };
}

describe("the app's link policy (the default)", () => {
  it('leaves an external link to the browser, in a new tab', async () => {
    const { onOpenFile } = view('[docs](https://example.test/docs)');
    const link = screen.getByRole('link', { name: 'docs' });
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    await userEvent.click(link);
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it('takes an internal .md link', async () => {
    const { onOpenFile } = view('[other](Other.md)');
    await userEvent.click(screen.getByRole('link', { name: 'other' }));
    expect(onOpenFile).toHaveBeenCalledWith('Other.md');
  });
});

describe("a surface's link policy", () => {
  const surface = { linkPolicy: 'surface' as const };

  it('takes an external link rather than letting it navigate the frame', async () => {
    const { onOpenFile } = view('[docs](https://example.test/docs)', surface);
    const link = screen.getByRole('link', { name: 'docs' });
    // No `target="_blank"` to be ignored by a sandbox, and no navigation:
    // the click is cancelled and the destination is handed over.
    expect(link.getAttribute('target')).toBeNull();
    await userEvent.click(link);
    expect(onOpenFile).toHaveBeenCalledWith('https://example.test/docs');
  });

  /**
   * The narrower half of the same bug: the internal rule matched `.md` only,
   * so a knowledge-base link to an image, a PDF or a document was left to the
   * browser as a relative URL — in a frame, another way to navigate away.
   */
  it.each([
    ['an image', '[shot](assets/shot.png)', 'assets/shot.png'],
    ['a PDF', '[report](Docs/Report.pdf)', 'Docs/Report.pdf'],
    ['a document', '[spec](Docs/Spec.docx)', 'Docs/Spec.docx'],
    ['a markdown page', '[other](Other.md)', 'Other.md'],
    ['a page with an anchor', '[goal](Other.md#goal)', 'Other.md#goal'],
  ])('takes a knowledge-base link to %s', async (_label, source, href) => {
    const { onOpenFile } = view(source, surface);
    await userEvent.click(screen.getByRole('link'));
    expect(onOpenFile).toHaveBeenCalledWith(href);
  });

  /**
   * A same-page anchor is the browser's under BOTH policies: it scrolls
   * inside this view and leaves nothing, so relaying it to the host would
   * open a second copy of the page in a tab.
   */
  it('leaves a same-page anchor alone', async () => {
    const { onOpenFile } = view('## Goal\n\n[jump](#goal)', surface);
    await userEvent.click(screen.getByRole('link', { name: 'jump' }));
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  /**
   * Judged as the browser judges it: a destination padded with whitespace is
   * still a same-page anchor once normalised, so it scrolls here rather than
   * being relayed out as another page.
   */
  it('leaves a whitespace-padded same-page anchor alone too', async () => {
    const { onOpenFile } = view('## Goal\n\n<a href=" #goal">jump</a>', surface);
    const link = screen.getByRole('link', { name: 'jump' });
    expect(link.getAttribute('href')).toBe(' #goal');
    await userEvent.click(link);
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it('still renders a bare node id inert when there is no resolver for it', () => {
    view('[a node](some-node-id)', surface);
    expect(screen.queryByRole('link', { name: 'a node' })).toBeNull();
  });
});
