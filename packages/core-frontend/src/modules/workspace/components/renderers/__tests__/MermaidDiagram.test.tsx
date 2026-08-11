import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

// mermaid is the boundary under test: what matters is what this component does
// when `render` REJECTS, which is the normal case for a diagram whose fence was
// split across a diff's change boundary.
const mermaidMock = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
}));
vi.mock('mermaid', () => ({ default: mermaidMock }));

import { MermaidDiagram } from '../MermaidDiagram';

beforeEach(() => {
  mermaidMock.render.mockReset();
});

describe('MermaidDiagram', () => {
  it('shows the error box when a diagram fails to parse and no fallback is given', async () => {
    mermaidMock.render.mockRejectedValue(new Error('Parse error on line 2'));
    render(<MermaidDiagram code="graph TD; A-->" />);
    // A document view WANTS this: a broken diagram there is a real defect the
    // author should see.
    expect(await screen.findByText('Mermaid diagram error')).toBeInTheDocument();
    expect(screen.getByText(/Parse error on line 2/)).toBeInTheDocument();
  });

  /**
   * The diff case. A diagram edited inside a change request reaches the
   * renderer with its ```mermaid fence truncated — it CANNOT parse, by
   * construction, every time. Without this the error box would replace the
   * red/green source lines, which are the only useful content in that block.
   */
  it('renders the fallback instead of the error box when one is given', async () => {
    mermaidMock.render.mockRejectedValue(new Error('Parse error on line 2'));
    render(
      <MermaidDiagram
        code="graph TD; A-->"
        errorFallback={<pre>graph TD; A--&gt;</pre>}
      />,
    );
    await waitFor(() => expect(screen.getByText(/graph TD/)).toBeInTheDocument());
    expect(screen.queryByText('Mermaid diagram error')).not.toBeInTheDocument();
    expect(screen.queryByText(/Parse error/)).not.toBeInTheDocument();
  });

  it('renders the diagram when it parses, fallback or not', async () => {
    mermaidMock.render.mockResolvedValue({ svg: '<svg data-testid="diagram"></svg>' });
    const { container } = render(
      <MermaidDiagram code="graph TD; A-->B" errorFallback={<pre>source</pre>} />,
    );
    // An UNTOUCHED diagram sits whole inside a single unchanged fragment, so it
    // parses and must still render as a diagram even in a diff.
    await waitFor(() => expect(container.querySelector('svg')).toBeTruthy());
    expect(screen.queryByText('source')).not.toBeInTheDocument();
  });
});
