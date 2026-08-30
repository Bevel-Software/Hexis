import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ChatGptInstallLink } from '../ChatGptInstallLink';

/**
 * Two states, not three: a live button on a reachable address and nothing on
 * a dead one. There is no hint variant — the Claude link next to it on the
 * settings page carries the operator hint for both.
 */
describe('ChatGptInstallLink', () => {
  it('opens ChatGPT’s connector settings for a reachable https address', () => {
    render(<ChatGptInstallLink mcpUrl="https://kb.acme.com/api/mcp" />);
    const link = screen.getByRole('link', { name: 'Add to ChatGPT' });
    expect(link).toHaveAttribute('href', expect.stringContaining('chatgpt.com'));
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  /**
   * ChatGPT has no prefill link, so the endpoint must NOT be smuggled into
   * the href on the hope that some parameter picks it up — an address in a
   * URL ChatGPT does not read is a leak with no upside.
   */
  it('does not put the endpoint in the href', () => {
    render(<ChatGptInstallLink mcpUrl="https://kb.acme.com/api/mcp" />);
    const href = screen.getByRole('link', { name: 'Add to ChatGPT' }).getAttribute('href')!;
    expect(href).not.toContain('kb.acme.com');
  });

  it('renders nothing for an address OpenAI could not reach', () => {
    const { container } = render(<ChatGptInstallLink mcpUrl="http://localhost:3001/api/mcp" />);
    expect(container).toBeEmptyDOMElement();
  });
});
