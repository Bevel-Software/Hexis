import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AddMemberInput, SUGGEST_DEBOUNCE_MS } from '../components/AddMemberInput';
import { suggestPrincipals, type SuggestResponse } from '../../access/api';

vi.mock('../../access/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../access/api')>();
  return { ...actual, suggestPrincipals: vi.fn() };
});

/**
 * How long "no request" has to hold: the component's own debounce plus slack,
 * derived from the component so raising the debounce cannot leave this test
 * asserting over a window the request has not been scheduled in yet.
 */
const PAST_DEBOUNCE_MS = SUGGEST_DEBOUNCE_MS + 150;

const ALICE = { name: 'Alice Green', email: 'alice@example.com' };
const PAT = { name: 'Pat Kim', email: 'pat@example.com' };

function people(...list: { name: string; email: string }[]): SuggestResponse {
  return { roles: [], groups: [], people: list, peopleWithheld: false };
}

/** The component is controlled — the caller owns the value, as both pages do. */
function Harness({
  onSubmit = () => {},
  exclude = [],
  busy = false,
}: {
  onSubmit?: (value: string) => void;
  exclude?: string[];
  busy?: boolean;
}) {
  const [value, setValue] = useState('');
  return (
    <AddMemberInput
      value={value}
      onValueChange={setValue}
      onSubmit={onSubmit}
      exclude={exclude}
      inputLabel="Member email"
      busy={busy}
    />
  );
}

beforeEach(() => {
  vi.mocked(suggestPrincipals).mockReset().mockResolvedValue(people(ALICE));
});

describe('AddMemberInput', () => {
  it('makes no suggest request below two characters, and one at two', async () => {
    render(<Harness />);
    const input = screen.getByRole('textbox', { name: 'Member email' });

    await userEvent.type(input, 'a');
    await new Promise((resolve) => setTimeout(resolve, PAST_DEBOUNCE_MS));
    // The server withholds people under two characters anyway — asking is pure
    // waste, and the guard is what keeps a one-letter keystroke off the wire.
    expect(suggestPrincipals).not.toHaveBeenCalled();

    await userEvent.type(input, 'l');
    await waitFor(() => expect(suggestPrincipals).toHaveBeenCalledTimes(1));
    expect(suggestPrincipals).toHaveBeenCalledWith('target-company-state', 'al');
    expect(await screen.findByText('Alice Green')).toBeInTheDocument();
    expect(screen.getByText('alice@example.com')).toBeInTheDocument();
  });

  it('never offers someone the caller already counts as a member', async () => {
    vi.mocked(suggestPrincipals).mockResolvedValue(people(PAT, ALICE));
    // Mixed case on purpose: membership is case-insensitive.
    render(<Harness exclude={['PAT@example.com']} />);

    await userEvent.type(screen.getByRole('textbox', { name: 'Member email' }), 'ex');
    expect(await screen.findByText('Alice Green')).toBeInTheDocument();
    expect(screen.queryByText('Pat Kim')).not.toBeInTheDocument();
  });

  it('choosing a suggestion submits exactly the email typing it would have', async () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);

    const input = screen.getByRole('textbox', { name: 'Member email' });
    await userEvent.type(input, 'ali');
    await userEvent.click(await screen.findByText('Alice Green'));
    expect(onSubmit).toHaveBeenCalledWith('alice@example.com');

    // Same handler, same argument, from the plain typed path.
    onSubmit.mockClear();
    await userEvent.clear(input);
    await userEvent.type(input, 'alice@example.com{Enter}');
    expect(onSubmit).toHaveBeenCalledWith('alice@example.com');
  });

  it('degrades to a plain email input when the suggest request fails', async () => {
    vi.mocked(suggestPrincipals).mockRejectedValue(new Error('suggest is down'));
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);

    const input = screen.getByRole('textbox', { name: 'Member email' });
    await userEvent.type(input, 'newcomer@example.com');
    await waitFor(() => expect(suggestPrincipals).toHaveBeenCalled());

    // No list, no error takes over the form — and the value still submits.
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    expect(screen.queryByText(/suggest is down/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(onSubmit).toHaveBeenCalledWith('newcomer@example.com');
  });

  it('a keyboard alone can reach a suggestion and choose it', async () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);

    const input = screen.getByRole('textbox', { name: 'Member email' });
    await userEvent.type(input, 'ali');
    await screen.findByText('Alice Green');

    // Tab moves focus from the input INTO the list — the list has to survive
    // that, or the row it lands on is gone before Enter reaches it.
    await userEvent.tab();
    const row = screen.getByRole('button', { name: /Alice Green/ });
    expect(row).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(onSubmit).toHaveBeenCalledWith('alice@example.com');
  });

  it('offers no suggestion rows while a mutation is in flight', async () => {
    const onSubmit = vi.fn();
    const { rerender } = render(<Harness onSubmit={onSubmit} />);

    await userEvent.type(screen.getByRole('textbox', { name: 'Member email' }), 'ali');
    expect(await screen.findByText('Alice Green')).toBeInTheDocument();

    // The input and Add button already go inert while the add runs; a live row
    // would be the one way left to queue a second mutation behind the first.
    rerender(<Harness onSubmit={onSubmit} busy />);
    await waitFor(() => expect(screen.queryByText('Alice Green')).not.toBeInTheDocument());
  });

  it('drops the previous query\'s people the moment the text changes', async () => {
    let resolveSecond: ((r: SuggestResponse) => void) | undefined;
    vi.mocked(suggestPrincipals)
      .mockResolvedValueOnce(people(ALICE))
      .mockImplementationOnce(
        () => new Promise<SuggestResponse>((resolve) => { resolveSecond = resolve; }),
      );
    render(<Harness />);
    const input = screen.getByRole('textbox', { name: 'Member email' });

    await userEvent.type(input, 'al');
    expect(await screen.findByText('Alice Green')).toBeInTheDocument();

    // A new query is in flight. Alice answered the OLD text, so leaving her row
    // up would let a click add someone the current text never named.
    await userEvent.type(input, 'pat');
    await waitFor(() => expect(screen.queryByText('Alice Green')).not.toBeInTheDocument());
    await waitFor(() => expect(resolveSecond).toBeDefined());

    resolveSecond!(people(PAT));
    expect(await screen.findByText('Pat Kim')).toBeInTheDocument();
  });

  it('a stale response never overwrites the current query, and a backspace clears the list', async () => {
    const resolvers: ((r: SuggestResponse) => void)[] = [];
    vi.mocked(suggestPrincipals).mockImplementation(
      () => new Promise<SuggestResponse>((resolve) => resolvers.push(resolve)),
    );
    render(<Harness />);
    const input = screen.getByRole('textbox', { name: 'Member email' });

    await userEvent.type(input, 'pa');
    await waitFor(() => expect(resolvers).toHaveLength(1));
    await userEvent.type(input, 'li');
    await waitFor(() => expect(resolvers).toHaveLength(2));

    // The NEWER query answers first, then the older one lands late.
    resolvers[1](people(ALICE));
    expect(await screen.findByText('Alice Green')).toBeInTheDocument();
    resolvers[0](people(PAT));
    await waitFor(() => expect(screen.queryByText('Pat Kim')).not.toBeInTheDocument());
    expect(screen.getByText('Alice Green')).toBeInTheDocument();

    // Backspacing under the threshold drops the list rather than leaving a
    // stale one hanging under a query too short to have produced it.
    await userEvent.clear(input);
    await userEvent.type(input, 'a');
    await waitFor(() => expect(screen.queryByText('Alice Green')).not.toBeInTheDocument());
  });
});
