import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { KbFileRail, type KbFileRailProps } from '../KbFileRail';

const LONG_PATH =
  'knowledge-base/Knowledge/Engineering/Architecture/Invariants/A-Very-Long-Node-Name-Indeed.md';

function renderRail(overrides: Partial<KbFileRailProps> = {}) {
  const props: KbFileRailProps = {
    path: 'knowledge-base/Knowledge/Invariant.md',
    charCount: 4218,
    lastCommit: { author: 'Ali', relative: '3d ago' },
    owners: { roles: ['Architect'], users: [] },
    linksOut: [{ label: 'NodeType.md', target: '../NodeTypes/NodeType.md' }],
    onOpen: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<KbFileRail {...props} />) };
}

describe('KbFileRail', () => {
  it('states where the file is, who touched it and who it is for', () => {
    renderRail();
    expect(screen.getByText('Path')).toBeInTheDocument();
    expect(screen.getByText('knowledge-base/Knowledge/Invariant.md')).toBeInTheDocument();
    expect(screen.getByText('Edited')).toBeInTheDocument();
    expect(screen.getByText(/3d ago by Ali/)).toBeInTheDocument();
    expect(screen.getByText('Access')).toBeInTheDocument();
    expect(screen.getByText('Architect')).toBeInTheDocument();
  });

  // The rail never shows a row it cannot fill. A metadata panel that prints
  // "—" for half its rows teaches people to stop reading it.
  it('omits the character count entirely when it is unknowable', () => {
    renderRail({ charCount: null });
    expect(screen.queryByText('Characters')).not.toBeInTheDocument();
  });

  // "Characters", not "Size": `openFileContent` is a string, so its length is
  // UTF-16 code units, and the rail will not print a byte figure it cannot
  // compute.
  it('labels the count Characters and never claims a byte size', () => {
    renderRail({ charCount: 4218 });
    expect(screen.getByText('Characters')).toBeInTheDocument();
    // Plugined through the runner's own locale, not a hard-coded `4,218`: the
    // rail calls `toLocaleString()`, so an en-DE machine renders `4.218` and a
    // literal would fail there while the component is perfectly correct.
    expect(screen.getByText((4218).toLocaleString())).toBeInTheDocument();
    expect(screen.queryByText('Size')).not.toBeInTheDocument();
    expect(screen.queryByText(/KB/)).not.toBeInTheDocument();
  });

  it('omits Edited when there is no commit to name', () => {
    renderRail({ lastCommit: null });
    expect(screen.queryByText('Edited')).not.toBeInTheDocument();
  });

  it('omits Access when nobody owns the path', () => {
    renderRail({ owners: { roles: [], users: [] } });
    expect(screen.queryByText('Access')).not.toBeInTheDocument();
  });

  it('renders no Links out section when the document links nowhere', () => {
    renderRail({ linksOut: [] });
    expect(screen.queryByText('Links out')).not.toBeInTheDocument();
  });

  it('opens a link with the raw target the caller resolves', async () => {
    const user = userEvent.setup();
    const { props } = renderRail();
    await user.click(screen.getByRole('button', { name: 'NodeType.md' }));
    expect(props.onOpen).toHaveBeenCalledWith('../NodeTypes/NodeType.md');
  });

  // A truncated path is unusable for the one thing anyone copies a path for.
  it('wraps a long path rather than truncating it', () => {
    renderRail({ path: LONG_PATH });
    const value = screen.getByText(LONG_PATH);
    expect(value.className).toContain('break-all');
    expect(value.className).not.toContain('truncate');
  });
});
