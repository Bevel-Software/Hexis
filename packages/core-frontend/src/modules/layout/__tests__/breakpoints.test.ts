import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NARROW_PX, NARROW_QUERY, TOOLBAR_STACK_QUERY } from '../breakpoints';

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../..');

function readSource(relativePath: string): string {
  return readFileSync(join(SRC_DIR, relativePath), 'utf8');
}

describe('narrow-layout source parity', () => {
  it('builds the media query from the shared numeric breakpoint', () => {
    expect(NARROW_PX).toBe(900);
    expect(NARROW_QUERY).toBe(`(max-width: ${NARROW_PX}px)`);
    expect(TOOLBAR_STACK_QUERY).toBe('(max-width: 767px)');
  });

  it('keeps the JS breakpoint aligned with the existing 900px Tailwind variants', () => {
    const files = [
      'shared/theme/measure.ts',
      'modules/workspace/components/KbDocumentShell.tsx',
    ];
    const breakpoints = files.map((file) => ({
      file,
      values: [
        ...new Set(
          [...readSource(file).matchAll(/max-\[(\d+)px\]:/g)].map((match) =>
            Number(match[1]),
          ),
        ),
      ],
    }));

    expect(breakpoints).toEqual(
      files.map((file) => ({ file, values: [NARROW_PX] })),
    );
  });

  it('keeps the library card track capable of shrinking to the viewport', () => {
    const source = readSource('modules/library/components/group-page-parts.tsx');

    expect(source).toContain(
      'grid-cols-[repeat(auto-fill,minmax(min(236px,100%),1fr))]',
    );
  });
});
