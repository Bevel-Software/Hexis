import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { cn } from '../../../lib/utils';
import {
  Button,
  buttonClasses,
  IconButton,
  Surface,
  ListRow,
  Badge,
  Banner,
  TextField,
  TextAreaField,
  MenuPanel,
  MenuItem,
  MenuLabel,
} from '../index';

/**
 * The a11y layer is a FROZEN API: 76 existing tests select components by
 * `role`, `aria-label` and `title`. Measured against this suite, dropping
 * `title=` breaks 31 tests, `role=` breaks 29 and `aria-label` breaks 16.
 *
 * So the contract every primitive must honour is: spread `...rest` onto the
 * root node, and never synthesise or override those three attributes. The
 * table below asserts that for every primitive at once — if someone adds a
 * primitive that swallows `title`, this fails rather than a screen-reader
 * regression shipping silently.
 */
const A11Y_CASES: Array<[string, (props: Record<string, unknown>) => ReactElement]> = [
  ['Button', (p) => <Button {...p}>x</Button>],
  ['IconButton', (p) => <IconButton aria-label="fallback" {...p} />],
  ['Surface', (p) => <Surface {...p}>x</Surface>],
  ['ListRow', (p) => <ListRow {...p} label="x" />],
  ['Badge', (p) => <Badge {...p}>x</Badge>],
  ['Banner', (p) => <Banner role="status" {...p}>x</Banner>],
  ['TextField', (p) => <TextField {...p} />],
  ['TextAreaField', (p) => <TextAreaField {...p} />],
  ['MenuPanel', (p) => <MenuPanel {...p}>x</MenuPanel>],
  ['MenuItem', (p) => <MenuItem {...p}>x</MenuItem>],
  ['MenuLabel', (p) => <MenuLabel {...p}>x</MenuLabel>],
];

describe('cn() knows the design system scales', () => {
  it('does not drop a semantic text colour when a custom size follows it', () => {
    // Regression: `text-ui` is a FONT SIZE. Untaught, tailwind-merge reads it
    // as a text colour, judges it to conflict with `text-ink-muted`, and drops
    // the colour — silently, in every primitive that composes size + colour.
    expect(cn('text-ink-muted', 'text-ui')).toBe('text-ink-muted text-ui');
    expect(cn('text-danger', 'text-meta')).toBe('text-danger text-meta');
  });

  it('still collapses genuine conflicts within one namespace', () => {
    expect(cn('text-ink', 'text-danger')).toBe('text-danger');
    expect(cn('text-ui', 'text-body')).toBe('text-body');
    expect(cn('shadow-card', 'shadow-overlay')).toBe('shadow-overlay');
  });

  it('lets a caller override a primitive default via className', () => {
    expect(cn('bg-surface', 'bg-sunken')).toBe('bg-sunken');
  });
});

describe('a11y contract (C4): every primitive forwards role/aria-label/title', () => {
  it.each(A11Y_CASES)('%s forwards all three untouched', (_name, renderFn) => {
    const { container } = render(
      renderFn({
        'data-probe': 'root',
        role: 'note',
        'aria-label': 'my-label',
        title: 'my-tooltip',
      }),
    );
    const root = container.querySelector('[data-probe="root"]');
    expect(root).not.toBeNull();
    expect(root!.getAttribute('role')).toBe('note');
    expect(root!.getAttribute('aria-label')).toBe('my-label');
    expect(root!.getAttribute('title')).toBe('my-tooltip');
  });

  it('ListRow does NOT shadow the native title attribute with its text prop', () => {
    // Regression: `label` used to be called `title`, which collided with the
    // HTML attribute and would have broken the 31 tests that read it.
    render(<ListRow data-testid="row" label="Row text" title="Tooltip text" />);
    const row = screen.getByTestId('row');
    expect(row.getAttribute('title')).toBe('Tooltip text');
    expect(row).toHaveTextContent('Row text');
  });
});

describe('Button', () => {
  it('defaults to type="button" so it never submits a form by accident', () => {
    render(<Button>Save</Button>);
    expect(screen.getByRole('button', { name: 'Save' })).toHaveAttribute('type', 'button');
  });

  it('honours an explicit type', () => {
    render(<Button type="submit">Go</Button>);
    expect(screen.getByRole('button', { name: 'Go' })).toHaveAttribute('type', 'submit');
  });

  it('fires onClick when enabled and not when disabled', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    const { rerender } = render(<Button onClick={onClick}>Go</Button>);
    await user.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledTimes(1);

    rerender(
      <Button onClick={onClick} disabled>
        Go
      </Button>,
    );
    await user.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('applies one disabled treatment rather than per-call-site copies', () => {
    render(<Button disabled>Go</Button>);
    const cls = screen.getByRole('button').className;
    expect(cls).toContain('disabled:opacity-50');
    expect(cls).toContain('disabled:cursor-not-allowed');
  });

  it('renders leading and trailing icons around the label', () => {
    render(
      <Button leadingIcon={<span>L</span>} trailingIcon={<span>T</span>}>
        Mid
      </Button>,
    );
    expect(screen.getByRole('button').textContent).toBe('LMidT');
  });

  it('buttonClasses produces the same classes as the component, for <a>/<Link>', () => {
    render(<Button variant="primary" size="sm">x</Button>);
    expect(screen.getByRole('button').className).toBe(
      buttonClasses({ variant: 'primary', size: 'sm' }),
    );
  });

  it.each([
    ['primary', 'bg-accent'],
    ['outline', 'border-line-strong'],
    ['quiet', 'text-ink-muted'],
    ['danger', 'text-danger'],
  ] as const)('variant %s resolves through a token, not a raw colour', (variant, expected) => {
    render(<Button variant={variant}>x</Button>);
    expect(screen.getByRole('button').className).toContain(expected);
  });
});

describe('IconButton', () => {
  it('is reachable by its required accessible name', () => {
    render(<IconButton aria-label="Hide sidebar">x</IconButton>);
    expect(screen.getByRole('button', { name: 'Hide sidebar' })).toBeInTheDocument();
  });

  it('shows a pressed background when active', () => {
    // Match a STANDALONE class: `hover:bg-hover` is always present and
    // contains `bg-hover` as a substring, so a naive contains() never fails.
    const hasBare = (el: Element) => el.className.split(/\s+/).includes('bg-hover');
    const { rerender } = render(<IconButton aria-label="Menu" />);
    expect(hasBare(screen.getByRole('button'))).toBe(false);
    rerender(<IconButton aria-label="Menu" active />);
    expect(hasBare(screen.getByRole('button'))).toBe(true);
  });

  it.each([28, 24, 22, 18] as const)('size %s maps to a fixed square', (size) => {
    const { container } = render(<IconButton aria-label="x" size={size} />);
    const cls = container.querySelector('button')!.className;
    expect(cls).toMatch(/h-(7|6|\[22px\]|\[18px\])/);
  });
});

describe('Surface', () => {
  it('renders the requested element', () => {
    const { container } = render(<Surface as="section">x</Surface>);
    expect(container.querySelector('section')).not.toBeNull();
  });

  it('only adds hover/press affordances when interactive', () => {
    const { container, rerender } = render(<Surface>x</Surface>);
    expect(container.firstElementChild!.className).not.toContain('cursor-pointer');
    rerender(<Surface interactive>x</Surface>);
    expect(container.firstElementChild!.className).toContain('cursor-pointer');
  });

  it('elevation none emits no shadow class', () => {
    const { container } = render(<Surface elevation="none">x</Surface>);
    expect(container.firstElementChild!.className).not.toMatch(/shadow-/);
  });
});

describe('ListRow', () => {
  it('as="button" gets type="button" so it never submits', () => {
    render(<ListRow as="button" label="Row" />);
    expect(screen.getByRole('button')).toHaveAttribute('type', 'button');
  });

  it('as="div" is not given a type attribute', () => {
    const { container } = render(<ListRow label="Row" />);
    expect(container.firstElementChild!.hasAttribute('type')).toBe(false);
  });

  it('renders label, description and meta', () => {
    render(<ListRow label="Name" description="Detail" meta={<span>12</span>} />);
    expect(screen.getByText('Name')).toBeInTheDocument();
    expect(screen.getByText('Detail')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
  });

  it('active is visual only and does not invent aria-current', () => {
    const { container } = render(<ListRow label="Row" active />);
    const root = container.firstElementChild!;
    expect(root.className).toContain('bg-hover');
    expect(root.hasAttribute('aria-current')).toBe(false);
  });
});

describe('Badge', () => {
  it.each([
    ['neutral', 'bg-sunken'],
    ['ok', 'bg-ok-soft'],
    ['wait', 'bg-wait-soft'],
    ['danger', 'bg-danger-soft'],
    ['outline', 'border-line'],
  ] as const)('tone %s uses a token background', (tone, expected) => {
    const { container } = render(<Badge tone={tone}>x</Badge>);
    expect(container.firstElementChild!.className).toContain(expected);
  });

  it('mono badges get the mono family for digit alignment', () => {
    const { container } = render(<Badge mono>v1.2.0</Badge>);
    expect(container.firstElementChild!.className).toContain('font-mono');
  });
});

describe('Banner', () => {
  it('renders nothing when it has no children', () => {
    // 13 existing tests assert `container.firstChild` is null on conditional
    // banners. A design-system wrapper that always renders a box breaks them.
    const { container } = render(<Banner role="status">{null}</Banner>);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when children is false', () => {
    const { container } = render(<Banner role="status">{false}</Banner>);
    expect(container.firstChild).toBeNull();
  });

  it('is selectable by the role the caller chose', () => {
    render(<Banner role="alert">Something broke</Banner>);
    expect(screen.getByRole('alert')).toHaveTextContent('Something broke');
  });

  it('renders the leading icon slot', () => {
    render(
      <Banner role="status" icon={<span>!</span>}>
        Note
      </Banner>,
    );
    expect(screen.getByRole('status').textContent).toBe('!Note');
  });
});

describe('Field', () => {
  it('TextField defaults to type=text and forwards value/onChange', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TextField aria-label="Search" onChange={onChange} />);
    const input = screen.getByRole('textbox', { name: 'Search' });
    expect(input).toHaveAttribute('type', 'text');
    await user.type(input, 'ab');
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('uses an inset accent outline instead of a border-colour shift on focus', () => {
    render(<TextField aria-label="Search" />);
    const cls = screen.getByRole('textbox').className;
    expect(cls).toContain('focus:outline-accent');
    expect(cls).toContain('focus:border-transparent');
    expect(cls).not.toMatch(/focus:border-slate/);
  });

  it('TextAreaField renders a textarea', () => {
    render(<TextAreaField aria-label="Note" />);
    expect(screen.getByRole('textbox', { name: 'Note' }).tagName).toBe('TEXTAREA');
  });
});

describe('Menu', () => {
  it('MenuPanel uses one radius/shadow pair for every menu in the app', () => {
    const { container } = render(<MenuPanel>x</MenuPanel>);
    const cls = container.firstElementChild!.className;
    expect(cls).toContain('rounded-lg');
    expect(cls).toContain('shadow-overlay');
  });

  it('MenuItem fires onClick and blocks it when disabled', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    const { rerender } = render(<MenuItem onClick={onClick}>Rename</MenuItem>);
    await user.click(screen.getByRole('button', { name: 'Rename' }));
    expect(onClick).toHaveBeenCalledTimes(1);

    rerender(
      <MenuItem onClick={onClick} disabled>
        Rename
      </MenuItem>,
    );
    await user.click(screen.getByRole('button', { name: 'Rename' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('MenuItem danger tone is distinguishable from default', () => {
    const { container: a } = render(<MenuItem>Delete</MenuItem>);
    const { container: b } = render(<MenuItem tone="danger">Delete</MenuItem>);
    expect(a.firstElementChild!.className).not.toContain('text-danger');
    expect(b.firstElementChild!.className).toContain('text-danger');
  });

  it('MenuItem renders the trailing adornment slot', () => {
    render(<MenuItem trailing={<span>✓</span>}>Light</MenuItem>);
    expect(screen.getByRole('button').textContent).toBe('Light✓');
  });

  it('MenuLabel renders its section heading', () => {
    render(<MenuLabel>Appearance</MenuLabel>);
    expect(screen.getByText('Appearance')).toBeInTheDocument();
  });
});
