import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ToolSharePanel } from '../components/tool-page/ToolSharePanel';

/**
 * The SEAM Ali builds the F-lens into. These assertions are the contract, not
 * an implementation detail: the dialog title, the props shape, and the body
 * placeholder are what his work replaces without touching this file's callers.
 */

const TOOL = { slug: 'github', name: 'github', path: 'Groups/Engineering/github.tool' };

describe('ToolSharePanel', () => {
  it('renders nothing while closed', () => {
    const { container } = render(
      <ToolSharePanel open={false} tool={TOOL} onClose={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('opens a dialog titled "Share tool" naming the tool, with the seam placeholder', () => {
    render(<ToolSharePanel open tool={TOOL} onClose={vi.fn()} />);

    expect(screen.getByRole('dialog')).toHaveAccessibleName('Share tool');
    expect(screen.getByText(/Access, ownership, and roles for/)).toBeInTheDocument();
    expect(screen.getByText('github')).toBeInTheDocument();
    expect(screen.getByTestId('tool-share-panel-body')).toBeInTheDocument();
  });

  it('closes on Done', () => {
    const onClose = vi.fn();
    render(<ToolSharePanel open tool={TOOL} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalled();
  });
});
