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
    const src = `# Goal\nThe goal.\n\n<details><summary>Source of Information</summary>\n\n1. PROD-1 — goal (2026-06-09)\n\n</details>\n`;
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
