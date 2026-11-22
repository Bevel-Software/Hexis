import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConnectAsChoice } from '../components/ConnectAsChoice';
import { connectedAsLabel, type BotChoice } from '../services/agent-choices.api';

const CODER: BotChoice = {
  id: 'delivery-coder',
  name: 'delivery-coder',
  description: 'writes and verifies the code for one delivery ticket',
  address: 'delivery-coder@agent.hexis',
  unavailable: null,
};
const TWIN: BotChoice = {
  id: 'release-helper',
  name: 'release-helper',
  description: '',
  address: 'release-helper@agent.hexis',
  unavailable: 'two files share the id release-helper',
};

describe('ConnectAsChoice', () => {
  it('shows nothing when no bot is on offer: the connection is the person\'s', () => {
    const { container } = render(<ConnectAsChoice bots={[]} value={null} onChange={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('offers Myself first, chosen, with the person\'s address; then each bot as "Bot · description"', () => {
    render(<ConnectAsChoice bots={[CODER]} myselfEmail="dana@acme.com" value={null} onChange={() => {}} />);
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(2);
    expect(radios[0]).toBeChecked();
    expect(screen.getByText('Myself')).toBeInTheDocument();
    expect(screen.getByText('dana@acme.com · everything you may read and write')).toBeInTheDocument();
    expect(screen.getByText('Bot · writes and verifies the code for one delivery ticket')).toBeInTheDocument();
    expect(screen.queryByText(/Everything/)).not.toBeInTheDocument();
  });

  it('lists a bot that cannot be used, disabled, with its reason', async () => {
    const onChange = vi.fn();
    render(<ConnectAsChoice bots={[CODER, TWIN]} value={null} onChange={onChange} />);
    const twin = screen.getAllByRole('radio')[2]!;
    expect(twin).toBeDisabled();
    expect(screen.getByText('Cannot be used: two files share the id release-helper')).toBeInTheDocument();
    await userEvent.click(twin);
    expect(onChange).not.toHaveBeenCalled();
    await userEvent.click(screen.getAllByRole('radio')[1]!);
    expect(onChange).toHaveBeenCalledWith('delivery-coder');
  });

  it('asks the person to confirm Myself when the bots could not be loaded', () => {
    render(<ConnectAsChoice bots={[]} value={null} onChange={() => {}} unavailable={{ confirmed: false, onConfirm: () => {} }} />);
    expect(screen.getByRole('alert')).toHaveTextContent("Your bots couldn't be loaded");
    expect(screen.getByLabelText('Connect as Myself anyway')).not.toBeChecked();
  });
});

describe('connectedAsLabel', () => {
  it('says as whom a connection is connected, and why it stopped', () => {
    expect(connectedAsLabel({ kind: 'myself' })).toBe('Connected as you');
    expect(connectedAsLabel(undefined)).toBe('Connected as you');
    expect(connectedAsLabel({ kind: 'bot', name: 'delivery-coder', stopped: null })).toBe('Connected as delivery-coder');
    expect(connectedAsLabel({ kind: 'bot', name: 'release-helper', stopped: 'you may no longer edit this bot' })).toBe(
      'Connected as release-helper · stopped: you may no longer edit this bot',
    );
  });
});
