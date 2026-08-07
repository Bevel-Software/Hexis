import { describe, it, expect } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { ToolLogo } from '../components/ToolLogo';

/**
 * A tool's mark. Two things are worth pinning, and neither is how it looks:
 *
 *  - the fallback FIRES, because most tools will never have a drawn logo — the
 *    KB accepts any `.tool` anybody writes;
 *  - the fallback is STABLE, because a monogram whose colour moved when the
 *    catalog gained an entry would be worse than no colour at all.
 */

function mark(slug: string, name?: string) {
  const { container } = render(<ToolLogo slug={slug} name={name} />);
  return container.firstElementChild as HTMLElement;
}

describe('ToolLogo', () => {
  it('draws the real logo for a service we ship a mark for', () => {
    expect(mark('slack').querySelector('svg')).not.toBeNull();
    cleanup();
    expect(mark('github').querySelector('svg')).not.toBeNull();
  });

  it('maps our slug, not the brand name', () => {
    // The `.tool` files declare `google_gmail`; nothing in the catalog says
    // "gmail", so keying on the brand would have silently missed every one.
    expect(mark('google_gmail').querySelector('svg')).not.toBeNull();
    cleanup();
    expect(mark('google_calendar').querySelector('svg')).not.toBeNull();
  });

  it('falls back to a monogram for a tool nobody has drawn', () => {
    const el = mark('heyreach', 'HeyReach');
    expect(el.querySelector('svg')).toBeNull();
    expect(el.textContent).toBe('H');
  });

  it('takes the monogram letter from the slug when there is no name', () => {
    expect(mark('quickbooks').textContent).toBe('Q');
  });

  it('gives one slug the same colour every time, and not by position', () => {
    const first = mark('heyreach').getAttribute('style');
    cleanup();
    const again = mark('heyreach').getAttribute('style');
    expect(again).toBe(first);
    expect(first).toMatch(/background-color/);

    // A different slug is free to collide on colour — what must NOT happen is
    // a slug's colour depending on what else exists.
    cleanup();
    const other = mark('granola').getAttribute('style');
    expect(other).toMatch(/background-color/);
  });

  it('stays out of the accessible name. The row already says the tool', () => {
    expect(mark('slack')).toHaveAttribute('aria-hidden', 'true');
    cleanup();
    expect(mark('heyreach')).toHaveAttribute('aria-hidden', 'true');
  });
});
