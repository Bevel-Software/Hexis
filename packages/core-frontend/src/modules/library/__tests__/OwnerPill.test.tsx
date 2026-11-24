import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { OwnerPill } from '../components/OwnerPill';
import { LibraryCard, type LibraryCardProps } from '../components/LibraryCard';

/**
 * The Library's Owner pill says what Owner means where a person meets it: as
 * its tooltip and its accessible description. One component draws it on the
 * cards, the plugin rows and the skill page.
 */

const OWNER =
  'Owner: everything Can edit allows, plus downloading a copy. Owners are also named as the people to ask about it.';
const COMPONENTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'components');

describe('the Owner pill', () => {
  it('carries what Owner means as its tooltip and accessible description', () => {
    render(<OwnerPill />);
    const pill = screen.getByText('Owner');
    expect(pill).toHaveAttribute('title', OWNER);
    expect(pill).toHaveAccessibleDescription(OWNER);
  });

  it('is the pill on a card the reader owns', () => {
    render(
      <LibraryCard
        {...({
          kind: 'skill',
          id: 'rfi',
          name: 'rfi',
          description: 'Answers an RFI.',
          owned: true,
          status: { state: 'ok', text: 'Ready' },
          onOpen: vi.fn(),
        } as LibraryCardProps)}
      />,
    );
    expect(screen.getByText('Owner')).toHaveAccessibleDescription(OWNER);
  });

  it('is the only Owner pill the cards, the plugin rows and the skill page draw', () => {
    for (const file of ['LibraryCard.tsx', 'PluginRows.tsx', 'skill-page/SkillPage.tsx']) {
      const source = readFileSync(join(COMPONENTS, file), 'utf8');
      expect(source, file).toContain('<OwnerPill');
      // No second, bare pill beside it.
      expect(source, file).not.toMatch(/>\s*Owner\s*</);
    }
  });
});
