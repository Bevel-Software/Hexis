import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PullRequestSummary } from '@bevel-software/platform-shared';
import { ChangeRequestDock } from '../components/ChangeRequestDock';
import { PageActions } from '../components/PageActions';
import { Dialog } from '../../../shared/components';

const CR = {
  number: 7,
  title: 'Tighten the refund wording',
  author: { login: 'user-42ee38e1c062' },
  appAuthor: { name: 'Olga' },
  branch: 'cr/refund-wording',
} as unknown as PullRequestSummary;

/**
 * The stacking band an element paints in, read off the Tailwind class it
 * carries (`z-30`, `z-[60]`).
 *
 * Reading the class rather than a computed style is not a shortcut: happy-dom
 * loads no stylesheet, and Tailwind emits nothing at test time, so the class
 * IS the value — and it is exactly what a layering regression rewrites.
 */
function band(el: Element): number {
  for (const cls of el.classList) {
    const m = /^z-\[?(\d+)\]?$/.exec(cls);
    if (m) return Number(m[1]);
  }
  throw new Error(`no z-index class on: ${el.className}`);
}

const dock = () => screen.getByRole('complementary', { name: /change requests for this skill/i });

/**
 * WHICH BAND THE DOCK PAINTS IN.
 *
 * The dock is ambient — it sits beside the skill for as long as you are
 * reading it — and nothing ambient may cover something the user just opened.
 * It shipped at `z-55`, above both the anchored-dropdown band and the modal
 * band, so opening the profile menu got you a list of change requests painted
 * over it and a dialog fared no better.
 *
 * These assert the ORDER against the real components on the other side of it,
 * not the literal number, so raising either band later can't quietly restore
 * the bug.
 */
describe('ChangeRequestDock: stacking band', () => {
  it('paints below the anchored-dropdown band, so an open menu is never covered', async () => {
    const user = userEvent.setup();
    render(
      <>
        <ChangeRequestDock crs={[CR]} onSelect={() => {}} />
        <PageActions onAdd={() => {}} onCopyLink={async () => true} />
      </>,
    );

    await user.click(screen.getByRole('button', { name: /more actions/i }));
    const menu = screen.getByRole('menu', { name: /more actions/i }).parentElement!;

    expect(band(dock())).toBeLessThan(band(menu));
  });

  it('paints below the modal band, so a dialog is never covered', () => {
    render(
      <>
        <ChangeRequestDock crs={[CR]} onSelect={() => {}} />
        <Dialog open title="Manage access" onClose={() => {}}>
          <p>body</p>
        </Dialog>
      </>,
    );

    const scrim = screen.getByRole('dialog').parentElement!;

    expect(band(dock())).toBeLessThan(band(scrim));
  });

  it('renders nothing when there is nothing to review', () => {
    render(<ChangeRequestDock crs={[]} onSelect={() => {}} />);

    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
  });
});
