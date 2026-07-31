import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import type { FileApprovalState } from '@bevel-software/platform-shared';
import { PrApprovalBadge } from '../components/PrApprovalBadge';

const ALICE = { name: 'Alice', email: 'alice@bevel.software' };

function state(overrides: Partial<FileApprovalState>): FileApprovalState {
  // Spread after defaults so an explicit empty `eligibleApprovers` (the
  // "outside the gate" case) passes through.
  return {
    path: 'Foo.md',
    eligibleApprovers: { roles: [], users: [ALICE] },
    approvedBy: [],
    isApproved: false,
    viewerCanApprove: false,
    ...overrides,
  };
}

describe('PrApprovalBadge', () => {
  it('renders nothing when state is missing', () => {
    const { container } = render(<PrApprovalBadge state={undefined} />);
    expect(container.firstChild).toBeNull();
  });

  it('shows the "confirmed" tooltip including the eligible approver', () => {
    const { container } = render(
      <PrApprovalBadge
        state={state({
          isApproved: true,
          approvedBy: [
            { email: 'alice@bevel.software', name: 'Alice', approvedAt: 'x', isStale: false, isSelfApproval: false },
          ],
        })}
      />,
    );
    const tooltipNode = container.querySelector('[title]');
    expect(tooltipNode?.getAttribute('title')).toMatch(/confirmed by/i);
    expect(tooltipNode?.getAttribute('title')).toMatch(/Alice/);
  });

  it('renders nothing for md files with no eligible approvers (outside the gate)', () => {
    const { container } = render(
      <PrApprovalBadge state={state({ eligibleApprovers: { roles: [], users: [] } })} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing for non-md files regardless of eligibility', () => {
    const { container } = render(
      <PrApprovalBadge state={state({ path: 'src/foo.ts' })} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('shows the outdated indicator when only stale approvals exist', () => {
    const { container } = render(
      <PrApprovalBadge
        state={state({
          isApproved: false,
          approvedBy: [
            { email: 'alice@bevel.software', name: 'Alice', approvedAt: 'x', isStale: true, isSelfApproval: false },
          ],
        })}
      />,
    );
    const tooltipNode = container.querySelector('[title]');
    expect(tooltipNode?.getAttribute('title')).toMatch(/confirmation outdated/i);
  });

  it('shows the waiting indicator when there are eligible approvers but none have approved', () => {
    const { container } = render(
      <PrApprovalBadge state={state({ isApproved: false, approvedBy: [] })} />,
    );
    const tooltipNode = container.querySelector('[title]');
    expect(tooltipNode?.getAttribute('title')).toMatch(/waiting on/i);
    expect(tooltipNode?.getAttribute('title')).toMatch(/Alice/);
  });

  it('renders for files where eligibility comes from a role grant', () => {
    const { container } = render(
      <PrApprovalBadge
        state={state({
          eligibleApprovers: { roles: ['Admin'], users: [] },
          isApproved: false,
        })}
      />,
    );
    const tooltipNode = container.querySelector('[title]');
    expect(tooltipNode?.getAttribute('title')).toMatch(/Admin/);
  });
});
