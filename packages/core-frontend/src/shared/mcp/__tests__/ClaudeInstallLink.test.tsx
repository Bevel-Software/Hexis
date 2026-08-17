import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ClaudeInstallLink } from '../ClaudeInstallLink';

/**
 * The three states of the connect affordance: a live button on a reachable
 * address, nothing on a dead one, and the operator hint when asked for — plus
 * the rule that the hint never prints a credential, whatever it was handed.
 */
describe('ClaudeInstallLink', () => {
  it('renders the install link for a reachable https address', () => {
    render(<ClaudeInstallLink mcpUrl="https://kb.acme.com/api/mcp" />);
    const link = screen.getByRole('link', { name: 'Add to Claude' });
    expect(link).toHaveAttribute('href', expect.stringContaining('claude.ai'));
  });

  it('renders nothing for an unreachable address without the hint', () => {
    const { container } = render(<ClaudeInstallLink mcpUrl="http://localhost:3001/api/mcp" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('names the dead address in the hint', () => {
    render(<ClaudeInstallLink mcpUrl="http://localhost:3001/api/mcp" showHint />);
    expect(screen.getByText('http://localhost:3001/api/mcp')).toBeInTheDocument();
    expect(screen.getByText(/PUBLIC_BACKEND_URL/)).toBeInTheDocument();
  });

  /**
   * `configureMcpUrl` strips credentials at the boot boundary, but `mcpUrl`
   * is a prop — a caller that bypasses that door must not get the password
   * printed on screen. (`canDeepLink` already refuses such a URL, which is
   * exactly what routes it INTO the hint branch.)
   */
  it('strips credentials from the URL it prints, rather than leaking a bypass caller’s secret', () => {
    render(<ClaudeInstallLink mcpUrl="http://someone:hunter2@kb.acme.com/api/mcp" showHint />);
    expect(screen.getByText('http://kb.acme.com/api/mcp')).toBeInTheDocument();
    expect(screen.queryByText(/hunter2/)).not.toBeInTheDocument();
    expect(screen.queryByText(/someone/)).not.toBeInTheDocument();
  });
});
