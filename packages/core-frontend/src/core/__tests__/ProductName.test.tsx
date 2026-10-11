import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MAKER_URL, ProductName } from '../ProductName';
import { AppRegistryContext, makeRegistry } from '../registry';

afterEach(cleanup);

describe('ProductName', () => {
  it("links the maker's name to the maker's site by default", () => {
    render(<ProductName />);
    expect(screen.getByRole('link', { name: 'Bevel' })).toHaveAttribute('href', MAKER_URL);
    expect(MAKER_URL).toBe('https://bevel.software');
  });

  it('links it where the registry says, for a distribution with its own front door', () => {
    render(
      <AppRegistryContext.Provider value={makeRegistry({ makerLink: 'https://hexis.software' })}>
        <ProductName />
      </AppRegistryContext.Provider>,
    );
    const link = screen.getByRole('link', { name: 'Bevel' });
    expect(link).toHaveAttribute('href', 'https://hexis.software');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.closest('span')).toHaveTextContent('Hexis by Bevel');
  });

  it("links the maker's site when the registry's place is empty, as when it is absent", () => {
    render(
      <AppRegistryContext.Provider value={makeRegistry({ makerLink: '' })}>
        <ProductName />
      </AppRegistryContext.Provider>,
    );
    expect(screen.getByRole('link', { name: 'Bevel' })).toHaveAttribute('href', MAKER_URL);
  });

  it('is plain text where a link cannot go, wherever the registry would send it', () => {
    render(
      <AppRegistryContext.Provider value={makeRegistry({ makerLink: 'https://hexis.software' })}>
        <ProductName link={false} />
      </AppRegistryContext.Provider>,
    );
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('Hexis by Bevel')).toBeInTheDocument();
  });
});
