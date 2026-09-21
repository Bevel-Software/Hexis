import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { IntegrationsSetupReminder } from '../components/IntegrationsSetupReminder';
import { SIDEBAR_ROW_INSET } from '../../layout/components/SidebarFrame';

/**
 * The Library's footer reminder, on its own: what it says, where it sends
 * you, and the two halves it is deliberately made of — a count that may be
 * cut, and a way out that may not.
 */
const reminder = () => screen.getByRole('button', { name: /setup/ });

describe('IntegrationsSetupReminder', () => {
  it('counts the integrations and sends the reader to Connect', () => {
    const onFinishSetup = vi.fn();
    render(<IntegrationsSetupReminder count={2} onFinishSetup={onFinishSetup} />);

    expect(reminder()).toHaveAccessibleName('2 integrations need setup. Finish now');
    fireEvent.click(reminder());
    expect(onFinishSetup).toHaveBeenCalledTimes(1);
  });

  it('says "1 integration needs", not "1 integrations need"', () => {
    render(<IntegrationsSetupReminder count={1} onFinishSetup={vi.fn()} />);
    expect(reminder()).toHaveAccessibleName('1 integration needs setup. Finish now');
  });

  it('renders nothing when nothing needs setup', () => {
    const { container } = render(<IntegrationsSetupReminder count={0} onFinishSetup={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  /**
   * The narrow sidebar's contract, stated on the element rather than measured:
   * happy-dom has no layout engine, so "it truncates" is the presence of the
   * rule that truncates it — on the TEXT (a flex row clips without ever
   * drawing an ellipsis), with `min-w-0` so the text can give way at all.
   */
  it('truncates the count, keeps the link whole, and puts the full line in a tooltip', () => {
    render(<IntegrationsSetupReminder count={12} onFinishSetup={vi.fn()} />);

    const said = screen.getByText('12 integrations need setup.');
    expect(said).toHaveClass('truncate', 'min-w-0');

    const link = screen.getByText('Finish now');
    expect(link).toHaveClass('flex-none', 'underline');
    expect(link).not.toHaveClass('truncate');

    expect(reminder()).toHaveAttribute('title', '12 integrations need setup. Finish now');
  });

  it('sits on the sidebar row grid rather than an inset of its own', () => {
    render(<IntegrationsSetupReminder count={2} onFinishSetup={vi.fn()} />);
    expect(reminder()).toHaveClass(SIDEBAR_ROW_INSET);
    // The rule above the footer and the space under the tree belong to the
    // frame's footer group. A row that brought either back would be the
    // second hairline this ticket removed.
    expect(reminder().className).not.toMatch(/\bborder-t\b|\bmt-\d/);
  });
});
