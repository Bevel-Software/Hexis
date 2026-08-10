import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { FileDiffPayload } from '@bevel-software/platform-shared';
import { MarkdownDiffViewer } from '../MarkdownDiffViewer';

/**
 * The diff viewer renders through the shared KB markdown pipeline, so a diff
 * reads like the document it is a diff of. These tests pin the two things that
 * make that safe rather than merely nice: it must stay renderable with NO
 * providers, and it must never swallow content.
 */

function payload(baseline: string, current: string): FileDiffPayload {
  return {
    path: 'Knowledge/Node.md',
    kind: 'modified',
    baseline,
    current,
    isBinary: false,
  } as FileDiffPayload;
}

describe('MarkdownDiffViewer', () => {
  /**
   * The load-bearing constraint. This component is rendered by the
   * change-request dialog and the file-history panel — both of which are
   * exercised bare in their own tests — and it is reachable from the embed
   * routes, which mount outside the Git/Workspace providers. If a future edit
   * reaches for `useFileNav()` instead of taking a resolver as a prop, this
   * test fails immediately rather than the embed crashing in production.
   */
  it('renders with no Router and no Git/Workspace providers', () => {
    render(<MarkdownDiffViewer payload={payload('# Old title\n', '# New title\n')} />);
    expect(screen.getByRole('heading', { name: 'New title' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Old title' })).toBeInTheDocument();
  });

  it('renders unchanged text once and changed text on both sides', () => {
    render(
      <MarkdownDiffViewer
        payload={payload('shared para\n\nold line\n', 'shared para\n\nnew line\n')}
      />,
    );
    expect(screen.getByText('shared para')).toBeInTheDocument();
    expect(screen.getByText('old line')).toBeInTheDocument();
    expect(screen.getByText('new line')).toBeInTheDocument();
  });

  describe('node-id links', () => {
    // The link exists only on the added side, so its text is unambiguous —
    // a diff renders both sides, so a fixture sharing text across them would
    // match twice.
    const withIdLink = payload('See nothing yet\n', 'See [the process](order-intake)\n');

    it('are inert when no resolver is supplied', () => {
      const { container } = render(<MarkdownDiffViewer payload={withIdLink} />);
      // A bare id must never fall through as a relative-URL anchor — that
      // would navigate the SPA to a path that does not exist.
      const anchors = Array.from(container.querySelectorAll('a'));
      expect(anchors.some((a) => a.getAttribute('href') === 'order-intake')).toBe(false);
      expect(screen.getAllByText('the process').length).toBeGreaterThan(0);
    });

    it('call the injected resolver when one is supplied', async () => {
      const onOpenNodeId = vi.fn();
      render(<MarkdownDiffViewer payload={withIdLink} onOpenNodeId={onOpenNodeId} />);
      await userEvent.click(screen.getByText('the process'));
      expect(onOpenNodeId).toHaveBeenCalledWith('order-intake');
    });
  });

  it('escapes spaces in link destinations so KB links resolve', () => {
    const onOpenFile = vi.fn();
    render(
      <MarkdownDiffViewer
        payload={payload('a\n', 'a\n\n[Foo](Some File.md)\n')}
        onOpenFile={onOpenFile}
      />,
    );
    // Without escaping, CommonMark rejects the unescaped space and the whole
    // link renders as literal text — the diff viewer's behaviour before it
    // adopted the KB pipeline.
    expect(screen.getByText('Foo')).toBeInTheDocument();
  });

  it('renders raw HTML blocks rather than escaping them', () => {
    const { container } = render(
      <MarkdownDiffViewer
        payload={payload('x\n', 'x\n\n<details><summary>Source</summary>body</details>\n')}
      />,
    );
    expect(container.querySelector('details')).toBeTruthy();
  });

  /**
   * rehype-raw is only safe alongside rehype-sanitize, and this surface renders
   * content someone else has PROPOSED — the one place an injected script would
   * be most valuable to an attacker and least expected by a reviewer.
   */
  it('sanitises dangerous markup in proposed content', () => {
    const { container } = render(
      <MarkdownDiffViewer
        payload={payload('x\n', 'x\n\n<img src=q onerror="alert(1)">\n')}
      />,
    );
    expect(container.innerHTML).not.toContain('onerror');
  });

  it('does not render a frontmatter panel for a body fragment that opens on a thematic break', () => {
    // `parseFrontmatter` matches ANY string starting with `---`, and diff
    // fragments are split at arbitrary change boundaries. Rendering a fragment
    // through a frontmatter-parsing view would swallow everything between the
    // two rules. The text must survive.
    render(
      <MarkdownDiffViewer
        payload={payload('intro\n', 'intro\n\n---\n\nvisible body text\n\n---\n')}
      />,
    );
    expect(screen.getByText('visible body text')).toBeInTheDocument();
  });
});
