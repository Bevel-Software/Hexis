import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { KbMarkdownView } from '../KbMarkdownView';

const SOURCE = `---
nodeType: "[Process](../NodeTypes/Process.md)"
---

Body text with an [Other Node](Other.md) link, a [Deep](Other.md#goal) anchor, and an [External](https://example.com) link.
`;

describe('KbMarkdownView', () => {
  it('renders the body and a clickable frontmatter nodeType link', () => {
    const onOpenFile = vi.fn();
    render(<KbMarkdownView source={SOURCE} onOpenFile={onOpenFile} />);

    expect(screen.getByText(/Body text with an/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('link', { name: 'Process' }));
    expect(onOpenFile).toHaveBeenCalledWith('../NodeTypes/Process.md');
  });

  // The panel never goes through the markdown pipeline, so it applies the
  // pipeline's URL policy itself: what the body would refuse, it refuses.
  it('holds a frontmatter link to the URL policy the body follows', () => {
    const onOpenFile = vi.fn();
    const source = (dest: string) => `---\nnodeType: "[Today](${dest})"\n---\n\nBody.\n`;
    const { rerender } = render(<KbMarkdownView source={source('./Notes: today.md')} onOpenFile={onOpenFile} />);
    fireEvent.click(screen.getByRole('link', { name: 'Today' }));
    expect(onOpenFile).toHaveBeenCalledWith('./Notes: today.md');

    // A bare name with a colon reads as a scheme, to react-markdown and to a
    // browser alike; the value stays text so the author sees what to fix.
    rerender(<KbMarkdownView source={source('Notes: today.md')} onOpenFile={onOpenFile} />);
    expect(screen.queryByRole('link', { name: 'Today' })).toBeNull();
    expect(screen.getByText('[Today](Notes: today.md)')).toBeInTheDocument();

    rerender(<KbMarkdownView source={source('javascript:alert(1)')} onOpenFile={onOpenFile} />);
    expect(screen.queryByRole('link', { name: 'Today' })).toBeNull();
    expect(document.querySelector('a[href^="javascript"]')).toBeNull();
  });

  it('routes internal .md body links (incl. anchors) through onOpenFile', () => {
    const onOpenFile = vi.fn();
    render(<KbMarkdownView source={SOURCE} onOpenFile={onOpenFile} />);

    fireEvent.click(screen.getByRole('link', { name: 'Other Node' }));
    expect(onOpenFile).toHaveBeenLastCalledWith('Other.md');

    fireEvent.click(screen.getByRole('link', { name: 'Deep' }));
    expect(onOpenFile).toHaveBeenLastCalledWith('Other.md#goal');
  });

  it('routes id-links ([text](some-id)) through onOpenNodeId, not onOpenFile', () => {
    const onOpenFile = vi.fn();
    const onOpenNodeId = vi.fn();
    render(
      <KbMarkdownView
        source={'Body with an [Availability SLA](bdl-gov-availability-sla) id-link.\n'}
        onOpenFile={onOpenFile}
        onOpenNodeId={onOpenNodeId}
      />,
    );
    fireEvent.click(screen.getByRole('link', { name: 'Availability SLA' }));
    expect(onOpenNodeId).toHaveBeenCalledWith('bdl-gov-availability-sla');
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it('leaves id-links inert when onOpenNodeId is omitted (e.g. the embed)', () => {
    const onOpenFile = vi.fn();
    render(<KbMarkdownView source={'An [SLA](bdl-gov-availability-sla) link.\n'} onOpenFile={onOpenFile} />);
    // The id-link must not render as a clickable link at all — not just be a no-op on click.
    expect(screen.queryByRole('link', { name: 'SLA' })).toBeNull();
    expect(screen.getByText('SLA')).toBeInTheDocument();
  });

  it('leaves external links as plain anchors (no onOpenFile)', () => {
    const onOpenFile = vi.fn();
    render(<KbMarkdownView source={SOURCE} onOpenFile={onOpenFile} />);

    const ext = screen.getByRole('link', { name: 'External' });
    expect(ext).toHaveAttribute('href', 'https://example.com');
    fireEvent.click(ext);
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it('shows a per-heading copy button that copies the heading deep-link', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const onOpenFile = vi.fn();
    render(
      <KbMarkdownView
        source={'# Goal\nThe goal.\n'}
        onOpenFile={onOpenFile}
        headingLink={(slug) => `https://ide.bevel.software/workspace/b/x.md#${slug}`}
      />,
    );
    const btn = screen.getByRole('button', { name: /copy link to this heading/i });
    fireEvent.click(btn);
    expect(writeText).toHaveBeenCalledWith('https://ide.bevel.software/workspace/b/x.md#goal');
  });

  it('omits the copy button when no headingLink is provided', () => {
    const onOpenFile = vi.fn();
    render(<KbMarkdownView source={'# Goal\nThe goal.\n'} onOpenFile={onOpenFile} />);
    expect(screen.queryByRole('button', { name: /copy link to this heading/i })).toBeNull();
  });

  it('renders inline HTML details blocks (Source of Information)', () => {
    const onOpenFile = vi.fn();
    const src = `# Goal\nThe goal.\n\n<details><summary>Source of Information</summary>\n\n1. PROD-1. Goal (2026-06-09)\n\n</details>\n`;
    render(<KbMarkdownView source={src} onOpenFile={onOpenFile} />);
    // rehype-raw turns the <details> into a real element rather than literal text.
    expect(screen.getByText('Source of Information').tagName.toLowerCase()).toBe('summary');
  });

  // WP1: the file viewer's document column is the scroller, so the view must be
  // able to surrender its own. The DEFAULT keeps it — the Atlassian embed and
  // the library's detail dialog both mount this view outside a document column
  // and would lose their scrollbar if the default flipped.
  it('owns a scroller by default', () => {
    const { container } = render(<KbMarkdownView source={'Body.\n'} onOpenFile={vi.fn()} />);
    expect((container.firstElementChild as HTMLElement).className).toContain('overflow-auto');
  });

  it('surrenders its scroller when scroll={false}', () => {
    const { container } = render(
      <KbMarkdownView source={'Body.\n'} onOpenFile={vi.fn()} scroll={false} />,
    );
    expect((container.firstElementChild as HTMLElement).className).not.toContain('overflow-auto');
  });
});

/**
 * Images: every state of `KbImage` in the pipeline, driven through the view so
 * the `resolveImage` prop is proven to reach the override.
 */
describe('KbMarkdownView images', () => {
  const RAW_URL = '/api/workspace/ws-1/file/raw?path=KB%2Fassets%2Fshot.png';
  const serve = () => ({ src: RAW_URL, path: 'KB/assets/shot.png' });

  it('passes an external image through as written, lazy and without a referrer', () => {
    const resolveImage = vi.fn(serve);
    render(
      <KbMarkdownView
        source={'![Ext](https://cdn.example.com/a.png)\n'}
        onOpenFile={vi.fn()}
        resolveImage={resolveImage}
      />,
    );
    const img = screen.getByRole('img', { name: 'Ext' });
    expect(img).toHaveAttribute('src', 'https://cdn.example.com/a.png');
    expect(img).toHaveAttribute('loading', 'lazy');
    expect(img).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(resolveImage).not.toHaveBeenCalled();
  });

  it('treats a protocol-relative image as external', () => {
    const resolveImage = vi.fn(serve);
    render(
      <KbMarkdownView
        source={'![Ext](//cdn.example.com/a.png)\n'}
        onOpenFile={vi.fn()}
        resolveImage={resolveImage}
      />,
    );
    expect(screen.getByRole('img', { name: 'Ext' })).toHaveAttribute('src', '//cdn.example.com/a.png');
    expect(resolveImage).not.toHaveBeenCalled();
  });

  it('says what to do when the sanitizer stripped a data: image', () => {
    render(
      <KbMarkdownView
        source={'![Pasted](data:image/png;base64,iVBORw0KGgo=)\n'}
        onOpenFile={vi.fn()}
        resolveImage={serve}
      />,
    );
    const placeholder = screen.getByRole('img', { name: /no usable source/ });
    expect(placeholder.getAttribute('aria-label')).toContain('Pasted');
    expect(placeholder.getAttribute('aria-label')).toContain('./assets/');
  });

  it('renders a workspace image as a plain tag when no resolver is injected (the embed)', () => {
    render(<KbMarkdownView source={'![Shot](./assets/shot.png)\n'} onOpenFile={vi.fn()} />);
    expect(screen.getByRole('img', { name: 'Shot' })).toHaveAttribute('src', './assets/shot.png');
  });

  it("serves a workspace image from the resolver's URL", () => {
    const resolveImage = vi.fn(serve);
    render(
      <KbMarkdownView
        source={'![Shot](./assets/shot.png)\n'}
        onOpenFile={vi.fn()}
        resolveImage={resolveImage}
      />,
    );
    expect(resolveImage).toHaveBeenCalledWith('./assets/shot.png');
    const img = screen.getByRole('img', { name: 'Shot' });
    expect(img).toHaveAttribute('src', RAW_URL);
    expect(img).toHaveAttribute('loading', 'lazy');
    expect(img).toHaveAttribute('referrerpolicy', 'no-referrer');
  });

  it('replaces an image that fails to load with a placeholder naming the workspace path', () => {
    render(
      <KbMarkdownView
        source={'![Shot](./assets/shot.png)\n'}
        onOpenFile={vi.fn()}
        resolveImage={serve}
      />,
    );
    fireEvent.error(screen.getByRole('img', { name: 'Shot' }));
    const placeholder = screen.getByRole('button', { name: /Couldn't load image: KB\/assets\/shot.png/ });
    // The alt text survives the picture.
    expect(placeholder.getAttribute('aria-label')).toMatch(/^Shot\./);
  });

  // A URL that never changes (a blip, a 403 that lifts, a file fixed on disk
  // with no event) is the one failure nothing else clears.
  it('tries the same source again on request after a failed load', () => {
    render(
      <KbMarkdownView
        source={'![Shot](./assets/shot.png)\n'}
        onOpenFile={vi.fn()}
        resolveImage={serve}
      />,
    );
    fireEvent.error(screen.getByRole('img', { name: 'Shot' }));
    fireEvent.click(screen.getByRole('button', { name: /Retry$/ }));
    expect(screen.getByRole('img', { name: 'Shot' })).toHaveAttribute('src', RAW_URL);
  });

  it('recovers when the source changes after a failure, without a reload', () => {
    const resolveImage = (src: string) => ({ src: `/raw/${src}`, path: src });
    const view = (src: string) => (
      <KbMarkdownView source={`![Shot](${src})\n`} onOpenFile={vi.fn()} resolveImage={resolveImage} />
    );
    const { rerender } = render(view('missing.png'));
    fireEvent.error(screen.getByRole('img', { name: 'Shot' }));
    expect(screen.getByRole('button', { name: /Couldn't load image/ })).toBeInTheDocument();
    rerender(view('fixed.png'));
    expect(screen.getByRole('img', { name: 'Shot' })).toHaveAttribute('src', '/raw/fixed.png');
  });

  it("shows the resolver's note instead of fetching when it withholds the bytes", () => {
    render(
      <KbMarkdownView
        source={'![Shot](./assets/shot.png)\n'}
        onOpenFile={vi.fn()}
        resolveImage={(src) => ({ src: null, path: src, note: 'Baseline image not shown' })}
      />,
    );
    expect(
      screen.getByRole('img', { name: /Baseline image not shown: \.\/assets\/shot.png/ }),
    ).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });

  it('names the raw source when the resolver cannot place it', () => {
    render(
      <KbMarkdownView
        source={'![Shot](./assets/shot.png)\n'}
        onOpenFile={vi.fn()}
        resolveImage={() => null}
      />,
    );
    expect(
      screen.getByRole('img', { name: /Couldn't load image: \.\/assets\/shot.png/ }),
    ).toBeInTheDocument();
  });

  it('routes an inline HTML <img> through the same override', () => {
    const resolveImage = vi.fn(serve);
    render(
      <KbMarkdownView
        source={'<img src="./assets/shot.png" alt="Inline">\n'}
        onOpenFile={vi.fn()}
        resolveImage={resolveImage}
      />,
    );
    expect(resolveImage).toHaveBeenCalledWith('./assets/shot.png');
    expect(screen.getByRole('img', { name: 'Inline' })).toHaveAttribute('src', RAW_URL);
  });

  it('forwards the attributes the sanitizer let through on an inline image', () => {
    render(
      <KbMarkdownView
        source={'<img src="./assets/shot.png" alt="Inline" align="right">\n'}
        onOpenFile={vi.fn()}
        resolveImage={serve}
      />,
    );
    const img = screen.getByRole('img', { name: 'Inline' });
    expect(img).toHaveAttribute('align', 'right');
    expect(img).toHaveAttribute('src', RAW_URL);
  });

  // A placeholder stands in for the image in the document: an anchor to the
  // figure still lands, a caption still describes it, nothing sizes a
  // picture that is not there, and nothing names it but itself.
  it("gives a placeholder the image's place in the document, not its dimensions or its name", () => {
    render(
      <KbMarkdownView
        source={
          '<p id="ttl">Figure 1</p><img src="./assets/shot.png" alt="Shot" id="fig-1" aria-describedby="cap" aria-labelledby="ttl" width="300">\n'
        }
        onOpenFile={vi.fn()}
        resolveImage={serve}
      />,
    );
    const img = screen.getByRole('img', { name: 'Figure 1' });
    expect(img).toHaveAttribute('width', '300');
    fireEvent.error(img);
    const placeholder = screen.getByRole('button', { name: /^Shot\. Couldn't load image/ });
    // The sanitizer prefixes ids and id references alike.
    expect(placeholder).toHaveAttribute('id', 'user-content-fig-1');
    expect(placeholder).toHaveAttribute('aria-describedby', 'user-content-cap');
    expect(placeholder).not.toHaveAttribute('aria-labelledby');
    expect(placeholder).not.toHaveAttribute('width');
  });

  it("names the placeholder for what it is, whatever aria-label the image carried", () => {
    render(
      <KbMarkdownView
        source={'<img src="./assets/rule.png" alt="Rule" aria-label="Decorative rule">\n'}
        onOpenFile={vi.fn()}
        resolveImage={serve}
      />,
    );
    fireEvent.error(screen.getByRole('img', { name: 'Decorative rule' }));
    expect(screen.getByRole('button', { name: /^Rule\. Couldn't load image/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Decorative rule' })).toBeNull();
  });

  it('keeps alt and title, and leaks no hast node onto the element', () => {
    render(
      <KbMarkdownView
        source={'![Shot](./assets/shot.png "The approval screen")\n'}
        onOpenFile={vi.fn()}
        resolveImage={serve}
      />,
    );
    const img = screen.getByRole('img', { name: 'Shot' });
    expect(img).toHaveAttribute('alt', 'Shot');
    expect(img).toHaveAttribute('title', 'The approval screen');
    expect(img.hasAttribute('node')).toBe(false);
  });
});
